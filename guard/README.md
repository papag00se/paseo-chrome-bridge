# Chrome Bridge enforcement for Pi and Codex in Paseo

`codex.mjs` launches Codex with **`CODEX_HOME=~/.paseo/codex-home`**.
Its configuration is independent of `~/.codex/config.toml`, which Codex Desktop
rewrites on startup. Launch-time `-c` exclusions disable `cua_repl`, `node_repl`,
and bundled browser/Chrome/computer-use plugins, including against project config.
Direct requests to restricted MCP servers are rejected at that operation only.

**Ordinary turns, resume, steering, notifications and shell work never depend on
MCP inventory or browser health.** Missing browser tools or a disconnected
companion fail the actual browser operation, not the entire session.

Initialize once with `python guard/isolate-codex.py`. This preserves existing
thread ids using consistent SQLite backups. Credentials, rollout history,
attachments and thread locks remain shared; config and database indexes are
private. No Desktop plugin/runtime/IPC directory is linked. Never rerun this
script to overwrite an established private home or synchronize Desktop config.

## Example launch path

The Codex provider command in `/home/you/.paseo/config.json` is:

```json
[
  "/usr/bin/node",
  "/home/you/Work/chrome-bridge/guard/codex.mjs",
  "--upstream",
  "/home/you/.local/share/mise/installs/codex/latest/bin/codex"
]
```

Paseo appends `app-server` and its normal arguments. The upstream path follows
the installed CLI's `latest` location. Version/help diagnostics pass through.
Alternate app-server transports and CLI execution modes are rejected.

After provider configuration changes, run `paseo reload --json`. Require
`agents.providers` in `appliedPaths` and verify `paseo provider diagnostic codex
--json` shows this wrapper. Existing running app-server processes cannot be
retrofitted; open a new agent or refresh/reopen an existing agent so it starts
through the new command. A daemon restart is not required for this provider
configuration change.

Restricted direct tool calls return `CHROME_BRIDGE_GUARD` for that operation;
subsequent ordinary turns continue. Inventory inspection is not a work gate.
Chrome may be closed during non-browser work; there is no fallback to OpenAI's
browser integration.

**Deployment is not complete merely because the file or failing sessions were
updated.** Every old live Node launcher retains its old code. A current turn can
finish successfully and the next turn can still hit the previous inventory gate.
Reload **all** idle/errored Codex agents, not just those with guard errors. Leave
active turns alone, but record them as pending migration and reload when idle.
Do not restart the daemon. Then run `python guard/audit-runtime.py`: it must
report zero legacy/unrestricted children, checking both actual child `CODEX_HOME`
and launch-time exclusions. Do not claim all sessions are fixed while any old
launcher remains.

## Verification

```sh
node --test guard/codex.test.mjs
python guard/audit-runtime.test.py
python guard/audit-runtime.py
```

Tests exercise real child-process stdio: broken discovery cannot block ordinary
work; restricted calls fail individually; subsequent turns continue; approved
browser calls pass through; and launch-time exclusions remain installed.

The Codex gateway covers Paseo's configured **Codex provider**. The separate Pi
gateway below covers Paseo's **Pi provider**, including Pi using openai-codex models.
Direct terminal launches and the ChatGPT app do not run through these gateways. The disabled
OpenAI plugin settings in `~/.codex/config.toml` apply only to ordinary Codex
launches, not Paseo's isolated Codex provider. Like the
provider configuration itself, this user-owned code can be changed by the
account owner; it is not an OS security boundary against someone with write
access to the files.

Changing tool registration does not authorize bypassing a blocked action.

## Pi in Paseo

The Pi provider command in `~/.paseo/config.json` now starts `/usr/bin/node`
with `guard/pi.mjs --upstream /home/you/.local/share/mise/installs/pi/latest/pi/pi`,
preserving the previous `--exclude-tools` setting. The gateway appends the
explicit `pi-extension.ts` extension and uses Pi's RPC protocol. Pi's
`openai-codex` model provider does not make the Codex app-server guard apply;
this is a separate launch path and a separately tested guard.

Before forwarding prompt, steer, follow_up, compact, or bash requests, the
Pi gateway checks that its inventory command is registered, then obtains the
actual Pi tool inventory through that command.
The inventory requires all eight `web_*` tools to be active and rejects
callable `cua_repl`/`node_repl` tools or unified-computer-use source metadata.
Missing guard extension, missing tools, and unknown or timed-out inventory
results reject the work with `CHROME_BRIDGE_GUARD`.
No model request is used to perform this check. The extension also validates
ordinary input and blocks tool calls when the inventory violates the rule,
including banned targets through the generic `mcp` adapter tool.

This checks Pi's loaded tool names/source metadata;
it is not cryptographic attestation of the tool implementations. Trusted local
extensions and writable configuration remain under the account owner's control.
Pi runs launched before this configuration change are not retrofitted. Start a
new Pi agent to obtain the guard. Chrome need not be open for non-browser
work. The provider reload applied without a daemon restart.

Pi integration tests use the installed Pi binary, real tool discovery, a harmless
shell probe, and an inert test tool registration. They never call a browser tool
or a model. Chrome does not need to be running:

```sh
python guard/pi.integration.test.py
```

The unit and integration fixtures verify tool discovery without model inference. Replace the example home directory and upstream executable paths with your own before configuring a provider.
