#!/usr/bin/env node
// Restrict computer-control operations, never unrelated session work.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const requiredTools = ['web_search','web_fetch','web_snapshot','web_click',
  'web_type','web_key','web_wait','web_screenshot'];
const bannedNames = new Set(['cua_repl', 'node_repl']);
const bannedPlugins = new Set(['unified-computer-use@openai-bundled',
  'computer-use@openai-bundled','browser@openai-bundled','chrome@openai-bundled']);
export const exclusions = [
  ...[...bannedNames].map(name => `mcp_servers.${name}.enabled=false`),
  ...[...bannedPlugins].map(name => `plugins."${name}".enabled=false`),
];
export function runGateway({command, args, input=process.stdin,
  output=process.stdout, errors=process.stderr, env=process.env}) {
  const child = spawn(command,args,{stdio:['pipe','pipe','pipe'],env});
  const emit = message => output.write(JSON.stringify(message)+'\n');
  const clientLines = createInterface({input});
  const serverLines = createInterface({input:child.stdout});
  let stopped=false;
  clientLines.on('line',line=>{
    let message;
    try {message=JSON.parse(line);} catch {
      emit({id:null,error:{code:-32700,message:'Invalid JSON'}}); return;
    }
    const p=message.params;
    if (message.method==='mcpServer/tool/call' &&
        (bannedNames.has(p?.server) || bannedNames.has(p?.serverName) ||
         bannedPlugins.has(p?.pluginId))) {
      emit({id:message.id,error:{code:-32001,
        message:'CHROME_BRIDGE_GUARD: Restricted computer-control tool call'}});
      return;
    }
    child.stdin.write(JSON.stringify(message)+'\n');
  });
  serverLines.on('line',line=>{
    try {emit(JSON.parse(line));} catch {
      errors.write('[chrome-bridge-guard] Invalid app-server protocol output\n');
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data',data=>errors.write(data));
  child.stdin.on('error',error=>errors.write(`[chrome-bridge-guard] ${error.message}\n`));
  const done=new Promise(resolve=>{
    child.on('error',error=>{
      stopped=true; errors.write(`${error.message}\n`);
      clientLines.close();serverLines.close();resolve(1);
    });
    child.on('exit',code=>{
      stopped=true;clientLines.close();serverLines.close();resolve(code??1);
    });
  });
  clientLines.on('close',()=>{if(!stopped)child.stdin.end();});
  return {done,stop:()=>child.kill('SIGTERM')};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=process.argv.slice(2);
  if(args[0]!=='--upstream'||!args[1]?.startsWith('/'))
    throw new Error('Usage: codex.mjs --upstream /absolute/path/to/codex [arguments]');
  const command=args[1],forwarded=args.slice(2);
  const env={...process.env,CODEX_HOME:join(homedir(),'.paseo','codex-home')};
  if(forwarded.includes('--version')||forwarded.includes('--help')){
    const child=spawn(command,forwarded,{stdio:'inherit',env});
    child.on('error',()=>{process.exitCode=1;});
    child.on('exit',code=>{process.exitCode=code??1;});
  }else if(forwarded[0]==='app-server'&&!forwarded.some(a=>
    a==='proxy'||a==='daemon'||a==='--listen'||a.startsWith('--listen='))){
    const gateway=runGateway({command,env,
      args:[...forwarded,...exclusions.flatMap(value=>['-c',value])]});
    for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,gateway.stop);
    process.exitCode=await gateway.done;
  }else{errorsNotSupported();}
}
function errorsNotSupported(){
  console.error('CHROME_BRIDGE_GUARD: only Paseo stdio app-server launches are supported');
  process.exitCode=1;
}
