# Background trusted-input validation

## Reproduction and fix
The live `web_click` call acknowledged a click on a harmless localhost button,
but its listener recorded no event while the Paseo tab was in the background.
The extension already addressed CDP commands to the dedicated tab; the earlier
explanation that input was being sent to the foreground tab was not established.

`attach()` now enables `Emulation.setFocusEmulationEnabled` on the dedicated CDP
target before commands. It does not activate tabs or focus windows, and errors
stop input rather than silently falling back to synthetic DOM events.

## Automated checks
`node --test mcp/tests/*.test.mjs`: **10 passed**.
Actual extension handlers run against isolated Chromium CDP sessions, including
trusted click/input/key behavior, target isolation, cached attachments, and
failure propagation before input.

## Live browser check
The follow-up found the live bridge delivering trusted input already; no further
reload was initiated in that follow-up and Chrome was not restarted. The exact
reload/reconnection mechanism was not observed. Functional verification used
only `http://127.0.0.1:18787/`, a temporary local fixture with no external requests:

- Click listener received `isTrusted: true`.
- Typing `test` generated four trusted input events on the fixture's input.
- Enter generated a trusted keydown on the same input.
- Another click after more than the two-second idle-detach interval was trusted.
- Native window-title observations showed the foreground Chrome tab on Daz 3D,
  then the user's Gmail inbox, not the test page. No foreground activation was
  requested by the test. No screenshots were needed for this live follow-up.
- No email, account form, or purchase was used to test input.

The temporary HTTP fixture server is stopped after validation. Source changes
are limited to Chrome Bridge; Daz content and recovery work are untouched.
