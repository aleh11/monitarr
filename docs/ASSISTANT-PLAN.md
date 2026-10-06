# Plan: Monitarr as the stack's management page

Status: idea, not scheduled. Written 2026-10-06.

Monitarr ships with the media-stack repo as the place people go to watch what's happening. These
two additions would make it the place to *fix* things too.

## 1. Ask-the-stack chat (an AI assistant that debugs the host)

A chat panel in Monitarr, admin-only, that runs the media-stack `debug-media-stack` skill against the real
host: "why is my download stuck?", "Jellyfin won't play X", "turn off Cleanuparr".

**Feasible: yes.** The pieces:
- **Agent runtime:** the Claude Agent SDK (the engine behind Claude Code) as a small service on the host,
  next to `/opt/media-stack`. It loads the repo's `AGENTS.md`, `docs/` and `.claude/skills/`, so it already
  knows the stack.
- **Transport:** Monitarr's backend proxies the chat to that service over a websocket and streams tokens and
  tool activity into the UI.
- **Auth:** Monitarr's existing Jellyfin login, restricted to Jellyfin admins.
- **Billing:** an Anthropic API key (or the owner's subscription) configured on the host, set during the
  setup interview.

**The hard part is safety, not plumbing.** The agent can reach Docker, which is root-equivalent on that box.
- Read-only tools by default (logs, the app APIs' GET calls, `docker compose ps`, `df`).
- Every change (restart, config write, file delete) appears in the chat as an **Approve / Deny** card showing
  the exact command. Nothing runs until it's approved.
- Treat log lines, torrent names and media filenames as untrusted input (prompt injection). They're data,
  never instructions.
- An audit log of every tool call, kept in Monitarr's DB and visible in the UI.
- Rate and spend limits per day.

**Zero-build alternative today:** Claude Code's Remote Control lets the owner drive a Claude Code session
running on the box from claude.ai or the mobile app. It's useful until this exists, but it isn't built into the page.

## 2. Containers tab (Portainer, embedded or native)

**Embedding Portainer: feasible with one header change.** Portainer sends
`Content-Security-Policy: … frame-ancestors 'none'`, which blocks iframes. Either:
- in the generated Caddyfile, rewrite that header on the `portainer` route to allow only
  `frame-ancestors https://monitarr.{$DOMAIN}` (preferred: it keeps the rest of the CSP), or
- run Portainer with `--no-csp` (simpler, but removes all of its CSP).

Both are on the same site (`*.{$DOMAIN}`), so Portainer's login survives inside the frame. With IP:port access
(no Caddy), only the `--no-csp` route works.

**Status:** done. The admin-only Containers tab embeds Portainer, and the System tab's own container list was removed.

**Native alternative (not built):** a logs viewer through `docker-proxy` (`CONTAINERS=1` already allows
`GET /containers/{id}/logs`) would be free. Restart buttons would need `POST=1` on the proxy, and that
should go through the same approval flow as the chat rather than becoming a bare button.

## Order, if we pick this up
1. Native logs viewer (no new permissions).
2. Portainer embed behind the Caddy header rewrite (`stack/services/portainer.yml` + the generator).
3. The chat: read-only first, then approval cards for changes.
