# chrome-bridge

Let a Paseo agent drive **your real, logged-in Chrome** — the same model as the
Claude/Codex browser extensions. A companion Chrome extension runs *inside* your
existing browser and executes commands sent over a **localhost bridge**. Because
it is your actual browser instance, you get your real profile, cookies, logins,
Chrome user-agent, canvas/WebGL/font fingerprint, and IP — with **no separate
browser launch, no `--remote-debugging-port` relaunch, and no profile lock
conflict**. Keep browsing normally while it works.

> Nothing in this repo contains secrets or personal data. The bridge binds to
> `127.0.0.1` only. An optional `BRIDGE_TOKEN` restricts access to callers that
> know the token.

## Architecture

```
Paseo agent ──HTTP POST /rpc──▶ bridge (Node, 127.0.0.1:8787)
                                   │  ws://127.0.0.1:8787/ext
                                   ▼
                        Chrome extension (MV3, in YOUR Chrome)
                                   │  chrome.debugger (CDP, trusted input)
                                   ▼
                        one background tab per agent
```

- **`bridge/`** — Node server. Agent-facing HTTP (`/health`, `/rpc`) and
  extension-facing WebSocket (`/ext`). Also implements the high-level `search`
  command with human-like pacing/jitter.
- **`extension/`** — MV3 extension. Connects out to the bridge and executes
  commands via the Chrome DevTools Protocol so keystrokes/clicks are *trusted*.
- **`plugin/`** — Optional Paseo plugin: auto-starts/monitors the bridge and
  shows a status panel (bridge running? extension connected? which UA?).
- **`mcp/`** — Stdio MCP server that presents the bridge to agents as
  **`web_search`** and **`web_fetch`** tools, so agents reach for it without
  prompting.

## Setup

### 1. Local setup

The installer uses the checkout's actual path and the current Node executable,
installs dependencies, generates a systemd user service, and merges the Pi/Paseo
MCP registration into the existing global MCP config without replacing other
servers:

```bash
./install-local.sh
```

It writes only machine-local files under `~/.config`; no credentials are copied
into the repository. To run the bridge manually instead:

```bash
cd bridge
npm install
node server.mjs           # or: BRIDGE_PORT=8787 node server.mjs
```

(If you install the Paseo plugin, it can also start the bridge.)

### 2. Chrome extension (one time)
1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this repo's `extension/` folder.
3. Keep a normal tab focused. Chrome shows a *"…is debugging this browser"*
   banner while a command runs — that is expected (`chrome.debugger`).

### 3. Keep the bridge running (pick one)

**A. systemd user service (recommended — zero babysitting).** Auto-starts on
login, auto-restarts on crash, and survives Paseo restarts. `./install-local.sh`
generates and enables the unit using the checkout's actual path. See
`chrome-bridge.service.example` for the sanitized template.

```bash
systemctl --user status chrome-bridge.service
# optional: run even before you log in
# loginctl enable-linger "$USER"
```

**B. Paseo plugin (status panel).** For Paseo 0.11.2–0.11.x:

```bash
cd ~/Work/chrome-bridge/plugin
npm ci --legacy-peer-deps
paseo plugin install "$PWD"
```

Open the plugin panel in Paseo to start and monitor the bridge. Its launcher expects the checkout at `~/Work/chrome-bridge`; the repository is named `paseo-chrome-bridge` on GitHub. The plugin probes the port before starting the bridge, so it can coexist with the systemd service.

## Driving it from the agent

### Option A: MCP tools (`web_search` / `web_fetch`) — recommended

Agents already understand these tool names, so no prompting is needed. One-time
setup:

```bash
cd mcp && npm install
```

Register the server with your agent(s):

```bash
# Claude Code (all projects)
claude mcp add --scope user web -- node /absolute/path/to/chrome-bridge/mcp/server.mjs

# Codex (~/.codex/config.toml)
# [mcp_servers.web]
# command = "node"
# args = ["/absolute/path/to/chrome-bridge/mcp/server.mjs"]
```

Pi/Paseo (`~/.config/mcp/mcp.json`) — `directTools` + `toolPrefix: "none"`
register the tools top-level under their exact names instead of behind the `mcp`
gateway. Use this global path because Paseo supplies its own temporary
`--mcp-config`; Pi merges the global config alongside it:

```json
{
  "mcpServers": {
    "web": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-bridge/mcp/server.mjs"],
      "directTools": true,
      "toolPrefix": "none"
    }
  }
}
```

`./install-local.sh` creates or merges this entry automatically using the
checkout's actual path. Restart the agent session (or `/reload` in Pi) after
editing MCP config—servers are read at session start.

The MCP server honors `BRIDGE_PORT` / `BRIDGE_TOKEN` environment variables if
you changed the defaults. `web_search` maps to the bridge `search` method;
`web_fetch` maps to the bridge's atomic `fetch` method (navigate plus rendered
text/link extraction from your logged-in Chrome).

### Option B: raw HTTP

The agent just makes localhost HTTP calls (e.g. via `bash`/`curl`):

```bash
# is everything connected?
curl -s http://127.0.0.1:8787/health

# search as you, with human pacing
curl -s -X POST http://127.0.0.1:8787/rpc \
  -H 'content-type: application/json' \
  -d '{"method":"search","params":{"query":"best ramen portland","engine":"google"}}'
```

### RPC methods (`POST /rpc  {method, params, session?}`)

`session` names the caller's tab. Calls without it share one tab (`shared`).

| method       | params                                                                 | does |
|--------------|------------------------------------------------------------------------|------|
| `search`     | `query`, `engine` (`google`\|`bing`\|`duckduckgo`), `limit?`, `focus?`, pacing | navigate → human-type → Enter → parsed `results` |
| `fetch`      | `url`, `waitMs?`, `maxChars?`                                          | atomic navigate + snapshot |
| `navigate`   | `url`, `waitMs?`                                                        | go to URL in the session's tab |
| `type`       | `selector`, `text`, `clearFirst?`, `perCharMinMs?`, `perCharMaxMs?`     | focus + trusted per-char typing |
| `key`        | `key`, `modifiers?` (`Alt`, `Control`, `Meta`, `Shift`), `repeat?` (1–100) | trusted navigation/editing key or ASCII letter/digit |
| `fill`       | `selector`, `text`                                                      | replace an editable field with one trusted insertion |
| `select`     | `selector`, exactly one of `label`, `value`, `index` (zero-based)          | commit and verify a native single-select choice |
| `focus`      | —                                                                      | reveal this session's existing tab/window without navigation |
| `click`      | `selector` or viewport `x`/`y`, `button?`, `clickCount?` (1–3)              | trusted mouse click at a control or screenshot point |
| `scroll`     | `selector?`, `deltaX?`, `deltaY?` (pixels, ±10,000)                         | trusted wheel input on the page or nested list |
| `waitText`   | `text`, `timeoutMs?`                                                    | wait until page contains text |
| `snapshot`   | `maxChars?`                                                            | `{title, url, text, links[]}` |
| `results`    | `limit?`                                                              | Google-aware `{query, count, results:[{rank,title,url,snippet}]}` |
| `openResult` | `n` (1-based), `focus?`, `maxChars?`                                   | human-paced trusted click into the Nth result → `{opened, target, page}` |
| `screenshot` | —                                                                      | `{dataUrl}` PNG |
| `eval`       | `expression`                                                          | evaluate JS, return value |

Pacing defaults (tunable per call): `perCharMinMs=55`, `perCharMaxMs=180`,
`thinkMinMs=500`, `thinkMaxMs=1500` — set these to match *your* natural cadence.

## Profile forms and editor controls

The MCP surface includes `web_fill`, `web_select`, `web_scroll`, and `web_focus` in addition to search, fetch, snapshot, click, type, key, wait, and screenshot. Examples:

```json
{"name":"web_select","arguments":{"selector":"#start-month","label":"February"}}
{"name":"web_select","arguments":{"selector":"#start-year","value":"2022"}}
{"name":"web_key","arguments":{"key":"ArrowDown","repeat":2}}
{"name":"web_key","arguments":{"key":"Tab","modifiers":["Shift"]}}
{"name":"web_key","arguments":{"key":"a","modifiers":["Control"]}}
{"name":"web_fill","arguments":{"selector":"#work-history","text":"Detailed work history..."}}
{"name":"web_click","arguments":{"x":400,"y":250,"clickCount":2}}
{"name":"web_scroll","arguments":{"selector":"#options-list","deltaY":400}}
{"name":"web_focus","arguments":{}}
```

- Supported named keys: Enter, Tab, Escape, Backspace, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown, Space. ASCII letters and digits are also supported. Modifiers describe shortcuts; literal letters use the casing provided in `key`.
- `web_select` addresses native single selects, including placeholder and disabled options. It rejects ambiguous labels/values, disabled options/controls, multiple selects, and listboxes (`size > 1`). The native popup is opened with Alt+ArrowDown, navigated before committing with Enter, and the resulting selected index is verified. This emits one trusted change, not a series of intermediate autosaves. Custom comboboxes still use click/type/key. Do not click native `<option>` elements: their layout rectangles are not clickable page coordinates.
- `web_fill` replaces up to 20,000 characters in an input, textarea, or contenteditable with trusted input, without a clipboard or per-character delays. `web_type` remains paced and limited to 1,000 characters. `clearFirst` selects only the target editor's contents and deletes them even when the replacement is empty. Password fields, non-editable fields, and replacements exceeding a field's maxlength are rejected before mutation. Typing or filling a select is an error, never a fake success.
- `web_snapshot` adds `checked` for checkboxes/radios and ARIA check controls. Native selects expose `multiple` and up to 500 `options` with `index`, `label`, `selected`, `disabled`, plus `optionsTruncated`. Option values and ordinary field values are deliberately omitted. ARIA options/checkboxes/radios/menu items and keyboard-focusable controls are discoverable.
- Selector-based `web_click` rejects native options, zero-size/hidden, disabled, and obscured controls before mouse input. Coordinate clicks require a complete x/y pair within the current browser viewport, from a fresh `web_screenshot`, never desktop coordinates. Clicks support left/right/middle buttons and click counts 1–3. The tool never substitutes a DOM click.
- `web_scroll` sends wheel input at the viewport center or the center of a visible selector, enabling nested menus and dialog scrolling without desktop control. Positive deltas scroll down/right; inspect afterward because wheel input does not guarantee an element can scroll.
- `web_focus` is the only explicit foreground operation. Routine commands remain on the agent's own background target. Use it when the user needs to see or take over the page.

### Activating an update

Reload the unpacked extension from `chrome://extensions`, then refresh/reconnect the agent's MCP server so it discovers the new tools and keyboard schema. A Chrome or Paseo daemon restart is unnecessary. Existing MCP server processes have already imported their tool definitions and do not hot-reload source edits. If your agent cannot refresh its MCP connection, start a fresh agent **after saving the current form**: ending the old agent releases its tab. Extension reload itself preserves the live-session tab mapping in `chrome.storage.session`.

## Configuration

| Setting        | Where | Default |
|----------------|-------|---------|
| Bridge port    | `BRIDGE_PORT` env (server) + `BRIDGE_PORT` in `extension/background.js` | `8787` |
| Shared token   | `BRIDGE_TOKEN` env (server) + `BRIDGE_TOKEN` in `extension/background.js` | none |

If you set a token on the server, set the same value in `background.js` and
send `Authorization: Bearer <token>` on `/rpc` calls.

## Agents, tabs and Google pacing

- **One tab per agent.** The MCP server runs once per agent and tags every call
  with its own session id. The extension keeps a separate background tab for
  each session, so two agents never type into the same page. The session to tab
  map is kept in `chrome.storage.session`, so a sleeping service worker does not
  lose track of tabs.
- **In order within an agent, side by side across agents.** The bridge runs one
  session's commands strictly in order. Different sessions do not wait for each
  other. If a caller disconnects while its command is still queued, the command
  is dropped, never executed.
- **Tabs close when the agent ends.** The MCP server holds `GET /session?id=…`
  open for its whole life. When the agent process ends, for any reason, the OS
  drops that connection and the bridge closes the agent's tab. When the
  extension reconnects, the bridge sends the list of live sessions and the
  extension closes every other agent tab.
- **Google searches share one cooldown.** All agents search through the same
  real browser, so simultaneous searches would look automated. Every call that
  loads a Google results page (`search` on Google, or `fetch`/`navigate` to
  `google.<tld>/search`) reserves the next slot 25–40 s after its own start. A
  call inside that window is not run. It gets HTTP 429 with `Retry-After`
  (seconds) and `{"ok": false, "error": "RATE_LIMITED", "retryAfterMs": …}`.
  The MCP tool turns that into "RATE_LIMITED — retry in N seconds … call this
  same tool again", so agents wait and retry instead of giving up. The spacing
  values live in `bridge/constants.mjs`.

## Notes & limits

- **Chrome must be running.** The extension lives inside Chrome, so nothing can
  drive (or launch) the browser while it is closed — same as the Claude/Codex
  extensions.
- Agent tabs are **background tabs** in a "Paseo" tab group, created on
  demand. They never hijack the tab you are viewing, and never touch app/PWA
  windows (e.g. Discord installed as a Chrome web app). Pass `"focus": true` to
  `navigate` to bring the agent's tab to the front.
- `chrome.debugger` shows a persistent info bar while attached. Harmless.
- MV3 service workers sleep when idle; the extension reconnects automatically
  and a `chrome.alarms` keep-alive plus bridge pings keep the socket live.
- CDP `Emulation.setFocusEmulationEnabled` prepares the agent's tab before
  commands, including cached debugger attachments. This does not activate a tab
  or focus a desktop window. Failure is returned before input is dispatched;
  there is no synthetic DOM-click fallback. Reload the unpacked extension after
  changing its source (`chrome://extensions` → Chrome Bridge → Reload).
- Typing uses CDP `Input.insertText` per character (trusted input events);
  Enter/keys use `Input.dispatchKeyEvent`.
- Regression tests execute the actual extension handlers against isolated
  Chromium CDP targets, checking trusted clicks, typing, keys, target isolation,
  and failure before input when focus preparation is unavailable.
- Be a good citizen: this is for automating *your own* activity at a human pace,
  not for scraping or evading rate limits.

## License

MIT
