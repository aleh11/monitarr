"""monitor — small dashboard for the media stack.

Reads Jellyfin (sessions, Playback Reporting history, per-user play counts),
keeps its own SQLite for ratings and the runtime leaderboard, and reports host
stats (disks, CPU, RAM, temps), container status and the Sonarr/Radarr queue.

Leaderboard rule: a finished movie/episode credits its full runtime to the
user who finished it. Tracking starts when the app first sees a user; anything
watched before that is baseline and never counts (no backlog).
"""
import asyncio
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field

JF_URL = os.environ.get("JELLYFIN_URL", "http://jellyfin:8096").rstrip("/")
JF_KEY = os.environ["JELLYFIN_API_KEY"]
SONARR_KEY = os.environ.get("SONARR_API_KEY", "")
RADARR_KEY = os.environ.get("RADARR_API_KEY", "")
DOCKER_URL = os.environ.get("DOCKER_URL", "http://docker-proxy:2375")
SECRET = os.environ["SESSION_SECRET"]
DB_PATH = os.environ.get("DB_PATH", "/data/monitor.db")
# label=path pairs; statvfs on a path reports the filesystem it lives on
DISKS = [d.split("=", 1) for d in os.environ.get("DISKS", "NVMe=/data").split(",") if "=" in d]
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
COOKIE = "monitor_session"
SESSION_DAYS = 30

STATIC = Path(__file__).parent / "static"
signer = URLSafeTimedSerializer(SECRET, salt="monitor-session")
jf = httpx.AsyncClient(base_url=JF_URL, headers={"Authorization": f'MediaBrowser Token="{JF_KEY}"'}, timeout=20)
http = httpx.AsyncClient(timeout=10)
cpu_state = {"pct": None}


# --------------------------------------------------------------------------- db
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS ratings (
            user_id TEXT, user_name TEXT, item_id TEXT, item_type TEXT,
            item_name TEXT, series_name TEXT, series_id TEXT, year INTEGER,
            score INTEGER NOT NULL, note TEXT, created_at TEXT, updated_at TEXT,
            PRIMARY KEY (user_id, item_id));
        CREATE TABLE IF NOT EXISTS playcounts (
            user_id TEXT, item_id TEXT, play_count INTEGER,
            PRIMARY KEY (user_id, item_id));
        CREATE TABLE IF NOT EXISTS tracked_users (user_id TEXT PRIMARY KEY, since TEXT);
        CREATE TABLE IF NOT EXISTS completions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, user_name TEXT,
            item_id TEXT, item_type TEXT, item_name TEXT, series_name TEXT,
            series_id TEXT, runtime_s INTEGER, at TEXT);
        CREATE TABLE IF NOT EXISTS disk_samples (ts INTEGER, label TEXT, used INTEGER, total INTEGER);
        CREATE INDEX IF NOT EXISTS idx_completions_at ON completions(at);
        CREATE INDEX IF NOT EXISTS idx_disk ON disk_samples(label, ts);
        """)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ------------------------------------------------------------------- jellyfin
def norm_id(i):
    return (i or "").replace("-", "").lower()


async def jf_users():
    r = await jf.get("/Users")
    r.raise_for_status()
    return r.json()


def item_info(it):
    return {
        "item_id": norm_id(it["Id"]),
        "item_type": it.get("Type"),
        "item_name": it.get("Name"),
        "series_name": it.get("SeriesName"),
        "series_id": norm_id(it.get("SeriesId")),
        "year": it.get("ProductionYear"),
        "season": it.get("ParentIndexNumber"),
        "episode": it.get("IndexNumber"),
        "runtime_s": int((it.get("RunTimeTicks") or 0) / 10_000_000),
    }


async def poll_completions():
    """Diff each user's per-item PlayCount against the last snapshot."""
    users = await jf_users()
    with db() as c:
        for u in users:
            uid = norm_id(u["Id"])
            r = await jf.get(f"/Users/{u['Id']}/Items", params={
                "Recursive": "true", "IncludeItemTypes": "Movie,Episode",
                "Filters": "IsPlayed", "EnableUserData": "true",
                "Fields": "RunTimeTicks,SeriesName,SeriesId,ProductionYear"})
            r.raise_for_status()
            items = r.json()["Items"]
            tracked = c.execute("SELECT 1 FROM tracked_users WHERE user_id=?", (uid,)).fetchone()
            known = {row["item_id"]: row["play_count"] for row in
                     c.execute("SELECT item_id, play_count FROM playcounts WHERE user_id=?", (uid,))}
            for it in items:
                iid = norm_id(it["Id"])
                count = (it.get("UserData") or {}).get("PlayCount") or 0
                prev = known.get(iid)
                if tracked:
                    new_plays = count - (prev or 0)
                    for _ in range(max(0, new_plays)):
                        info = item_info(it)
                        c.execute("""INSERT INTO completions (user_id,user_name,item_id,item_type,item_name,
                                     series_name,series_id,runtime_s,at) VALUES (?,?,?,?,?,?,?,?,?)""",
                                  (uid, u["Name"], iid, info["item_type"], info["item_name"],
                                   info["series_name"], info["series_id"], info["runtime_s"], now_iso()))
                if prev != count:
                    c.execute("INSERT OR REPLACE INTO playcounts VALUES (?,?,?)", (uid, iid, count))
            if not tracked:
                c.execute("INSERT INTO tracked_users VALUES (?,?)", (uid, now_iso()))


# ---------------------------------------------------------------- host stats
def read_cpu():
    with open("/proc/stat") as f:
        vals = list(map(int, f.readline().split()[1:]))
    idle = vals[3] + vals[4]
    return idle, sum(vals)


def disk_usage():
    out = []
    for label, path in DISKS:
        try:
            s = os.statvfs(path)
        except OSError:
            continue
        # ext4 reserves ~5% for root; leave it out so used + free = what we can use
        used = (s.f_blocks - s.f_bfree) * s.f_frsize
        free = s.f_bavail * s.f_frsize
        out.append({"label": label, "total": used + free, "free": free, "used": used})
    return out


def sample_disks():
    ts = int(time.time())
    with db() as c:
        for d in disk_usage():
            c.execute("INSERT INTO disk_samples VALUES (?,?,?,?)", (ts, d["label"], d["used"], d["total"]))
        c.execute("DELETE FROM disk_samples WHERE ts < ?", (ts - 60 * 86400,))


def days_to_full(label, free):
    """Linear growth over the last 14 days of samples; None if not growing."""
    with db() as c:
        rows = c.execute("SELECT ts, used FROM disk_samples WHERE label=? AND ts > ? ORDER BY ts",
                         (label, int(time.time()) - 14 * 86400)).fetchall()
    if len(rows) < 2 or rows[-1]["ts"] - rows[0]["ts"] < 6 * 3600:
        return None
    per_day = (rows[-1]["used"] - rows[0]["used"]) / ((rows[-1]["ts"] - rows[0]["ts"]) / 86400)
    return round(free / per_day) if per_day > 0 else None


def temps():
    out = {}
    for h in Path("/sys/class/hwmon").glob("hwmon*"):
        try:
            name = (h / "name").read_text().strip()
        except OSError:
            continue
        if name == "coretemp":
            for lbl in h.glob("temp*_label"):
                if lbl.read_text().startswith("Package"):
                    out["CPU"] = int((h / lbl.name.replace("label", "input")).read_text()) / 1000
        elif name in ("nvme", "drivetemp"):
            try:
                out["NVMe" if name == "nvme" else "SSD"] = int((h / "temp1_input").read_text()) / 1000
            except OSError:
                pass
    return out


def meminfo():
    m = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            m[k] = int(v.split()[0]) * 1024
    return {"total": m["MemTotal"], "available": m["MemAvailable"]}


# --------------------------------------------------------------- background
async def background():
    prev = read_cpu()
    last_poll = last_disk = 0
    while True:
        await asyncio.sleep(5)
        cur = read_cpu()
        d_total = cur[1] - prev[1]
        if d_total:
            cpu_state["pct"] = round(100 * (1 - (cur[0] - prev[0]) / d_total), 1)
        prev = cur
        t = time.time()
        if t - last_poll >= POLL_SECONDS:
            last_poll = t
            try:
                await poll_completions()
            except Exception as e:  # keep the loop alive through Jellyfin restarts
                print("poll_completions failed:", repr(e), flush=True)
        if t - last_disk >= 3600:
            last_disk = t
            sample_disks()


@asynccontextmanager
async def lifespan(app):
    init_db()
    task = asyncio.create_task(background())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


# --------------------------------------------------------------------- auth
def current_user(request: Request):
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401)
    try:
        return signer.loads(token, max_age=SESSION_DAYS * 86400)
    except BadSignature:
        raise HTTPException(401)


class Login(BaseModel):
    username: str
    password: str


@app.post("/api/login")
async def login(body: Login, request: Request, response: Response):
    auth = ('MediaBrowser Client="Monitor", Device="Web", DeviceId="monitor-web", Version="1.0"')
    async with httpx.AsyncClient(base_url=JF_URL, timeout=20) as c:
        r = await c.post("/Users/AuthenticateByName", headers={"Authorization": auth},
                         json={"Username": body.username, "Pw": body.password})
        if r.status_code != 200:
            raise HTTPException(401, "Wrong Jellyfin username or password")
        data = r.json()
        # we only needed to verify the password; don't leave a Jellyfin session behind
        await c.post("/Sessions/Logout", headers={"Authorization": f'{auth}, Token="{data["AccessToken"]}"'})
    user = {"id": norm_id(data["User"]["Id"]), "name": data["User"]["Name"],
            "admin": data["User"]["Policy"]["IsAdministrator"]}
    secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    response.set_cookie(COOKIE, signer.dumps(user), max_age=SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", secure=secure)
    return user


@app.post("/api/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE)
    return {"ok": True}


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/api/me")
async def me(user=Depends(current_user)):
    return user


# --------------------------------------------------------------------- now
@app.get("/api/now")
async def now_playing(user=Depends(current_user)):
    r = await jf.get("/Sessions", params={"activeWithinSeconds": 960})
    r.raise_for_status()
    out = []
    for s in r.json():
        it = s.get("NowPlayingItem")
        if not it:
            continue
        ps = s.get("PlayState") or {}
        ti = s.get("TranscodingInfo") or {}
        runtime = it.get("RunTimeTicks") or 0
        out.append({
            **item_info(it),
            "user": s.get("UserName"),
            "client": s.get("Client"), "device": s.get("DeviceName"),
            "progress": round(100 * (ps.get("PositionTicks") or 0) / runtime, 1) if runtime else None,
            "paused": ps.get("IsPaused", False),
            "method": ps.get("PlayMethod"),
            "transcode_reasons": ti.get("TranscodeReasons") or [],
            "hw_accel": ti.get("HardwareAccelerationType"),
        })
    return out


# ------------------------------------------------------------- leaderboard
@app.get("/api/leaderboard")
async def leaderboard(user=Depends(current_user)):
    week_ago = datetime.fromtimestamp(time.time() - 7 * 86400, timezone.utc).isoformat()
    with db() as c:
        def board(where="", args=()):
            return [dict(r) for r in c.execute(f"""
                SELECT user_name, SUM(runtime_s) AS seconds,
                       SUM(item_type='Movie') AS movies, SUM(item_type='Episode') AS episodes
                FROM completions {where} GROUP BY user_id ORDER BY seconds DESC""", args)]
        top_shows = [dict(r) for r in c.execute("""
            SELECT user_name, series_name, COUNT(*) AS episodes, SUM(runtime_s) AS seconds
            FROM completions WHERE item_type='Episode' GROUP BY user_id, series_id
            ORDER BY seconds DESC LIMIT 10""")]
        recent = [dict(r) for r in c.execute("SELECT * FROM completions ORDER BY id DESC LIMIT 30")]
        since = c.execute("SELECT MIN(since) FROM tracked_users").fetchone()[0]
    return {"since": since, "all_time": board(), "week": board("WHERE at >= ?", (week_ago,)),
            "top_shows": top_shows, "recent": recent}


# ----------------------------------------------------------------- ratings
@app.get("/api/ratings")
async def ratings(user=Depends(current_user)):
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM ratings ORDER BY updated_at DESC")]
    items = {}
    for r in rows:
        it = items.setdefault(r["item_id"], {k: r[k] for k in (
            "item_id", "item_type", "item_name", "series_name", "series_id", "year")} | {"reviews": []})
        it["reviews"].append({"user_id": r["user_id"], "user_name": r["user_name"], "score": r["score"],
                              "note": r["note"], "updated_at": r["updated_at"]})
    out = list(items.values())
    for it in out:
        it["avg"] = round(sum(x["score"] for x in it["reviews"]) / len(it["reviews"]), 1)
        it["latest"] = max(x["updated_at"] for x in it["reviews"])
    out.sort(key=lambda x: x["latest"], reverse=True)
    return out


@app.get("/api/to-rate")
async def to_rate(user=Depends(current_user)):
    """The caller's recently finished movies/episodes they haven't rated yet."""
    r = await jf.get(f"/Users/{user['id']}/Items", params={
        "Recursive": "true", "IncludeItemTypes": "Movie,Episode", "Filters": "IsPlayed",
        "SortBy": "DatePlayed", "SortOrder": "Descending", "Limit": 40,
        "Fields": "RunTimeTicks,SeriesName,SeriesId,ProductionYear"})
    r.raise_for_status()
    with db() as c:
        rated = {row[0] for row in c.execute("SELECT item_id FROM ratings WHERE user_id=?", (user["id"],))}
    out, seen_series = [], set()
    for it in r.json()["Items"]:
        info = item_info(it)
        if info["item_id"] in rated:
            continue
        # one card per show: the most recent unrated episode stands in for it
        if info["series_id"]:
            if info["series_id"] in seen_series:
                continue
            seen_series.add(info["series_id"])
            info["series_rated"] = info["series_id"] in rated
        out.append(info)
    return out[:16]


@app.get("/api/search")
async def search(q: str, user=Depends(current_user)):
    r = await jf.get("/Items", params={"SearchTerm": q, "Recursive": "true", "Limit": 12,
                                       "IncludeItemTypes": "Movie,Series,Episode",
                                       "Fields": "SeriesName,SeriesId,ProductionYear"})
    r.raise_for_status()
    return [item_info(it) for it in r.json()["Items"]]


class Rating(BaseModel):
    item_id: str = Field(pattern=r"^[0-9a-fA-F-]{32,36}$")
    score: int = Field(ge=1, le=10)
    note: str = Field(default="", max_length=280)


@app.post("/api/ratings")
async def rate(body: Rating, user=Depends(current_user)):
    r = await jf.get("/Items", params={"Ids": body.item_id, "Fields": "SeriesName,SeriesId,ProductionYear"})
    found = r.json().get("Items") if r.status_code == 200 else None
    if not found:
        raise HTTPException(404, "Item not found in Jellyfin")
    info = item_info(found[0])
    ts = now_iso()
    with db() as c:
        c.execute("""INSERT INTO ratings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(user_id, item_id) DO UPDATE SET score=excluded.score,
                     note=excluded.note, user_name=excluded.user_name, updated_at=excluded.updated_at""",
                  (user["id"], user["name"], info["item_id"], info["item_type"], info["item_name"],
                   info["series_name"], info["series_id"], info["year"], body.score,
                   body.note.strip(), ts, ts))
    return {"ok": True}


@app.delete("/api/ratings/{item_id}")
async def unrate(item_id: str, user=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM ratings WHERE user_id=? AND item_id=?", (user["id"], norm_id(item_id)))
    return {"ok": True}


# ----------------------------------------------------------------- history
@app.get("/api/history")
async def history(user=Depends(current_user)):
    q = ("SELECT DateCreated, UserId, ItemId, ItemType, ItemName, PlaybackMethod, ClientName, "
         "DeviceName, PlayDuration FROM PlaybackActivity ORDER BY DateCreated DESC LIMIT 100")
    r = await jf.post("/user_usage_stats/submit_custom_query",
                      json={"CustomQueryString": q, "ReplaceUserId": False})
    r.raise_for_status()
    names = {norm_id(u["Id"]): u["Name"] for u in await jf_users()}
    data = r.json()
    cols = data.get("colums") or data.get("columns") or []
    out = []
    for row in data.get("results", []):
        d = dict(zip(cols, row))
        out.append({"at": d["DateCreated"], "user": names.get(norm_id(d["UserId"]), "?"),
                    "item_id": norm_id(d["ItemId"]), "type": d["ItemType"], "name": d["ItemName"],
                    "method": d["PlaybackMethod"], "client": d["ClientName"], "device": d["DeviceName"],
                    "seconds": int(d["PlayDuration"] or 0)})
    return out


# ------------------------------------------------------------------ system
async def arr_queue(name, url, key):
    if not key:
        return []
    try:
        r = await http.get(f"{url}/api/v3/queue", headers={"X-Api-Key": key},
                           params={"pageSize": 50, "includeSeries": "true", "includeMovie": "true"})
        r.raise_for_status()
    except httpx.HTTPError:
        return [{"app": name, "title": f"{name} unreachable", "status": "error"}]
    out = []
    for q in r.json()["records"]:
        size, left = q.get("size") or 0, q.get("sizeleft") or 0
        out.append({"app": name, "title": q.get("title"), "status": q.get("trackedDownloadState") or q.get("status"),
                    "progress": round(100 * (1 - left / size), 1) if size else 0,
                    "timeleft": q.get("timeleft"), "warning": q.get("trackedDownloadStatus") == "warning"})
    return out


@app.get("/api/system")
async def system(user=Depends(current_user)):
    disks = disk_usage()
    for d in disks:
        d["days_to_full"] = days_to_full(d["label"], d["free"])
    try:
        r = await http.get(f"{DOCKER_URL}/containers/json", params={"all": "true"})
        containers = sorted(({"name": c["Names"][0].lstrip("/"), "state": c["State"], "status": c["Status"]}
                             for c in r.json()), key=lambda c: c["name"])
    except (httpx.HTTPError, ValueError):
        containers = []
    queue = (await arr_queue("Sonarr", "http://sonarr:8989", SONARR_KEY)
             + await arr_queue("Radarr", "http://radarr:7878", RADARR_KEY))
    with open("/proc/loadavg") as f:
        load = [float(x) for x in f.read().split()[:3]]
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    counts = (await jf.get("/Items/Counts")).json()
    return {"disks": disks, "cpu": cpu_state["pct"], "cores": os.cpu_count(), "load": load,
            "memory": meminfo(), "uptime": uptime, "temps": temps(), "containers": containers,
            "queue": queue, "library": {k: counts.get(k) for k in ("MovieCount", "SeriesCount", "EpisodeCount")}}


# ------------------------------------------------------------------ images
@app.get("/api/img/{item_id}")
async def image(item_id: str, user=Depends(current_user)):
    if not all(ch in "0123456789abcdefABCDEF-" for ch in item_id):
        raise HTTPException(400)
    r = await jf.get(f"/Items/{item_id}/Images/Primary", params={"fillHeight": 360, "quality": 85})
    if r.status_code != 200:
        raise HTTPException(404)
    return Response(r.content, media_type=r.headers.get("content-type", "image/jpeg"),
                    headers={"Cache-Control": "private, max-age=86400"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")
