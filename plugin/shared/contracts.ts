import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const bridgeStatus = defineRpc({
  name: "status",
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
  name: "start",
  input: z.object({}),
  output: z.object({ running: z.boolean(), detail: z.string() }),
});

export const bridgeStop = defineRpc({
  name: "stop",
  input: z.object({}),
  output: z.object({ running: z.boolean(), detail: z.string() }),
});
