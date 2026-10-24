import importlib.util
import json
import pathlib
import tempfile
import unittest

root = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('update_manifest', root / 'tools/make_update_manifest.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateManifestTests(unittest.TestCase):
    def test_public_only_version_binding_and_assets(self):
        with tempfile.TemporaryDirectory(prefix='anima_update_manifest_') as tmp:
            base = pathlib.Path(tmp)
            (base / 'src-tauri/src').mkdir(parents=True)
            cfg = base / 'src-tauri/tauri.conf.json'
            src = base / 'src-tauri/src/updater.rs'
            cfg.write_text(json.dumps({'version': '99.1.1', 'bundle': {'createUpdaterArtifacts': True}}))
            src.write_text('pub const CHANNEL: &str = "private";')
            installer = base / 'PaintDeck_99.1.1_x64-setup.exe'
            installer.write_bytes(b'test installer bytes; never executed')
            installer.with_suffix('.exe.sig').write_text((root / 'src-tauri/tests/fixtures/updater/payload.txt.sig').read_text())
            with self.assertRaises(ValueError):
                module.prepare(base, installer, 'notes', base / 'out')
            src.write_text('pub const CHANNEL: &str = "public";')
            files = module.prepare(base, installer, 'notes', base / 'out')
            manifest = json.loads(files[2].read_text('utf-8'))
            self.assertEqual(manifest['version'], '99.1.1')
            self.assertTrue(manifest['platforms']['windows-x86_64']['url'].endswith('/v99.1.1/PaintDeck_99.1.1_x64-setup.exe'))
            with self.assertRaises(ValueError):
                module.prepare(base, installer, 'notes', base / 'out')
            cfg.write_text(json.dumps({'version': '99.1.10', 'bundle': {'createUpdaterArtifacts': True}}))
            renamed = base / 'PaintDeck_99.1.10_x64-setup.exe'
            renamed.write_bytes(installer.read_bytes())
            renamed.with_suffix('.exe.sig').write_text(installer.with_suffix('.exe.sig').read_text())
            with self.assertRaises(ValueError):
                module.prepare(base, renamed, 'notes', base / 'mismatch')


if __name__ == '__main__':
    unittest.main()
