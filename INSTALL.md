# Install Veno Twitch Stability Fork 1.0.1 in uBlock Origin

This package is a **uBlock Origin user resource**. It is not a normal filter list, so installation requires both:

1. A URL to `veno-twitch-stable.js` in uBlock Origin's advanced `userResourcesLocation` setting.
2. The invocation rule `twitch.tv##+js(veno-twitch-stable)` in **My filters**.

Use the full uBlock Origin extension. Remove or disable any existing Twitch-specific player script first, including another VAFT resource, TTV-AB, Purple AdBlock, video-swap-new, or similar. Running two scripts that both hook Twitch's worker/player is a common cause of black screens and reload loops.

## Recommended setup: host the file at a pinned HTTPS URL

This is the cleanest option because uBlock Origin can load the resource whenever the browser starts.

1. Extract this ZIP.
2. Upload `veno-twitch-stable.js` **unchanged** to a public GitHub repository, public Gist, or another plain-text HTTPS host you control.
3. Copy the file's **raw** URL, not the normal HTML page URL. A commit-pinned permalink is safer than a moving branch URL because the code cannot change without you deliberately changing the URL.
4. Open the uBlock Origin dashboard.
5. Under **Settings**, enable **I am an advanced user**, then click the cogwheel beside it.
6. Find the line beginning with `userResourcesLocation` and replace `unset` with your raw URL. For example:

   ```text
   userResourcesLocation https://your-raw-host.example/veno-twitch-stable.js
   ```

   When another user-resource URL is already present, keep it and append the new URL separated by one space.
7. Open **My filters**, paste this line, and apply changes:

   ```text
   twitch.tv##+js(veno-twitch-stable)
   ```

8. Disable and re-enable uBlock Origin, or restart Firefox. Then hard-refresh Twitch with `Ctrl+F5`.

Open Firefox Developer Tools on a live channel and filter the console for `[AD DEBUG]`. Successful startup begins with:

```text
Veno Twitch Stability Fork v1.0.1 (VAFT v93 base) loading
```

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

- It runs only for live playback. Twitch VODs, clips, and chat-only popouts are left untouched.
- Playlist-processing exceptions return Twitch's original response instead of leaving playback waiting indefinitely.
- V2/raw CDN playlist URLs and `.m3u8` URLs with query strings are recognized.
- PlaybackAccessToken rewriting is restricted to confirmed live-stream operations. VOD and picture-in-picture/chat-player requests are unchanged.
- Worker-proxied requests are restricted to Twitch's GraphQL endpoint and expected operations.
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
3. Restart or disable/re-enable uBlock Origin.
4. Hard-refresh Twitch.

## Important limitation

This build passed syntax, mock-browser, GraphQL-scoping, worker-bridge, HLS V2/query, fail-open, and video-target tests. It was **not** live-tested across Twitch's account-, channel-, region-, browser-, codec-, and ad-cohort variations. Twitch can change its player and delivery logic at any time. Treat this as an experimental stability fork, not a permanent guarantee that every ad will be removed.
