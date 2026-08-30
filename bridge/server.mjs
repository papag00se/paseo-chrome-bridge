#!/usr/bin/env node
// chrome-bridge: localhost bridge between the Paseo agent and a companion
// Chrome extension. The agent POSTs commands over HTTP; the extension connects
// over WebSocket and executes them inside YOUR real, logged-in Chrome tab.
//
// Nothing here is secret. Bind is 127.0.0.1 only. Optional shared token via
// BRIDGE_TOKEN keeps other local users from driving your browser.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const HOST = "127.0.0.1";
const TOKEN = process.env.BRIDGE_TOKEN || ""; // optional; "" = no token
const VERSION = "0.1.0";

// ---- extension connection state -------------------------------------------
let extSocket = null;
let extInfo = null; // { userAgent, ... } sent by the extension on hello
let seq = 0;
const pending = new Map(); // id -> { resolve, reject, timer }

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

function sendToExtension(cmd, params = {}, timeoutMs = 30000) {
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
    extSocket.send(JSON.stringify({ id, cmd, params }));
  });
}

// ---- human-like pacing helpers --------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

// High-level "search": navigate, type like a human, submit, read results.
async function doSearch(params) {
  const {
    query,
    engine = "google",
    perCharMinMs = 55,
    perCharMaxMs = 180,
    thinkMinMs = 500,
    thinkMaxMs = 1500,
    maxChars = 4000,
  } = params || {};
  if (!query || typeof query !== "string") throw new Error("query_required");

  const engines = {
    google: { url: "https://www.google.com/", box: "textarea[name=q], input[name=q]" },
    bing: { url: "https://www.bing.com/", box: "textarea[name=q], input[name=q]" },
    duckduckgo: { url: "https://duckduckgo.com/", box: "input[name=q]" },
  };
  const e = engines[engine] || engines.google;

  await sendToExtension("navigate", { url: e.url, waitMs: 15000 });
  await sleep(jitter(thinkMinMs, thinkMaxMs));
  await sendToExtension("type", {
    selector: e.box,
    text: query,
    clearFirst: true,
    perCharMinMs,
    perCharMaxMs,
  });
  await sleep(jitter(200, 700));
  await sendToExtension("key", { key: "Enter" });
  // give results a moment to render
  await sendToExtension("waitText", { text: "", timeoutMs: 8000 }).catch(() => {});
  await sleep(jitter(thinkMinMs, thinkMaxMs));
  const snap = await sendToExtension("snapshot", { maxChars });
  return { engine, query, page: snap };
}

// ---- HTTP control server (agent-facing) -----------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (TOKEN) {
      const auth = req.headers["authorization"] || "";
      if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { ok: false, error: "unauthorized" });
    }

    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        extensionConnected: !!(extSocket && extSocket.readyState === extSocket.OPEN),
        extension: extInfo,
      });
    }

    if (req.method === "POST" && req.url === "/rpc") {
      const body = await readBody(req);
      let msg;
      try {
        msg = JSON.parse(body || "{}");
      } catch {
        return json(res, 400, { ok: false, error: "invalid_json" });
      }
      const { method, params } = msg || {};
      if (!method) return json(res, 400, { ok: false, error: "method_required" });
      try {
        const result = method === "search" ? await doSearch(params) : await sendToExtension(method, params || {});
        return json(res, 200, { ok: true, result });
      } catch (err) {
        return json(res, 200, { ok: false, error: String(err && err.message ? err.message : err) });
      }
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// ---- WebSocket server (extension-facing) ----------------------------------
const wss = new WebSocketServer({ server, path: "/ext" });

wss.on("connection", (ws, req) => {
  // enforce localhost + token on the WS upgrade too
  const ra = req.socket.remoteAddress || "";
  if (!ra.includes("127.0.0.1") && ra !== "::1" && !ra.includes("::ffff:127.0.0.1")) {
    ws.close();
    return;
  }
  if (TOKEN) {
    const url = new URL(req.url, "http://localhost");
    if (url.searchParams.get("token") !== TOKEN) {
      ws.close();
      return;
    }
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
setInterval(() => {
  if (extSocket && extSocket.readyState === extSocket.OPEN) {
    try {
      extSocket.send(JSON.stringify({ type: "ping" }));
    } catch {}
  }
}, 20000);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    log(`port ${PORT} already in use — another bridge is running; exiting cleanly`);
    process.exit(0);
  }
  log("server error", err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  log(`chrome-bridge v${VERSION} listening on http://${HOST}:${PORT}`);
  log(`  agent:      POST http://${HOST}:${PORT}/rpc   {method, params}`);
  log(`  extension:  ws://${HOST}:${PORT}/ext`);
  if (TOKEN) log("  token auth: ENABLED");
});
