import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { bridgeStart, bridgeStatus, bridgeStop } from "../shared/contracts";

export function BridgeSettings({ theme, layout }: PluginSurfaceProps) {
  const getStatus = useRpc(bridgeStatus), start = useRpc(bridgeStart), stop = useRpc(bridgeStop);
  const queries = useQueryClient();
  const status = useQuery({ queryKey: ["chrome-bridge-status"], queryFn: () => getStatus({}), refetchInterval: 3000 });
  const action = useMutation({
    mutationFn: (operation: "start" | "stop") => operation === "start" ? start({}) : stop({}),
    onSettled: () => queries.invalidateQueries({ queryKey: ["chrome-bridge-status"] }),
  });
  const text = { color: theme.colors.foreground }, muted = { color: theme.colors.foregroundMuted };
  return <View style={{ gap: 16, padding: layout.compact ? 12 : 20 }}>
    <SettingsSection title="Chrome Bridge">
      <Text style={muted}>Drives your real, logged-in Chrome through the companion extension and localhost bridge. No separate browser or profile lock.</Text>
      {status.data ? <View style={{ gap: 8 }}>
        <Text style={text}>{status.data.running ? `Bridge running on :${status.data.port}` : "Bridge stopped"}</Text>
        <Text style={text}>{status.data.extensionConnected ? "Extension connected" : "Extension not connected"}</Text>
        {!!status.data.extensionUserAgent && <Text style={muted}>{status.data.extensionUserAgent}</Text>}
        <Text style={muted}>{status.data.detail}</Text>
      </View> : <Text style={muted}>{status.isPending ? "Loading bridge status…" : "Bridge status unavailable"}</Text>}
      <SettingsCard>
        <SettingsAction label="Start the bridge" actionLabel="Start" disabled={action.isPending} onPress={() => action.mutate("start")} />
        <SettingsAction label="Stop the bridge" actionLabel="Stop" disabled={action.isPending} onPress={() => action.mutate("stop")} />
      </SettingsCard>
      {!!(status.error || action.error) && <Text accessibilityRole="alert" style={text}>{(action.error || status.error)?.message}</Text>}
    </SettingsSection>
    <SettingsSection title="One-time extension setup">
      <Text style={muted}>1. Open chrome://extensions and enable Developer mode.{"\n"}2. Choose Load unpacked and select the repository's extension/ folder.{"\n"}3. Keep a normal tab focused; the status above confirms when it connects.</Text>
    </SettingsSection>
  </View>;
}
