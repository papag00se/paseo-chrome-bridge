import { GOOGLE_SEARCH_JITTER_MS, GOOGLE_SEARCH_MIN_INTERVAL_MS } from "./constants.mjs";

// True when an /rpc call would load a Google results page: the high-level search
// on Google, or any navigation/fetch straight to a google.<tld>/search URL.
export function isGoogleSearch(method, params = {}) {
  if (method === "search") return (params.engine ?? "google") === "google";
  if (method !== "fetch" && method !== "navigate") return false;
  try {
    const url = new URL(params.url);
    return /(^|\.)google\.[a-z.]+$/i.test(url.hostname) && url.pathname.startsWith("/search");
  } catch {
    return false;
  }
}

// One shared spacing window for Google searches from every agent. acquire()
// either reserves the next slot or reports how long the caller must wait. It
// never sleeps, so a rate-limited caller gets an immediate answer.
export function createGoogleCooldown({
  minIntervalMs = GOOGLE_SEARCH_MIN_INTERVAL_MS,
  jitterMs = GOOGLE_SEARCH_JITTER_MS,
  now = Date.now,
  random = Math.random,
} = {}) {
  let nextAllowedAt = 0;
  return {
    acquire() {
      const t = now();
      if (t < nextAllowedAt) return { ok: false, retryAfterMs: nextAllowedAt - t };
      nextAllowedAt = t + minIntervalMs + Math.floor(random() * jitterMs);
      return { ok: true };
    },
  };
}
