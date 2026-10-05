const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Keep navigation readiness separate from the requested SPA rendering delay.
// The extension's navigate waitMs is a readiness deadline, not a post-load sleep.
export async function fetchPage(params, send, wait = sleep) {
  const { url, waitMs = 1500, maxChars = 20000 } = params || {};
  if (!url || typeof url !== "string") throw new Error("url_required");
  const delay = Number(waitMs);
  if (!Number.isFinite(delay) || delay < 0 || delay > 30000) throw new Error("invalid_waitMs");
  await send("navigate", { url, waitMs: 15000 });
  await wait(delay);
  return send("snapshot", { maxChars });
}
