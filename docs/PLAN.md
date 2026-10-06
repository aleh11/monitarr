# Monitarr: React and measured viewing

## Problem and goals

The current PlayCount snapshot gives every increment an entire runtime. Bulk marking a show watched and library changes can therefore create fictional viewing and completions. Replace that source before building analytics. Keep Jellyfin login, now playing, collaborative watchlist, up next, new additions, ratings, taste comparisons, playback history and server health usable.

## Implementation order

1. Add a persistent SQLite playback tracker driven by frequent Jellyfin session samples. Credit only forward movement bounded by elapsed wall time. Pauses, stale check-ins, reconnect gaps, seeks and new sessions never receive guessed time. Preserve progress anchors between batched client updates, requiring uninterrupted polling and limiting the anchor to 45 seconds. Record watched position ranges and count each observed playback once after 90% coverage. Rewatches can count; bulk PlayCount changes cannot. Preserve legacy tables but exclude their estimates from verified metrics.
2. Add date-range analytics in a requested IANA timezone. Merge simultaneous streams per user to avoid doubled hours. Split time at local midnight. Calculate total watch time, peak day, longest consecutive viewing, completed episodes and completed movies. Supply daily chart points, category winners, per-user statistics, top titles and measured history. Use inclusive calendar dates with exclusive next-midnight boundaries; defaults are the current month.
3. Build a typed React/Vite frontend with genuine shadcn/ui components, its Recharts chart wrapper, and a range calendar. Retain every existing workflow and add loading, empty, retry and authentication states.
4. Create a cinematic control-room visual identity: a deep blue canvas, pearl surfaces/text, ocean blue accents and restrained lilac/gold chart series. Use a locally bundled geometric sans, large open headings, a compact sidebar and one wide viewing chart as the central visual. Themes: Midnight, Daylight and Plum, plus system preference; persist the choice and respect reduced motion. Design the leaderboard as readable rankings with a selectable metric, five category winners, daily activity and a movie/episode breakdown. All panels respond to the same calendar range and timezone.
5. Build React inside a multi-stage Docker image and serve it from the existing FastAPI application. Add PR validation for backend regression tests, frontend type checking/build and interaction tests. Keep production deployment on main.
6. Verify the one-episode regression, pause/seek/restart behavior, duplicate samples, replay completions, midnight/month boundaries, simultaneous streams and longest viewing runs. Inspect desktop/mobile screenshots and exercise calendar, theme, authentication, ratings and watchlist flows. Commit to a feature branch and open a draft PR with validation evidence.

## Definitions and honest limits

- Watch time is observed active playback, never a title's advertised runtime. Five-second polling can miss very short plays and tail intervals. Outages are not backfilled or estimated.
- A completion requires measured coverage of at least 90% of a movie or episode in one playback. Position jumps do not add coverage. Restarting the same playback preserves its coverage but receives no outage time.
- Consecutive viewing joins active intervals with at most 15 seconds between them; only active seconds contribute. A longer pause breaks the run. Calendar filtering clips intervals before aggregation.
- Historical runtime credits are retained for recovery but cannot be transformed into accurate watch time. Verified rankings start with the new tracker. Playback Reporting remains available as separate historical evidence.
- No production Jellyfin or server is available locally. Tests use isolated databases and realistic fixtures; live verification after deployment remains necessary.

## Design review

Avoid a generic wall of identical statistic cards. Give the viewing timeline most of the space; use a quiet metric strip and a ranked table with avatar colors, generous name columns and precise numeric alignment. Keep theme colors semantic so graphs, dialogs and calendar selections remain coherent. Poster images come from the existing authenticated Jellyfin proxy. No decorative stock images or invented live statistics.
