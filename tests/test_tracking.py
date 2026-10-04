from datetime import datetime, timezone

import pytest

import tracking


@pytest.fixture
def database(tmp_path):
    path = str(tmp_path / "monitor.db")
    tracking.initialize(path, stamp("2026-10-01T00:00:00Z"))
    return path


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def session(at, position=0, paused=False, item="episode1", user="alice", sid="screen1", runtime=100, kind="Episode", checkin=None, playlist=None):
    return {"Id": sid, "UserId": user, "UserName": user.title(), "PlaylistItemId": playlist,
            "LastPlaybackCheckIn": tracking.iso(at if checkin is None else checkin),
            "NowPlayingItem": {"Id": item, "Name": "Rick and Morty", "Type": kind, "RunTimeTicks": runtime * 10_000_000},
            "PlayState": {"PositionTicks": position * 10_000_000, "IsPaused": paused}}


def report(database):
    return tracking.analytics(database, "2026-10-01", "2026-10-31")


def play(database, at, runtime=100, **kwargs):
    for position in range(0, runtime + 1, 5):
        tracking.observe(database, [session(at + position, position, runtime=runtime, **kwargs)], at + position)


def insert_run(database, uid, spans, kind="Episode", completion=None, name=None):
    run_id = uid + str(spans[0][0]) + kind
    with tracking.connect(database) as c:
        c.execute("INSERT INTO playback_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                  (run_id, uid, name or uid.title(), "item", kind, "Title", None, None, 600, "Web", "TV", spans[0][0]))
        for start, end in spans:
            c.execute("INSERT INTO watch_intervals(run_id,started_at,ended_at,position_start,position_end) VALUES (?,?,?,?,?)",
                      (run_id, start, end, 0, end - start))
        if completion is not None:
            c.execute("INSERT INTO verified_completions VALUES (?,?)", (run_id, completion))


def test_one_episode_is_one_completion_without_playcounts(database):
    at = stamp("2026-10-04T12:00:00Z")
    play(database, at)
    board = report(database)
    assert board["totals"] == {"seconds": 100, "episodes": 1, "movies": 0, "viewers": 1}
    assert board["users"][0]["consecutive_seconds"] == 100


def test_bulk_library_marks_never_create_time_or_completions(database):
    with tracking.connect(database) as c:
        c.execute("CREATE TABLE completions (runtime_s INTEGER)")
        c.executemany("INSERT INTO completions VALUES (?)", [(1200,)] * 26)
    tracking.observe(database, [], stamp("2026-10-04T12:00:00Z"))
    assert report(database)["totals"]["seconds"] == 0
    assert report(database)["totals"]["episodes"] == 0


def test_pause_seek_stale_checkin_and_outage_credit_nothing(database):
    at = stamp("2026-10-04T12:00:00Z")
    samples = [(0, 0, False), (5, 5, False), (10, 10, True), (15, 10, True),
               (20, 10, False), (25, 15, False), (30, 85, False), (35, 90, False)]
    for elapsed, position, paused in samples:
        tracking.observe(database, [session(at + elapsed, position, paused)], at + elapsed)
    tracking.observe(database, [session(at + 40, 95, checkin=at)], at + 40)
    tracking.observe(database, [session(at + 400, 100)], at + 400)
    board = report(database)
    assert board["totals"]["seconds"] == 15
    assert board["totals"]["episodes"] == 0


def test_duplicate_poll_and_rewind_do_not_double_coverage(database):
    at = stamp("2026-10-04T12:00:00Z")
    for i in range(11):
        tracking.observe(database, [session(at + i * 5, i * 5)], at + i * 5)
        tracking.observe(database, [session(at + i * 5, i * 5)], at + i * 5)
    for i in range(11):
        tracking.observe(database, [session(at + 55 + i * 5, i * 5)], at + 55 + i * 5)
    assert report(database)["totals"]["seconds"] == 100
    assert report(database)["totals"]["episodes"] == 0


def test_full_replay_counts_once_per_observed_playback(database):
    at = stamp("2026-10-04T12:00:00Z")
    play(database, at)
    play(database, at + 105)
    assert report(database)["totals"]["episodes"] == 2
    assert report(database)["totals"]["seconds"] == 200


def test_session_disappearance_and_item_switch_have_no_guessed_tail(database):
    at = stamp("2026-10-04T12:00:00Z")
    tracking.observe(database, [session(at)], at)
    tracking.observe(database, [session(at + 5, 5)], at + 5)
    tracking.observe(database, [session(at + 10, 5, item="other")], at + 10)
    tracking.observe(database, [], at + 15)
    assert report(database)["totals"]["seconds"] == 5


def test_restart_preserves_coverage_but_does_not_backfill(database):
    at = stamp("2026-10-04T12:00:00Z")
    for i in range(11):
        tracking.observe(database, [session(at + i * 5, i * 5)], at + i * 5)
    tracking.initialize(database)
    for i in range(11):
        tracking.observe(database, [session(at + 400 + i * 5, 50 + i * 5)], at + 400 + i * 5)
    assert report(database)["totals"]["seconds"] == 100
    assert report(database)["totals"]["episodes"] == 1
    assert report(database)["users"][0]["consecutive_seconds"] == 50


def test_unknown_runtime_tracks_time_but_never_completion(database):
    at = stamp("2026-10-04T12:00:00Z")
    tracking.observe(database, [session(at, runtime=0)], at)
    tracking.observe(database, [session(at + 5, 5, runtime=0)], at + 5)
    assert report(database)["totals"]["seconds"] == 5
    assert report(database)["totals"]["episodes"] == 0


def test_union_concurrency_peak_day_and_ties(database):
    at = stamp("2026-10-04T12:00:00Z")
    insert_run(database, "alice", [(at, at + 3600)])
    insert_run(database, "alice", [(at + 1800, at + 5400)], kind="Movie", completion=at + 5400)
    insert_run(database, "bob", [(at, at + 5400)])
    board = report(database)
    assert board["totals"]["seconds"] == 10800
    assert board["users"][0]["seconds"] == 5400
    assert board["users"][0]["peak_day_seconds"] == 5400
    assert board["users"][0]["consecutive_seconds"] == 5400
    assert board["leaders"]["seconds"] == ["alice", "bob"]
    assert board["leaders"]["movies"] == ["alice"]


def test_midnight_split_in_selected_timezone_and_month_clipping(database):
    at = stamp("2026-09-30T21:30:00Z")
    insert_run(database, "alice", [(at, at + 7200)])
    board = tracking.analytics(database, "2026-10-01", "2026-10-01", "Africa/Johannesburg")
    assert board["totals"]["seconds"] == 5400
    assert board["daily"][0]["seconds"] == 5400
    assert board["users"][0]["peak_day"] == "2026-10-01"


def test_dst_days_and_completion_exclusive_upper_bound(database):
    at = stamp("2026-11-01T04:00:00Z")
    insert_run(database, "alice", [(at, at + 25 * 3600)], completion=at + 25 * 3600)
    board = tracking.analytics(database, "2026-11-01", "2026-11-01", "America/New_York")
    assert board["totals"]["seconds"] == 25 * 3600
    assert board["totals"]["episodes"] == 0


def test_longest_run_counts_active_seconds_not_short_gaps(database):
    at = stamp("2026-10-04T12:00:00Z")
    insert_run(database, "alice", [(at, at + 100), (at + 110, at + 210), (at + 230, at + 400)])
    assert report(database)["users"][0]["consecutive_seconds"] == 200
    assert report(database)["totals"]["seconds"] == 370


@pytest.mark.parametrize("start,end,tz", [("bad", "2026-10-04", "UTC"), ("2026-10-05", "2026-10-04", "UTC"),
                                           ("2024-01-01", "2026-10-04", "UTC"), (None, None, "bad-zone")])
def test_invalid_ranges(database, start, end, tz):
    with pytest.raises(ValueError):
        tracking.analytics(database, start, end, tz)


def test_default_month_uses_requested_timezone(database):
    now = datetime(2026, 9, 30, 23, 0, tzinfo=timezone.utc)
    board = tracking.analytics(database, tz="Africa/Johannesburg", now=now)
    assert board["range"] == {"start": "2026-10-01", "end": "2026-10-01", "timezone": "Africa/Johannesburg"}


def test_measured_history_filters_and_preserves_completion(database):
    at = stamp("2026-10-04T12:00:00Z")
    play(database, at)
    rows = tracking.activity(database, "2026-10-04", "2026-10-04")
    assert len(rows) == 1
    assert rows[0]["completed"] is True
    assert rows[0]["seconds"] == 100
    assert tracking.activity(database, "2026-10-05", "2026-10-05") == []


def test_batched_client_checkins_are_measured_between_real_progress_samples(database):
    at = stamp("2026-10-04T12:00:00Z")
    for elapsed in range(0, 101, 5):
        position = elapsed // 10 * 10
        tracking.observe(database, [session(at + elapsed, position)], at + elapsed)
    assert report(database)["totals"]["seconds"] == 100
    assert report(database)["totals"]["episodes"] == 1


def test_slow_client_checkins_do_not_invent_idle_watch_time(database):
    at = stamp("2026-10-04T12:00:00Z")
    for elapsed in range(0, 101, 5):
        tracking.observe(database, [session(at + elapsed, 0)], at + elapsed)
    assert report(database)["totals"]["seconds"] == 0


def test_failure_breaks_sample_coverage_without_losing_the_run(database):
    at = stamp("2026-10-04T12:00:00Z")
    tracking.observe(database, [session(at, 0)], at)
    tracking.observe(database, [session(at + 5, 5)], at + 5)
    tracking.mark_gap(database)
    tracking.observe(database, [session(at + 15, 15)], at + 15)
    tracking.observe(database, [session(at + 20, 20)], at + 20)
    assert report(database)["totals"]["seconds"] == 10
    with tracking.connect(database) as c:
        assert c.execute("SELECT COUNT(*) FROM playback_runs").fetchone()[0] == 1


def test_breakdown_reconciles_concurrent_movies_and_episodes(database):
    at = stamp("2026-10-04T12:00:00Z")
    insert_run(database, "alice", [(at, at + 3600)])
    insert_run(database, "alice", [(at + 1800, at + 5400)], kind="Movie")
    board = report(database)
    assert board["breakdown"] == {"Movie": 2700, "Episode": 2700}
    assert sum(board["breakdown"].values()) == board["totals"]["seconds"]
