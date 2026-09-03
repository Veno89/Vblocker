# Install Veno Twitch Stability Fork 1.0.2 in uBlock Origin

This package is a **uBlock Origin user resource**. It is not a normal filter list, so installation requires both:

1. A URL to `veno-twitch-stable.js` in uBlock Origin's advanced `userResourcesLocation` setting.
2. The invocation rule `twitch.tv##+js(veno-twitch-stable)` in **My filters**.

Use the full uBlock Origin extension. Remove or disable any existing Twitch-specific player script first, including another VAFT resource, TTV-AB, Purple AdBlock, video-swap-new, or similar. Running two scripts that both hook Twitch's worker/player is a common cause of black screens and reload loops.

## Recommended setup: use the public GitHub copy

This is the cleanest option because uBlock Origin can load the resource without a local terminal or server. The repository must remain public: uBlock Origin fetches the raw file anonymously and cannot use your GitHub login for a private repository.

1. Open the uBlock Origin dashboard.
2. Under **Settings**, enable **I am an advanced user**, then click the cogwheel beside it.
3. Find the line beginning with `userResourcesLocation` and replace `unset` with this raw URL:

   ```text
   userResourcesLocation https://raw.githubusercontent.com/Veno89/Vblocker/main/veno-twitch-stable.js
   ```

   When another user-resource URL is already present, keep it and append the new URL separated by one space.
4. Open **My filters**, paste this line, and apply changes:

   ```text
   twitch.tv##+js(veno-twitch-stable)
   ```

5. Apply changes in both panes. Open uBlock Origin's **Dashboard -> Filter lists**, click the clock beside **uBlock filters**, then click **Update now** and wait for completion. Hard-refresh Twitch with `Ctrl+F5`.

`main` is the moving stable channel. It changes only when release-quality content is deliberately pushed, while uBlock Origin sees that change on its resource-update schedule or after the manual refresh above. To freeze a tested build, replace `main` with the full commit SHA you want; that URL must be replaced manually to upgrade. A normal GitHub page URL is not valid here—it must be the `raw.githubusercontent.com` file URL.

Open Firefox Developer Tools on a live channel and filter the console for `[AD DEBUG]`. Successful startup begins with:

```text
Veno Twitch Stability Fork v1.0.2 (VAFT v93 base) loading
```

If the tab reaches a live channel through Twitch's in-page navigation from an
excluded VOD/chat/clip route, hard-refresh the live channel once. Workers
created on excluded routes are deliberately left unmodified.

## Local Windows setup: no upload required

Firefox extensions generally cannot rely on an arbitrary local file path, so this package includes a tiny loopback-only resource server.

1. Keep all extracted files together in the same folder.
2. Double-click `Start-Local-Resource-Server.cmd`.
3. Leave that terminal window open while enabling/restarting uBlock Origin and testing the resource.
4. Use this value in advanced settings:

   ```text
   userResourcesLocation http://127.0.0.1:8765/veno-twitch-stable.js
   ```

5. Add the same My filters rule:

   ```text
   twitch.tv##+js(veno-twitch-stable)
   ```

The server binds only to `127.0.0.1`, serves only this JavaScript file plus a health endpoint, starts no detached/background process, and stops when you press `Ctrl+C` or close its window. Re-run it whenever uBlock Origin needs to load or refresh the resource.

## What this stability fork deliberately changes

- It runs only for live playback. Twitch VOD routes/embeds, collection-only embeds, clips, and chat-only embeds/popouts are left untouched.
- Playlist-processing exceptions return Twitch's original response instead of leaving playback waiting indefinitely.
- Auxiliary health, backup-playlist, and worker GraphQL operations have hard deadlines that include response-body reads.
- V2/raw CDN playlist URLs and `.m3u8` URLs with query strings are recognized.
- Backup responses must be valid HLS before they can be cached or selected.
- PlaybackAccessToken rewriting is restricted to confirmed live-stream operations. VOD and picture-in-picture/chat-player requests are unchanged.
- Worker-proxied requests are restricted to Twitch's GraphQL endpoint and expected operations.
- Replaced workers cannot issue stale player actions, and visibility changes keep one monitor loop.
- Player actions prefer the actual Twitch-owned video element instead of the first video anywhere on the page.
- Manual mute and pause intent are respected more conservatively.
- The unstable 360p/autoplay fallback and synthetic ad-completion beacons are off by default.

The conservative defaults favour a visible ad or a brief pause over an aggressive recovery loop that repeatedly destroys and rebuilds the player.

## Optional aggressive fallback

Only use this after confirming Source-tier backups consistently fail. Open the Twitch console, run:

```js
localStorage.setItem('twitchAdSolutions_preferLowQualityBackup', 'true');
localStorage.setItem('twitchAdSolutions_fastAutoplayFirstTry', 'false');
location.reload();
```

This permits the lower-quality autoplay ladder as a last resort and can increase the risk of loading circles or quality-restoration problems.

Reset it with:

```js
localStorage.removeItem('twitchAdSolutions_preferLowQualityBackup');
localStorage.removeItem('twitchAdSolutions_fastAutoplayFirstTry');
location.reload();
```

## Optional package validation

The resource has already been validated in this package. With Node.js installed, you can reproduce the mock-browser tests by double-clicking `Run-Validation.cmd`, or by running:

```text
node tests/validate.js
```

The test runner uses only Node's built-in modules and launches no browser, server, worker, watcher, or background process.

## Removal and rollback

1. Delete or comment out `twitch.tv##+js(veno-twitch-stable)` under **My filters**.
2. Remove this resource URL from `userResourcesLocation`, or restore the value to `unset` when it was the only URL.
3. Apply changes, refresh **uBlock filters** from **Dashboard -> Filter lists**, and wait for completion.
4. Hard-refresh Twitch.

## Important limitation

This build passed syntax and 25 mock-browser regression groups covering route scope, GraphQL scoping/deadlines, worker lifecycle, HLS V2/query handling, bounded fail-open recovery, player targeting, reload behavior, and timer/state cleanup. It was **not** live-tested across Twitch's account-, channel-, region-, browser-, codec-, and ad-cohort variations. Twitch can change its player and delivery logic at any time. Treat this as an experimental stability fork, not a permanent guarantee that every ad will be removed.
