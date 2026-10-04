# monitor

A React dashboard for your Jellyfin circle: now playing, a shared watchlist,
ratings, measured viewing analytics, playback history and media-server health.
The frontend uses TypeScript, Vite, shadcn/ui, Recharts and locally bundled Manrope.
FastAPI serves the production build and signs Jellyfin login cookies.

## Smart picks and requests

Discover replaces the watchlist's random picker. Choose up to four viewers,
time available, movie/show, genre and mood. Watch tonight selects accessible
Jellyfin titles shared by the group, with actual movie or episode runtimes.
Discover & request finds titles through Seerr, using highly rated titles as
recommendation seeds. Partially available shows can offer missing seasons.
Every recommendation includes reasons, and IMDb links use metadata identifiers.

Ratings guide genre, cast and director preferences. Episode ratings are averaged
into one show signal. Verified completions add a small, capped signal; merely
starting playback adds none. The group score considers its least satisfied
viewer. Jellyfin watched flags, ratings, measured completions and explicit
already-seen feedback control the unseen filter without adding viewing time.
Not interested hides a title for that viewer's future groups. Both feedback
actions can be undone. Mood is a genre shortcut, not a predicted emotional label.

Requests use the signed-in viewer's Seerr account matched by Jellyfin ID. The
backend sends X-API-User with the private integration key, so Seerr enforces
the user's quotas, approval rules and request permissions. It never falls back
to administrator requests. Movies require an explicit request action; shows
require selecting missing seasons. Availability is refreshed before submission.
Existing requests and available seasons cannot be requested again. Failed or
declined requests link to Seerr for handling there.

Your first use may require signing into Seerr once with Jellyfin. The deployment
connects the existing media-stack Seerr instance automatically: it extracts only
the integration key and public service URLs into `/data/seerr-connection.json`
with owner 1000 and permissions 0600. No credentials are sent to the browser or
printed in job logs. For another deployment, configure the variables below.

Local metadata is cached for five minutes and Seerr reads for two minutes;
request checks bypass caches. The candidate pool is bounded: up to 10,000 local
titles, the first 100 episodes per shortlisted show, and up to 32 external
title details from ratings-based recommendations and discovery lists. Unknown
runtimes are excluded when a time limit is set. Choose no time limit to include
them. Cold starts explain that picks use filters and catalogue popularity.
See [the recommendation plan](docs/RECOMMENDATIONS.md).

## Viewing analytics

The default leaderboard is the current calendar month. Pick any inclusive date
range up to 366 days with the calendar, or use the current/previous month and
7/30-day shortcuts. Calendar days and peak days use your selected IANA timezone.
There are five rankings, with shared winners on ties:

- Total active watch time
- Most watch time in a single day
- Longest consecutive active viewing
- Episodes completed
- Movies completed

The daily timeline can show everyone or one viewer. The viewing mix divides movie
and episode time, and top titles and recent completions follow the same range.
Midnight, Daylight, Plum, Lavender, Cyber, Cinema, Tron Evolution and the system
preference are remembered on the current device. Lavender has a light lilac
palette; Cyber pairs electric pink with lime; Cinema uses velvet, brass and
serif headings; Tron Evolution adds cyan-lit edges and a subtle grid.

Profile pictures sync from Jellyfin across the account area, leaderboards, now
playing, reviews and history. Click your account picture to preview, upload or
remove your own picture. Changes also update Jellyfin and respect its current
user preference policy. Uploads accept JPEG, PNG and WebP up to 5 MB and 16
megapixels; Monitor corrects orientation, crops a 512-pixel square and strips
metadata before saving. Pictures are proxied through the signed Monitor session,
and missing or unavailable pictures fall back to initials.

### How measurement works

Monitor samples Jellyfin sessions every five seconds and stores evidence of
forward playback progress in SQLite. It does **not** credit a full runtime or
use PlayCount changes. Bulk marking a season watched never creates viewing.
Pauses, seeks, stale clients, failed requests and restart gaps get no invented
time. Client updates may arrive in batches: unchanged samples preserve a progress
anchor, but time is credited only when progress actually arrives, within a bounded
45-second window and with uninterrupted polling.

A movie or episode counts as completed once a single observed playback covers
90% of its runtime. Revisiting the same positions doesn't increase coverage;
rewatching after a completed playback can count again. Unknown-runtime items can
add time but cannot be verified as completions.

Simultaneous streams count once per viewer. If movies and episodes overlap for
one viewer, their viewing-mix time is shared equally. Consecutive viewing permits
up to 15 seconds between active intervals, adding only active seconds to the run.
Time is split at local midnight, including daylight-saving transitions.

Five-second sampling can miss very brief plays and tail intervals. Infrequently
reporting clients, nonstandard playback speeds and watches during outages may be
undercounted. This is conservative observed measurement, not a playback-event log.

### Existing data

The first startup adds new tracking tables without deleting ratings, watchlists,
legacy completions or playcounts. Old full-runtime credits stay in SQLite for
recovery but are excluded from measured rankings: they cannot be converted into
accurate history. Verified rankings begin when the new tracker starts. The
Playback Reporting plugin archive remains available separately in History; the
plugin is optional for the new tracker.

Back up the existing database before deploying. Use the same persistent DB_PATH
and session secret to retain data and login sessions. The new leaderboard API
schema replaces the old `all_time`/`week` runtime response; `/api/analytics` and
`/api/leaderboard` return the same measured range response. `/api/activity` returns
up to 200 measured sessions; `/api/history` retains the plugin archive.

## Local development

Requires Python 3.13+ and Node 22.12+.

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
npm --prefix frontend ci
npm --prefix frontend run build
```

Set JELLYFIN_API_KEY, SESSION_SECRET, DB_PATH to a writable persistent location,
and JELLYFIN_URL to your server. Then start FastAPI:

```sh
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
```

For frontend changes, run `npm --prefix frontend run dev`. Vite proxies `/api`
to FastAPI on port 8000. System metrics require Linux `/proc` and the configured
media-stack services; playback and frontend development also work on macOS.
The production frontend is generated into `static/`; only its source and icon
assets are committed.

## Validation

```sh
.venv/bin/python -m pytest -q
npm --prefix frontend run build
cd frontend
npx playwright install chromium
npm test
```

Browser tests run against the production build with isolated fixtures. They cover
authentication, calendar ranges, timezone selection, all themes, ratings,
watchlist mutations, existing screens, retry/empty states, phone overflow and
WCAG accessibility checks. They do not access your live Jellyfin accounts.

## Deploy

Docker builds the frontend in a Node stage and copies its output into the Python
image. A PR runs backend, production frontend/browser and container-build checks.
Merging to `main` builds `ghcr.io/aleh11/monitor`, then the self-hosted media-server
runner restarts Monitor in the `media-stack` compose project. Main's deploy build
also runs the backend regressions before publishing.

After deployment, play one episode, pause, resume and seek; verify that only
observed time accrues and that one completion appears after measured coverage.
Check a phone, a theme switch and last month's leaderboard against the live
server. The local checks cannot verify a production client's reporting cadence.

## Configuration

| Variable | Purpose |
|---|---|
| `JELLYFIN_API_KEY` | Required Jellyfin API key with access to sessions and library data |
| `SESSION_SECRET` | Required random signing secret for login cookies |
| `JELLYFIN_URL` | Defaults to `http://jellyfin:8096` |
| `SONARR_API_KEY`, `RADARR_API_KEY` | Optional download queue connections |
| `DOCKER_URL` | Defaults to `http://docker-proxy:2375` |
| `DISKS` | Filesystems to report, `Label=/path,…` |
| `DB_PATH` | Defaults to `/data/monitor.db`; must persist across containers |
| `SEERR_URL` | Internal Seerr address, defaults to `http://seerr:5055` |
| `SEERR_API_KEY` | Optional override of the server's private Seerr connection key |
| `SEERR_PUBLIC_URL` | Public browser address for Seerr links |
| `JELLYFIN_PUBLIC_URL` | Public browser address for Watch now links |
| `SEERR_CONNECTION_FILE` | Defaults to `/data/seerr-connection.json`, used when overrides are absent |

Polling is fixed at five seconds; the previous `POLL_SECONDS` setting no longer
controls playback measurement. See [the implementation plan](docs/PLAN.md).
