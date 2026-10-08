#!/usr/bin/env node
// MCP stdio server that presents the chrome-bridge as `web_search` and
// `web_fetch` tools. Agents already know these names, so they reach for the
// bridge without any prompting.
//
// Requires the bridge (bridge/server.mjs) to be running and the companion
// Chrome extension to be connected.

import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerBrowserTools } from "./browser-tools.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN = process.env.BRIDGE_TOKEN || "";
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

// One MCP server process runs per agent, so this id is the agent's browser
// session: its own tab, and its own command order.
const SESSION = randomUUID();

// Held open while this process lives. When the agent exits, the OS drops the
// connection and the bridge closes this agent's tab. Opened on first browser
// use and reopened after a bridge restart; unref'd so it never keeps the
// process alive.
let sessionLink = null;
function holdSession() {
  if (sessionLink) return;
  const req = http.get(`${BASE}/session?id=${SESSION}`, { headers: AUTH }, (res) => {
    res.on("data", () => {});
    res.on("close", () => {
      if (sessionLink === req) sessionLink = null;
    });
  });
  req.on("socket", (socket) => socket.unref());
  req.on("error", () => {
    if (sessionLink === req) sessionLink = null;
  });
  sessionLink = req;
}

class RateLimited extends Error {
  constructor(retryAfterMs) {
    super("RATE_LIMITED");
    this.retryAfterMs = retryAfterMs;
  }
}

async function rpc(method, params = {}, timeoutMs = 120_000) {
  holdSession();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ method, params, session: SESSION }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (res.status === 429) {
      const seconds = Number(res.headers.get("retry-after"));
      throw new RateLimited(body?.retryAfterMs ?? (Number.isFinite(seconds) ? seconds * 1000 : 30_000));
    }
    if (!res.ok || !body || body.ok === false) {
      const detail = body?.error ? String(body.error) : `http ${res.status}`;
      throw new Error(`bridge rpc "${method}" failed: ${detail}`);
    }
    return body.result ?? body;
  } catch (err) {
    if (err instanceof RateLimited) throw err;
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

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function errorResult(err) {
  let message = String(err?.message ?? err);
  if (err instanceof RateLimited) {
    const seconds = Math.ceil(err.retryAfterMs / 1000);
    message =
      `RATE_LIMITED — retry in ${seconds} seconds. This is a temporary cooldown, not a failure. ` +
      "Google searches from every agent share the user's real browser, so they are spaced out " +
      `to look like one person searching. Wait ${seconds} seconds (for example run \`sleep ${seconds}\`), ` +
      "then call this same tool again with the same arguments. Do not give up on the search.";
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
      "Use this whenever you need current information from the web. Google searches are " +
      "spaced out across all agents: a RATE_LIMITED result says how many seconds to wait " +
      "before retrying the same call.",
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
      const result = await rpc("search", { query, engine, limit });
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
      "to read a specific web page. For logged-in apps use web_snapshot to inspect the existing " +
      "page without reloading, web_screenshot to see it, and web_click to navigate controls. " +
      "Your calls run in order in your own browser tab.",
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
      const snap = await rpc("fetch", { url, waitMs, maxChars });
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

registerBrowserTools(server, { rpc, errorResult });

const transport = new StdioServerTransport();
await server.connect(transport);
