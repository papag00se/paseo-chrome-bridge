#!/usr/bin/env node
// MCP stdio server that presents the chrome-bridge as `web_search` and
// `web_fetch` tools. Agents already know these names, so they reach for the
// bridge without any prompting.
//
// Requires the bridge (bridge/server.mjs) to be running and the companion
// Chrome extension to be connected.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;

async function rpc(method, params = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) {
      const detail = body?.error ? String(body.error) : `http ${res.status}`;
      throw new Error(`bridge rpc "${method}" failed: ${detail}`);
    }
    return body.result ?? body;
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`bridge rpc "${method}" timed out after ${timeoutMs}ms`);
    }
    if (err.cause?.code === "ECONNREFUSED" || /fetch failed/i.test(String(err.message))) {
      throw new Error(
        `chrome-bridge is not reachable on ${BASE}. Start it (systemctl --user start chrome-bridge` +
          ` or node bridge/server.mjs) and make sure Chrome is running with the extension loaded.`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The bridge drives a single Chrome tab, so only one operation may run at a
// time. Serialize this process's calls locally (batched parallel tool calls
// simply run back-to-back), and let the bridge's own queue arbitrate between
// separate agent processes.
let localChain = Promise.resolve();
function serialize(task) {
  const result = localChain.then(task);
  localChain = result.catch(() => {});
  return result;
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function errorResult(err) {
  let message = String(err?.message ?? err);
  if (message.includes("QUEUE_FULL")) {
    message =
      "QUEUE_FULL: the browser executes one web_search/web_fetch at a time and its short " +
      "wait queue is full. Do not issue parallel calls; wait for the current operation to " +
      "finish, then retry this call sequentially.";
  }
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new McpServer({ name: "chrome-bridge", version: "0.1.0" });

server.registerTool(
  "web_search",
  {
    title: "Web search",
    description:
      "Search the web using the user's real, logged-in Chrome browser (real cookies, IP, and " +
      "fingerprint, human-paced typing). Returns ranked results with titles, URLs, and snippets. " +
      "Use this whenever you need current information from the web. The browser handles exactly " +
      "one operation at a time: never call web_search/web_fetch in parallel; make calls " +
      "sequentially and wait for each result.",
    inputSchema: {
      query: z.string().describe("The search query"),
      engine: z
        .enum(["google", "bing", "duckduckgo"])
        .optional()
        .describe("Search engine to use (default google)"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 8)"),
    },
  },
  async ({ query, engine = "google", limit = 8 }) => {
    try {
      const result = await serialize(() => rpc("search", { query, engine, limit }));
      const results = result?.results ?? [];
      if (results.length === 0) {
        return text(`No results parsed for "${query}" on ${engine}. The page may need a different engine or the query may be too narrow.`);
      }
      const lines = results.map(
        (r) => `${r.rank}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      );
      return text(`Results for "${query}" (${engine}):\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "web_fetch",
  {
    title: "Web fetch",
    description:
      "Fetch a URL using the user's real, logged-in Chrome browser and return the rendered page " +
      "text and links. Works on pages that need JavaScript or the user's login session. Use this " +
      "to read a specific web page. The browser handles exactly one operation at a time: never " +
      "call web_search/web_fetch in parallel; make calls sequentially and wait for each result.",
    inputSchema: {
      url: z.string().url().describe("The URL to fetch"),
      maxChars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .optional()
        .describe("Max characters of page text to return (default 20000)"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(30_000)
        .optional()
        .describe("Extra milliseconds to wait after navigation for slow pages (default 1500)"),
    },
  },
  async ({ url, maxChars = 20_000, waitMs = 1500 }) => {
    try {
      const snap = await serialize(() => rpc("fetch", { url, waitMs, maxChars }));
      const links = (snap?.links ?? [])
        .slice(0, 40)
        .map((l) => `- ${l.text ? `${l.text}: ` : ""}${l.href ?? l.url ?? ""}`)
        .join("\n");
      const parts = [
        `# ${snap?.title ?? "(no title)"}`,
        `URL: ${snap?.url ?? url}`,
        "",
        snap?.text ?? "(no text extracted)",
      ];
      if (links) parts.push("", "## Links", links);
      return text(parts.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
