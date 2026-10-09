import type { PluginServerContext } from "@getpaseo/plugin/server";
import { bridgeStart, bridgeStatus, bridgeStop } from "../shared/contracts";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const bridgeDir = resolve(homedir(), "Work", "chrome-bridge", "bridge");
const serverPath = resolve(bridgeDir, "server.mjs");

let child: ChildProcess | null = null;

function isRunning(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

async function start(): Promise<{ ok: boolean; detail: string }> {
  if (isRunning()) return { ok: true, detail: "already running" };
  // If a bridge (e.g. a systemd user service) is already serving this port,
  // don't spawn a competing one. health() only reaches these details when the
  // HTTP probe succeeds, i.e. a bridge is already listening.
  const existing = await health();
  if (existing.detail === "extension connected" || existing.detail === "waiting for extension") {
    return { ok: true, detail: "external bridge already running" };
  }
  try {
    child = spawn("/usr/bin/node", [serverPath], {
      cwd: bridgeDir,
      env: { ...process.env, BRIDGE_PORT: String(PORT) },
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      console.log(`[chrome-bridge] server exited code=${code}`);
      child = null;
    });
    child.on("error", (err) => {
      console.error(`[chrome-bridge] spawn error: ${err.message}`);
      child = null;
    });
    return { ok: true, detail: `spawned ${serverPath}` };
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) };
  }
}

function stop(): { ok: boolean; detail: string } {
  if (!isRunning()) return { ok: false, detail: "not running" };
  child!.kill("SIGTERM");
  child = null;
  return { ok: true, detail: "stopped" };
}

async function health(): Promise<{ connected: boolean; ua: string | null; detail: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (!res.ok) return { connected: false, ua: null, detail: `http ${res.status}` };
    const body = (await res.json()) as {
      extensionConnected?: boolean;
      extension?: { userAgent?: string } | null;
    };
    return {
      connected: !!body.extensionConnected,
      ua: body.extension?.userAgent ?? null,
      detail: body.extensionConnected ? "extension connected" : "waiting for extension",
    };
  } catch (err) {
    return { connected: false, ua: null, detail: String(err instanceof Error ? err.message : err) };
  }
}

export default function contribute(plugin: PluginServerContext) {
  // Auto-start the bridge when the plugin loads. Guarded so a failure never
  // breaks plugin initialization.
  void start().catch((err) => {
    console.error(`[chrome-bridge] auto-start failed: ${String(err)}`);
  });

  plugin.handle(bridgeStatus, async () => {
    const running = isRunning();
    const h = await health();
    return {
      running: running || h.detail === "extension connected" || h.detail === "waiting for extension",
      port: PORT,
      extensionConnected: h.connected,
      extensionUserAgent: h.ua,
      detail: h.detail,
    };
  });

  plugin.handle(bridgeStart, async () => {
    const r = await start();
    return { running: isRunning(), detail: r.detail };
  });

  plugin.handle(bridgeStop, async () => {
    const r = stop();
    return { running: isRunning(), detail: r.detail };
  });

  return () => { stop(); };
}
