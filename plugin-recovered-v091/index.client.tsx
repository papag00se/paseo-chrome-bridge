import type { PluginClientContext } from "@getpaseo/plugin/client";
import { BridgeSettings } from "./client/main";
export default function contribute(client: PluginClientContext) {
 client.addSettingsScreen({id:"settings",title:"Settings",icon:"Globe",Component:BridgeSettings});
 client.addCommandCenterItem({id:"settings",title:"Chrome Bridge settings",icon:"Globe",context:"global",onSelect:({openSettings})=>openSettings("settings")});
 return () => {};
}
