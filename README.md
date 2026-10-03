# monitor

Dashboard for the media stack at `monitor.<domain>`: now playing, watch-hours
leaderboard, ratings, playback history, and host/system stats. Log in with a
Jellyfin account.

- **Leaderboard:** every finished movie/episode credits its full runtime to the
  user who finished it (Jellyfin `PlayCount` increments). Tracking starts when
  a user is first seen, so anything watched earlier never counts.
- **Ratings:** 1–10 plus an optional one-liner, per user, per movie/show/episode.
- **History:** from Jellyfin's Playback Reporting plugin (must be installed).

## Deploy

Push to `main`: GitHub Actions builds `ghcr.io/aleh11/monitor`, then the
self-hosted runner on the media server pulls it and restarts the `monitor`
service defined in the `media-stack` repo's `docker-compose.yml`.

## Configuration (env)

| Variable | |
|---|---|
| `JELLYFIN_API_KEY` | Jellyfin API key (required) |
| `SESSION_SECRET` | random string for signing login cookies (required) |
| `JELLYFIN_URL` | default `http://jellyfin:8096` |
| `SONARR_API_KEY`, `RADARR_API_KEY` | for the download queue |
| `DOCKER_URL` | docker-socket-proxy, default `http://docker-proxy:2375` |
| `DISKS` | `Label=/path,…` — filesystems to report |
| `DB_PATH` | default `/data/monitor.db` |
