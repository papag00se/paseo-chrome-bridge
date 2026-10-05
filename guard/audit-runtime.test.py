import importlib.util
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit_runtime', pathlib.Path(__file__).with_name('audit-runtime.py'))
audit_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_runtime)

class RuntimeAuditTests(unittest.TestCase):
    def fixture(self, root, wrapper, child, home, exclusions):
        p = root / str(wrapper)
        (p / 'task' / str(wrapper)).mkdir(parents=True)
        (p / 'cmdline').write_bytes(b'node\0' + audit_runtime.WRAPPER + b'\0')
        (p / 'task' / str(wrapper) / 'children').write_text(str(child))
        c = root / str(child)
        c.mkdir()
        args = ['codex', 'app-server']
        for value in exclusions:
            args += ['-c', value]
        (c / 'cmdline').write_bytes('\0'.join(args).encode())
        (c / 'environ').write_bytes(f'CODEX_HOME={home}\0SECRET=not-for-output\0'.encode())

    def test_old_live_launchers_remain_detectable_after_source_file_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.fixture(root, 1, 2, '/shared/.codex', [])
            self.fixture(root, 3, 4, '/private', audit_runtime.EXCLUSIONS)
            rows = audit_runtime.audit(root, '/private')
            by_pid = {r['wrapperPid']: r for r in rows}
            self.assertFalse(by_pid[1]['isolated'])
            self.assertEqual(set(by_pid[1]['missingExclusions']), audit_runtime.EXCLUSIONS)
            self.assertTrue(by_pid[3]['isolated'])
            self.assertEqual(by_pid[3]['missingExclusions'], [])
            self.assertNotIn('not-for-output', repr(rows))

    def test_private_home_alone_is_not_sufficient(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            self.fixture(root, 1, 2, '/private', [])
            row = audit_runtime.audit(root, '/private')[0]
            self.assertTrue(row['isolated'])
            self.assertTrue(row['missingExclusions'])

if __name__ == '__main__':
    unittest.main()
