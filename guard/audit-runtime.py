#!/usr/bin/env python3
"""Read-only deployment audit. File changes do not update live Node launchers."""
import json
import pathlib
import sys

WRAPPER = b'/home/jesse/Work/chrome-bridge/guard/codex.mjs'
EXPECTED_HOME = str(pathlib.Path.home() / '.paseo' / 'codex-home')
EXCLUSIONS = {
    'mcp_servers.cua_repl.enabled=false',
    'mcp_servers.node_repl.enabled=false',
    *{f'plugins."{name}@openai-bundled".enabled=false' for name in
      ['unified-computer-use', 'computer-use', 'browser', 'chrome']},
}

def audit(proc=pathlib.Path('/proc'), expected_home=EXPECTED_HOME):
    rows = []
    for p in proc.iterdir():
        if not p.name.isdigit():
            continue
        try:
            if WRAPPER not in (p / 'cmdline').read_bytes().split(b'\0'):
                continue
            for child in (p / 'task' / p.name / 'children').read_text().split():
                c = proc / child
                args = (c / 'cmdline').read_bytes().decode().split('\0')
                if 'app-server' not in args:
                    continue
                env = dict(v.split(b'=', 1) for v in (c / 'environ').read_bytes().split(b'\0') if b'=' in v)
                home = env.get(b'CODEX_HOME', b'').decode()
                missing = sorted(EXCLUSIONS - set(args))
                rows.append({'wrapperPid': int(p.name), 'childPid': int(child),
                             'isolated': home == expected_home,
                             'missingExclusions': missing})
        except (OSError, ValueError):
            # A process may disappear during the read-only snapshot.
            continue
    return rows

if __name__ == '__main__':
    rows = audit()
    bad = [r for r in rows if not r['isolated'] or r['missingExclusions']]
    print(json.dumps({'checked': len(rows), 'legacyOrUnrestricted': len(bad), 'failures': bad}, indent=2))
    sys.exit(1 if bad or not rows else 0)
