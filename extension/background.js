// Chrome Bridge — MV3 background service worker.
//
// Connects out to the localhost bridge (ws://127.0.0.1:8787/ext) and executes
// commands inside your ACTIVE tab using the Chrome DevTools Protocol via
// chrome.debugger, so input events are trusted and behave like real typing.
//
// Nothing secret lives here. Change BRIDGE_URL/token below if you customize the
// bridge port. Chrome shows a "…is debugging this browser" banner while active;
// that is expected.

const BRIDGE_PORT = 8787;
const BRIDGE_TOKEN = ""; // must match BRIDGE_TOKEN on the server ("" = none)
const BRIDGE_URL =
  `ws://127.0.0.1:${BRIDGE_PORT}/ext` + (BRIDGE_TOKEN ? `?token=${encodeURIComponent(BRIDGE_TOKEN)}` : "");

let socket = null;
let backoff = 1000;

// ---------- CDP helpers ----------
const attached = new Set();

function cdp(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function attach(tabId) {
  return new Promise((resolve, reject) => {
    if (attached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err && !/already attached/i.test(err.message)) return reject(new Error(err.message));
      attached.add(tabId);
      resolve();
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

// Detach from every tab shortly after the last command, so Chrome's
// "started debugging this browser" banner does not linger while idle.
let detachTimer = null;
function cancelIdleDetach() {
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
}
function scheduleIdleDetach() {
  cancelIdleDetach();
  detachTimer = setTimeout(detachAll, 2000);
}
async function detachAll() {
  for (const id of [...attached]) {
    await new Promise((r) =>
      chrome.debugger.detach({ tabId: id }, () => {
        void chrome.runtime.lastError;
        r();
      }),
    );
    attached.delete(id);
  }
}

// A dedicated "Paseo" tab the agent drives, so it never hijacks the tab you are
// looking at (and never touches app/PWA windows like Discord). Created on demand,
// in the background, and grouped for visibility — like the Claude/Codex extensions.
let AGENT_TAB = null;
chrome.tabs.onRemoved.addListener((id) => {
  if (id === AGENT_TAB) AGENT_TAB = null;
});
async function ensureAgentTab(focus = false) {
  if (AGENT_TAB != null) {
    try {
      await chrome.tabs.get(AGENT_TAB);
    } catch {
      AGENT_TAB = null;
    }
  }
  if (AGENT_TAB == null) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    AGENT_TAB = tab.id;
    try {
      const groupId = await chrome.tabs.group({ tabIds: AGENT_TAB });
      await chrome.tabGroups.update(groupId, { title: "Paseo", color: "blue" });
    } catch {}
  }
  if (focus) {
    try {
      const t = await chrome.tabs.get(AGENT_TAB);
      await chrome.tabs.update(AGENT_TAB, { active: true });
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    } catch {}
  }
  return AGENT_TAB;
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || "eval_error");
  return r.result ? r.result.value : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(min + Math.random() * Math.max(0, max - min));

// ---------- command implementations ----------
async function cmdNavigate(p) {
  const tabId = await ensureAgentTab(!!p.focus);
  await attach(tabId);
  await cdp(tabId, "Page.enable");
  await cdp(tabId, "Page.navigate", { url: p.url });
  const deadline = Date.now() + (p.waitMs || 15000);
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(tabId, "document.readyState");
      if (state === "complete" || state === "interactive") break;
    } catch {}
    await sleep(150);
  }
  return { url: await evaluate(tabId, "location.href") };
}

async function cmdWaitText(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const text = p.text || "";
  const deadline = Date.now() + (p.timeoutMs || 8000);
  while (Date.now() < deadline) {
    const ok = await evaluate(
      tabId,
      `(() => { const t = document.body ? document.body.innerText : ""; return ${JSON.stringify(
        text,
      )} === "" ? t.length > 0 : t.includes(${JSON.stringify(text)}); })()`,
    );
    if (ok) return { found: true };
    await sleep(200);
  }
  return { found: false };
}

async function cmdType(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const sel = p.selector;
  // focus (and optionally select existing content to overwrite)
  const focused = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.focus(); ${
      p.clearFirst ? "if (el.select) el.select();" : ""
    } return true; })()`,
  );
  if (!focused) throw new Error("selector_not_found");
  const text = String(p.text || "");
  const min = p.perCharMinMs ?? 55;
  const max = p.perCharMaxMs ?? 180;
  for (const ch of text) {
    await cdp(tabId, "Input.insertText", { text: ch });
    await sleep(jitter(min, max));
  }
  return { typed: text.length };
}

const KEYMAP = {
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
};

async function cmdKey(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const k = KEYMAP[p.key];
  if (!k) throw new Error("unsupported_key");
  const base = { windowsVirtualKeyCode: k.keyCode, key: k.key, code: k.code };
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(k.text ? { text: k.text } : {}) });
  if (k.text) await cdp(tabId, "Input.dispatchKeyEvent", { type: "char", ...base, text: k.text });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { key: p.key };
}

async function cmdClick(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const rect = await evaluate(
    tabId,
    `(() => { const el = document.querySelector(${JSON.stringify(
      p.selector,
    )}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`,
  );
  if (!rect) throw new Error("selector_not_found");
  const opts = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...opts });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...opts });
  return { clicked: p.selector };
}

async function cmdSnapshot(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const max = p.maxChars || 4000;
  return evaluate(
    tabId,
    `(() => ({
      title: document.title,
      url: location.href,
      text: (document.body ? document.body.innerText : "").slice(0, ${max}),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({ text: (a.innerText||'').trim().slice(0,120), href: a.href }))
    }))()`,
  );
}

async function cmdScreenshot() {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  const r = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
  return { dataUrl: "data:image/png;base64," + r.data };
}

async function cmdEval(p) {
  const tabId = await ensureAgentTab();
  await attach(tabId);
  return { value: await evaluate(tabId, `(${p.expression})`) };
}

const HANDLERS = {
  navigate: cmdNavigate,
  waitText: cmdWaitText,
  type: cmdType,
  key: cmdKey,
  click: cmdClick,
  snapshot: cmdSnapshot,
  screenshot: cmdScreenshot,
  eval: cmdEval,
};

async function dispatch(cmd, params) {
  const h = HANDLERS[cmd];
  if (!h) throw new Error("unknown_command:" + cmd);
  return h(params || {});
}

// ---------- bridge connection ----------
// Race-safe: every handler is bound to its own socket instance (`ws`) and only
// sends when that socket is OPEN and still current, so overlapping reconnects
// can never send on a socket that is still CONNECTING.
let reconnectTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  let ws;
  try {
    ws = new WebSocket(BRIDGE_URL);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  const send = (obj) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {}
    }
  };

  ws.onopen = () => {
    if (socket !== ws) return;
    backoff = 1000;
    const ua = (self.navigator && self.navigator.userAgent) || "";
    send({ type: "hello", info: { userAgent: ua, ext: "chrome-bridge 0.1.0" } });
  };

  ws.onmessage = async (event) => {
    if (socket !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "ping") {
      send({ type: "pong" });
      return;
    }
    if (typeof msg.id === "number") {
      cancelIdleDetach();
      try {
        const result = await dispatch(msg.cmd, msg.params);
        send({ id: msg.id, ok: true, result });
      } catch (err) {
        send({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
      } finally {
        scheduleIdleDetach();
      }
    }
  };

  ws.onclose = () => {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  backoff = Math.min(backoff * 2, 15000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
}

// keep the SW alive / ensure a live socket
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
});

connect();
