import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const bridgeStatus = defineRpc({
  name: "chromeBridge.status",
  input: z.object({}),
  output: z.object({
    running: z.boolean(),
    port: z.number(),
    extensionConnected: z.boolean(),
    extensionUserAgent: z.string().nullable(),
    detail: z.string(),
  }),
});

export const bridgeStart = defineRpc({
  name: "chromeBridge.start",
  input: z.object({}),
  output: z.object({ running: z.boolean(), detail: z.string() }),
});

export const bridgeStop = defineRpc({
  name: "chromeBridge.stop",
  input: z.object({}),
  output: z.object({ running: z.boolean(), detail: z.string() }),
});
