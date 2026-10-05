import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {runGateway,exclusions} from './codex.mjs';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

function harness(t){
  const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
  errors.resume();
  const received=[],waiters=new Map();
  const fixture=`
    const {createInterface}=require('node:readline');
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='mcpServerStatus/list') return; // deliberately broken discovery
      process.stdout.write(JSON.stringify({id:m.id,result:{forwarded:m}})+'\\n');
    });`;
  const gateway=runGateway({command:process.execPath,args:['-e',fixture],input,output,errors});
  const lines=createInterface({input:output});
  lines.on('line',line=>{const m=JSON.parse(line);received.push(m);waiters.get(m.id)?.(m);});
  t.after(async()=>{input.end();gateway.stop();await gateway.done;lines.close();});
  let sequence=0;
  return {received,call(method,params={}){
    const id=++sequence;
    return new Promise(resolve=>{waiters.set(id,resolve);input.write(JSON.stringify({id,method,params})+'\n');});
  }};
}
test('broken inventory cannot block resume, multiple turns, shell, steering or notifications',{timeout:5000},async t=>{
  const h=harness(t);
  for(const method of ['thread/start','thread/resume','thread/fork','turn/start',
    'turn/start','turn/steer','thread/queue/add','thread/shellCommand']){
    const result=await h.call(method,{threadId:'existing-thread'});
    assert.equal(result.result.forwarded.method,method);
  }
});
test('restricted direct calls fail only that operation; subsequent turns still work',{timeout:5000},async t=>{
  const h=harness(t);
  for(const params of [{server:'cua_repl'},{serverName:'node_repl'},
    {pluginId:'unified-computer-use@openai-bundled'}]){
    assert.match((await h.call('mcpServer/tool/call',params)).error.message,/Restricted/);
    assert.equal((await h.call('turn/start')).result.forwarded.method,'turn/start');
  }
});
test('approved browser call is forwarded without whole-inventory checks',{timeout:5000},async t=>{
  const h=harness(t);
  assert.equal((await h.call('mcpServer/tool/call',{server:'chrome_bridge',tool:'web_click'})).result.forwarded.params.server,'chrome_bridge');
});
test('Desktop config rewrites cannot affect the launched private configuration',{timeout:5000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'paseo-codex-isolation-'));
  t.after(()=>rm(home,{recursive:true,force:true}));
  const desktop=join(home,'.codex'),privateHome=join(home,'.paseo','codex-home');
  await mkdir(desktop,{recursive:true});await mkdir(privateHome,{recursive:true});
  await writeFile(join(privateHome,'config.toml'),'owner = "paseo"');
  await writeFile(join(desktop,'config.toml'),'owner = "desktop-rewritten"');
  const upstream=join(home,'upstream');
  await writeFile(upstream,`#!${process.execPath}\nconst fs=require('node:fs');\nconsole.log(JSON.stringify({id:1,result:{home:process.env.CODEX_HOME,config:fs.readFileSync(process.env.CODEX_HOME+'/config.toml','utf8'),args:process.argv.slice(2)}}));\n`,{mode:0o700});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./codex.mjs',import.meta.url)),
    '--upstream',upstream,'app-server'],{env:{...process.env,HOME:home},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.equal(code,0,err);
  const result=JSON.parse(out.trim()).result;
  assert.equal(result.home,privateHome);assert.equal(result.config,'owner = "paseo"');
  for(const value of exclusions)assert.ok(result.args.includes(value));
  assert.equal(await readFile(join(desktop,'config.toml'),'utf8'),'owner = "desktop-rewritten"');
});
test('launch excludes both restricted servers and all bundled browser plugins',()=>{
  assert.ok(exclusions.includes('mcp_servers.cua_repl.enabled=false'));
  assert.ok(exclusions.includes('mcp_servers.node_repl.enabled=false'));
  for(const name of ['unified-computer-use','computer-use','browser','chrome'])
    assert.ok(exclusions.includes(`plugins."${name}@openai-bundled".enabled=false`));
});
