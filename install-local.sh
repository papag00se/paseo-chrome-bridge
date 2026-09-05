#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
NODE=$(command -v node || true)

if [[ -z "$NODE" ]]; then
  echo "error: node is required" >&2
  exit 1
fi

for value in "$ROOT" "$NODE"; do
  if [[ "$value" == *$'\n'* ]]; then
    echo "error: paths containing newlines are not supported" >&2
    exit 1
  fi
done

echo "Installing Node dependencies..."
npm --prefix "$ROOT/bridge" install
npm --prefix "$ROOT/mcp" install

SERVICE_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$SERVICE_DIR/chrome-bridge.service"
mkdir -p "$SERVICE_DIR"

# Systemd supports quoted arguments. Escape the two characters that retain
# special meaning inside its double-quoted strings.
systemd_quote() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

ROOT_ESCAPED=$(systemd_quote "$ROOT")
NODE_ESCAPED=$(systemd_quote "$NODE")
cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Chrome Bridge (agent -> real Chrome)
Documentation=https://github.com/papag00se/chrome-bridge
After=default.target

[Service]
Type=simple
WorkingDirectory="$ROOT_ESCAPED/bridge"
Environment=BRIDGE_PORT=8787
ExecStart="$NODE_ESCAPED" "$ROOT_ESCAPED/bridge/server.mjs"
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

MCP_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/mcp/mcp.json"
mkdir -p "$(dirname "$MCP_CONFIG")"
MCP_CONFIG="$MCP_CONFIG" MCP_SERVER="$ROOT/mcp/server.mjs" "$NODE" <<'NODE'
import fs from "node:fs";

const path = process.env.MCP_CONFIG;
let config = {};
if (fs.existsSync(path)) {
  try {
    config = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`error: cannot parse existing MCP config ${path}: ${error.message}`);
    process.exit(1);
  }
}
config.mcpServers ??= {};
config.mcpServers.web = {
  command: process.execPath,
  args: [process.env.MCP_SERVER],
  directTools: true,
  toolPrefix: "none",
};
const temporary = `${path}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, path);
NODE

systemctl --user daemon-reload
systemctl --user enable --now chrome-bridge.service

echo
echo "Installed and started: $SERVICE_FILE"
echo "Registered Pi/Paseo MCP tools in: $MCP_CONFIG"
echo "Next: load $ROOT/extension as an unpacked Chrome extension."
echo "Start a new agent session (or reload it) to discover web_search/web_fetch."
