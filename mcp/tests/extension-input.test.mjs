import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const source = await readFile(new URL('../../extension/background.js', import.meta.url), 'utf8');

// Execute the actual extension handlers; only Chrome's extension transport is
// adapted to a real, isolated Chromium CDP session. Never uses the user profile.
function extension(session, { failFocus = false, storage = {}, firstTab = 7, allowFocus = false } = {}) {
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
      async get(id) { if (!tabs.has(id)) throw new Error('No tab'); return { id, windowId: 91 }; },
      async remove(id) { tabs.delete(id); calls.push(['remove', id]); },
      async group() { return 1; },
      async update(id, options) { assert.ok(allowFocus, 'must not activate a tab'); calls.push(['activate', {id, ...options}]); },
    },
    tabGroups: { async query() { return []; }, async update() {} },
    windows: { async update(id, options) { assert.ok(allowFocus, 'must not focus a window'); calls.push(['focusWindow', {id, ...options}]); } },
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

test('native selects commit exactly the intended option once through trusted input', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><select id="month"><option value="">Choose</option><option disabled>Unavailable</option><option value="jan">January</option><option value="feb">February</option><optgroup disabled><option>Locked</option></optgroup><option value="mar">March</option></select><select id="other"><option>untouched</option></select></form><script>
      window.changes = []; window.submits = 0;
      month.onchange = e => changes.push([month.value, e.isTrusted]);
      document.querySelector('form').onsubmit = e => { e.preventDefault(); submits++; };
    </script>`);
    const session = await page.context().newCDPSession(page);
    const ext = extension(session);
    const result = await ext.run('dispatch("select", {selector: "#month", label: "February"}, "agent-a")');
    assert.equal(result.label, 'February');
    assert.equal(result.index, 3);
    assert.equal(await page.locator('#month').inputValue(), 'feb');
    assert.deepEqual(await page.evaluate(() => changes), [['feb', true]]);
    await ext.run('dispatch("select", {selector: "#month", value: "mar"}, "agent-a")');
    await ext.run('dispatch("select", {selector: "#month", index: 2}, "agent-a")');
    assert.deepEqual(await page.evaluate(() => changes), [['feb', true], ['mar', true], ['jan', true]]);
    await ext.run('dispatch("select", {selector: "#month", label: "January"}, "agent-a")');
    assert.equal(await page.evaluate(() => changes.length), 3);
    assert.equal(await page.evaluate(() => submits), 0);
    assert.equal(await page.locator('#other').inputValue(), 'untouched');
    await page.evaluate(() => { month.options[0].disabled = true; month.options[1].disabled = false; month.options[1].hidden = true; month.selectedIndex = 0; });
    await ext.run('dispatch("select", {selector: "#month", label: "February"}, "agent-a")');
    assert.deepEqual(await page.evaluate(() => changes.at(-1)), ['feb', true]);
    await assert.rejects(ext.run('dispatch("select", {selector: "#month", index: 1}, "agent-a")'), /select_option_disabled/);
    await assert.rejects(ext.run('dispatch("select", {selector: "#month", label: "Missing"}, "agent-a")'), /select_option_missing_or_ambiguous/);
    await assert.rejects(ext.run('dispatch("select", {selector: "#month", label: "January", index: 2}, "agent-a")'), /exactly_one/);
    await page.evaluate(() => { month.options[0].label = 'January'; });
    await assert.rejects(ext.run('dispatch("select", {selector: "#month", label: "January"}, "agent-a")'), /select_option_missing_or_ambiguous/);
    await page.evaluate(() => { month.size = 4; });
    await assert.rejects(ext.run('dispatch("select", {selector: "#month", index: 2}, "agent-a")'), /single_dropdown_required/);
    await session.detach();
  } finally { await browser.close(); }
});

test('field replacement clears rich text and empty values without touching adjacent fields', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input id="plain" value="old"><textarea id="history">old history</textarea><div id="rich" contenteditable="true"><h2>Old heading</h2><p>Old paragraph</p></div><input id="other" value="untouched"><input id="password" type="password"><input id="locked" readonly><input id="number" type="number" value="100"><input id="short" maxlength="3" value="old"><select id="native"><option>A</option></select><script>
      window.inputs = []; document.addEventListener('input', e => inputs.push(e.isTrusted));
    </script>`);
    const session = await page.context().newCDPSession(page);
    const ext = extension(session);
    await ext.run('dispatch("type", {selector: "#rich", text: "New heading\\nNew paragraph", clearFirst: true, perCharMinMs: 0, perCharMaxMs: 0}, "agent-a")');
    assert.equal(await page.locator('#rich').innerText(), 'New heading\nNew paragraph');
    await ext.run('dispatch("type", {selector: "#plain", text: "", clearFirst: true}, "agent-a")');
    assert.equal(await page.locator('#plain').inputValue(), '');
    await ext.run('dispatch("fill", {selector: "#number", text: "125"}, "agent-a")');
    assert.equal(await page.locator('#number').inputValue(), '125');
    await assert.rejects(ext.run('dispatch("fill", {selector: "#short", text: "too long"}, "agent-a")'), /text_exceeds_field_maxlength/);
    assert.equal(await page.locator('#short').inputValue(), 'old');
    const long = 'Detailed experience. '.repeat(500);
    await ext.run(`dispatch("fill", {selector: "#history", text: ${JSON.stringify(long)}}, "agent-a")`);
    assert.equal(await page.locator('#history').inputValue(), long);
    await ext.run('dispatch("fill", {selector: "#rich", text: "Replacement only"}, "agent-a")');
    assert.equal(await page.locator('#rich').innerText(), 'Replacement only');
    assert.equal(await page.locator('#other').inputValue(), 'untouched');
    assert.ok((await page.evaluate(() => inputs)).every(Boolean));
    await assert.rejects(ext.run('dispatch("fill", {selector: "#password", text: "no"}, "agent-a")'), /password_field_not_allowed/);
    await assert.rejects(ext.run('dispatch("type", {selector: "#native", text: "A"}, "agent-a")'), /use_web_select/);
    await assert.rejects(ext.run('dispatch("fill", {selector: "#locked", text: "no"}, "agent-a")'), /field_not_editable/);
    await session.detach();
  } finally { await browser.close(); }
});

test('keyboard navigation, modifiers and repetitions operate on the target', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input id="edit" value="abcdef"><input id="other" value="untouched">');
    const session = await page.context().newCDPSession(page);
    const ext = extension(session);
    await ext.run('dispatch("type", {selector: "#edit", text: ""}, "agent-a")');
    await ext.run('dispatch("key", {key: "End"}, "agent-a")');
    await ext.run('dispatch("key", {key: "ArrowLeft", modifiers: ["Shift"], repeat: 3}, "agent-a")');
    await ext.run('dispatch("key", {key: "Backspace"}, "agent-a")');
    assert.equal(await page.locator('#edit').inputValue(), 'abc');
    await ext.run('dispatch("key", {key: "a", modifiers: ["Control"]}, "agent-a")');
    await ext.run('dispatch("key", {key: "Delete"}, "agent-a")');
    assert.equal(await page.locator('#edit').inputValue(), '');
    await ext.run('dispatch("key", {key: "z"}, "agent-a")');
    assert.equal(await page.locator('#edit').inputValue(), 'z');
    assert.equal(await page.locator('#other').inputValue(), 'untouched');
    await assert.rejects(ext.run('dispatch("key", {key: "F999"}, "agent-a")'), /unsupported_key/);
    await assert.rejects(ext.run('dispatch("key", {key: "constructor"}, "agent-a")'), /unsupported_key/);
    await assert.rejects(ext.run('dispatch("key", {key: "Enter", repeat: 0}, "agent-a")'), /invalid_repeat/);
    await assert.rejects(ext.run('dispatch("key", {key: "Enter", modifiers: ["Nope"]}, "agent-a")'), /unsupported_modifier/);
    await session.detach();
  } finally { await browser.close(); }
});

test('click rejects native options, hidden, disabled and obscured targets', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<select><option id="option">Pick me</option></select><button id="hidden" hidden>Hidden</button><button id="disabled" disabled>Disabled</button><button id="covered" style="position:fixed;left:0;top:0;width:100px;height:100px">Covered</button><div style="position:fixed;left:0;top:0;width:100px;height:100px;background:red"></div>');
    const session = await page.context().newCDPSession(page);
    const ext = extension(session);
    for (const [selector, message] of [['#option', /use_web_select/], ['#hidden', /control_not_visible/], ['#disabled', /control_disabled/], ['#covered', /control_obscured/]]) {
      await assert.rejects(ext.run(`dispatch("click", {selector: ${JSON.stringify(selector)}}, "agent-a")`), message);
    }
    assert.equal(ext.calls.some(([m]) => m === 'Input.dispatchMouseEvent'), false);
    await session.detach();
  } finally { await browser.close(); }
});

test('viewport clicks and targeted scrolling support custom controls without desktop input', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="custom" style="width:200px;height:40px">Custom rating</div><div id="list" style="width:200px;height:100px;overflow:auto"><div style="height:2000px">Long options list</div></div><script>
      window.clicks = []; custom.onclick = e => clicks.push([e.isTrusted, e.detail]);
    </script>`);
    const session = await page.context().newCDPSession(page);
    const ext = extension(session);
    const box = await page.locator('#custom').boundingBox();
    await ext.run(`dispatch("click", {x: ${box.x + 20}, y: ${box.y + 20}, clickCount: 2}, "agent-a")`);
    assert.deepEqual(await page.evaluate(() => clicks), [[true, 2]]);
    await ext.run('dispatch("scroll", {selector: "#list", deltaY: 200}, "agent-a")');
    await page.waitForFunction(() => document.querySelector('#list').scrollTop > 0);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await assert.rejects(ext.run('dispatch("click", {x: 99999, y: 20}, "agent-a")'), /coordinates_outside_viewport/);
    await assert.rejects(ext.run('dispatch("click", {x: 20}, "agent-a")'), /invalid_coordinates/);
    await assert.rejects(ext.run('dispatch("click", {selector: "#custom", x: 20, y: 20}, "agent-a")'), /provide_selector_or_coordinates/);
    await assert.rejects(ext.run('dispatch("scroll", {deltaY: 10001}, "agent-a")'), /invalid_scroll_delta/);
    await session.detach();
  } finally { await browser.close(); }
});

test('explicit focus reveals only the requesting agent tab, without navigating', async () => {
  const ext = extension({send: async () => ({data: ''})}, {allowFocus: true});
  await ext.run('dispatch("screenshot", {}, "agent-a")');
  await ext.run('dispatch("screenshot", {}, "agent-b")');
  await ext.run('dispatch("focus", {}, "agent-a")');
  assert.deepEqual(ext.calls.filter(([m]) => m === 'activate'), [['activate', {id: 7, active: true}]]);
  assert.deepEqual(ext.calls.filter(([m]) => m === 'focusWindow'), [['focusWindow', {id: 91, focused: true}]]);
  assert.equal(ext.calls.some(([m]) => m === 'Page.navigate'), false);
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
