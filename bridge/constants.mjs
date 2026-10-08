// Named constants shared by the bridge. Environment variables are reserved for
// per-machine settings (BRIDGE_PORT, BRIDGE_TOKEN).

export const VERSION = "0.2.0";
export const DEFAULT_PORT = 8787;
export const HOST = "127.0.0.1";

// Commands without a session (raw curl callers) share one tab.
export const DEFAULT_SESSION = "shared";

// Google sees every search from the user's real browser, so all agents share one
// spacing window. Each Google search reserves the next slot at
// minimum + random(0, jitter) after its own start, like a person between searches.
export const GOOGLE_SEARCH_MIN_INTERVAL_MS = 25_000;
export const GOOGLE_SEARCH_JITTER_MS = 15_000;

export const EXTENSION_COMMAND_TIMEOUT_MS = 30_000;
export const EXTENSION_PING_INTERVAL_MS = 20_000;
export const MAX_BODY_BYTES = 5_000_000;
