#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

// RPC records are LF-delimited; Unicode separators inside JSON are not delimiters.
export function lines(stream, callback) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end+1); callback(line);
    }
  });
}
export function runPiGateway({command,args,input=process.stdin,output=process.stdout,errors=process.stderr,timeoutMs=25000}) {
  const token = randomUUID();
  const child = spawn(command,args,{stdio:['pipe','pipe','pipe'],env:{...process.env,PASEO_PI_GUARD_TOKEN:token}});
  const pending = new Map();
  const inventories = new Map();
  const send = data => child.stdin.write(JSON.stringify(data)+'\n');
  const emit = data => output.write(JSON.stringify(data)+'\n');
  function wait(map,id) {
    return new Promise((resolve,reject) => {
      const timer = setTimeout(()=>{map.delete(id);reject(new Error('Inventory check timed out'));},timeoutMs);
      map.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});
    });
  }
  function call(type,extra={}) {
    const id = `${token}-${randomUUID()}`;
    const promise = wait(pending,id); send({id,type,...extra}); return promise;
  }
  async function check() {
    // Never send a slash command until Pi confirms it is registered: otherwise
    // a missing extension could cause the diagnostic text to reach a model.
    const commands = await call('get_commands');
    if (!commands.success || !commands.data?.commands?.some(c=>c.name==='chrome-bridge-guard-check')) throw new Error('Pi guard extension is not loaded');
    const id = randomUUID();
    const inventory = wait(inventories,id);
    const [response,result] = await Promise.all([call('prompt',{message:`/chrome-bridge-guard-check ${id}`}),inventory]);
    if (!response.success || response.data?.disposition !== 'handled') throw new Error('Pi inventory command was not handled');
    if (!result.ok) throw new Error(result.error || 'Pi inventory rejected');
    errors.write('[chrome-bridge-guard] PASS Pi inventory and Chrome Bridge health\n');
  }
  lines(child.stdout,line=>{
    let data; try {data=JSON.parse(line);} catch {child.kill();return;}
    if (String(data.id??'').startsWith(token)) {
      const p=pending.get(data.id); if(p){pending.delete(data.id);p.resolve(data);} return;
    }
    emit(data);
  });
  lines(child.stderr,line=>{
    try {
      const data=JSON.parse(line);
      if(data.chromeBridgeGuard===token) {
        const p=inventories.get(data.request); if(p){inventories.delete(data.request);p.resolve(data);} return;
      }
    } catch {}
    errors.write(line+'\n');
  });
  let queue = Promise.resolve();
  const guarded = new Set(['prompt','steer','follow_up','compact','bash']);
  lines(input,line=>{
    let data; try {data=JSON.parse(line);} catch {return;}
    if (String(data.id??'').startsWith(token)) return;
    if (!guarded.has(data.type)) {send(data);return;}
    queue=queue.then(async()=>{
      try {await check();send(data);} catch(error) {
        emit({id:data.id,type:'response',command:data.type,success:false,error:`CHROME_BRIDGE_GUARD: ${error.message}`});
      }
    });
  });
  input.on('end',()=>queue.finally(()=>child.stdin.end()));
  child.stdin.on('error',()=>{});
  function rejectAll(error) {for(const map of [pending,inventories]){for(const p of map.values())p.reject(error);map.clear();}}
  const done = new Promise(resolve=>{
    child.on('error',e=>{rejectAll(e);errors.write(e.message+'\n');resolve(1);});
    child.on('exit',code=>{rejectAll(new Error('Pi stopped during inventory check'));resolve(code??1);});
  });
  return {done,stop:()=>child.kill('SIGTERM')};
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const [flag,command,...args]=process.argv.slice(2);
  if(flag!=='--upstream'||!command?.startsWith('/')) throw new Error('Expected --upstream /absolute/path/to/pi');
  if(args.includes('--version')||args.includes('--help')||args.includes('--list-models')) {
    const child=spawn(command,args,{stdio:'inherit'});child.on('exit',code=>{process.exitCode=code??1;});
  } else if(args.includes('rpc') && args.includes('--mode')) {
    const extension=fileURLToPath(new URL('./pi-extension.ts',import.meta.url));
    const gateway=runPiGateway({command,args:[...args,'--extension',extension]});
    for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,gateway.stop);
    process.exitCode=await gateway.done;
  } else {console.error('CHROME_BRIDGE_GUARD: only Paseo Pi RPC launches are allowed');process.exitCode=1;}
}
