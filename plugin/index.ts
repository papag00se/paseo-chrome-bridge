import type { PluginContext } from "@getpaseo/plugin";
import { bridgeStart, bridgeStatus, bridgeStop } from "./contracts";
import { MainSurface } from "./main.client";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, "..", "bridge", "server.mjs");
const bridgeDir = resolve(here, "..", "bridge");

let child: ChildProcess | null = null;

function isRunning(): boolean {
  return !!child && child.exitCode === null && !child.killed;
}

function start(): { ok: boolean; detail: string } {
  if (isRunning()) return { ok: true, detail: "already running" };
  try {
    child = spawn(process.execPath, [serverPath], {
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

export default function contribute(plugin: PluginContext) {
  // Auto-start the bridge when the plugin loads. Guarded so a failure never
  // breaks plugin initialization.
  try {
    start();
  } catch (err) {
    console.error(`[chrome-bridge] auto-start failed: ${String(err)}`);
  }

  plugin.handle(bridgeStatus, async () => {
    const running = isRunning();
    const h = running ? await health() : { connected: false, ua: null, detail: "bridge not running" };
    return {
      running,
      port: PORT,
      extensionConnected: h.connected,
      extensionUserAgent: h.ua,
      detail: h.detail,
    };
  });

  plugin.handle(bridgeStart, async () => {
    const r = start();
    return { running: isRunning(), detail: r.detail };
  });

  plugin.handle(bridgeStop, async () => {
    const r = stop();
    return { running: isRunning(), detail: r.detail };
  });

  plugin.addSurface("main", MainSurface);
  plugin.addSidebarItem({
    id: "chrome-bridge",
    title: "Chrome Bridge",
    icon: "Globe",
    surface: "main",
  });

  return () => {
    stop();
  };
}
