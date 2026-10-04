import json
import sqlite3
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SAMPLE_GAP_SECONDS = 45
POLL_GAP_SECONDS = 15
RUN_GAP_SECONDS = 15


@contextmanager
def connect(path):
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout=15000")
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize(path, timestamp=None):
    with connect(path) as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.executescript("""
            CREATE TABLE IF NOT EXISTS playback_runs (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL, user_name TEXT NOT NULL,
                item_id TEXT NOT NULL, item_type TEXT NOT NULL, item_name TEXT NOT NULL,
                series_name TEXT, series_id TEXT, runtime_s REAL NOT NULL,
                client TEXT, device TEXT, started_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS playback_snapshots (
                session_key TEXT PRIMARY KEY, run_id TEXT NOT NULL,
                observed_at REAL NOT NULL, payload TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS watch_intervals (
                id INTEGER PRIMARY KEY, run_id TEXT NOT NULL,
                started_at REAL NOT NULL, ended_at REAL NOT NULL,
                position_start REAL NOT NULL, position_end REAL NOT NULL,
                CHECK (ended_at > started_at));
            CREATE TABLE IF NOT EXISTS verified_completions (
                run_id TEXT PRIMARY KEY, completed_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS tracking_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS idx_watch_time ON watch_intervals(started_at, ended_at);
            CREATE INDEX IF NOT EXISTS idx_watch_run ON watch_intervals(run_id);
            CREATE INDEX IF NOT EXISTS idx_verified_time ON verified_completions(completed_at);
        """)
        c.execute("INSERT OR IGNORE INTO tracking_metadata VALUES ('since', ?)",
                  (str(timestamp if timestamp is not None else datetime.now(timezone.utc).timestamp()),))


def normalized(value):
    return str(value or "").replace("-", "").lower()


def parse_timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, AttributeError, TypeError):
        return None


def merge_intervals(intervals, gap=0):
    merged = []
    for start, end in sorted(intervals):
        if end <= start:
            continue
        if merged and start <= merged[-1][1] + gap:
            merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
        else:
            merged.append((start, end))
    return merged


def coverage(c, run_id):
    ranges = c.execute("SELECT position_start, position_end FROM watch_intervals WHERE run_id=?", (run_id,))
    return sum(end - start for start, end in merge_intervals([(r[0], r[1]) for r in ranges]))


def observe(path, sessions, timestamp):
    active = set()
    with connect(path) as c:
        for session in sessions:
            item = session.get("NowPlayingItem") or {}
            state = session.get("PlayState") or {}
            uid = normalized(session.get("UserId"))
            if not session.get("Id") or not uid or item.get("Type") not in ("Movie", "Episode"):
                continue
            iid = normalized(item.get("Id"))
            if not iid:
                continue
            key = str(session["Id"]) + ":" + uid
            active.add(key)
            position = max(0, (state.get("PositionTicks") or 0) / 10_000_000)
            runtime = max(0, (item.get("RunTimeTicks") or 0) / 10_000_000)
            position = min(position, runtime) if runtime else position
            checkin = parse_timestamp(session.get("LastPlaybackCheckIn"))
            fresh = checkin is not None and -5 <= timestamp - checkin <= 30
            current = {"item_id": iid, "position": position, "paused": bool(state.get("IsPaused")),
                       "fresh": fresh, "playlist_id": session.get("PlaylistItemId"), "last_observed_at": timestamp}
            previous = c.execute("SELECT * FROM playback_snapshots WHERE session_key=?", (key,)).fetchone()
            previous_data = json.loads(previous["payload"]) if previous else None
            same = previous_data and previous_data["item_id"] == iid
            if same and current["playlist_id"] and previous_data.get("playlist_id"):
                same = current["playlist_id"] == previous_data["playlist_id"]
            if same:
                completed = c.execute("SELECT 1 FROM verified_completions WHERE run_id=?", (previous["run_id"],)).fetchone()
                if completed and position <= 5 and previous_data["position"] > 30:
                    same = False
            if same:
                run_id = previous["run_id"]
                elapsed = timestamp - previous["observed_at"]
                delta = position - previous_data["position"]
                uninterrupted = timestamp - previous_data.get("last_observed_at", previous["observed_at"]) <= POLL_GAP_SECONDS
                if (0 < elapsed <= SAMPLE_GAP_SECONDS and 0 < delta <= elapsed * 1.5 + 1
                        and uninterrupted and fresh and previous_data["fresh"]
                        and not current["paused"] and not previous_data["paused"]):
                    credited = min(delta, elapsed)
                    c.execute("INSERT INTO watch_intervals(run_id,started_at,ended_at,position_start,position_end) "
                              "VALUES (?,?,?,?,?)", (run_id, timestamp - credited, timestamp,
                                                    position - credited, position))
                    if not completed and runtime > 0 and coverage(c, run_id) >= runtime * 0.9:
                        c.execute("INSERT OR IGNORE INTO verified_completions VALUES (?,?)", (run_id, timestamp))
            else:
                run_id = uuid.uuid4().hex
                c.execute("INSERT INTO playback_runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                    run_id, uid, session.get("UserName") or "Unknown viewer", iid, item["Type"],
                    item.get("Name") or "Untitled", item.get("SeriesName"), normalized(item.get("SeriesId")),
                    runtime, session.get("Client"), session.get("DeviceName"), timestamp))
            anchor = timestamp
            if (same and position == previous_data["position"] and fresh and previous_data["fresh"]
                    and not current["paused"] and not previous_data["paused"] and uninterrupted
                    and timestamp - previous["observed_at"] <= SAMPLE_GAP_SECONDS):
                anchor = previous["observed_at"]
            c.execute("INSERT OR REPLACE INTO playback_snapshots VALUES (?,?,?,?)",
                      (key, run_id, anchor, json.dumps(current)))
        keys = [r[0] for r in c.execute("SELECT session_key FROM playback_snapshots")]
        for key in keys:
            if key not in active:
                c.execute("DELETE FROM playback_snapshots WHERE session_key=?", (key,))
        c.execute("INSERT OR REPLACE INTO tracking_metadata VALUES ('last_sample', ?)", (str(timestamp),))


def mark_gap(path):
    with connect(path) as c:
        for row in c.execute("SELECT session_key, payload FROM playback_snapshots").fetchall():
            payload = json.loads(row["payload"])
            payload["fresh"] = False
            c.execute("UPDATE playback_snapshots SET payload=? WHERE session_key=?", (json.dumps(payload), row["session_key"]))


def date_window(start=None, end=None, tz="UTC", now=None):
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Choose a valid IANA timezone") from None
    today = (now or datetime.now(timezone.utc)).astimezone(zone).date()
    try:
        first = date.fromisoformat(start) if start else today.replace(day=1)
        last = date.fromisoformat(end) if end else today
    except ValueError:
        raise ValueError("Dates must use YYYY-MM-DD") from None
    if last < first:
        raise ValueError("End date must be on or after the start date")
    if (last - first).days > 365:
        raise ValueError("Choose a range of at most 366 days")
    try:
        lower = datetime.combine(first, time.min, zone).timestamp()
        upper = datetime.combine(last + timedelta(days=1), time.min, zone).timestamp()
    except (OverflowError, OSError):
        raise ValueError("Choose dates within the supported calendar") from None
    return first, last, zone, lower, upper


def split_days(intervals, zone):
    days = defaultdict(float)
    for start, end in intervals:
        cursor = start
        while cursor < end:
            local_date = datetime.fromtimestamp(cursor, zone).date()
            midnight = datetime.combine(local_date + timedelta(days=1), time.min, zone).timestamp()
            stop = min(end, midnight)
            days[local_date.isoformat()] += stop - cursor
            cursor = stop
    return days


def longest_run(intervals):
    best = current = 0
    previous_end = None
    for start, end in intervals:
        current = current + end - start if previous_end is not None and start - previous_end <= RUN_GAP_SECONDS else end - start
        best = max(best, current)
        previous_end = end
    return best


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def analytics(path, start=None, end=None, tz="UTC", now=None):
    first, last, zone, lower, upper = date_window(start, end, tz, now)
    with connect(path) as c:
        intervals = [dict(r) for r in c.execute("""
            SELECT w.*, r.user_id, r.user_name, r.item_id, r.item_name, r.item_type,
                   r.series_name, r.series_id, r.client, r.device
            FROM watch_intervals w JOIN playback_runs r ON r.id=w.run_id
            WHERE w.started_at < ? AND w.ended_at > ? ORDER BY w.started_at
        """, (upper, lower))]
        completions = [dict(r) for r in c.execute("""
            SELECT r.*, v.completed_at FROM verified_completions v
            JOIN playback_runs r ON r.id=v.run_id
            WHERE v.completed_at >= ? AND v.completed_at < ? ORDER BY v.completed_at DESC
        """, (lower, upper))]
        metadata = dict(c.execute("SELECT key, value FROM tracking_metadata"))
    users = {}
    by_user = defaultdict(list)
    by_type = defaultdict(list)
    by_title = {}
    for row in intervals:
        uid = row["user_id"]
        users.setdefault(uid, {"user_id": uid, "user_name": row["user_name"], "episodes": 0, "movies": 0})
        clipped = (max(lower, row["started_at"]), min(upper, row["ended_at"]))
        by_user[uid].append(clipped)
        by_type[(uid, row["item_type"])].append(clipped)
        title_key = row["series_id"] or row["item_id"]
        title = by_title.setdefault(title_key, {"item_id": title_key, "item_name": row["series_name"] or row["item_name"],
                                               "item_type": "Series" if row["series_id"] else row["item_type"], "intervals": defaultdict(list)})
        title["intervals"][uid].append(clipped)
    for row in completions:
        user = users.setdefault(row["user_id"], {"user_id": row["user_id"], "user_name": row["user_name"], "episodes": 0, "movies": 0})
        user["episodes" if row["item_type"] == "Episode" else "movies"] += 1
    daily = { (first + timedelta(days=i)).isoformat(): {"date": (first + timedelta(days=i)).isoformat(), "seconds": 0, "episodes": 0, "movies": 0, "users": {}}
              for i in range((last - first).days + 1)}
    for uid, user in users.items():
        merged = merge_intervals(by_user[uid])
        days = split_days(merged, zone)
        user.update(seconds=round(sum(b - a for a, b in merged), 2), peak_day_seconds=round(max(days.values(), default=0), 2),
                    peak_day=max(days, key=days.get) if days else None, consecutive_seconds=round(longest_run(merged), 2),
                    active_days=len(days))
        for day, seconds in days.items():
            daily[day]["seconds"] += seconds
            daily[day]["users"][uid] = round(seconds, 2)
    for row in completions:
        day = datetime.fromtimestamp(row["completed_at"], zone).date().isoformat()
        daily[day]["episodes" if row["item_type"] == "Episode" else "movies"] += 1
    rows = sorted(users.values(), key=lambda r: (-r["seconds"], r["user_name"].casefold(), r["user_id"]))
    metrics = ("seconds", "peak_day_seconds", "consecutive_seconds", "episodes", "movies")
    leaders = {metric: [r["user_id"] for r in rows if r[metric] == max((u[metric] for u in rows), default=0) and r[metric] > 0]
               for metric in metrics}
    titles = []
    for title in by_title.values():
        title["seconds"] = round(sum(b - a for spans in title.pop("intervals").values() for a, b in merge_intervals(spans)), 2)
        titles.append(title)
    breakdown = {"Movie": 0.0, "Episode": 0.0}
    for uid in users:
        kinds = {kind: merge_intervals(by_type[(uid, kind)]) for kind in breakdown}
        boundaries = sorted({value for spans in kinds.values() for span in spans for value in span})
        for left, right in zip(boundaries, boundaries[1:]):
            active = [kind for kind, spans in kinds.items() if any(a <= left and b >= right for a, b in spans)]
            for kind in active:
                breakdown[kind] += (right - left) / len(active)
    breakdown = {kind: round(seconds, 2) for kind, seconds in breakdown.items()}
    return {"range": {"start": first.isoformat(), "end": last.isoformat(), "timezone": tz},
            "tracking": {"since": iso(float(metadata["since"])),
                         "last_sample": iso(float(metadata["last_sample"])) if metadata.get("last_sample") else None,
                         "source": "observed_playback", "sample_seconds": 5, "completion_coverage": 0.9,
                         "consecutive_gap_seconds": RUN_GAP_SECONDS},
            "users": rows, "leaders": leaders, "daily": list(daily.values()),
            "totals": {"seconds": round(sum(r["seconds"] for r in rows), 2), "episodes": sum(r["episodes"] for r in rows),
                       "movies": sum(r["movies"] for r in rows), "viewers": len(rows)},
            "breakdown": breakdown, "top_titles": sorted(titles, key=lambda r: -r["seconds"])[:8],
            "recent": [{**r, "at": iso(r["completed_at"])} for r in completions[:30]]}


def activity(path, start=None, end=None, tz="UTC", now=None):
    first, last, zone, lower, upper = date_window(start, end, tz, now)
    with connect(path) as c:
        rows = c.execute("""
            SELECT r.*, w.started_at AS interval_start, w.ended_at AS interval_end, v.completed_at FROM watch_intervals w
            JOIN playback_runs r ON r.id=w.run_id
            LEFT JOIN verified_completions v ON v.run_id=r.id
            WHERE w.started_at < ? AND w.ended_at > ? ORDER BY w.started_at DESC
        """, (upper, lower)).fetchall()
    runs = {}
    for row in rows:
        run = runs.setdefault(row["id"], {"id": row["id"], "user_id": row["user_id"], "user": row["user_name"],
                           "item_id": row["item_id"], "series_id": row["series_id"], "name": row["item_name"],
                           "series_name": row["series_name"], "type": row["item_type"], "device": row["device"],
                           "client": row["client"], "at": iso(min(upper, row["interval_end"])), "seconds": 0,
                           "completed": row["completed_at"] is not None and lower <= row["completed_at"] < upper})
        run["seconds"] += min(upper, row["interval_end"]) - max(lower, row["interval_start"])
    return [{**r, "seconds": round(r["seconds"], 2)} for r in list(runs.values())[:200]]
