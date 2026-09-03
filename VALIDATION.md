# Validation report — Veno Twitch Stability Fork 1.0.2 — 2026-09-03

## Automated mock-browser suite — passed (25/25 groups)

- uBlock resource header and invocation-token consistency.
- Full initializer execution in a mocked Twitch/browser environment.
- Route guards: a live channel initializes; VOD routes/embeds, collection-only embeds, clip hosts/paths, and official chat embeds/popouts do not. An empty `channel` cannot override a VOD, while a non-empty explicit `channel` is treated as live when stale `video`/`collection` parameters coexist.
- Duplicate-hook guard: an already-active VAFT/TwitchAdSolutions version is preserved and this fork refuses to layer over it.
- GraphQL scoping: only exact confirmed live PlaybackAccessToken operations are rewritten for string and URL-object requests; VOD, picture-in-picture/chat, unrelated, malformed, operation-name lookalikes, and lookalike-host requests remain untouched.
- Batched GraphQL handling changes only eligible live packets.
- Worker bridge rejects non-Twitch endpoints, unexpected operations, and operation-name substring lookalikes.
- Worker bridge strips unexpected forwarded headers.
- Stalled worker-bridge and primary media-playlist response-body reads settle through bounded fail-open paths; the latter returns the identical, still-readable original response.
- Generated worker bootloader compiles, embeds the already-prefetched source, performs one source read, cleans up only script-owned replacement Blobs, and ignores stale-worker messages.
- A rejected weak-signal Twitch worker remains unmodified without invalidating the current verified video worker.
- A live-to-excluded SPA transition disables current-worker playlist/bridge activity, leaves newly created workers unmodified, and safely re-enables the verified live worker on return.
- Active-worker crash recovery is deduplicated, waits through the rolling cooldown or temporary ineligibility on the existing monitor, and becomes inert after worker replacement.
- Twitch HLS v2 master parsing accepts a raw CDN media URL with no `.m3u8` suffix.
- `.m3u8` media URLs containing query strings are recognized.
- Rebuilt HLS responses preserve unrelated headers and remove stale content length/encoding headers.
- Synthetic playlist-processing failure resolves with the original readable response within the bounded test window; no pending/hung promise.
- Stalled auxiliary master probes and full backup searches resolve through bounded fail-open paths.
- Named post-reload minimal selection rejects an ad-contaminated candidate.
- Backup searches that become stale after an ad-break end or generation change return the untouched input without contaminating newer-break failure/cache/cycle state or causing late strip/reload side effects.
- Mixed ad/live playlists retain the correct recovery media sequence.
- Untrusted ad-pod metadata is clamped to a recovery budget of 1-8.
- Player-root video is preferred over an unrelated first page video.
- Explicit user-pause intent blocks tab-focus auto-resume.
- Repeated visibility changes retain one buffer-monitor timer.
- Worker-requested no-strip post-ad transition performs a soft source reset even when health metrics look good.
- Automatic early reloads ignore replaced-worker requests, honor the main-thread 15-second cooldown, signal suppression, and proceed only after cooldown when the player is not healthy.
- Confirmed wedge recovery bypasses the healthy-player shortcut and performs the expected two-stage pause/play then hard-reload recovery.
- Script-hidden video state is restored exactly when a node becomes primary or an initialized page navigates to an excluded VOD/chat route.
- Channel transitions clear stale recovery state while recording fresh player baselines; no drift interval survives the reset.

## Additional package checks — passed

- JavaScript syntax check using Node.js 24.20.0 after removing the one-line uBlock resource header.
- `node --check tests/validate.js`.
- `git diff --check` (line-ending conversion warnings only).
- PowerShell parser validation for `Start-Local-Resource-Server.ps1`.
- Static scans confirm removal of whole-body GraphQL blanking, direct `videos[0]` targeting, and unhandled `processAfter(response);` calls.

## Not validated

- Live Twitch playback or ad delivery.
- Every Firefox/Chromium version or extension combination.
- Every region, account cohort, channel, codec, quality ladder, embed experiment, or ad format.
- Future Twitch player/API changes.
- A generated bootloader running in a genuine browser Worker, real CDN timing, browser background throttling, and end-to-end uBlock Origin injection.

The tests demonstrate internal consistency and defensive behaviour; they do not prove universal live effectiveness.

## Reproduce locally

With Node.js installed, run `Run-Validation.cmd` or execute `node tests/validate.js`. The suite uses only Node's built-in modules and does not start browsers, servers, workers, or background processes.
