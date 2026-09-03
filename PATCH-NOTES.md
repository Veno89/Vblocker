# Veno Twitch Stability Fork 1.0.2 — patch notes

## Base

Derived from the user-supplied TwitchAdSolutions VAFT v93 snapshot under the MIT License. The original ad-detection and clean-backup strategy remains substantially intact; this fork concentrates on reducing collateral player failure.

## Stability changes carried from 1.0.0

1. **Live-only scope:** skips Twitch VOD routes, VOD embeds, clips, and chat-only popouts.
2. **Fail-open HLS processing:** catches asynchronous media/master playlist-processing failures and returns the original, still-readable response instead of leaving the player promise pending.
3. **V2/raw playlist support:** accepts raw absolute CDN variant URLs without requiring `.m3u8` in the path, and recognizes `.m3u8` URLs with query strings.
4. **Bounded master probing:** avoids malformed `fetch(undefined)` calls and limits cached-variant health probes.
5. **Ad-break generation guard:** a slow backup search cannot commit into a later ad break.
6. **Scoped GraphQL mutation:** rewrites only confirmed live PlaybackAccessToken packets. VOD and picture-in-picture/chat packets pass through untouched.
7. **Restricted worker bridge:** forwards only HTTPS POST requests to Twitch's GraphQL endpoint, only for expected operations, and only with a minimal header allow-list.
8. **Player-owned video targeting:** recovery actions use Twitch's actual player element when discoverable rather than blindly indexing the first page video.
9. **Exact recycled-node restoration:** standalone Amazon ad-video nodes are restored to their pre-hide display and mute state when Twitch reuses them.
10. **Conservative defaults:** 360p/autoplay fallback, fast-autoplay selection, inferred silent-mute recovery, and synthetic ad-completion spoofing are disabled by default; early reloads wait longer.
11. **Worker identity guard:** Twitch-origin workers without plausible video/WASM characteristics run unmodified.
12. **Duplicate-hook guard:** the fork refuses to initialize when any VAFT/TwitchAdSolutions resource is already active, regardless of load order or version.
13. **Exact worker operations:** the worker bridge accepts only the two explicitly expected Twitch GraphQL operation names rather than substring lookalikes.

## New in 1.0.1

- Removes stale `Content-Length` and `Content-Encoding` headers when a playlist response body is rebuilt, while preserving unrelated headers and response metadata.
- Bounds the synchronous Twitch worker-source cache to eight entries using a small LRU policy.
- Prefers video nodes inside `.video-player` before the whole-page fallback when React player discovery is temporarily unavailable.
- Prevents the tab-focus recovery handler from resuming playback when explicit user-pause intent is recorded.

## New in 1.0.2

- Reuses the prefetched Twitch worker source instead of refetching a Blob URL that Twitch may already have revoked; only script-owned replacement Blobs are cleaned up.
- Bounds auxiliary health probes, backup master/media fetches, the full backup search, and worker GraphQL body reads so optional recovery work cannot hold playback forever.
- Rejects malformed/non-HLS backup responses, missing variant URLs, and ad-marked candidates during the short post-reload single-probe mode.
- Keeps exactly one buffer-monitor timer across visibility changes and ignores messages, proxy responses, and crash events from replaced workers.
- Gives confirmed worker-crash and post-break-wedge recovery an explicit hard-reload path while enforcing a main-thread 15-second gate on every automatic early reload, including across worker replacement.
- Makes the required no-strip post-ad transition a soft reload even when ordinary health metrics look good, while retaining the healthy-player guard for optional early recovery.
- Clears transient monitor/recovery state on channel changes, refreshes disconnected React/player roots, avoids whole-document video fallbacks, and restores script-hidden video/overlay state on excluded SPA routes.
- Fixes mixed ad/live recovery media-sequence math, backup pin opt-out, no-strip soft reload selection, and end-of-break state ordering.
- Discards a stale asynchronous backup search before it can strip, mutate recovery state, or request a reload, and clamps untrusted ad-pod reload budgets to 1-8.
- Extends live-only route protection to official chat embeds and collection-only VOD embeds, with dynamic suppression after live-to-VOD/chat/clip SPA navigation.

## Deliberate non-goals

- No claim of permanent ad removal.
- No VOD or clip interception.
- No attempt to impersonate ad-view completion.
- No self-updater. A moving `main` raw URL changes only when this repository is deliberately pushed; a commit-pinned URL stays frozen.
- No stacking with another Twitch-specific blocker.
