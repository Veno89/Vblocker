START HERE
==========

Open INSTALL.md.

You need the My filters rule and one userResourcesLocation:

My filters:
  twitch.tv##+js(veno-twitch-stable)

Recommended hosted userResourcesLocation:
  https://raw.githubusercontent.com/Veno89/Vblocker/main/veno-twitch-stable.js

Alternative local Windows userResourcesLocation:
  http://127.0.0.1:8765/veno-twitch-stable.js

The GitHub repository must remain public. With this hosted URL, the local Windows server is not needed.

Optional regression validation (Node.js required):
  Run-Validation.cmd

For integrity verification:
  SHA256SUMS.txt

Historical diff only: user-supplied VAFT v93 snapshot -> v1.0.1.
AUDIT-DIFF.patch does not contain v1.0.2 changes; Git history covers v1.0.1 -> v1.0.2.
