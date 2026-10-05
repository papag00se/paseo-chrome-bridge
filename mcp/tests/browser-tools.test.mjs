import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "@playwright/test";
import { inspectPage } from "../browser-tools.mjs";
import { fetchPage } from "../../bridge/page-fetch.mjs";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("fetch waits after navigation, before extraction, including explicit zero", async () => {
  for (const waitMs of [0, 2000]) {
    const steps = [];
    const result = await fetchPage({ url: "https://example.test", waitMs }, async (method, params) => {
      steps.push([method, params]);
      return { text: "hydrated page" };
    }, async delay => steps.push(["wait", delay]));
    assert.deepEqual(steps, [
      ["navigate", { url: "https://example.test", waitMs: 15000 }],
      ["wait", waitMs],
      ["snapshot", { maxChars: 20000 }],
    ]);
    assert.equal(result.text, "hydrated page");
  }
  await assert.rejects(fetchPage({ url: "https://example.test", waitMs: -1 }, () => assert.fail()), /invalid_waitMs/);
});

test("browser snapshot selectors address real controls and omit hidden controls and input values", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<title>Editor</title><main>
      <label for="url">Destination</label><input id="url" value="PRIVATE_VALUE">
      <input type="password" value="PRIVATE_PASSWORD" aria-label="Password">
      <button id="edit:page">Edit</button><button>Preview</button>
      <button disabled>Save</button><button style="display:none">Hidden</button>
      <input type="hidden" value="HIDDEN_VALUE"><a href="https://example.test">Public page</a>
    </main>`);
    const snapshot = await page.evaluate(({ source }) => (0, eval)(`(${source})(20000,150)`), { source: inspectPage.toString() });
    assert.equal(snapshot.title, "Editor");
    assert.equal(snapshot.elements.find(el => el.label === "Destination").selector, "#url");
    assert.equal(snapshot.elements.find(el => el.label === "Save").disabled, true);
    assert.equal(snapshot.elements.some(el => el.label === "Hidden"), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_VALUE|PRIVATE_PASSWORD|HIDDEN_VALUE/);
    for (const element of snapshot.elements) assert.equal(await page.locator(element.selector).count(), 1);
    await page.locator(snapshot.elements.find(el => el.label === "Edit").selector).click();
    const limited = await page.evaluate(({ source }) => (0, eval)(`(${source})(500,1)`), { source: inspectPage.toString() });
    assert.equal(limited.elements.length, 1);
    assert.equal(limited.elementsTruncated, true);
  } finally {
    await browser.close();
  }
});

test("MCP stdio end-to-end: discovery, typed commands, image output, errors and serialization", async () => {
  const calls = [];
  let active = 0;
  let maximum = 0;
  const bridge = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    calls.push(request);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--;
    let result = { received: request.method };
    if (request.method === "eval") result = { value: { title: "Authenticated editor", elements: [] } };
    if (request.method === "screenshot") result = { dataUrl: `data:image/png;base64,${png}` };
    if (request.method === "waitText") result = { found: false };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(request.params?.selector === "#missing"
      ? { ok: false, error: "selector_not_found" } : { ok: true, result }));
  });
  await new Promise(resolve => bridge.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server.mjs", import.meta.url))],
    env: { ...process.env, BRIDGE_PORT: String(bridge.address().port), BRIDGE_TOKEN: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ["web_search", "web_fetch", "web_snapshot", "web_click", "web_type", "web_key", "web_wait", "web_screenshot"].sort());
    const snapshot = await client.callTool({ name: "web_snapshot", arguments: {} });
    assert.equal(JSON.parse(snapshot.content[0].text).title, "Authenticated editor");
    assert.equal(calls.at(-1).method, "eval");
    assert.match(calls.at(-1).params.expression, /20000,150/);
    await client.callTool({ name: "web_click", arguments: { selector: "#edit" } });
    assert.deepEqual(calls.at(-1), { method: "click", params: { selector: "#edit" } });
    await client.callTool({ name: "web_type", arguments: { selector: "#url", text: "hello", clearFirst: true } });
    assert.deepEqual(calls.at(-1).params, { selector: "#url", text: "hello", clearFirst: true, perCharMinMs: 10, perCharMaxMs: 25 });
    const image = await client.callTool({ name: "web_screenshot", arguments: {} });
    assert.deepEqual(image.content[0], { type: "image", mimeType: "image/png", data: png });
    const wait = await client.callTool({ name: "web_wait", arguments: { text: "Ready", timeoutMs: 10 } });
    assert.equal(JSON.parse(wait.content[0].text).found, false);
    const missing = await client.callTool({ name: "web_click", arguments: { selector: "#missing" } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /selector_not_found/);
    await Promise.all(["Tab", "Escape"].map(key => client.callTool({ name: "web_key", arguments: { key } })));
    assert.equal(maximum, 1);
    const count = calls.length;
    const invalid = await client.callTool({ name: "web_click", arguments: { selector: "" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, count);
  } finally {
    await client.close();
    await new Promise(resolve => bridge.close(resolve));
  }
});
