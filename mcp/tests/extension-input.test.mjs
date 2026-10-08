import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');

// Execute the actual extension handlers; only Chrome's extension transport is
// adapted to a real, isolated Chromium CDP session. Never uses the user profile.
function extension(session, { failFocus = false, storage = {}, firstTab = 7 } = {}) {
  const calls = [];
  const tabs = new Set();
  let nextTab = firstTab;
  const chrome = {
    runtime: {},
    debugger: {
      onDetach: { addListener() {} },
      attach(target, version, cb) { calls.push(['attach', target]); cb(); },
      sendCommand(target, method, params, cb) {
        calls.push([method, target]);
        const result = failFocus && method === 'Emulation.setFocusEmulationEnabled'
          ? Promise.reject(new Error('focus unavailable')) : session.send(method, params);
        result.then(cb, err => {
          chrome.runtime.lastError = { message: err.message };
          cb();
          delete chrome.runtime.lastError;
        });
      },
    },
    storage: { session: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: {
      onRemoved: { addListener() {} },
      async create() { const id = nextTab++; tabs.add(id); calls.push(['create', id]); return { id }; },
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { id }; },
      async remove(id) { tabs.delete(id); calls.push(['remove', id]); },
      async group() { return 1; },
      async update() { assert.fail('must not activate a tab'); },
    },
    tabGroups: { async query() { return []; }, async update() {} },
    windows: { async update() { assert.fail('must not focus a window'); } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
  };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout,
    WebSocket: class { static CONNECTING = 0; static OPEN = 1; readyState = 0; },
  });
  vm.runInContext(source, context);
  return { run: expression => vm.runInContext(expression, context), calls, tabs };
}

test('extension trusted input stays on its target without activating the foreground tab', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent(`<button id="go">Test</button><input id="input"><script>
      window.clicks = []; window.keys = [];
      go.onclick = e => clicks.push(e.isTrusted);
      input.onkeydown = e => keys.push([e.key, e.isTrusted]);
    </script>`);
    const foreground = await context.newPage();
    await foreground.setContent('<input id="other" value="untouched">');
    await foreground.bringToFront();
    const session = await context.newCDPSession(page);
    const ext = extension(session);
    await ext.run('dispatch("click", {selector: "#go"}, "agent-a")');
    await ext.run('dispatch("type", {selector: "#input", text: "hello", perCharMinMs: 0, perCharMaxMs: 0}, "agent-a")');
    await ext.run('dispatch("key", {key: "Enter"}, "agent-a")');
    assert.deepEqual(await page.evaluate(() => clicks), [true]);
    assert.equal(await page.locator('#input').inputValue(), 'hello');
    assert.deepEqual(await page.evaluate(() => keys), [['Enter', true]]);
    assert.equal(await foreground.locator('#other').inputValue(), 'untouched');
    assert.ok(ext.calls.filter(([m]) => m !== 'create').every(([, target]) => target.tabId === 7));
    assert.equal(ext.calls.filter(([method]) => method === 'attach').length, 1);
    assert.equal(ext.calls.filter(([method]) => method === 'Emulation.setFocusEmulationEnabled').length, 3);
    await session.detach();
  } finally { await browser.close(); }
});

test('failed focus preparation rejects input, including on a cached attachment', async () => {
  const ext = extension({ send() { assert.fail('must not send input'); } }, { failFocus: true });
  await assert.rejects(ext.run('dispatch("click", {selector: "#go"}, "agent-a")'), /focus unavailable/);
  await assert.rejects(ext.run('dispatch("key", {key: "Enter"}, "agent-a")'), /focus unavailable/);
  assert.deepEqual(ext.calls.map(([method]) => method), ['create', 'attach', 'Emulation.setFocusEmulationEnabled', 'Emulation.setFocusEmulationEnabled']);
});

test('each agent session gets its own tab, kept across service-worker restarts and closed on release', async () => {
  const storage = {};
  const browser = { send: async () => ({ data: '' }) };
  const ext = extension(browser, { storage });
  await ext.run('dispatch("screenshot", {}, "agent-a")');
  await ext.run('dispatch("screenshot", {}, "agent-b")');
  await ext.run('dispatch("screenshot", {}, "agent-a")');
  const shots = ext.calls.filter(([m]) => m === 'Page.captureScreenshot').map(([, t]) => t.tabId);
  assert.deepEqual(shots, [7, 8, 7]);

  // A restarted service worker reads the same session map and reuses the tab.
  const restarted = extension(browser, { storage, firstTab: 9 });
  for (const id of ext.tabs) restarted.tabs.add(id);
  await restarted.run('dispatch("screenshot", {}, "agent-a")');
  assert.deepEqual(restarted.calls.filter(([m]) => m === 'Page.captureScreenshot').map(([, t]) => t.tabId), [7]);
  assert.equal(restarted.calls.some(([m]) => m === 'create'), false);

  await restarted.run('dispatch("release", {}, "agent-b")');
  assert.deepEqual(restarted.calls.filter(([m]) => m === 'remove'), [['remove', 8]]);
  await restarted.run('dispatch("screenshot", {}, "agent-c")');
  await restarted.run('dispatch("retain", {sessions: ["shared", "agent-a"]}, null)');
  assert.deepEqual(restarted.calls.filter(([m]) => m === 'remove').map(([, id]) => id), [8, 9]);
  assert.deepEqual(Object.keys(storage.sessionTabs), ['agent-a']);
});
