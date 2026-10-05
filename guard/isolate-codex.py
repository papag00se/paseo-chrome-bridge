#!/usr/bin/env python3
"""One-time Paseo home initialization; never modifies Codex Desktop's config.
History payloads and credentials remain shared. Configuration and database
indexes are private. Existing thread ids are preserved through SQLite backups.
"""
import pathlib, shutil, sqlite3, tomllib
source = pathlib.Path.home() / '.codex'
target = pathlib.Path.home() / '.paseo' / 'codex-home'
target.mkdir(mode=0o700, parents=True, exist_ok=True)
config = target / 'config.toml'
if config.exists():
    raise SystemExit('Private config already exists; refusing to overwrite it')
text = (source / 'config.toml').read_text()
# Remove Desktop-provisioned legacy MCP sections, including nested env.
lines, section = [], ''
for line in text.splitlines(keepends=True):
    if line.lstrip().startswith('['):
        section = line.strip()
    if section.startswith(('[mcp_servers.node_repl', '[mcp_servers.cua_repl')):
        continue
    lines.append(line)
text = ''.join(lines)
text += '\n[mcp_servers.node_repl]\nenabled = false\ncommand = "/usr/bin/false"\n'
text += '\n[mcp_servers.cua_repl]\nenabled = false\ncommand = "/usr/bin/false"\n'
tomllib.loads(text)
for db in source.glob('*.sqlite'):
    dest = target / db.name
    if dest.exists():
        continue
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as src, sqlite3.connect(dest) as dst:
        src.backup(dst)
    dest.chmod(0o600)
# No link to config.toml, plugins, runtime, browser, or desktop IPC.
for name in ['auth.json','sessions','archived_sessions','attachments',
             'thread-writer-locks','shell_snapshots','AGENTS.md','skills','memories']:
    src, dest = source / name, target / name
    if src.exists() and not dest.exists():
        dest.symlink_to(src, target_is_directory=src.is_dir())
config.write_text('# Paseo-owned configuration. Codex Desktop must not manage this file.\n' + text)
config.chmod(0o600)
print(f'Initialized {target}; config is private, existing thread history preserved')
