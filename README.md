# Veno Twitch Stability Fork

An experimental stability-focused Twitch live-stream ad-blocking resource for
the full version of uBlock Origin. It is based on the TwitchAdSolutions VAFT
v93 script and is designed to fail open instead of leaving playback stuck.

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

Apply the changes, restart the browser or disable and re-enable uBlock Origin,
then hard-refresh Twitch.

The Raw GitHub URL replaces the local resource server. You do not need to run
`Start-Local-Resource-Server.cmd` when using the hosted setup.

For an immutable version, replace `main` in the Raw URL with a full commit SHA.
See [INSTALL.md](INSTALL.md) for detailed setup, rollback, and troubleshooting
instructions.

## Scope and validation

Version 1.0.1 targets live playback only. VODs, clips, and chat-only popouts are
left untouched. The included mock-browser test suite covers route guards,
GraphQL scoping, worker restrictions, HLS processing, fail-open behavior, and
player targeting. It does not replace live testing across Twitch's changing
account, region, browser, codec, and ad-delivery variations.

Run the local checks with:

```text
node tests/validate.js
```

## License

MIT. See [LICENSE.txt](LICENSE.txt).
