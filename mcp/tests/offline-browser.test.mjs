import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('disconnected companion leaves discovery available and returns a browser tool error', async () => {
  const bridge = http.createServer(async (req, res) => {
    for await (const _chunk of req) {} // Consume the request without browser access.
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ok:false, error:'extension_not_connected'}));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const client = new Client({name:'offline-test', version:'1.0.0'});
  const transport = new StdioClientTransport({
    command:process.execPath,
    args:[fileURLToPath(new URL('../server.mjs', import.meta.url))],
    env:{...process.env, BRIDGE_PORT:String(bridge.address().port), BRIDGE_TOKEN:''},
    stderr:'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 8);
    const result = await client.callTool({name:'web_snapshot', arguments:{}});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /extension_not_connected/);
  } finally {
    await client.close();
    await new Promise(resolve => bridge.close(resolve));
  }
});
