import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { createBridge } from "../server.mjs";
import { createGoogleCooldown, isGoogleSearch } from "../google-cooldown.mjs";

// Starts a real bridge plus a stand-in extension on a real WebSocket. The
// stand-in records every command and answers after `delayMs`.
async function start({ cooldown, delayMs = 0 } = {}) {
  const bridge = createBridge({ cooldown, log: () => {} });
  await new Promise((resolve) => bridge.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const received = [];
  let active = new Map(); // session -> running commands
  const overlaps = [];
  const ext = new WebSocket(`${base.replace("http", "ws")}/ext`);
  await new Promise((resolve) => ext.on("open", resolve));
  ext.on("message", async (raw) => {
    const msg = JSON.parse(raw);
    if (typeof msg.id !== "number") return;
    received.push(msg);
    const running = (active.get(msg.session) || 0) + 1;
    active.set(msg.session, running);
    overlaps.push({ session: msg.session, running, total: [...active.values()].reduce((a, b) => a + b, 0) });
    await new Promise((r) => setTimeout(r, delayMs));
    active.set(msg.session, active.get(msg.session) - 1);
    ext.send(JSON.stringify({ id: msg.id, ok: true, result: { cmd: msg.cmd, results: [] } }));
  });
  const rpc = async (session, method, params = {}) => {
    const res = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params, session }),
    });
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() };
  };
  const close = async () => {
    ext.close();
    await bridge.close();
  };
  return { base, ext, received, overlaps, rpc, close };
}

const until = async (check, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("each agent's commands run in order in its own session; agents run side by side", async () => {
  const b = await start({ delayMs: 60 });
  try {
    const results = await Promise.all([
      b.rpc("agent-a", "click", { selector: "#one" }),
      b.rpc("agent-a", "click", { selector: "#two" }),
      b.rpc("agent-b", "click", { selector: "#three" }),
    ]);
    assert.ok(results.every((r) => r.status === 200 && r.body.ok));
    const bySession = (s) => b.received.filter((m) => m.session === s).map((m) => m.params.selector);
    assert.deepEqual(bySession("agent-a"), ["#one", "#two"]);
    assert.deepEqual(bySession("agent-b"), ["#three"]);
    // Never two commands at once inside one agent's tab...
    assert.ok(b.overlaps.every((o) => o.running === 1));
    // ...but different agents do not wait for each other.
    assert.ok(b.overlaps.some((o) => o.total === 2));
    // Raw callers without a session share one tab.
    await b.rpc(undefined, "snapshot");
    assert.equal(b.received.at(-1).session, "shared");
  } finally {
    await b.close();
  }
});

test("Google searches share one cooldown across agents and answer 429 with the wait", async () => {
  let now = 1_000_000;
  const cooldown = createGoogleCooldown({ minIntervalMs: 30_000, jitterMs: 0, now: () => now });
  const b = await start({ cooldown });
  const googleFetch = { url: "https://www.google.com/search?q=ramen", waitMs: 0 };
  try {
    assert.equal((await b.rpc("agent-a", "fetch", googleFetch)).status, 200);

    now += 12_000;
    const limited = await b.rpc("agent-b", "search", { query: "ramen", engine: "google" });
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfter, "18");
    assert.equal(limited.body.error, "RATE_LIMITED");
    assert.equal(limited.body.retryAfterMs, 18_000);
    // The limited call never reached the browser.
    assert.ok(!b.received.some((m) => m.session === "agent-b"));

    // Other engines and ordinary pages are not held back.
    assert.equal((await b.rpc("agent-b", "fetch", { url: "https://example.test", waitMs: 0 })).status, 200);
    assert.equal((await b.rpc("agent-b", "navigate", { url: "https://www.bing.com/search?q=x" })).status, 200);

    now += 18_000;
    assert.equal((await b.rpc("agent-b", "fetch", googleFetch)).status, 200);
  } finally {
    await b.close();
  }
});

test("an agent's tab is released when its process connection drops, and only live tabs survive a reconnect", async () => {
  const b = await start();
  try {
    const held = http.get(`${b.base}/session?id=agent-a`);
    const kept = http.get(`${b.base}/session?id=agent-b`);
    await new Promise((resolve) => kept.on("response", resolve));
    held.destroy();
    await until(() => b.received.some((m) => m.cmd === "release"));
    const release = b.received.find((m) => m.cmd === "release");
    assert.equal(release.session, "agent-a");

    // The extension (re)connects: the bridge lists the sessions still alive.
    b.ext.send(JSON.stringify({ type: "hello", info: { userAgent: "test" } }));
    await until(() => b.received.some((m) => m.cmd === "retain"));
    assert.deepEqual(b.received.find((m) => m.cmd === "retain").params.sessions.sort(), ["agent-b", "shared"]);
    kept.destroy();
  } finally {
    await b.close();
  }
});

test("only Google results pages count as Google searches", () => {
  assert.equal(isGoogleSearch("search", {}), true);
  assert.equal(isGoogleSearch("search", { engine: "bing" }), false);
  assert.equal(isGoogleSearch("fetch", { url: "https://www.google.co.uk/search?q=x" }), true);
  assert.equal(isGoogleSearch("navigate", { url: "https://google.com/search?q=x" }), true);
  assert.equal(isGoogleSearch("fetch", { url: "https://www.google.com/maps" }), false);
  assert.equal(isGoogleSearch("fetch", { url: "https://notgoogle.com/search" }), false);
  assert.equal(isGoogleSearch("click", { url: "https://www.google.com/search" }), false);
});
