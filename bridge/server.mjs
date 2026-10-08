#!/usr/bin/env node
// chrome-bridge: localhost bridge between agents and a companion Chrome
// extension. Agents POST commands over HTTP; the extension connects over
// WebSocket and executes them inside YOUR real, logged-in Chrome.
//
// Every agent gets its own tab. An agent names itself with a session id on each
// /rpc call and holds GET /session open while it lives; when that connection
// drops (the agent exited for any reason), its tab is closed. Commands within
// one session run in order; different sessions run independently, except that
// Google searches from all sessions share one spacing window (HTTP 429).
//
// Nothing here is secret. Bind is 127.0.0.1 only. Optional shared token via
// BRIDGE_TOKEN keeps other local users from driving your browser.

import http from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import {
  DEFAULT_PORT,
  DEFAULT_SESSION,
  EXTENSION_COMMAND_TIMEOUT_MS,
  EXTENSION_PING_INTERVAL_MS,
  HOST,
  MAX_BODY_BYTES,
  VERSION,
} from "./constants.mjs";
import { createGoogleCooldown, isGoogleSearch } from "./google-cooldown.mjs";
import { fetchPage } from "./page-fetch.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

class RateLimited extends Error {
  constructor(retryAfterMs) {
    super("RATE_LIMITED");
    this.retryAfterMs = retryAfterMs;
  }
}

const SEARCH_ENGINES = {
  google: { url: "https://www.google.com/", box: "textarea[name=q], input[name=q]" },
  bing: { url: "https://www.bing.com/", box: "textarea[name=q], input[name=q]" },
  duckduckgo: { url: "https://duckduckgo.com/", box: "input[name=q]" },
};

// High-level "search": navigate, type like a human, submit, read results.
async function doSearch(send, params) {
  const {
    query,
    engine = "google",
    perCharMinMs = 55,
    perCharMaxMs = 180,
    thinkMinMs = 500,
    thinkMaxMs = 1500,
    limit = 10,
    focus = false,
  } = params || {};
  if (!query || typeof query !== "string") throw new Error("query_required");
  const e = SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;

  await send("navigate", { url: e.url, waitMs: 15000, focus });
  await sleep(jitter(thinkMinMs, thinkMaxMs));
  await send("type", { selector: e.box, text: query, clearFirst: true, perCharMinMs, perCharMaxMs });
  await sleep(jitter(200, 700));
  await send("key", { key: "Enter" });
  await send("waitText", { text: "", timeoutMs: 8000 }).catch(() => {});
  await sleep(jitter(thinkMinMs, thinkMaxMs));
  const parsed = await send("results", { limit });
  return { engine, query, ...parsed };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function sessionName(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 200) : DEFAULT_SESSION;
}

export function createBridge({
  token = "",
  cooldown = createGoogleCooldown(),
  log = (...a) => console.log(new Date().toISOString(), ...a),
} = {}) {
  // ---- extension connection ------------------------------------------------
  let extSocket = null;
  let extInfo = null;
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }

  function sendToExtension(cmd, params, session, timeoutMs = EXTENSION_COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!extSocket || extSocket.readyState !== extSocket.OPEN) {
        return reject(new Error("extension_not_connected"));
      }
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("extension_timeout"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      extSocket.send(JSON.stringify({ id, cmd, params: params || {}, session }));
    });
  }

  // ---- sessions ----------------------------------------------------------------
  // Commands for one session run strictly in order (one agent, one tab).
  // Tasks whose caller disconnected while waiting are skipped, never executed:
  // an abandoned command must not type into the tab a minute later.
  const chains = new Map(); // session -> promise tail
  const live = new Map(); // session -> open /session connections

  function inSession(session, task, isAbandoned = () => false) {
    const result = (chains.get(session) || Promise.resolve()).then(() => {
      if (isAbandoned()) {
        log(`skipping queued command for ${session}: caller disconnected`);
        throw new Error("CALLER_GONE");
      }
      return task();
    });
    const tail = result.catch(() => {});
    chains.set(session, tail);
    tail.then(() => {
      if (chains.get(session) === tail) chains.delete(session);
    });
    return result;
  }

  function release(session) {
    log(`releasing tab for session ${session}`);
    inSession(session, () => sendToExtension("release", {}, session)).catch(() => {});
  }

  function retainLiveSessions() {
    const sessions = [DEFAULT_SESSION, ...live.keys()];
    sendToExtension("retain", { sessions }, null).catch((err) => log("retain failed", err.message));
  }

  function run(method, params, session) {
    if (isGoogleSearch(method, params)) {
      const slot = cooldown.acquire();
      if (!slot.ok) throw new RateLimited(slot.retryAfterMs);
    }
    const send = (cmd, p) => sendToExtension(cmd, p, session);
    if (method === "search") return doSearch(send, params);
    if (method === "fetch") return fetchPage(params, send);
    return send(method, params);
  }

  // ---- HTTP control server (agent-facing) ------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      if (token && req.headers["authorization"] !== `Bearer ${token}`) {
        return json(res, 401, { ok: false, error: "unauthorized" });
      }
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          version: VERSION,
          extensionConnected: !!(extSocket && extSocket.readyState === extSocket.OPEN),
          extension: extInfo,
          liveSessions: live.size,
        });
      }

      // Held open for the agent's lifetime. The OS closes it when the agent
      // process ends, however it ends, and that closes the agent's tab.
      if (req.method === "GET" && url.pathname === "/session") {
        const session = sessionName(url.searchParams.get("id"));
        if (session === DEFAULT_SESSION) return json(res, 400, { ok: false, error: "session_id_required" });
        live.set(session, (live.get(session) || 0) + 1);
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
        res.write("open\n");
        req.on("close", () => {
          const left = (live.get(session) || 1) - 1;
          if (left > 0) return live.set(session, left);
          live.delete(session);
          release(session);
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/rpc") {
        let msg;
        try {
          msg = JSON.parse((await readBody(req)) || "{}");
        } catch {
          return json(res, 400, { ok: false, error: "invalid_json" });
        }
        const { method, params } = msg || {};
        if (!method) return json(res, 400, { ok: false, error: "method_required" });
        const session = sessionName(msg.session);
        let callerGone = false;
        res.on("close", () => {
          if (!res.writableEnded) callerGone = true;
        });
        try {
          const result = await inSession(session, () => run(method, params || {}, session), () => callerGone);
          if (!callerGone) json(res, 200, { ok: true, result });
        } catch (err) {
          if (callerGone) return;
          if (err instanceof RateLimited) {
            const seconds = Math.ceil(err.retryAfterMs / 1000);
            return json(
              res,
              429,
              {
                ok: false,
                error: "RATE_LIMITED",
                retryAfterMs: err.retryAfterMs,
                message: `Google searches from all agents are spaced out. Retry after ${seconds}s.`,
              },
              { "retry-after": String(seconds) },
            );
          }
          json(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
        }
        return;
      }

      return json(res, 404, { ok: false, error: "not_found" });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
    }
  });

  // ---- WebSocket server (extension-facing) -----------------------------------
  const wss = new WebSocketServer({ server, path: "/ext" });

  wss.on("connection", (ws, req) => {
    const ra = req.socket.remoteAddress || "";
    if (!ra.includes("127.0.0.1") && ra !== "::1" && !ra.includes("::ffff:127.0.0.1")) {
      ws.close();
      return;
    }
    if (token && new URL(req.url, "http://localhost").searchParams.get("token") !== token) {
      ws.close();
      return;
    }

    log("extension connected");
    extSocket = ws;

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "hello") {
        extInfo = msg.info || null;
        log("extension hello", extInfo && extInfo.userAgent);
        // Close tabs of agents that ended while the extension or bridge was away.
        retainLiveSessions();
        return;
      }
      if (msg.type === "pong") return;
      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || "extension_error"));
      }
    });

    ws.on("close", () => {
      log("extension disconnected");
      if (extSocket === ws) {
        extSocket = null;
        extInfo = null;
      }
    });
    ws.on("error", () => {});
  });

  // keep the MV3 service worker alive with periodic app-level pings
  const pinger = setInterval(() => {
    if (extSocket && extSocket.readyState === extSocket.OPEN) {
      try {
        extSocket.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }
  }, EXTENSION_PING_INTERVAL_MS);
  pinger.unref();

  function close() {
    clearInterval(pinger);
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BRIDGE_PORT || DEFAULT_PORT);
  const token = process.env.BRIDGE_TOKEN || "";
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const { server } = createBridge({ token, log });
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      log(`port ${port} already in use — another bridge is running; exiting cleanly`);
      process.exit(0);
    }
    log("server error", err && err.message ? err.message : err);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    log(`chrome-bridge v${VERSION} listening on http://${HOST}:${port}`);
    log(`  agent:      POST http://${HOST}:${port}/rpc   {method, params, session}`);
    log(`  extension:  ws://${HOST}:${port}/ext`);
    if (token) log("  token auth: ENABLED");
  });
}
