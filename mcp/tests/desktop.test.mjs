import test from 'node:test';
import assert from 'node:assert/strict';
import {perform} from '../desktop-worker.mjs';
test('text is passed on stdin, never as executable code or an option',async()=>{
 let got;
 await perform('type',{text:'--help $(touch /tmp/should-not-exist) `echo bad` é'},{},async(...args)=>{got=args;return '';});
 assert.equal(got[0],'/usr/bin/wtype');assert.deepEqual(got[1],['-d','10','-']);
 assert.equal(got[2].input,'--help $(touch /tmp/should-not-exist) `echo bad` é');
});
test('drag releases its button when movement fails',async()=>{
 const calls=[];
 await assert.rejects(perform('drag',{fromX:0,fromY:0,toX:100,toY:100},{},async(cmd,args)=>{
  calls.push([cmd,args]);if(calls.length===3)throw new Error('move failure');return 'ok';
 }),/move failure/);
 assert.deepEqual(calls.at(-1),['/usr/bin/ydotool',['click','0x80']]);
});
test('click positions first and uses the requested button and count',async()=>{
 const calls=[];
 await perform('click',{x:100,y:200,button:'right',count:2},{},async(cmd,args)=>{calls.push([cmd,args]);return 'ok';});
 assert.deepEqual(calls,[['/usr/bin/hyprctl',['dispatch','hl.dsp.cursor.move({x=100,y=200})']],['/usr/bin/ydotool',['click','--repeat','2','--next-delay','40','0xC1']]]);
});
test('screenshot fixes scale and keeps negative global region coordinates',async()=>{
 let got;
 const result=await perform('screenshot',{region:{x:-100,y:20,width:50,height:60}},{},async(cmd,args)=>{got=args;return Buffer.from('png');});
 assert.deepEqual(got,['-s','1','-g','-100,20 50x60','-']);assert.equal(result.image,Buffer.from('png').toString('base64'));
});
