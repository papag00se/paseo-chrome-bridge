import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {lines,runPiGateway} from './pi.mjs';

test('LF framing preserves Unicode separators and split UTF-8',()=>{
  const stream=new PassThrough(); const records=[];
  lines(stream,line=>records.push(JSON.parse(line)));
  const value={message:'one\u2028two\u2029threeé'};
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  for(const byte of bytes) stream.write(Buffer.from([byte]));
  assert.deepEqual(records,[value]); stream.end();
});

test('missing guard extension rejects prompt without starting a model',async()=>{
  const input=new PassThrough(),output=new PassThrough(),errors=new PassThrough();
  const records=[];
  const gateway=runPiGateway({command:'/home/jesse/.local/share/mise/installs/pi/latest/pi/pi',args:['--mode','rpc','--no-session','--no-extensions'],input,output,errors});
  try {
    const result=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('test timed out')),10000);
      lines(output,line=>{const data=JSON.parse(line);records.push(data);if(data.id==='probe'){clearTimeout(timer);resolve(data);}});
    });
    input.write(JSON.stringify({id:'probe',type:'prompt',message:'Must never reach a model'})+'\n');
    const response=await result;
    assert.equal(response.success,false);
    assert.match(response.error,/guard extension is not loaded/);
    assert.ok(!records.some(r=>r.type==='agent_start'));
  } finally {input.end();gateway.stop();await gateway.done;}
});
