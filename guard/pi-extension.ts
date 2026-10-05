// Loaded explicitly by the Paseo Pi launcher. Metadata checks only.
const required = ['web_search','web_fetch','web_snapshot','web_click','web_type','web_key','web_wait','web_screenshot'];
const banned = /(^|[^a-z0-9])(?:cua_repl|node_repl)(?:[^a-z0-9]|$)|unified-computer-use/i;
export default function (pi: any) {
  function inspect() {
    const tools = pi.getAllTools();
    const bad = tools.filter((t: any) => t.exposure !== 'hidden' && banned.test(JSON.stringify({name:t.name,source:t.sourceInfo})));
    if (bad.length) throw new Error(`Banned integration present: ${bad.map((t: any) => t.name).join(', ')}`);
    const active = new Set(pi.getActiveTools());
    const missing = required.filter(name => !active.has(name));
    if (missing.length) throw new Error(`Chrome Bridge tools missing or inactive: ${missing.join(', ')}`);
    return [...active];
  }
  pi.registerCommand('chrome-bridge-guard-check', {
    description: 'Internal Paseo Chrome Bridge inventory check',
    handler: async (args: string) => {
      let result: any;
      const deadline = Date.now() + 15000;
      while (true) {
        try {
          const names = inspect();
          // Availability belongs to browser tool execution, not agent startup.
          // Keep enforcing the inventory even when Chrome is closed.
          result = {ok:true,names}; break;
        } catch (error: any) {
          if (!error.message.startsWith('Chrome Bridge tools missing') || Date.now() >= deadline) {result={ok:false,error:error.message}; break;}
          await new Promise(resolve => setTimeout(resolve,100));
        }
      }
      process.stderr.write(JSON.stringify({chromeBridgeGuard:process.env.PASEO_PI_GUARD_TOKEN,request:args,...result})+'\n');
    }
  });
  pi.on('tool_call', async (event: any) => {
    try {
      if (banned.test(event.toolName) || (event.toolName === 'mcp' && banned.test(JSON.stringify(event.input)))) throw new Error('Banned computer-control integration');
      inspect();
    } catch (error: any) { return {block:true,reason:`CHROME_BRIDGE_GUARD: ${error.message}`}; }
  });
  pi.on('input', async (_event: any, ctx: any) => {
    try {inspect();} catch (error: any) {
      ctx.ui.notify(`CHROME_BRIDGE_GUARD: ${error.message}`, 'error');
      return {action:'handled'};
    }
    return {action:'continue'};
  });
}
