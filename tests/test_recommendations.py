import asyncio
import importlib
from collections import defaultdict

import httpx
import pytest
from fastapi import HTTPException

import recommendations as rec
import tracking

ALICE = "a" * 32
BOB = "b" * 32
MOVIE = "1" * 32
SHOW = "2" * 32
EPISODE = "3" * 32
VIEWERS = [{"id": ALICE, "name": "Alice"}, {"id": BOB, "name": "Bob"}]


def candidate(key="movie:10", genres=None, runtime=90, **values):
    return {"key": key, "media_type": key.split(":")[0], "name": key, "genres": genres or ["Comedy"],
            "runtime_minutes": runtime, "sources": [], "community_rating": 7, **values}


def profiles():
    return {u["id"]: {"genres": defaultdict(float), "people": defaultdict(float), "titles": {},
                      "rating_count": 0, "completed_count": 0} for u in VIEWERS}


def rank(items, filters=None, preferences=None, feedback=None, watched=None):
    return rec.rank_candidates(items, VIEWERS, preferences or profiles(), filters or rec.PickFilters(),
                               feedback or {}, watched or set(), {})


def test_ratings_dominate_completion_and_episode_ratings_are_one_show_signal():
    metadata = {MOVIE: candidate(), SHOW: candidate("tv:20", ["Drama"])}
    ratings = [{"user_id": ALICE, "item_id": MOVIE, "series_id": None, "score": 10},
               {"user_id": BOB, "item_id": EPISODE, "series_id": SHOW, "score": 2},
               {"user_id": BOB, "item_id": "4" * 32, "series_id": SHOW, "score": 4}]
    pref = rec.build_profiles(VIEWERS, ratings, [(ALICE, SHOW)] * 26, metadata)
    assert pref[ALICE]["genres"]["comedy"] == 6
    assert pref[ALICE]["genres"]["drama"] == 0.6
    assert pref[BOB]["genres"]["drama"] == -4.5
    assert pref[BOB]["rating_count"] == 1
    assert pref[ALICE]["completed_count"] == 1


def test_group_prefers_shared_match_over_one_viewers_favourite():
    pref = profiles()
    pref[ALICE]["genres"].update(comedy=6, drama=2)
    pref[BOB]["genres"].update(comedy=-6, drama=2)
    result = rank([candidate(), candidate("movie:11", ["Drama"])], preferences=pref)
    assert result[0]["key"] == "movie:11"
    assert any("Bob" in reason for reason in result[0]["reasons"])
    assert not any("percent" in reason for reason in result[0]["reasons"])


def test_many_completions_cannot_cancel_an_explicit_dislike():
    metadata = {MOVIE: candidate()}
    completed = []
    for n in range(100):
        iid = f"{n + 10:032x}"
        metadata[iid] = candidate(f"movie:{n + 100}")
        completed.append((ALICE, iid))
    pref = rec.build_profiles(VIEWERS, [{"user_id": ALICE, "item_id": MOVIE, "score": 2}], completed, metadata)
    assert pref[ALICE]["genres"]["comedy"] == -5.25


def test_strict_time_genre_mood_type_and_unseen_filters():
    items = [candidate(), candidate("movie:11", runtime=None), candidate("movie:12", runtime=121),
             candidate("movie:13", ["Horror"]), candidate("tv:14", runtime=22)]
    result = rank(items, rec.PickFilters(media_type="movie", mood="light", genre="Comedy"))
    assert [m["key"] for m in result] == ["movie:10"]
    assert not rank([candidate()], watched={(BOB, "movie:10")})
    assert rank([candidate()], rec.PickFilters(unseen=False), watched={(BOB, "movie:10")})
    assert len(rank(items, rec.PickFilters(max_minutes=None))) == 5


def test_feedback_hides_for_group_and_seen_only_filters_when_unseen_enabled():
    assert not rank([candidate()], feedback={(BOB, "movie:10"): "not_interested"})
    assert not rank([candidate()], feedback={(BOB, "movie:10"): "seen"})
    assert rank([candidate()], rec.PickFilters(unseen=False), feedback={(BOB, "movie:10"): "seen"})


def test_cold_start_and_missing_genres_do_not_invent_taste_reasons():
    result = rank([candidate(genres=[])])
    assert "starting pick" in result[0]["reasons"][0]
    assert rec.genre_features(["Sci-Fi & Fantasy", "Action & Adventure"]) == {"science fiction", "fantasy", "action", "adventure"}


@pytest.fixture
def application(monkeypatch, tmp_path):
    monkeypatch.setenv("JELLYFIN_API_KEY", "test-key")
    monkeypatch.setenv("SESSION_SECRET", "test-secret")
    monkeypatch.setenv("SEERR_API_KEY", "private-seerr-key")
    monkeypatch.setenv("SEERR_URL", "http://seerr:5055")
    monkeypatch.setenv("JELLYFIN_PUBLIC_URL", "https://jellyfin.test")
    monkeypatch.setenv("SEERR_PUBLIC_URL", "https://seerr.test")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "monitarr.db"))
    module = importlib.import_module("app")
    monkeypatch.setattr(module, "DB_PATH", str(tmp_path / "monitarr.db"))
    module.init_db()
    tracking.initialize(module.DB_PATH)
    service = rec.Discovery(lambda: module.jf, lambda: module.DB_PATH)
    monkeypatch.setattr(module.discovery, "cache", {})
    monkeypatch.setattr(module.discovery, "inflight", {})
    monkeypatch.setattr(module.discovery, "locks", {})
    return module, service


def request(module, path, method="GET", body=None, authenticated=True):
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://test") as client:
            if authenticated:
                client.cookies.set(module.COOKIE, module.signer.dumps({"id": ALICE, "name": "Alice", "admin": False}))
            return await client.request(method, path, json=body)
    return asyncio.run(run())


def test_all_discovery_endpoints_require_login(application):
    module, _ = application
    for path, method, body in [("/api/recommendations/options", "GET", None),
                               ("/api/recommendations", "POST", {}),
                               ("/api/recommendations/feedback", "POST", {"key": "movie:10", "action": "seen"}),
                               ("/api/seerr/movie/10", "GET", None),
                               ("/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10})]:
        assert request(module, path, method, body, authenticated=False).status_code == 401


def test_feedback_is_owned_by_caller_and_undo_persists(application):
    module, _ = application
    with module.db() as c:
        c.execute("INSERT INTO recommendation_feedback VALUES (?,?,?,?)", (BOB, "movie:10", "seen", "now"))
    assert request(module, "/api/recommendations/feedback", "POST", {"key": "movie:10", "action": "not_interested"}).status_code == 200
    assert request(module, "/api/recommendations/feedback", "POST", {"key": "movie:10", "action": None}).status_code == 200
    with module.db() as c:
        assert [(r["user_id"], r["action"]) for r in c.execute("SELECT * FROM recommendation_feedback")] == [(BOB, "seen")]
    assert request(module, "/api/recommendations/feedback", "POST", {"key": "../secret", "action": "seen"}).status_code == 422
    assert request(module, "/api/recommendations/feedback", "POST", {"key": "movie:10", "action": "seen", "user_id": BOB}).status_code == 422


def test_library_intersection_and_episode_runtime(application, monkeypatch):
    module, service = application
    def movie(iid, name, tmdb):
        return {"Id": iid, "Name": name, "Type": "Movie", "Genres": ["Comedy"], "RunTimeTicks": 90 * 600_000_000,
                "ProviderIds": {"Tmdb": str(tmdb)}, "UserData": {"Played": False}}
    show = {"Id": SHOW, "Name": "A show", "Type": "Series", "Genres": ["Comedy"],
            "ProviderIds": {"Tmdb": "20"}, "RecursiveItemCount": 26, "UserData": {"UnplayedItemCount": 26}}
    shared = movie(MOVIE, "Shared movie", 10)
    hidden = movie("4" * 32, "Restricted movie", 11)
    async def jf_get(path, params=None):
        if path == "/Users":
            return [{"Id": u["id"], "Name": u["name"]} for u in VIEWERS]
        if path.endswith("/Episodes"):
            return {"Items": [{"Id": EPISODE, "Name": "Pilot", "Type": "Episode", "ParentIndexNumber": 1,
                               "IndexNumber": 1, "RunTimeTicks": 22 * 600_000_000, "UserData": {"Played": False}}]}
        return {"Items": [shared, show] + ([hidden] if ALICE in path else []), "TotalRecordCount": 3}
    monkeypatch.setattr(service, "jf_get", jf_get)
    result = asyncio.run(service.picks(rec.PickFilters(viewers=[BOB], max_minutes=30), {"id": ALICE}))
    assert len(result["items"]) == 1
    assert result["items"][0]["runtime_minutes"] == 22
    assert result["items"][0]["play_item_id"] == EPISODE
    assert result["items"][0]["watch_url"].endswith(EPISODE)
    result = asyncio.run(service.picks(rec.PickFilters(viewers=[BOB]), {"id": ALICE}))
    assert "Restricted movie" not in [m["name"] for m in result["items"]]
    assert [u["id"] for u in result["viewers"]] == [ALICE, BOB]


def test_invalid_or_disabled_viewer_rejected(application, monkeypatch):
    _, service = application
    async def jf_get(*args):
        return [{"Id": ALICE, "Name": "Alice"}, {"Id": BOB, "Name": "Bob", "Policy": {"IsDisabled": True}}]
    monkeypatch.setattr(service, "jf_get", jf_get)
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.viewers([BOB], {"id": ALICE}))
    assert error.value.status_code == 400


def install_seerr_mock(monkeypatch, handler):
    original = httpx.AsyncClient
    def client(**kwargs):
        kwargs.setdefault("transport", httpx.MockTransport(handler))
        return original(**kwargs)
    monkeypatch.setattr(httpx, "AsyncClient", client)


def test_seerr_uses_verified_user_header_never_admin_or_browser_override(application, monkeypatch):
    module, _ = application
    observed = []
    def handler(req):
        observed.append(req)
        assert req.headers["X-Api-Key"] == "private-seerr-key"
        if "/user/jellyfin/" in req.url.path:
            assert req.url.path.endswith(ALICE)
            return httpx.Response(200, json={"id": 7, "jellyfinUserId": ALICE, "permissions": 32})
        assert req.headers["X-API-User"] == "7"
        if req.url.path.endswith("/movie/10"):
            return httpx.Response(200, json={"title": "A movie", "mediaInfo": {"status": 1}})
        if req.url.path.endswith("/request"):
            assert __import__("json").loads(req.content) == {"mediaType": "movie", "mediaId": 10}
            return httpx.Response(201, json={"id": 25, "status": 1})
        raise AssertionError(req.url)
    install_seerr_mock(monkeypatch, handler)
    result = request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10})
    assert result.status_code == 200
    assert result.json() == {"ok": True, "status": "pending", "request_id": 25}
    assert "private-seerr-key" not in result.text
    assert request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10, "userId": 1}).status_code == 422
    assert request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10, "ignoreQuota": True}).status_code == 422


def test_unlinked_account_and_mismatched_mapping_cannot_submit(application, monkeypatch):
    module, _ = application
    def handler(req):
        if "/user/jellyfin/" in req.url.path:
            return httpx.Response(404, json={})
        if req.url.path.endswith("/user"):
            return httpx.Response(200, json={"results": [{"id": 1, "jellyfinUserId": BOB}]})
        raise AssertionError("An unlinked account reached a request endpoint")
    install_seerr_mock(monkeypatch, handler)
    result = request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10})
    assert result.status_code == 409
    def wrong(req):
        return httpx.Response(200, json={"id": 1, "jellyfinUserId": BOB})
    install_seerr_mock(monkeypatch, wrong)
    assert request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10}).status_code == 403


@pytest.mark.parametrize("status", [2, 3, 5, 6])
def test_movie_duplicate_available_and_blocklisted_never_post(application, monkeypatch, status):
    module, _ = application
    async def seerr(path, seerr_user=None, method="GET", **kwargs):
        assert method == "GET"
        if path.startswith("/user/jellyfin/"):
            return {"id": 7, "jellyfinUserId": ALICE}
        return {"mediaInfo": {"status": status}}
    monkeypatch.setattr(module.discovery, "seerr", seerr)
    assert request(module, "/api/seerr/request", "POST", {"media_type": "movie", "media_id": 10}).status_code == 409


def test_series_only_sends_chosen_missing_seasons(application, monkeypatch):
    module, _ = application
    submitted = []
    async def seerr(path, seerr_user=None, method="GET", body=None, **kwargs):
        if path.startswith("/user/jellyfin/"):
            return {"id": 7, "jellyfinUserId": ALICE}
        if path == "/settings/public":
            return {"partialRequestsEnabled": True}
        if method == "POST":
            submitted.append(body)
            assert seerr_user == 7
            return {"id": 8, "status": 2}
        return {"seasons": [{"seasonNumber": n, "episodeCount": 10} for n in [0, 1, 2, 3]],
                "mediaInfo": {"status": 4, "seasons": [{"seasonNumber": 1, "status": 5}],
                              "requests": [{"status": 1, "seasons": [{"seasonNumber": 2}]}]}}
    monkeypatch.setattr(module.discovery, "seerr", seerr)
    for selection in ([], [0], [1], [2], [99], [1, 3]):
        result = request(module, "/api/seerr/request", "POST", {"media_type": "tv", "media_id": 20, "seasons": selection})
        assert result.status_code == 409
    result = request(module, "/api/seerr/request", "POST", {"media_type": "tv", "media_id": 20, "seasons": [3, 3]})
    assert result.status_code == 200
    assert submitted == [{"mediaType": "tv", "mediaId": 20, "seasons": [3]}]
    assert result.json()["status"] == "processing"


def test_concurrent_clicks_create_one_request(application, monkeypatch):
    module, _ = application
    posted = []
    async def seerr(path, seerr_user=None, method="GET", body=None, **kwargs):
        if path.startswith("/user/jellyfin/"):
            return {"id": 7, "jellyfinUserId": ALICE}
        if method == "POST":
            await asyncio.sleep(0)
            posted.append(body)
            return {"id": 1, "status": 1}
        return {"mediaInfo": {"status": 2 if posted else 1}}
    monkeypatch.setattr(module.discovery, "seerr", seerr)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url="http://test") as client:
            client.cookies.set(module.COOKIE, module.signer.dumps({"id": ALICE, "name": "Alice", "admin": False}))
            return await asyncio.gather(*(client.post("/api/seerr/request", json={"media_type": "movie", "media_id": 10}) for _ in range(2)))
    results = asyncio.run(run())
    assert sorted(r.status_code for r in results) == [200, 409]
    assert len(posted) == 1


def test_partial_request_setting_is_enforced_server_side(application, monkeypatch):
    module, _ = application
    async def seerr(path, seerr_user=None, method="GET", **kwargs):
        if path.startswith("/user/jellyfin/"):
            return {"id": 7, "jellyfinUserId": ALICE}
        if path == "/settings/public":
            return {"partialRequestsEnabled": False}
        assert method == "GET"
        return {"seasons": [{"seasonNumber": n, "episodeCount": 10} for n in [1, 2]]}
    monkeypatch.setattr(module.discovery, "seerr", seerr)
    assert request(module, "/api/seerr/request", "POST", {"media_type": "tv", "media_id": 20, "seasons": [1]}).status_code == 400


def test_upstream_quota_and_outage_are_actionable_without_leaking_secrets(application, monkeypatch):
    _, service = application
    def quota(req):
        return httpx.Response(403, json={"message": "Movie Quota exceeded."})
    install_seerr_mock(monkeypatch, quota)
    with pytest.raises(HTTPException) as error:
        asyncio.run(service.seerr("/request", 7, method="POST", body={}))
    assert "limit" in error.value.detail
    assert "private-seerr-key" not in error.value.detail


def test_connection_file_overrides_and_secrets_stay_server_side(application, monkeypatch, tmp_path):
    import json
    module, _ = application
    path = tmp_path / "seerr.json"
    path.write_text(json.dumps({"url": "http://seerr:5055", "key": "file-key", "public_url": "javascript:bad"}))
    monkeypatch.setenv("SEERR_CONNECTION_FILE", str(path))
    monkeypatch.delenv("SEERR_API_KEY")
    monkeypatch.delenv("SEERR_PUBLIC_URL")
    assert rec.connection_config()["key"] == "file-key"
    assert rec.connection_config()["public_url"] == ""


def test_external_discovery_uses_favourites_and_has_correct_metadata(application, monkeypatch):
    _, service = application
    pref = profiles()
    pref[ALICE]["titles"]["movie:10"] = 9
    pref[ALICE]["rating_count"] = 1
    media = candidate(media_id=10, item_id=MOVIE)
    observed = []
    async def seerr(path, seerr_user=None, **kwargs):
        observed.append(path)
        assert seerr_user == 7
        if path.endswith("/recommendations") or path.startswith("/discover/"):
            return {"results": [{"id": 99, "mediaType": "movie", "title": "Discovery", "genreIds": [35], "voteAverage": 8}]}
        return {"id": 99, "title": "Discovery", "releaseDate": "2025-01-01", "runtime": 95,
                "genres": [{"name": "Comedy"}], "posterPath": "/poster.jpg", "voteAverage": 8,
                "imdbId": "tt1234567", "credits": {"cast": [], "crew": []}, "mediaInfo": {"status": 1}}
    monkeypatch.setattr(service, "seerr", seerr)
    result = asyncio.run(service.external_candidates({MOVIE: media}, pref, VIEWERS, 7, rec.PickFilters(mode="discover")))
    assert "/movie/10/recommendations" in observed
    assert result[0]["sources"][0]["score"] == 9
    assert result[0]["poster"] == "https://image.tmdb.org/t/p/w500/poster.jpg"
    assert result[0]["runtime_minutes"] == 95
    assert result[0]["status"] == "missing"
