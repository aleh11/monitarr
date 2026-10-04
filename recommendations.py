import asyncio
import hashlib
import json
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

import tracking

FIELDS = "Genres,People,Overview,ProviderIds,RecursiveItemCount"
GENRES = {28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
          99: "Documentary", 18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History",
          27: "Horror", 10402: "Music", 9648: "Mystery", 10749: "Romance",
          878: "Science Fiction", 53: "Thriller", 10752: "War", 37: "Western",
          10759: "Action & Adventure", 10765: "Sci-Fi & Fantasy", 10762: "Kids",
          10763: "News", 10764: "Reality", 10766: "Soap", 10767: "Talk", 10768: "War & Politics"}
MOODS = {"any": set(), "light": {"comedy", "family", "animation"},
         "edge": {"thriller", "horror", "crime", "mystery"},
         "escape": {"science fiction", "fantasy", "adventure", "action"},
         "thoughtful": {"drama", "documentary", "history"}}
MOOD_NAMES = {"any": "Any mood", "light": "Something light", "edge": "On the edge",
              "escape": "An escape", "thoughtful": "Something thoughtful"}
KEY_PATTERN = r"^(?:(?:movie|tv):[1-9][0-9]{0,9}|jf:[0-9a-f]{32})$"


def normalize(value):
    return str(value or "").replace("-", "").lower()


def genre_features(genres):
    out = set()
    for genre in genres:
        name = genre.lower().strip()
        if name in {"sci-fi", "science-fiction", "sci-fi & fantasy"}:
            out.update({"science fiction", "fantasy"})
        elif name == "action & adventure":
            out.update({"action", "adventure"})
        else:
            out.add(name)
    return out


def safe_url(value):
    parsed = urlparse(value or "")
    return value.rstrip("/") if parsed.scheme in {"http", "https"} and parsed.netloc and not parsed.username else ""


def connection_config():
    try:
        saved = json.loads(Path(os.environ.get("SEERR_CONNECTION_FILE", "/data/seerr-connection.json")).read_text())
    except (OSError, ValueError):
        saved = {}
    return {"url": safe_url(os.environ.get("SEERR_URL", saved.get("url", "http://seerr:5055"))),
            "key": os.environ.get("SEERR_API_KEY", saved.get("key", "")),
            "public_url": safe_url(os.environ.get("SEERR_PUBLIC_URL", saved.get("public_url", ""))),
            "jellyfin_url": safe_url(os.environ.get("JELLYFIN_PUBLIC_URL", saved.get("jellyfin_url", "")))}


def initialize(path):
    with tracking.connect(path) as c:
        c.execute("""CREATE TABLE IF NOT EXISTS recommendation_feedback (
            user_id TEXT NOT NULL, media_key TEXT NOT NULL, action TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY (user_id, media_key),
            CHECK(action IN ('not_interested', 'seen')))""")


class PickFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["tonight", "discover"] = "tonight"
    viewers: list[str] = Field(default_factory=list, max_length=4)
    max_minutes: int | None = Field(default=120, ge=10, le=360)
    media_type: Literal["all", "movie", "tv"] = "all"
    genre: str = Field(default="any", max_length=50)
    mood: Literal["any", "light", "edge", "escape", "thoughtful"] = "any"
    unseen: bool = True
    variation: int = Field(default=0, ge=0, le=10000)


class Feedback(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=KEY_PATTERN)
    action: Literal["not_interested", "seen"] | None


class MediaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    media_type: Literal["movie", "tv"]
    media_id: int = Field(gt=0, le=2_147_483_647)
    seasons: list[int] = Field(default_factory=list, max_length=100)


def library_media(item):
    media_type = "movie" if item.get("Type") == "Movie" else "tv"
    provider_ids = item.get("ProviderIds") or {}
    raw_tmdb = provider_ids.get("Tmdb") or provider_ids.get("TMDb")
    tmdb = int(raw_tmdb) if str(raw_tmdb).isdigit() and int(raw_tmdb) > 0 else None
    iid = normalize(item["Id"])
    people = item.get("People") or []
    return {"key": f"{media_type}:{tmdb}" if tmdb else f"jf:{iid}", "item_id": iid,
            "media_type": media_type, "media_id": tmdb, "name": item.get("Name") or "Untitled",
            "year": item.get("ProductionYear"), "genres": item.get("Genres") or [],
            "overview": item.get("Overview") or "", "runtime_minutes": (item.get("RunTimeTicks") or 0) / 600_000_000 or None,
            "cast": [p["Name"] for p in people if p.get("Type") == "Actor" and p.get("Name")][:8],
            "directors": [p["Name"] for p in people if p.get("Type") == "Director" and p.get("Name")],
            "community_rating": item.get("CommunityRating"), "imdb_id": provider_ids.get("Imdb"),
            "poster": f"/api/img/{iid}", "status": "available", "sources": [],
            "_raw": item}


def build_profiles(viewers, ratings, completed, metadata):
    profiles = {u["id"]: {"genres": defaultdict(float), "people": defaultdict(float),
                          "titles": {}, "rating_count": 0, "completed_count": 0} for u in viewers}
    grouped = defaultdict(list)
    for row in ratings:
        iid = normalize(row.get("series_id") or row["item_id"])
        if row["user_id"] in profiles and iid in metadata:
            grouped[(row["user_id"], iid)].append(row["score"])
    for (uid, iid), scores in grouped.items():
        profile = profiles[uid]
        score = sum(scores) / len(scores)
        profile["titles"][metadata[iid]["key"]] = score
        profile["rating_count"] += 1
        add_affinity(profile, metadata[iid], (score - 6) * 1.5)
    completion_affinity = {uid: {"genres": defaultdict(float), "people": defaultdict(float)} for uid in profiles}
    for uid, iid in set(completed):
        if uid in profiles and iid in metadata and (uid, iid) not in grouped:
            profiles[uid]["completed_count"] += 1
            add_affinity(completion_affinity[uid], metadata[iid], 0.6)
    for uid, affinity in completion_affinity.items():
        for genre, value in affinity["genres"].items():
            profiles[uid]["genres"][genre] += min(0.75, value)
        for person, value in affinity["people"].items():
            profiles[uid]["people"][person] += min(0.25, value)
    return profiles


def add_affinity(profile, media, weight):
    genres = genre_features(media["genres"])
    for genre in genres:
        profile["genres"][genre] += weight / max(1, len(genres))
    for name in media.get("cast", []):
        profile["people"][name.lower()] += weight * 0.35
    for name in media.get("directors", []):
        profile["people"][name.lower()] += weight * 0.7


def rank_candidates(candidates, viewers, profiles, filters, feedback, watched, votes):
    ranked = []
    for source in candidates:
        media = dict(source)
        key = media["key"]
        if filters.media_type != "all" and media["media_type"] != filters.media_type:
            continue
        genres = genre_features(media["genres"])
        if filters.genre != "any" and not genres.intersection(genre_features([filters.genre])):
            continue
        if MOODS[filters.mood] and not genres.intersection(MOODS[filters.mood]):
            continue
        runtime = media.get("runtime_minutes")
        if filters.max_minutes is not None and (not runtime or runtime > filters.max_minutes):
            continue
        actions = [feedback.get((u["id"], key)) for u in viewers]
        if "not_interested" in actions:
            continue
        seen = any((u["id"], key) in watched or action == "seen" for u, action in zip(viewers, actions))
        if filters.unseen and seen:
            continue
        scores, reasons = [], []
        for viewer in viewers:
            profile = profiles[viewer["id"]]
            positive = sorted(((g, min(6, profile["genres"].get(g, 0))) for g in genres), key=lambda p: -p[1])
            genre_score = sum(max(-6, min(6, profile["genres"].get(g, 0))) for g in genres) / max(1, len(genres))
            people = media.get("cast", []) + media.get("directors", [])
            person_scores = [(name, max(-4, min(4, profile["people"].get(name.lower(), 0)))) for name in people]
            person_score = sum(value for _, value in person_scores) / max(1, len(person_scores))
            score = genre_score + person_score
            direct = profile["titles"].get(key)
            if direct is not None:
                score += (direct - 6) * 1.5
            if any(s["user_id"] == viewer["id"] for s in media.get("sources", [])):
                score += 2
                seed = next(s for s in media["sources"] if s["user_id"] == viewer["id"])
                reasons.append(f"Suggested alongside {seed['name']}, which {viewer['name']} rated {seed['score']:g}/10")
            elif positive and positive[0][1] >= 1:
                reasons.append(f"{positive[0][0].capitalize()} matches {viewer['name']}’s highly rated titles")
            elif any(value >= 1 for _, value in person_scores):
                name = max(person_scores, key=lambda p: p[1])[0]
                reasons.append(f"Features {name}, a favourite in {viewer['name']}’s ratings")
            scores.append(score)
        taste = 0.6 * sum(scores) / len(scores) + 0.4 * min(scores)
        quality = (media.get("community_rating") or 6) * 0.15
        score = taste + quality + (0 if seen else 1)
        if votes.get(key, set()).intersection(u["id"] for u in viewers):
            score += 1.5
            reasons.append("Already on your circle’s watchlist")
        if not reasons:
            reasons.append("A starting pick based on your filters; rate more titles to personalise it")
        if filters.unseen:
            reasons.append("No selected viewer has marked this title watched")
        if runtime and filters.max_minutes is not None:
            reasons.append(f"{int(round(runtime))} minutes fits your {filters.max_minutes}-minute window")
        variation = int(hashlib.sha256(f"{key}:{filters.variation}".encode()).hexdigest()[:8], 16) / 0xffffffff
        media["reasons"] = reasons[:5]
        media["seen"] = seen
        media["_score"] = score + (variation * 1.5 if filters.variation else variation * 0.001)
        ranked.append(media)
    ranked.sort(key=lambda media: -media["_score"])
    return ranked


class Discovery:
    def __init__(self, jellyfin, db_path):
        self.jellyfin = jellyfin
        self.db_path = db_path
        self.cache = {}
        self.inflight = {}
        self.locks = {}
        self.limit = asyncio.Semaphore(6)

    async def cached(self, key, load, ttl=300):
        cached = self.cache.get(key)
        if cached and cached[0] > time.monotonic():
            return cached[1]
        if key not in self.inflight:
            self.inflight[key] = asyncio.create_task(load())
        task = self.inflight[key]
        try:
            value = await asyncio.shield(task)
            if len(self.cache) >= 512:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = (time.monotonic() + ttl, value)
            return value
        finally:
            if task.done():
                self.inflight.pop(key, None)

    async def jf_get(self, path, params=None):
        async with self.limit:
            try:
                result = await self.jellyfin().get(path, params=params)
                result.raise_for_status()
                return result.json()
            except (httpx.HTTPError, ValueError) as error:
                raise HTTPException(502, "Unable to load Jellyfin’s library. Please try again.") from error

    async def viewers(self, requested, caller):
        data = await self.jf_get("/Users")
        enabled = {normalize(u["Id"]): {"id": normalize(u["Id"]), "name": u["Name"]}
                   for u in data if not (u.get("Policy") or {}).get("IsDisabled")}
        selected = list(dict.fromkeys(normalize(uid) for uid in (requested or [caller["id"]])))
        caller_id = normalize(caller["id"])
        selected = [caller_id] + [uid for uid in selected if uid != caller_id]
        if len(selected) > 4 or any(uid not in enabled for uid in selected):
            raise HTTPException(400, "Choose up to four active viewers, including yourself")
        return [enabled[uid] for uid in selected], list(enabled.values())

    async def catalog(self, uid):
        async def load():
            items = []
            for start in range(0, 10000, 500):
                data = await self.jf_get(f"/Users/{uid}/Items", {"Recursive": "true", "IncludeItemTypes": "Movie,Series",
                    "Fields": FIELDS, "EnableUserData": "true", "StartIndex": start, "Limit": 500,
                    "SortBy": "DateCreated", "SortOrder": "Descending"})
                batch = data.get("Items", [])
                items.extend(batch)
                if len(batch) < 500 or len(items) >= data.get("TotalRecordCount", 10000):
                    break
            return {normalize(it["Id"]): library_media(it) for it in items}
        return await self.cached(("catalog", uid), load)

    async def seerr(self, path, seerr_user=None, method="GET", body=None, params=None, fresh=False):
        config = connection_config()
        if not config["key"] or not config["url"]:
            raise HTTPException(503, "Seerr is not connected yet. Library picks are still available.")
        headers = {"X-Api-Key": config["key"]}
        if seerr_user is not None:
            headers["X-API-User"] = str(seerr_user)
        async def load():
            async with self.limit:
                try:
                    async with httpx.AsyncClient(timeout=20) as client:
                        response = await client.request(method, f"{config['url']}/api/v1{path}",
                                                        headers=headers, json=body, params=params)
                except httpx.HTTPError as error:
                    raise HTTPException(502, "Seerr is unreachable. Try again shortly.") from error
                if response.status_code == 404:
                    raise HTTPException(404, "This account or title was not found in Seerr")
                if response.status_code in {400, 403, 409, 429}:
                    message = "Seerr did not allow this request. Check your request permissions and limits."
                    if method != "GET":
                        try:
                            text = str(response.json().get("message") or response.json().get("error") or "")
                        except ValueError:
                            text = ""
                        if "quota" in text.lower() or "limit" in text.lower():
                            message = "Your Seerr request limit has been reached. Try again when it resets."
                        elif "duplicate" in text.lower() or "already" in text.lower():
                            message = "This title or season is already requested. Refresh to see its status."
                    raise HTTPException(response.status_code, message)
                if not response.is_success:
                    raise HTTPException(502, "Seerr could not complete this request. Please try again.")
                try:
                    return response.json()
                except ValueError as error:
                    raise HTTPException(502, "Seerr returned an unreadable response") from error
        if method != "GET" or fresh:
            return await load()
        key = ("seerr", config["url"], hashlib.sha256(config["key"].encode()).hexdigest(), seerr_user, path, json.dumps(params, sort_keys=True))
        return await self.cached(key, load, ttl=120)

    async def account(self, caller):
        try:
            mapped = await self.seerr(f"/user/jellyfin/{normalize(caller['id'])}", fresh=True)
        except HTTPException as error:
            if error.status_code != 404:
                raise
            mapped = None
            for skip in range(0, 1000, 100):
                page = await self.seerr("/user", params={"take": 100, "skip": skip}, fresh=True)
                matches = [u for u in page.get("results", []) if normalize(u.get("jellyfinUserId")) == normalize(caller["id"])]
                if matches:
                    mapped = matches[0]
                    break
                if len(page.get("results", [])) < 100:
                    break
            if not mapped:
                raise HTTPException(409, "Sign into Seerr once with your Jellyfin account, then try again")
        if normalize(mapped.get("jellyfinUserId")) != normalize(caller["id"]) or not isinstance(mapped.get("id"), int) or mapped["id"] <= 0:
            raise HTTPException(403, "Seerr could not verify the linked Jellyfin account")
        return mapped

    async def integration(self, caller):
        config = connection_config()
        result = {"connected": False, "linked": False, "message": "", "public_url": config["public_url"],
                  "can_request_movie": False, "can_request_tv": False}
        if not config["key"]:
            result["message"] = "Connect Seerr to discover and request new titles. Library picks work now."
            return result
        try:
            account = await self.account(caller)
            permissions = account.get("permissions", 0)
            quota = await self.seerr(f"/user/{account['id']}/quota", account["id"], fresh=True)
            result.update(connected=True, linked=True,
                          can_request_movie=bool(permissions & (2 | 32 | 262144)) and not quota.get("movie", {}).get("restricted", False),
                          can_request_tv=bool(permissions & (2 | 32 | 524288)) and not quota.get("tv", {}).get("restricted", False))
            result["message"] = "Requests follow your Seerr permissions and approval rules."
        except HTTPException as error:
            result["connected"] = error.status_code == 409
            result["message"] = error.detail
        return result

    def signals(self, viewers, metadata):
        with tracking.connect(self.db_path()) as c:
            ratings = [dict(row) for row in c.execute("SELECT * FROM ratings")]
            completed = [(r["user_id"], normalize(r["series_id"] or r["item_id"])) for r in c.execute(
                "SELECT r.user_id,r.item_id,r.series_id FROM verified_completions v JOIN playback_runs r ON r.id=v.run_id")]
            feedback = {(r["user_id"], r["media_key"]): r["action"] for r in c.execute("SELECT * FROM recommendation_feedback")}
            votes = defaultdict(set)
            for row in c.execute("SELECT * FROM watchlist_votes"):
                if row["item_id"] in metadata:
                    votes[metadata[row["item_id"]]["key"]].add(row["user_id"])
        return build_profiles(viewers, ratings, completed, metadata), feedback, votes

    async def episode(self, media, viewers):
        iid = media["item_id"]
        async def for_user(uid):
            data = await self.jf_get(f"/Shows/{iid}/Episodes", {"UserId": uid, "Fields": FIELDS,
                "IsMissing": "false", "EnableUserData": "true", "Limit": 100})
            return {normalize(it["Id"]): it for it in data.get("Items", []) if not it.get("IsVirtualItem") and (it.get("ParentIndexNumber") or 0) > 0}
        catalogs = await asyncio.gather(*(for_user(u["id"]) for u in viewers))
        common = set.intersection(*(set(c) for c in catalogs))
        episodes = [it for key, it in catalogs[0].items() if key in common]
        episodes.sort(key=lambda it: (any((c[normalize(it["Id"])].get("UserData") or {}).get("Played") for c in catalogs),
                                     it.get("ParentIndexNumber") or 0, it.get("IndexNumber") or 0))
        if not episodes:
            return None
        first = episodes[0]
        return {**media, "play_item_id": normalize(first["Id"]),
                "runtime_minutes": (first.get("RunTimeTicks") or 0) / 600_000_000 or None,
                "episode_label": f"S{first.get('ParentIndexNumber') or 1:02} E{first.get('IndexNumber') or 1:02} · {first.get('Name', '')}"}

    async def picks(self, filters, caller):
        viewers, _ = await self.viewers(filters.viewers, caller)
        catalogs = await asyncio.gather(*(self.catalog(u["id"]) for u in viewers))
        metadata = catalogs[0]
        common = set.intersection(*(set(c) for c in catalogs))
        profiles, feedback, votes = self.signals(viewers, metadata)
        watched = set()
        for viewer, catalog in zip(viewers, catalogs):
            for media in catalog.values():
                raw = media["_raw"]
                ud = raw.get("UserData") or {}
                count = raw.get("RecursiveItemCount") or 0
                if ud.get("Played") or (media["media_type"] == "tv" and count > (ud.get("UnplayedItemCount") if ud.get("UnplayedItemCount") is not None else count)):
                    watched.add((viewer["id"], media["key"]))
        for uid, profile in profiles.items():
            for key in profile["titles"]:
                watched.add((uid, key))
        with tracking.connect(self.db_path()) as c:
            for row in c.execute("SELECT r.user_id,r.item_id,r.series_id FROM verified_completions v JOIN playback_runs r ON r.id=v.run_id"):
                media = metadata.get(normalize(row["series_id"] or row["item_id"]))
                if media:
                    watched.add((row["user_id"], media["key"]))
        if filters.mode == "tonight":
            candidates = [metadata[key] for key in common]
            shortlist_filters = filters.model_copy(update={"max_minutes": None})
            preliminary = rank_candidates(candidates, viewers, profiles, shortlist_filters, feedback, watched, votes)
            movies = [m for m in preliminary if m["media_type"] == "movie"]
            shows = [m for m in preliminary if m["media_type"] == "tv"][:24]
            episodes = await asyncio.gather(*(self.episode(m, viewers) for m in shows), return_exceptions=True)
            candidates = movies + [m for m in episodes if isinstance(m, dict)]
            if not candidates and any(isinstance(m, HTTPException) for m in episodes):
                raise next(m for m in episodes if isinstance(m, HTTPException))
            candidates = [{**m, "play_item_id": m.get("play_item_id", m["item_id"])} for m in candidates]
            integration = None
        else:
            account = await self.account(caller)
            candidates = await self.external_candidates(metadata, profiles, viewers, account["id"], filters)
            local_keys = {m["key"] for m in metadata.values()}
            candidates = [m for m in candidates if (m["key"] not in local_keys or m["status"] == "partial") and m["status"] != "available"]
            integration = await self.integration(caller)
        ranked = rank_candidates(candidates, viewers, profiles, filters, feedback, watched, votes)
        config = connection_config()
        for media in ranked:
            play_id = media.get("play_item_id")
            media["watch_url"] = f"{config['jellyfin_url']}/web/index.html#!/details?id={play_id}" if play_id and config["jellyfin_url"] else None
            media["seerr_url"] = f"{config['public_url']}/{media['media_type']}/{media['media_id']}" if media.get("media_id") and config["public_url"] else None
            media["imdb_url"] = f"https://www.imdb.com/title/{media['imdb_id']}/" if re.fullmatch(r"tt[0-9]+", media.get("imdb_id") or "") else None
        return {"items": [{k: v for k, v in m.items() if not k.startswith("_") and k not in {"sources", "cast", "directors", "imdb_id"}} for m in ranked[:12]],
                "viewers": viewers, "integration": integration,
                "personalised": any(p["rating_count"] for p in profiles.values()),
                "message": "Ratings guide your picks; verified completions add a smaller signal. Mood uses genres.",
                "candidate_count": len(candidates), "library_limited": any(len(c) >= 10000 for c in catalogs)}

    async def external_candidates(self, metadata, profiles, viewers, account_id, filters):
        seeds = []
        for viewer in viewers:
            profile = profiles[viewer["id"]]
            favourites = sorted(profile["titles"].items(), key=lambda p: -p[1])
            for key, score in favourites:
                media = next((m for m in metadata.values() if m["key"] == key and m["media_id"]), None)
                if media and score >= 7:
                    seeds.append({**media, "user_id": viewer["id"], "score": score})
                    if sum(s["user_id"] == viewer["id"] for s in seeds) >= 2:
                        break
        tasks = [(f"/{s['media_type']}/{s['media_id']}/recommendations", s) for s in seeds]
        types = [filters.media_type] if filters.media_type != "all" else ["movie", "tv"]
        tasks.extend(("/discover/movies" if kind == "movie" else "/discover/tv", None) for kind in types)
        results = await asyncio.gather(*(self.seerr(path, account_id) for path, _ in tasks), return_exceptions=True)
        pool = {}
        for (path, seed), data in zip(tasks, results):
            if isinstance(data, Exception):
                continue
            for raw in data.get("results", [])[:20]:
                kind = raw.get("mediaType") or ("movie" if "/movies" in path else "tv")
                if kind not in {"movie", "tv"} or raw.get("adult"):
                    continue
                key = f"{kind}:{raw['id']}"
                entry = pool.setdefault(key, {"raw": raw, "sources": []})
                if seed:
                    entry["sources"].append(seed)
        if not pool and any(isinstance(r, Exception) for r in results):
            raise HTTPException(502, "Seerr’s catalogue could not be loaded. Please try again.")
        rough = []
        for key, entry in pool.items():
            raw = entry["raw"]
            rough.append({"key": key, "media_type": raw["mediaType"], "media_id": raw["id"],
                          "name": raw.get("title") or raw.get("name"),
                          "genres": [GENRES[g] for g in raw.get("genreIds", []) if g in GENRES],
                          "community_rating": raw.get("voteAverage"), "sources": entry["sources"], "status": "missing"})
        prefilters = filters.model_copy(update={"max_minutes": None, "unseen": False})
        rough = rank_candidates(rough, viewers, profiles, prefilters, {}, set(), {})[:32]
        results = await asyncio.gather(*(self.seerr(f"/{m['media_type']}/{m['media_id']}", account_id) for m in rough), return_exceptions=True)
        if rough and all(isinstance(result, Exception) for result in results):
            raise HTTPException(502, "Seerr could not load title details. Please try again.")
        out = []
        for media, detail in zip(rough, results):
            if isinstance(detail, Exception) or detail.get("adult"):
                continue
            info = detail.get("mediaInfo") or {}
            status = media_status(info)
            if status == "blocked":
                continue
            runtime = detail.get("runtime") if media["media_type"] == "movie" else next(iter(detail.get("episodeRunTime") or []), None)
            credits = detail.get("credits") or {}
            poster = detail.get("posterPath")
            media.update(name=detail.get("title") or detail.get("name") or media["name"],
                         year=int((detail.get("releaseDate") or detail.get("firstAirDate") or "0000")[:4]) or None,
                         overview=detail.get("overview") or "", genres=[g["name"] for g in detail.get("genres", [])],
                         runtime_minutes=runtime, poster=f"https://image.tmdb.org/t/p/w500{poster}" if poster and re.fullmatch(r"/[A-Za-z0-9_.-]+", poster) else None,
                         community_rating=detail.get("voteAverage"), imdb_id=detail.get("imdbId") or (detail.get("externalIds") or {}).get("imdbId"),
                         cast=[p["name"] for p in credits.get("cast", [])[:8]],
                         directors=[p["name"] for p in credits.get("crew", []) if p.get("job") == "Director"], status=status)
            out.append(media)
        return out


def media_status(info):
    status = info.get("status")
    requests = info.get("requests") or []
    if status not in {4, 5, 6} and requests:
        latest = max(requests, key=lambda r: r.get("id", 0))
        if latest.get("status") in {3, 4}:
            return "declined" if latest["status"] == 3 else "failed"
    return {2: "pending", 3: "processing", 4: "partial", 5: "available", 6: "blocked"}.get(status, "missing")


def season_choices(detail):
    info = detail.get("mediaInfo") or {}
    available = {s["seasonNumber"] for s in info.get("seasons", []) if s.get("status") == 5}
    requested = {s["seasonNumber"] for r in info.get("requests", []) if r.get("status") in {1, 2, 4}
                 for s in r.get("seasons", [])}
    return [{"number": s["seasonNumber"], "name": s.get("name") or f"Season {s['seasonNumber']}",
             "episodes": s.get("episodeCount") or 0,
             "status": "available" if s["seasonNumber"] in available else "requested" if s["seasonNumber"] in requested else "missing",
             "requestable": s["seasonNumber"] not in available | requested}
            for s in detail.get("seasons", []) if s.get("seasonNumber", 0) > 0 and s.get("episodeCount", 0) > 0]


def create_router(current_user, jellyfin, db_path):
    router = APIRouter(prefix="/api")
    service = Discovery(jellyfin, db_path)

    @router.get("/recommendations/options")
    async def options(response: Response, user=Depends(current_user)):
        response.headers["Cache-Control"] = "no-store"
        _, viewers = await service.viewers([], user)
        catalog, integration = await asyncio.gather(service.catalog(user["id"]), service.integration(user))
        return {"viewers": viewers, "genres": sorted({g for m in catalog.values() for g in m["genres"]}),
                "moods": [{"value": key, "name": name} for key, name in MOOD_NAMES.items()], "integration": integration}

    @router.post("/recommendations")
    async def picks(body: PickFilters, response: Response, user=Depends(current_user)):
        response.headers["Cache-Control"] = "no-store"
        return await service.picks(body, user)

    @router.post("/recommendations/feedback")
    async def feedback(body: Feedback, user=Depends(current_user)):
        with tracking.connect(db_path()) as c:
            if body.action is None:
                c.execute("DELETE FROM recommendation_feedback WHERE user_id=? AND media_key=?", (user["id"], body.key))
            else:
                c.execute("INSERT INTO recommendation_feedback VALUES (?,?,?,?) ON CONFLICT(user_id,media_key) "
                          "DO UPDATE SET action=excluded.action,updated_at=excluded.updated_at",
                          (user["id"], body.key, body.action, datetime.now(timezone.utc).isoformat()))
        return {"ok": True}

    @router.get("/seerr/{media_type}/{media_id}")
    async def details(media_type: Literal["movie", "tv"], media_id: int, response: Response, user=Depends(current_user)):
        if not 0 < media_id <= 2_147_483_647:
            raise HTTPException(400, "Invalid title")
        response.headers["Cache-Control"] = "no-store"
        account = await service.account(user)
        detail = await service.seerr(f"/{media_type}/{media_id}", account["id"], fresh=True)
        integration = await service.integration(user)
        public = await service.seerr("/settings/public", account["id"], fresh=True)
        return {"name": detail.get("title") or detail.get("name"), "status": media_status(detail.get("mediaInfo") or {}),
                "seasons": season_choices(detail) if media_type == "tv" else [],
                "partial_requests": public.get("partialRequestsEnabled", True),
                "can_request": integration[f"can_request_{media_type}"]}

    @router.post("/seerr/request")
    async def request(body: MediaRequest, response: Response, user=Depends(current_user)):
        response.headers["Cache-Control"] = "no-store"
        account = await service.account(user)
        lock_key = (body.media_type, body.media_id)
        lock = service.locks.setdefault(lock_key, asyncio.Lock())
        try:
            async with lock:
                detail = await service.seerr(f"/{body.media_type}/{body.media_id}", account["id"], fresh=True)
                info = detail.get("mediaInfo") or {}
                if info.get("status") in {5, 6}:
                    raise HTTPException(409, "This title is already available or cannot be requested")
                payload = {"mediaType": body.media_type, "mediaId": body.media_id}
                if body.media_type == "tv":
                    available = {s["number"] for s in season_choices(detail) if s["requestable"]}
                    selected = set(body.seasons)
                    if not selected or not selected.issubset(available):
                        raise HTTPException(409, "Choose seasons that are not already available or requested")
                    public = await service.seerr("/settings/public", account["id"], fresh=True)
                    if not public.get("partialRequestsEnabled", True) and selected != available:
                        raise HTTPException(400, "Seerr requires all missing seasons to be requested together")
                    payload["seasons"] = sorted(selected)
                elif body.seasons:
                    raise HTTPException(400, "Movies do not have seasons")
                elif info.get("status") in {2, 3} or any(r.get("status") in {1, 2, 4} for r in info.get("requests", [])):
                    raise HTTPException(409, "This movie is already requested. Refresh to see its status.")
                result = await service.seerr("/request", account["id"], method="POST", body=payload, fresh=True)
                service.cache = {k: v for k, v in service.cache.items() if k[0] != "seerr"}
                status = {1: "pending", 2: "processing", 3: "declined", 4: "failed", 5: "available"}.get(result.get("status"), "pending")
                return {"ok": True, "status": status, "request_id": result.get("id")}
        finally:
            if not lock.locked() and not getattr(lock, "_waiters", None):
                service.locks.pop(lock_key, None)

    return router, service
