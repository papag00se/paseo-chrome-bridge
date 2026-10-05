# Native desktop tools for Paseo agents

`desktop-server.mjs` is a standalone stdio MCP server using this machine's
Hyprland Lua dispatcher, grim, wtype and ydotool. It does not use OpenAI's
computer-control integration or Chrome Bridge to operate the desktop.

Registered globally for all currently enabled Paseo providers:

- Pi: `~/.config/mcp/mcp.json`, `desktop`, direct `desktop_*` tools.
- Codex: `~/.codex/config.toml`, `mcp_servers.desktop`.
- Claude: user-scoped `desktop` server in `~/.claude.json`.

New processes load these configurations. Existing agents need a runtime reload
(`paseo agent reload <id>`) to discover newly registered MCP tools. Disabled
providers and other operating-system accounts are outside this installation.
Normal provider permission settings still apply; this does not disable approval
policies. Chrome Bridge requirements in the existing Pi/Codex launch guards
remain in force.

Tools: desktop_status, desktop_screenshot, desktop_move, desktop_click,
desktop_type, desktop_key, desktop_scroll, desktop_drag. Images use logical
pixel scale 1; add the selected monitor or region origin to image coordinates.
The worker discovers the current Hyprland instance and Wayland socket, and
fails on ambiguous desktop sessions. Input operations and screenshots use one
shared flock, so individual calls from separate processes cannot overlap.
Whole multi-step workflows must still be coordinated between agents and the
human; window positions can change between calls. Take fresh screenshots.

`desktop_type` currently accepts ASCII only, at most 1000 characters per call.
This compositor drops non-ASCII wtype input; such text is explicitly rejected.
Typing uses stdin and never invokes a shell or modifies the clipboard.
Drag releases the mouse button in a finally block. Keys/modifiers are handled
by wtype, which releases modifiers on exit.

Do not use these tools to bypass a denied action, including accessing a blocked
browser-extension page through a screenshot or alternate control surface.

Validation: four worker tests, MCP discovery/status, and a real temporary GTK
window with region screenshots, clicks, ASCII text, Ctrl+A, End and Return.
The GTK window was closed after validation. Desktop operations were not tested
against the wallet extension or any blocked page.

```sh
node --test mcp/tests/desktop.test.mjs
```

Hyprland API reference: https://wiki.hypr.land/configuring/core/dispatchers/

Fresh Paseo Pi and Codex agents confirmed all eight desktop tools and no
cua_repl tools. Claude CLI confirmed its user-scoped desktop MCP server is
connected, but the disposable Claude agent could not run because its OAuth
session expired and refresh failed; Claude requires sign-in before model-level
verification can complete.
