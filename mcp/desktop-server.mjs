#!/usr/bin/env node
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {fileURLToPath} from 'node:url';
import {run} from './desktop-worker.mjs';

const server=new McpServer({name:'omarchy-desktop',version:'1.0.0'});
const worker=fileURLToPath(new URL('./desktop-worker.mjs',import.meta.url));
const runtime=process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const coordinate=z.number().int().min(-50000).max(50000);
const shared=' Native Omarchy/Hyprland desktop control, independent of OpenAI cua_repl. The desktop is shared by all agents and the human: coordinate use and do not run concurrent desktop workflows. Coordinates are global logical pixels. Inspect desktop_status and a fresh screenshot before targeting controls. Never use this tool to circumvent a blocked action or access a page through an alternate route.';
function register(name,description,inputSchema,readOnly,action) {
  server.registerTool(name,{description:description+shared,inputSchema,annotations:{readOnlyHint:readOnly,openWorldHint:true}},async params=>{
    try {
      if(action==='click' && ((params.x===undefined)!==(params.y===undefined))) throw new Error('Supply both x and y, or neither');
      const result=JSON.parse(await run('/usr/bin/flock',['--wait','5',`${runtime}/paseo-desktop.lock`,process.execPath,worker],{input:JSON.stringify({action,params})}));
      if(result.image)return {content:[{type:'image',data:result.image,mimeType:result.mimeType},{type:'text',text:'Screenshot scale is 1 pixel per logical desktop pixel. For a region, add its x/y origin to image coordinates. For a monitor, add its desktop_status x/y origin.'}]};
      return {content:[{type:'text',text:JSON.stringify(result)}]};
    } catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
  });
}
register('desktop_status','Read monitor layout, scale, rotation and cursor position. Does not inspect window contents.',{},true,'status');
register('desktop_screenshot','Capture the desktop, one monitor, or an explicit region. Use monitor or region to avoid unnecessarily capturing other windows.',{monitor:z.string().max(100).optional(),region:z.object({x:coordinate,y:coordinate,width:z.number().int().min(1).max(16000),height:z.number().int().min(1).max(16000)}).optional()},true,'screenshot');
register('desktop_move','Move the pointer.',{x:coordinate,y:coordinate},false,'move');
register('desktop_click','Click a mouse button at optional coordinates.',{x:coordinate.optional(),y:coordinate.optional(),button:z.enum(['left','right','middle']).default('left'),count:z.number().int().min(1).max(3).default(1)},false,'click');
register('desktop_type','Type ASCII text into the focused control without using the clipboard. Non-ASCII is rejected because this compositor drops virtual-keyboard Unicode characters.',{text:z.string().min(1).max(1000).regex(/^[\t\n\r\x20-\x7e]+$/, "Only ASCII text is supported by the installed virtual keyboard")},false,'type');
register('desktop_key','Press an XKB key such as Return, Escape, Tab, BackSpace, Left or a, optionally with modifiers.',{key:z.string().regex(/^[A-Za-z0-9_]+$/).max(80),modifiers:z.array(z.enum(['shift','ctrl','alt','logo','altgr'])).max(5).default([])},false,'key');
register('desktop_scroll','Scroll at the current pointer location. Wheel units are relative; positive vertical is up, negative down.',{vertical:z.number().int().min(-100).max(100).default(0),horizontal:z.number().int().min(-100).max(100).default(0)},false,'scroll');
register('desktop_drag','Drag with the left mouse button; releases it even if movement fails.',{fromX:coordinate,fromY:coordinate,toX:coordinate,toY:coordinate},false,'drag');
await server.connect(new StdioServerTransport());
