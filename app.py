import asyncio
import base64
from io import BytesIO
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import tracking
import recommendations
from PIL import Image, ImageOps, UnidentifiedImageError
from itsdangerous import BadSignature, URLSafeTimedSerializer
from pydantic import BaseModel, Field

JF_URL = os.environ.get("JELLYFIN_URL", "http://jellyfin:8096").rstrip("/")
JF_KEY = os.environ["JELLYFIN_API_KEY"]
SONARR_KEY = os.environ.get("SONARR_API_KEY", "")
RADARR_KEY = os.environ.get("RADARR_API_KEY", "")
SECRET = os.environ["SESSION_SECRET"]
DB_PATH = os.environ.get("DB_PATH", "/data/monitarr.db")
# One-time migration from the app's previous name (monitor → monitarr)
if "DB_PATH" not in os.environ and not os.path.exists(DB_PATH) and os.path.exists("/data/monitor.db"):
    for suffix in ("-wal", "-shm", ""):  # SQLite side files first, so the DB never appears without them
        if os.path.exists("/data/monitor.db" + suffix):
            os.rename("/data/monitor.db" + suffix, DB_PATH + suffix)
# label=path pairs; statvfs on a path reports the filesystem it lives on
DISKS = [d.split("=", 1) for d in os.environ.get("DISKS", "NVMe=/data").split(",") if "=" in d]
POLL_SECONDS = 5
tracking_health = {"error": None}
COOKIE = "monitor_session"  # pre-rename name, kept so existing logins stay valid
SESSION_DAYS = 30

STATIC = Path(__file__).parent / "static"
signer = URLSafeTimedSerializer(SECRET, salt="monitor-session")  # pre-rename salt, kept for existing sessions
jf = httpx.AsyncClient(base_url=JF_URL, headers={"Authorization": f'MediaBrowser Token="{JF_KEY}"'}, timeout=20)
http = httpx.AsyncClient(timeout=10)
cpu_state = {"pct": None}


# --------------------------------------------------------------------------- db
def db():
    return tracking.connect(DB_PATH)


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
        CREATE TABLE IF NOT EXISTS watchlist (
            item_id TEXT PRIMARY KEY, item_type TEXT, item_name TEXT, year INTEGER,
            added_by_id TEXT, added_by_name TEXT, note TEXT, added_at TEXT);
        CREATE TABLE IF NOT EXISTS watchlist_votes (
            item_id TEXT, user_id TEXT, user_name TEXT, PRIMARY KEY (item_id, user_id));
        CREATE TABLE IF NOT EXISTS disk_samples (ts INTEGER, label TEXT, used INTEGER, total INTEGER);
        CREATE INDEX IF NOT EXISTS idx_completions_at ON completions(at);
        CREATE INDEX IF NOT EXISTS idx_disk ON disk_samples(label, ts);
        """)
    recommendations.initialize(DB_PATH)


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


async def poll_playback():
    response = await jf.get("/Sessions", params={"activeWithinSeconds": 60})
    response.raise_for_status()
    await asyncio.to_thread(tracking.observe, DB_PATH, response.json(), time.time())
    tracking_health["error"] = None


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
    prev = read_cpu() if Path("/proc/stat").exists() else None
    last_poll = last_disk = 0
    while True:
        await asyncio.sleep(5)
        if prev is not None:
            cur = read_cpu()
            d_total = cur[1] - prev[1]
            if d_total:
                cpu_state["pct"] = round(100 * (1 - (cur[0] - prev[0]) / d_total), 1)
            prev = cur
        t = time.time()
        if t - last_poll >= POLL_SECONDS:
            last_poll = t
            try:
                await poll_playback()
            except Exception as e:
                tracking_health["error"] = "Jellyfin is unreachable. Viewing will resume when it reconnects."
                await asyncio.to_thread(tracking.mark_gap, DB_PATH)
                print("poll_playback failed:", repr(e), flush=True)
        if t - last_disk >= 3600:
            last_disk = t
            sample_disks()


@asynccontextmanager
async def lifespan(app):
    init_db()
    tracking.initialize(DB_PATH)
    task = asyncio.create_task(background())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    await jf.aclose()
    await http.aclose()


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
    auth = ('MediaBrowser Client="Monitarr", Device="Web", DeviceId="monitarr-web", Version="1.0"')
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


def profile_info(data, viewer_id):
    policy = data.get("Policy") or {}
    return {"id": norm_id(data["Id"]), "name": data["Name"],
            "image_tag": data.get("PrimaryImageTag"),
            "can_edit_image": norm_id(data["Id"]) == viewer_id and not policy.get("IsDisabled", False)
            and bool(policy.get("IsAdministrator") or policy.get("EnableUserPreferenceAccess", False))}


async def profile_request(method, path, **kwargs):
    try:
        response = await jf.request(method, path, **kwargs)
    except httpx.HTTPError as error:
        raise HTTPException(502, "Unable to reach Jellyfin. Please try again.") from error
    if response.status_code == 403:
        raise HTTPException(403, "Jellyfin does not allow this profile picture change")
    if response.status_code == 404:
        raise HTTPException(404, "Jellyfin profile or picture not found")
    if response.status_code == 400:
        raise HTTPException(400, "Jellyfin could not save this picture. Try another image.")
    if not response.is_success:
        raise HTTPException(502, "Jellyfin could not complete this request. Please try again.")
    return response


@app.get("/api/users")
async def profiles(response: Response, user=Depends(current_user)):
    data = await profile_request("GET", "/Users")
    response.headers["Cache-Control"] = "no-store"
    return [profile_info(profile, user["id"]) for profile in data.json()]


async def editable_profile(user):
    response = await profile_request("GET", f"/Users/{user['id']}")
    data = response.json()
    if not profile_info(data, user["id"])["can_edit_image"]:
        raise HTTPException(403, "Your Jellyfin administrator has disabled profile picture changes")
    return data


def prepare_profile_image(data):
    try:
        with Image.open(BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG", "WEBP"}:
                raise HTTPException(415, "Choose a JPEG, PNG or WebP image")
            if image.width * image.height > 16_000_000:
                raise HTTPException(413, "Choose an image smaller than 16 megapixels")
            image.load()
            square = ImageOps.fit(ImageOps.exif_transpose(image).convert("RGBA"),
                                  (512, 512), method=Image.Resampling.LANCZOS)
            clean = Image.frombytes("RGBA", square.size, square.tobytes())
            output = BytesIO()
            clean.save(output, format="PNG")
            return output.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as error:
        raise HTTPException(422, "This image could not be opened. Choose another picture.") from error


@app.post("/api/me/image")
async def upload_profile_image(request: Request, user=Depends(current_user)):
    if request.headers.get("content-type", "").split(";")[0].lower() not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(415, "Choose a JPEG, PNG or WebP image")
    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > 5 * 1024 * 1024:
            raise HTTPException(413, "Choose a picture smaller than 5 MB")
        chunks.extend(chunk)
    image = await asyncio.to_thread(prepare_profile_image, bytes(chunks))
    await editable_profile(user)
    await profile_request("POST", f"/Users/{user['id']}/Images/Primary",
                          content=base64.b64encode(image), headers={"Content-Type": "image/png"})
    updated = await profile_request("GET", f"/Users/{user['id']}")
    return profile_info(updated.json(), user["id"])


@app.delete("/api/me/image")
async def remove_profile_image(user=Depends(current_user)):
    await editable_profile(user)
    await profile_request("DELETE", f"/Users/{user['id']}/Images/Primary")
    updated = await profile_request("GET", f"/Users/{user['id']}")
    return profile_info(updated.json(), user["id"])


@app.get("/api/users/{user_id}/image")
async def profile_image(user_id: str, tag: str | None = None, user=Depends(current_user)):
    try:
        user_id = UUID(user_id).hex
    except ValueError as error:
        raise HTTPException(400, "Invalid viewer") from error
    image = await profile_request("GET", f"/Users/{user_id}/Images/Primary",
                                  params={"width": 160, "height": 160, "format": "Png", "tag": tag or ""})
    content_type = image.headers.get("content-type", "").split(";")[0]
    if content_type not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
        raise HTTPException(502, "Jellyfin returned an invalid picture")
    return Response(image.content, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=300" if tag else "no-store",
                             "X-Content-Type-Options": "nosniff"})


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
            "user_id": norm_id(s.get("UserId")),
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
@app.get("/api/analytics")
async def leaderboard(start: str | None = None, end: str | None = None, tz: str = "UTC", user=Depends(current_user)):
    try:
        result = await asyncio.to_thread(tracking.analytics, DB_PATH, start, end, tz)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    result["tracking"]["error"] = tracking_health["error"]
    return result


@app.get("/api/activity")
async def measured_activity(start: str | None = None, end: str | None = None, tz: str = "UTC", user=Depends(current_user)):
    try:
        return await asyncio.to_thread(tracking.activity, DB_PATH, start, end, tz)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


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


# ---------------------------------------------------------------- to-watch
CARD_FIELDS = "SeriesName,SeriesId,ProductionYear,RunTimeTicks"


@app.get("/api/up-next")
async def up_next(user=Depends(current_user)):
    """The caller's in-progress items and next episodes, Jellyfin's own picks."""
    resume, nxt = await asyncio.gather(
        jf.get("/UserItems/Resume", params={"userId": user["id"], "Limit": 12, "MediaTypes": "Video",
                                            "Fields": CARD_FIELDS, "EnableUserData": "true"}),
        jf.get("/Shows/NextUp", params={"userId": user["id"], "Limit": 12, "Fields": CARD_FIELDS}))
    out, seen = [], set()
    for it in resume.json().get("Items", []) + nxt.json().get("Items", []):
        info = item_info(it)
        key = info["series_id"] or info["item_id"]  # one card per show
        if key in seen:
            continue
        seen.add(key)
        ud = it.get("UserData") or {}
        info["resume_pct"] = round(ud.get("PlayedPercentage") or 0) or None
        out.append(info)
    return out[:12]


@app.get("/api/watchlist")
async def watchlist(user=Depends(current_user)):
    with db() as c:
        items = [dict(r) for r in c.execute("SELECT * FROM watchlist ORDER BY added_at DESC")]
        votes = [dict(r) for r in c.execute("SELECT * FROM watchlist_votes")]
    if not items:
        return []
    ids = ",".join(i["item_id"] for i in items)
    users = await jf_users()

    async def progress_for(u):
        r = await jf.get(f"/Users/{u['Id']}/Items", params={"Ids": ids, "Fields": "RecursiveItemCount",
                                                            "EnableUserData": "true"})
        out = {}
        for it in r.json().get("Items", []):
            ud = it.get("UserData") or {}
            if it["Type"] == "Series":
                total = it.get("RecursiveItemCount") or 0
                watched = total - (ud.get("UnplayedItemCount") or 0)
                out[norm_id(it["Id"])] = {"watched": max(0, watched), "total": total,
                                          "done": total > 0 and watched >= total}
            else:
                out[norm_id(it["Id"])] = {"done": bool(ud.get("Played"))}
        return u["Name"], out

    per_user = dict(await asyncio.gather(*(progress_for(u) for u in users)))
    for it in items:
        it["in"] = [v["user_name"] for v in votes if v["item_id"] == it["item_id"]]
        it["progress"] = {name: p[it["item_id"]] for name, p in per_user.items() if it["item_id"] in p}
        it["missing"] = not it["progress"]  # removed from the library since it was added
        it["done"] = bool(it["in"]) and all(it["progress"].get(n, {}).get("done") for n in it["in"])
        it["can_remove"] = user["admin"] or it["added_by_id"] == user["id"]
    # unfinished first, then most people in; rows arrive newest-first and sort is stable
    items.sort(key=lambda i: (i["done"], -len(i["in"])))
    return items


class WatchAdd(BaseModel):
    item_id: str = Field(pattern=r"^[0-9a-fA-F-]{32,36}$")
    note: str = Field(default="", max_length=200)


@app.post("/api/watchlist")
async def watchlist_add(body: WatchAdd, user=Depends(current_user)):
    r = await jf.get("/Items", params={"Ids": body.item_id, "Fields": "SeriesId,ProductionYear"})
    found = r.json().get("Items") if r.status_code == 200 else None
    if not found:
        raise HTTPException(404, "Item not found in Jellyfin")
    it = found[0]
    if it["Type"] == "Episode" and it.get("SeriesId"):  # an episode means the show
        r = await jf.get("/Items", params={"Ids": it["SeriesId"], "Fields": "ProductionYear"})
        it = r.json()["Items"][0]
    if it["Type"] not in ("Movie", "Series"):
        raise HTTPException(400, "Only movies and shows can go on the watchlist")
    iid = norm_id(it["Id"])
    with db() as c:
        c.execute("INSERT OR IGNORE INTO watchlist VALUES (?,?,?,?,?,?,?,?)",
                  (iid, it["Type"], it["Name"], it.get("ProductionYear"), user["id"], user["name"],
                   body.note.strip(), now_iso()))
        c.execute("INSERT OR IGNORE INTO watchlist_votes VALUES (?,?,?)", (iid, user["id"], user["name"]))
    return {"ok": True, "item_id": iid}


@app.post("/api/watchlist/{item_id}/in")
async def watchlist_in(item_id: str, user=Depends(current_user)):
    with db() as c:
        if not c.execute("SELECT 1 FROM watchlist WHERE item_id=?", (norm_id(item_id),)).fetchone():
            raise HTTPException(404)
        c.execute("INSERT OR IGNORE INTO watchlist_votes VALUES (?,?,?)", (norm_id(item_id), user["id"], user["name"]))
    return {"ok": True}


@app.delete("/api/watchlist/{item_id}/in")
async def watchlist_out(item_id: str, user=Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM watchlist_votes WHERE item_id=? AND user_id=?", (norm_id(item_id), user["id"]))
    return {"ok": True}


@app.delete("/api/watchlist/{item_id}")
async def watchlist_remove(item_id: str, user=Depends(current_user)):
    iid = norm_id(item_id)
    with db() as c:
        row = c.execute("SELECT added_by_id FROM watchlist WHERE item_id=?", (iid,)).fetchone()
        if not row:
            raise HTTPException(404)
        if not user["admin"] and row["added_by_id"] != user["id"]:
            raise HTTPException(403, "Only whoever added it (or an admin) can remove it")
        c.execute("DELETE FROM watchlist WHERE item_id=?", (iid,))
        c.execute("DELETE FROM watchlist_votes WHERE item_id=?", (iid,))
    return {"ok": True}


@app.get("/api/latest")
async def latest(user=Depends(current_user)):
    """Recently added to the library, grouped by show, flagged if already listed."""
    r = await jf.get("/Items/Latest", params={"userId": user["id"], "Limit": 16,
                                              "IncludeItemTypes": "Movie,Episode", "Fields": CARD_FIELDS})
    with db() as c:
        listed = {row[0] for row in c.execute("SELECT item_id FROM watchlist")}
    out = []
    for it in r.json():
        info = item_info(it)
        info["listed"] = (info["series_id"] or info["item_id"]) in listed
        out.append(info)
    return out


# ------------------------------------------------------------------- taste
@app.get("/api/taste")
async def taste(user=Depends(current_user)):
    """How alike each pair of users rates, plus their biggest disagreements."""
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT user_id, user_name, item_id, item_name, series_name, "
                                           "item_type, score FROM ratings")]
    by_item = {}
    for r in rows:
        by_item.setdefault(r["item_id"], []).append(r)
    names = {r["user_id"]: r["user_name"] for r in rows}
    ids = sorted(names)
    pairs = []
    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            shared = []
            for item_rows in by_item.values():
                ra = next((x for x in item_rows if x["user_id"] == a), None)
                rb = next((x for x in item_rows if x["user_id"] == b), None)
                if ra and rb:
                    shared.append((ra, rb))
            if not shared:
                continue
            diff = sum(abs(ra["score"] - rb["score"]) for ra, rb in shared) / len(shared)
            fights = sorted(shared, key=lambda p: abs(p[0]["score"] - p[1]["score"]), reverse=True)
            pairs.append({
                "a": names[a], "b": names[b], "shared": len(shared),
                "match": round(100 - diff * 100 / 9),
                "fights": [{"item": f"{ra['series_name']} · {ra['item_name']}" if ra["item_type"] == "Episode" else ra["item_name"],
                            "a_score": ra["score"], "b_score": rb["score"]}
                           for ra, rb in fights[:3] if ra["score"] != rb["score"]],
            })
    return pairs


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
                    "user_id": norm_id(d["UserId"]),
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
    queue = (await arr_queue("Sonarr", "http://sonarr:8989", SONARR_KEY)
             + await arr_queue("Radarr", "http://radarr:7878", RADARR_KEY))
    with open("/proc/loadavg") as f:
        load = [float(x) for x in f.read().split()[:3]]
    with open("/proc/uptime") as f:
        uptime = float(f.read().split()[0])
    counts = (await jf.get("/Items/Counts")).json()
    return {"disks": disks, "cpu": cpu_state["pct"], "cores": os.cpu_count(), "load": load,
            "memory": meminfo(), "uptime": uptime, "temps": temps(),
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


discovery_router, discovery = recommendations.create_router(current_user, lambda: jf, lambda: DB_PATH)
app.include_router(discovery_router)

app.mount("/static", StaticFiles(directory=STATIC), name="static")
app.mount("/assets", StaticFiles(directory=STATIC / "assets", check_dir=False), name="assets")


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return FileResponse(STATIC / "favicon-32.png", media_type="image/png")


@app.get("/apple-touch-icon.png", include_in_schema=False)
async def apple_touch_icon():
    return FileResponse(STATIC / "apple-touch-icon.png", media_type="image/png")


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")
