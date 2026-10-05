import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function run(command,args=[],{env=process.env,input='',binary=false}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe']});
    const out=[],err=[];
    const timer=setTimeout(()=>child.kill('SIGTERM'),15000);
    child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);const data=Buffer.concat(out);code===0?resolve(binary?data:data.toString()):reject(new Error(`${command} failed: ${Buffer.concat(err).toString() || data.toString() || code}`));});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
export async function desktopEnvironment() {
  const runtime=process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const env={...process.env,XDG_RUNTIME_DIR:runtime,YDOTOOL_SOCKET:process.env.YDOTOOL_SOCKET || `${runtime}/.ydotool_socket`};
  const instances=JSON.parse(await run('/usr/bin/hyprctl',['-j','instances'],{env}));
  const instance=instances.find(i=>i.instance===env.HYPRLAND_INSTANCE_SIGNATURE) || (instances.length===1?instances[0]:null);
  if(!instance)throw new Error('No unambiguous Hyprland desktop session; set HYPRLAND_INSTANCE_SIGNATURE');
  env.HYPRLAND_INSTANCE_SIGNATURE=instance.instance;
  env.WAYLAND_DISPLAY=instance.wl_socket;
  return env;
}
export async function perform(action,p,env,exec=run) {
  const call=(cmd,args=[],extra={})=>exec(cmd,args,{env,...extra});
  const move=async(x,y)=>{
    const result=await call('/usr/bin/hyprctl',['dispatch',`hl.dsp.cursor.move({x=${x},y=${y}})`]);
    if(!result.trim().startsWith('ok'))throw new Error(`Cursor move failed: ${result}`);
  };
  switch(action) {
    case 'status': return {monitors:JSON.parse(await call('/usr/bin/hyprctl',['-j','monitors'])),cursor:JSON.parse(await call('/usr/bin/hyprctl',['-j','cursorpos']))};
    case 'screenshot': {
      const args=['-s','1'];
      if(p.monitor)args.push('-o',p.monitor);
      if(p.region)args.push('-g',`${p.region.x},${p.region.y} ${p.region.width}x${p.region.height}`);
      args.push('-');
      const data=await call('/usr/bin/grim',args,{binary:true});
      return {image:data.toString('base64'),mimeType:'image/png'};
    }
    case 'move': await move(p.x,p.y); break;
    case 'click': {
      if(p.x!==undefined)await move(p.x,p.y);
      const code={left:'0xC0',right:'0xC1',middle:'0xC2'}[p.button||'left'];
      await call('/usr/bin/ydotool',['click','--repeat',String(p.count||1),'--next-delay','40',code]); break;
    }
    case 'type': await call('/usr/bin/wtype',['-d','10','-'],{input:p.text});break;
    case 'key': {
      const mods=p.modifiers||[];
      await call('/usr/bin/wtype',[...mods.flatMap(m=>['-M',m]),'-k',p.key,...[...mods].reverse().flatMap(m=>['-m',m])]); break;
    }
    case 'scroll': await call('/usr/bin/ydotool',['mousemove','--wheel','-x',String(p.horizontal||0),'-y',String(p.vertical||0)]);break;
    case 'drag':
      await move(p.fromX,p.fromY);
      try {
        await call('/usr/bin/ydotool',['click','0x40']);
        for(let i=1;i<=10;i++) {
          await move(Math.round(p.fromX+(p.toX-p.fromX)*i/10),Math.round(p.fromY+(p.toY-p.fromY)*i/10));
          await new Promise(resolve=>setTimeout(resolve,20));
        }
      } finally {await call('/usr/bin/ydotool',['click','0x80']);}
      break;
    default:throw new Error('Unknown desktop action');
  }
  return {ok:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const {action,params}=JSON.parse(input);
    const result=await perform(action,params,await desktopEnvironment());
    process.stdout.write(JSON.stringify(result));
  } catch(error){process.stderr.write(error.message);process.exitCode=1;}
}
