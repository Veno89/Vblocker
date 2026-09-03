# Validation report — 2026-09-03

## Passed

- uBlock resource header and invocation-token consistency.
- JavaScript syntax check using Node.js 22.16.0 after removing the one-line uBlock resource header.
- Full initializer execution in a mocked Twitch/browser environment.
- Route guards: live channel initializes; VOD route, VOD embed, and chat-only popout do not initialize.
- Duplicate-hook guard: an already-active VAFT/TwitchAdSolutions version is preserved and this fork refuses to layer over it.
- GraphQL scoping: confirmed live PlaybackAccessToken player type is rewritten for both string and URL-object requests; VOD, picture-in-picture/chat, unrelated, malformed, and lookalike-host requests remain untouched.
- Batched GraphQL handling changes only eligible live packets.
- Worker bridge rejects non-Twitch endpoints, unexpected operations, and operation-name substring lookalikes.
- Worker bridge strips unexpected forwarded headers.
- Twitch HLS v2 master parsing accepts a raw CDN media URL with no `.m3u8` suffix.
- `.m3u8` media URLs containing query strings are recognized.
- Rebuilt HLS responses preserve unrelated headers and remove stale content length/encoding headers.
- Synthetic playlist-processing failure resolves with the original readable response within the bounded test window; no pending/hung promise.
- Player-root video is preferred over an unrelated first page video.
- Explicit user-pause intent blocks tab-focus auto-resume.
- Static scans confirm removal of whole-body GraphQL blanking, direct `videos[0]` targeting, and unhandled `processAfter(response);` calls.

## Not validated

- Live Twitch playback or ad delivery.
- Every Firefox/Chromium version or extension combination.
- Every region, account cohort, channel, codec, quality ladder, embed experiment, or ad format.
- Future Twitch player/API changes.

The tests demonstrate internal consistency and defensive behaviour; they do not prove universal live effectiveness.

## Reproduce locally

With Node.js installed, run `Run-Validation.cmd` or execute `node tests/validate.js`. The suite uses only Node's built-in modules and does not start browsers, servers, workers, or background processes.
