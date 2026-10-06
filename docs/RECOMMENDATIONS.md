# Smart picks and Seerr requests

## Outcome

Replace the watchlist's random picker with a dedicated Discover screen. Watch
tonight recommends playable items in Jellyfin. Discover & request recommends
titles outside the library and creates Seerr requests only after a user chooses
a title and, for television, seasons.

## Implementation order

1. Add a transparent recommendation engine. Ratings are the strongest taste
   signal; verified completions contribute less. Starting playback contributes
   nothing. Combine each selected viewer's preferences with an emphasis on the
   least satisfied viewer, then apply time, genre, mood, type and unseen filters.
   Provide factual reasons instead of invented confidence percentages.
2. Load user-scoped Jellyfin metadata and intersect the selected viewers' library
   access. Movie runtimes and individual episode runtimes determine time fit.
   Keep watched state separate from measured viewing time. Persist per-user
   not-interested/already-seen feedback and support undo.
3. Connect to the existing Seerr service on the server. Match accounts by Jellyfin
   user ID, never by display name. Send requests with X-API-User so Seerr applies
   the real user's permission, approval and quota rules. Never send userId,
   ignoreQuota or administrator overrides from the browser. Refresh title and
   season availability before requesting and prevent duplicate submissions.
4. Build the Discover screen with existing shadcn controls and theme tokens.
   Separate immediate playback from requests, show reasons, offer season
   selection and display approval/processing/available/failure states.
5. Validate recommendation ordering, group fairness, filters, feedback, library
   access, authentication, impersonation prevention, season selection, duplicate
   requests and upstream outages. Run desktop/mobile flows and accessibility
   checks, then deploy through the existing main workflow and confirm health.

## Design

Reuse Manrope and each theme's semantic palette. Midnight anchors are ink
#101a30, slate #16223a, sky #9bc8ff, mist #edf2fc and muted #a3b1c8. A large
featured pick is the focal point; compact alternatives follow beneath it.
Filters are left aligned and grouped into who, time and mood. Movie artwork,
real reasons and explicit availability provide the visual hierarchy.

```text
What are we watching?
[Watch tonight] [Discover & request]
[viewers] [time] [type] [genre] [mood] [unseen]
[featured artwork | title, synopsis, why it fits, watch/request]
[alternative] [alternative] [alternative]
```

Review: retain Monitarr's established theme identity rather than introduce a
second palette. Avoid scores that look like predicted ratings. Use one featured
title and quieter alternatives so this reads as a viewing decision, not another
analytics dashboard. Unknown runtimes cannot satisfy a selected time limit.
Mood is a transparent genre-based shortcut in this first version.

## Integration and practical limits

Seerr supplies catalogue metadata and title-based recommendations; IMDb links
use external identifiers, with no scraping or new paid API. Without enough taste
history, explain that picks use filters and catalogue popularity. Recommendations
use a bounded candidate pool and do not promise exhaustive library search.

Deployment reads the existing Seerr configuration on the media server and saves
only the integration key and public service URLs into Monitarr's private data
directory, owned by its runtime user with mode 0600. No secrets enter source,
browser responses or job logs. Environment variables can override this file.
If Seerr is unavailable or unconfigured, local recommendations remain usable
and the screen gives a clear connection message. Existing accounts must first
sign into Seerr with Jellyfin; Monitarr does not silently create accounts.

Sources: https://docs.seerr.dev/api/create-new-request/ and the official Seerr
API schema and authentication middleware in https://github.com/seerr-team/seerr.
