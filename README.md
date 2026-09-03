# Veno Twitch Stability Fork

An experimental stability-focused Twitch live-stream ad-blocking resource for
the full version of uBlock Origin. It is based on a user-supplied
TwitchAdSolutions VAFT snapshot labelled v93 and is designed to fail open
instead of leaving playback stuck.

## Install from GitHub

Remove or disable other Twitch player/ad-blocking scripts first. Then set this
value in uBlock Origin's advanced settings:

```text
userResourcesLocation https://raw.githubusercontent.com/Veno89/Vblocker/main/veno-twitch-stable.js
```

Keep this rule under **My filters**:

```text
twitch.tv##+js(veno-twitch-stable)
```

Apply changes in both panes. Open uBlock Origin's **Dashboard -> Filter lists**,
click the clock beside **uBlock filters**, then click **Update now** and wait for
completion. Hard-refresh Twitch.

The Raw GitHub URL replaces the local resource server. You do not need to run
`Start-Local-Resource-Server.cmd` when using the hosted setup.

The repository must remain public because uBlock Origin fetches this URL
anonymously. `Veno89/Vblocker` is currently public. `main` is the moving stable
channel: it changes only when release-quality content is deliberately pushed,
while uBlock Origin sees that change on its resource-update schedule or after
the manual refresh above.

For an immutable version, replace `main` in the Raw URL with a full commit SHA.
That URL stays frozen and must be replaced manually to upgrade. See
[INSTALL.md](INSTALL.md) for detailed setup, rollback, and troubleshooting.

## Scope and validation

Version 1.0.2 targets live playback only. VODs, clips, collection-only embeds,
and chat-only embeds/popouts are left untouched. The included mock-browser suite
covers route guards, GraphQL scoping and deadlines, worker lifecycle, HLS
processing and deadlines, fail-open behavior, player targeting, recovery, and
timer cleanup. It does not replace live testing across Twitch's changing
account, region, browser, codec, and ad-delivery variations.

If a tab reaches a live channel through Twitch's in-page navigation from an
excluded VOD/chat/clip route, hard-refresh that live channel once. The resource
intentionally leaves workers created on excluded routes unmodified.

Run the local checks with:

```text
node tests/validate.js
```

## License

MIT. See [LICENSE.txt](LICENSE.txt).
