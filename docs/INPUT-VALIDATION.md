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
`node --test mcp/tests/*.test.mjs bridge/tests/*.test.mjs guard/*.test.mjs`: **28 passed**.
Actual extension handlers run against isolated Chromium CDP sessions, including
trusted click/input/key behavior, target isolation, cached attachments, and
failure propagation before input.

## Native forms and rich-text regression (0.3.0)

Profile editing exposed three additional failures: only four keys were available, `Input.insertText` did not select native dropdown options, and `clearFirst` ignored contenteditable contents. Clicking an `<option>` also reported success despite its zero-size page rectangle.

The new select handler opens the native popup using trusted keys, navigates past disabled choices, commits once, and verifies the selected index. Real Chromium tests prove exact label/value/index selection, a single trusted change per selection, no form submission, no adjacent-control mutation, no extra change for an unchanged choice, and errors for missing/disabled/ambiguous choices.

Editor tests cover replacing existing rich text, clearing to empty, replacing a number field, preserving adjacent fields, a 10,500-character textarea insertion without pacing/timeouts, trusted input events, password/readonly rejection, and maxlength rejection before mutation. Keyboard tests cover Shift+Arrow selection, Control+A/Delete, direct letters, bounded repetitions, and invalid keys/modifiers. Click tests prove invisible/disabled/obscured/native-option failures produce no mouse input. Explicit focus activates only the requesting agent's tab and window without navigation.

Browser-coordinate click tests exercise a non-semantic custom control and double-click detail. Wheel input scrolls a nested list without scrolling the outer page. Out-of-viewport/incomplete coordinates, ambiguous click targets, and unbounded scroll deltas are rejected.

MCP tests cover discovery and forwarding for all twelve tools, dropdown choice validation before RPC, expanded keyboard parameters, long fills, explicit focus, selected-option/checkbox state, and continued omission of field/option values. These tests use an isolated browser, not a live account form. Activation instructions are in [REFERENCE.md](REFERENCE.md#activating-an-update).

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
