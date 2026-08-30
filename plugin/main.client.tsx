import type { PluginSurfaceProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { bridgeStart, bridgeStatus, bridgeStop } from "./contracts";

type Status = {
  running: boolean;
  port: number;
  extensionConnected: boolean;
  extensionUserAgent: string | null;
  detail: string;
};

export function MainSurface({ theme, layout }: PluginSurfaceProps) {
  const getStatus = useRpc(bridgeStatus);
  const start = useRpc(bridgeStart);
  const stop = useRpc(bridgeStop);
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getStatus({}));
    } catch {
      setStatus(null);
    }
  }, [getStatus]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const s = useMemo(
    () => ({
      screen: { flex: 1, padding: layout.compact ? 16 : 24, gap: 12, backgroundColor: theme.colors.surface0 },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      row: { flexDirection: "row" as const, gap: 10, alignItems: "center" as const },
      dot: (on: boolean) => ({ width: 10, height: 10, borderRadius: 5, backgroundColor: on ? theme.colors.accent : theme.colors.statusDanger }),
      label: { color: theme.colors.foreground, fontSize: 14 },
      btn: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8, backgroundColor: theme.colors.accent },
      btnText: { color: theme.colors.accentForeground, textAlign: "center" as const, fontWeight: "600" as const },
      code: { color: theme.colors.foreground, fontFamily: "monospace" as const, fontSize: 12 },
      card: { gap: 8, padding: 14, borderRadius: 10, backgroundColor: theme.colors.surface0 },
    }),
    [theme, layout.compact],
  );

  const running = !!status?.running;
  const connected = !!status?.extensionConnected;

  return (
    <ScrollView contentContainerStyle={s.screen}>
      <Text style={s.title}>Chrome Bridge</Text>
      <Text style={s.muted}>
        Drives your real, logged-in Chrome via a companion extension over a localhost bridge. Your profile, cookies,
        fingerprint, and IP — no separate browser, no profile lock.
      </Text>

      <View style={s.card}>
        <View style={s.row}>
          <View style={s.dot(running)} />
          <Text style={s.label}>Bridge server {running ? `running on :${status?.port}` : "stopped"}</Text>
        </View>
        <View style={s.row}>
          <View style={s.dot(connected)} />
          <Text style={s.label}>{connected ? "Extension connected" : "Extension not connected"}</Text>
        </View>
        {status?.extensionUserAgent ? <Text style={s.code}>{status.extensionUserAgent}</Text> : null}
        <Text style={s.muted}>{status?.detail ?? "…"}</Text>
      </View>

      <View style={s.row}>
        <Pressable style={s.btn} onPress={async () => { await start({}); refresh(); }} accessibilityRole="button" accessibilityLabel="Start bridge">
          <Text style={s.btnText}>Start</Text>
        </Pressable>
        <Pressable style={s.btn} onPress={async () => { await stop({}); refresh(); }} accessibilityRole="button" accessibilityLabel="Stop bridge">
          <Text style={s.btnText}>Stop</Text>
        </Pressable>
      </View>

      <View style={s.card}>
        <Text style={s.label}>One-time extension setup</Text>
        <Text style={s.muted}>
          1. Open chrome://extensions, enable Developer mode.{"\n"}
          2. Load unpacked → select the repo's extension/ folder.{"\n"}
          3. Keep a normal tab focused; the dot above turns on when it connects.
        </Text>
      </View>
    </ScrollView>
  );
}
