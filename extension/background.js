// Chrome Bridge — MV3 background service worker.
//
// Connects out to the localhost bridge (ws://127.0.0.1:8787/ext) and executes
// commands in each agent's own background tab using the Chrome DevTools Protocol
// via chrome.debugger, so input events are trusted and behave like real typing.
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

async function attach(tabId) {
  if (!attached.has(tabId)) {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err && !/already attached/i.test(err.message)) return reject(new Error(err.message));
        attached.add(tabId);
        resolve();
      });
    });
  }
  // Background tabs can acknowledge Input events without delivering them.
  // Emulate page focus on this CDP target, not by activating the user's window.
  // Reapply even on cached attachments; propagate errors rather than reporting
  // successful input when Chrome cannot prepare the target.
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attached.delete(source.tabId);
});

// Detach from every tab shortly after the last command, so Chrome's
// "started debugging this browser" banner does not linger while idle. Agents
// run commands concurrently in their own tabs, so wait for all of them.
let detachTimer = null;
let inFlight = 0;
function cancelIdleDetach() {
  if (detachTimer) {
    clearTimeout(detachTimer);
    detachTimer = null;
  }
}
function scheduleIdleDetach() {
  cancelIdleDetach();
  if (inFlight === 0) detachTimer = setTimeout(detachAll, 2000);
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

// Each agent session gets its own background tab in the "Paseo" tab group, so
// agents never type into each other's pages, and the tab you are looking at
// (or app/PWA windows like Discord) is never touched. The session -> tab map
// lives in chrome.storage.session so it survives service-worker restarts.
let sessionTabs = null; // Promise<Map<session, tabId>>
function loadSessionTabs() {
  sessionTabs ??= chrome.storage.session
    .get("sessionTabs")
    .then((stored) => new Map(Object.entries(stored.sessionTabs || {})));
  return sessionTabs;
}
async function saveSessionTabs(map) {
  await chrome.storage.session.set({ sessionTabs: Object.fromEntries(map) });
}

chrome.tabs.onRemoved.addListener(async (id) => {
  const map = await loadSessionTabs();
  for (const [session, tabId] of map) if (tabId === id) map.delete(session);
  await saveSessionTabs(map);
});

// Serialized so two sessions opening tabs at once share one group.
let groupChain = Promise.resolve();
function addToPaseoGroup(tabId) {
  groupChain = groupChain.then(async () => {
    try {
      const [group] = await chrome.tabGroups.query({ title: "Paseo" });
      if (group) await chrome.tabs.group({ tabIds: tabId, groupId: group.id });
      else {
        const groupId = await chrome.tabs.group({ tabIds: tabId });
        await chrome.tabGroups.update(groupId, { title: "Paseo", color: "blue" });
      }
    } catch {}
  });
  return groupChain;
}

async function tabFor(session, focus = false) {
  const map = await loadSessionTabs();
  let tabId = map.get(session);
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabId = null;
    }
  }
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    tabId = tab.id;
    map.set(session, tabId);
    await saveSessionTabs(map);
    await addToPaseoGroup(tabId);
  }
  if (focus) {
    try {
      const t = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
    } catch {}
  }
  return tabId;
}

async function closeSessions(sessions) {
  const map = await loadSessionTabs();
  for (const session of sessions) {
    const tabId = map.get(session);
    map.delete(session);
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  }
  await saveSessionTabs(map);
  return { closed: sessions.length };
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
async function cmdNavigate(tabId, p) {
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

async function cmdWaitText(tabId, p) {
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

async function cmdType(tabId, p) {
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

async function cmdKey(tabId, p) {
  const k = KEYMAP[p.key];
  if (!k) throw new Error("unsupported_key");
  const base = { windowsVirtualKeyCode: k.keyCode, key: k.key, code: k.code };
  // Google and other JS-heavy forms may ignore rawKeyDown for Enter. A normal
  // keyDown is the browser event path that triggers the focused form's submit.
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  return { key: p.key };
}

async function cmdClick(tabId, p) {
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

async function cmdSnapshot(tabId, p) {
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

async function cmdScreenshot(tabId) {
  const r = await cdp(tabId, "Page.captureScreenshot", { format: "png" });
  return { dataUrl: "data:image/png;base64," + r.data };
}

async function cmdEval(tabId, p) {
  return { value: await evaluate(tabId, `(${p.expression})`) };
}

// Google-aware organic result extraction: clean {rank, title, url, snippet}.
function resultsExpr(limit) {
  return `(() => {
    const out = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a')).filter((a) => a.querySelector('h3') && /^https?:/.test(a.href));
    for (const a of anchors) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const h3 = a.querySelector('h3');
      let snippet = '';
      let el = a;
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const s = el.querySelector('.VwiC3b, div[data-sncf], .yXK7lf, .lyLwlc');
        if (s && s.innerText) { snippet = s.innerText.trim(); break; }
      }
      out.push({ rank: out.length + 1, title: (h3.innerText || '').trim(), url: a.href, snippet: snippet.slice(0, 300) });
      if (out.length >= ${limit}) break;
    }
    const box = document.querySelector('textarea[name=q], input[name=q]');
    return { query: box ? box.value : '', count: out.length, results: out };
  })()`;
}

async function cmdResults(tabId, p) {
  return evaluate(tabId, resultsExpr(p.limit || 10));
}

// Click into the Nth organic result at a human pace (trusted click, with a
// navigate fallback if the click is intercepted).
async function cmdOpenResult(tabId, p) {
  const idx = Math.max(1, p.n || 1) - 1;
  const info = await evaluate(
    tabId,
    `(() => {
      const seen = new Set();
      const uniq = [];
      for (const a of Array.from(document.querySelectorAll('a'))) {
        if (!a.querySelector('h3') || !/^https?:/.test(a.href) || seen.has(a.href)) continue;
        seen.add(a.href); uniq.push(a);
      }
      const a = uniq[${idx}];
      if (!a) return null;
      a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 12), href: a.href, title: (a.querySelector('h3') || {}).innerText || '' };
    })()`,
  );
  if (!info) throw new Error('result_not_found');

  await sleep(jitter(300, 900));
  const opts = { x: info.x, y: info.y, button: 'left', clickCount: 1 };
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...opts });
  await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...opts });

  const deadline = Date.now() + (p.waitMs || 15000);
  let navigated = false;
  while (Date.now() < deadline) {
    try {
      const st = await evaluate(tabId, 'document.readyState');
      const url = await evaluate(tabId, 'location.href');
      if ((st === 'complete' || st === 'interactive') && url && !/[.\/]google\.[^/]+\/search/.test(url)) {
        navigated = true;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!navigated) {
    // fallback: the click was intercepted; go straight to the href
    await cdp(tabId, 'Page.enable');
    await cdp(tabId, 'Page.navigate', { url: info.href });
    const d2 = Date.now() + (p.waitMs || 15000);
    while (Date.now() < d2) {
      try {
        const st = await evaluate(tabId, 'document.readyState');
        if (st === 'complete' || st === 'interactive') break;
      } catch {}
      await sleep(150);
    }
  }
  const snap = await evaluate(
    tabId,
    `(() => ({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${p.maxChars || 4000}) }))()`,
  );
  return { opened: info.title, target: info.href, viaFallback: !navigated, page: snap };
}

const HANDLERS = {
  navigate: cmdNavigate,
  waitText: cmdWaitText,
  type: cmdType,
  key: cmdKey,
  click: cmdClick,
  snapshot: cmdSnapshot,
  results: cmdResults,
  openResult: cmdOpenResult,
  screenshot: cmdScreenshot,
  eval: cmdEval,
};

async function dispatch(cmd, params = {}, session = "shared") {
  // Session lifecycle from the bridge: an agent ended, or the bridge lists the
  // sessions still alive after a reconnect.
  if (cmd === "release") return closeSessions([session]);
  if (cmd === "retain") {
    const keep = new Set(params.sessions || []);
    return closeSessions([...(await loadSessionTabs()).keys()].filter((s) => !keep.has(s)));
  }
  const h = HANDLERS[cmd];
  if (!h) throw new Error("unknown_command:" + cmd);
  const tabId = await tabFor(session, !!params.focus);
  await attach(tabId);
  return h(tabId, params);
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
    send({ type: "hello", info: { userAgent: ua, ext: "chrome-bridge 0.2.0" } });
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
      inFlight++;
      try {
        const result = await dispatch(msg.cmd, msg.params, msg.session || "shared");
        send({ id: msg.id, ok: true, result });
      } catch (err) {
        send({ id: msg.id, ok: false, error: String(err && err.message ? err.message : err) });
      } finally {
        inFlight--;
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
