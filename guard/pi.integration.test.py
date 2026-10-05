"""Real Pi RPC tests; no models or browser tools are called."""
import json, os, pathlib, selectors, subprocess, tempfile, time, unittest
ROOT = pathlib.Path(__file__).resolve().parent
PI = '/home/jesse/.local/share/mise/installs/pi/latest/pi/pi'

class GuardTests(unittest.TestCase):
    def probe(self, extra=(), env=None):
        p = subprocess.Popen(['node', str(ROOT/'pi.mjs'), '--upstream', PI,
            '--mode', 'rpc', '--no-session', *extra], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, **(env or {})})
        selector = selectors.DefaultSelector()
        selector.register(p.stdout, selectors.EVENT_READ, 'out')
        selector.register(p.stderr, selectors.EVENT_READ, 'err')
        records = []
        p.stdin.write(json.dumps({'id':'test','type':'bash','command':'printf guard-probe'})+'\n')
        p.stdin.flush()
        try:
            deadline = time.monotonic()+35
            while time.monotonic()<deadline:
                for key, _ in selector.select(1):
                    line = key.fileobj.readline()
                    if not line:
                        selector.unregister(key.fileobj)
                        continue
                    if key.data == 'out':
                        record=json.loads(line)
                        records.append(record)
                        if record.get('id') == 'test' and record.get('type') == 'response': return record, records
            self.fail('Pi probe timed out')
        finally:
            selector.close()
            p.terminate()
            try: p.wait(timeout=5)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
            for stream in (p.stdin,p.stdout,p.stderr): stream.close()

    def test_bridge_present(self):
        result, records=self.probe()
        self.assertTrue(result['success'],result)
        self.assertEqual(result['data']['output'],'guard-probe')
        self.assertFalse(any(r.get('type')=='agent_start' for r in records))

    def test_banned_inert_tool(self):
        # This fixture has no browser integration or behavior; it registers a name.
        with tempfile.TemporaryDirectory() as directory:
            extension=pathlib.Path(directory)/'inert.ts'
            extension.write_text('export default function(pi:any){ pi.registerTool({name:"mcp__cua_repl__js",label:"Inert test",description:"Inert test",parameters:{type:"object",properties:{}},execute:async()=>{throw new Error("must never execute")}}); }')
            result,records=self.probe(['--extension',str(extension)])
        self.assertFalse(result['success'],result)
        self.assertIn('Banned integration present',result['error'])
        self.assertFalse(any(r.get('type')=='agent_start' for r in records))

    def test_missing_bridge_tool(self):
        result,_=self.probe(['--exclude-tools','web_click'])
        self.assertFalse(result['success'],result)
        self.assertIn('web_click',result['error'])

    def test_unavailable_bridge_does_not_block_shell_work(self):
        result,records=self.probe(env={'BRIDGE_PORT':'1'})
        self.assertTrue(result['success'],result)
        self.assertEqual(result['data']['output'],'guard-probe')
        self.assertFalse(any(r.get('type')=='agent_start' for r in records))

if __name__ == '__main__': unittest.main()
