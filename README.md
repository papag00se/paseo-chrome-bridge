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
                        your active, logged-in tab
```

- **`bridge/`** — Node server. Agent-facing HTTP (`/health`, `/rpc`) and
  extension-facing WebSocket (`/ext`). Also implements the high-level `search`
  command with human-like pacing/jitter.
- **`extension/`** — MV3 extension. Connects out to the bridge and executes
  commands via the Chrome DevTools Protocol so keystrokes/clicks are *trusted*.
- **`plugin/`** — Optional Paseo plugin: auto-starts/monitors the bridge and
  shows a status panel (bridge running? extension connected? which UA?).

## Setup

### 1. Bridge
```bash
cd bridge
npm install
node server.mjs           # or: BRIDGE_PORT=8787 node server.mjs
```
(If you install the Paseo plugin, it starts this for you.)

### 2. Chrome extension (one time)
1. Open `chrome://extensions` and enable **Developer mode**.
2. **Load unpacked** → select this repo's `extension/` folder.
3. Keep a normal tab focused. Chrome shows a *"…is debugging this browser"*
   banner while a command runs — that is expected (`chrome.debugger`).

### 3. Paseo plugin (optional but nice)
```bash
paseo plugin install /absolute/path/to/chrome-bridge/plugin
paseo plugin ls
```
Open the **Chrome Bridge** sidebar item to see live status and Start/Stop.

## Driving it from the agent

The agent just makes localhost HTTP calls (e.g. via `bash`/`curl`):

```bash
# is everything connected?
curl -s http://127.0.0.1:8787/health

# search as you, with human pacing
curl -s -X POST http://127.0.0.1:8787/rpc \
  -H 'content-type: application/json' \
  -d '{"method":"search","params":{"query":"best ramen portland","engine":"google"}}'
```

### RPC methods (`POST /rpc  {method, params}`)

| method       | params                                                                 | does |
|--------------|------------------------------------------------------------------------|------|
| `search`     | `query`, `engine` (`google`\|`bing`\|`duckduckgo`), pacing overrides    | navigate → human-type → Enter → snapshot |
| `navigate`   | `url`, `waitMs?`                                                        | go to URL in the active tab |
| `type`       | `selector`, `text`, `clearFirst?`, `perCharMinMs?`, `perCharMaxMs?`     | focus + trusted per-char typing |
| `key`        | `key` (`Enter`\|`Tab`\|`Escape`\|`Backspace`)                           | trusted key event |
| `click`      | `selector`                                                             | trusted mouse click at element center |
| `waitText`   | `text`, `timeoutMs?`                                                    | wait until page contains text |
| `snapshot`   | `maxChars?`                                                            | `{title, url, text, links[]}` |
| `screenshot` | —                                                                      | `{dataUrl}` PNG |
| `eval`       | `expression`                                                          | evaluate JS, return value |

Pacing defaults (tunable per call): `perCharMinMs=55`, `perCharMaxMs=180`,
`thinkMinMs=500`, `thinkMaxMs=1500` — set these to match *your* natural cadence.

## Configuration

| Setting        | Where | Default |
|----------------|-------|---------|
| Bridge port    | `BRIDGE_PORT` env (server) + `BRIDGE_PORT` in `extension/background.js` | `8787` |
| Shared token   | `BRIDGE_TOKEN` env (server) + `BRIDGE_TOKEN` in `extension/background.js` | none |

If you set a token on the server, set the same value in `background.js` and
send `Authorization: Bearer <token>` on `/rpc` calls.

## Notes & limits

- The extension acts on the **active tab of the last-focused normal window**.
- `chrome.debugger` shows a persistent info bar while attached. Harmless.
- MV3 service workers sleep when idle; the extension reconnects automatically
  and a `chrome.alarms` keep-alive plus bridge pings keep the socket live.
- Typing uses CDP `Input.insertText` per character (trusted input events);
  Enter/keys use `Input.dispatchKeyEvent`.
- Be a good citizen: this is for automating *your own* activity at a human pace,
  not for scraping or evading rate limits.

## License

MIT
