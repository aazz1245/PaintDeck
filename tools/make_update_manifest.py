"""Prepare public updater assets after a signed public build. Never uploads anything."""
import argparse
import base64
import datetime
import json
import pathlib
import shutil


def prepare(root, installer, notes, output):
    root, installer, output = map(pathlib.Path, (root, installer, output))
    config = json.loads((root / 'src-tauri/tauri.conf.json').read_text('utf-8'))
    source = (root / 'src-tauri/src/updater.rs').read_text('utf-8')
    if 'pub const CHANNEL: &str = "public";' not in source or config['bundle'].get('createUpdaterArtifacts') is not True:
        raise ValueError('Only a public export can prepare updater assets; private installers must never be published.')
    version = config['version']
    if version not in installer.name or installer.suffix.lower() != '.exe':
        raise ValueError('Installer filename must contain the configured version and end in .exe')
    signature = installer.with_suffix(installer.suffix + '.sig').read_text('utf-8').strip()
    # CLI signatures bind the version in their authenticated trusted comment.
    decoded = base64.b64decode(signature, validate=True).decode('utf-8')
    trusted = next((s.removeprefix('trusted comment: ') for s in decoded.splitlines() if s.startswith('trusted comment: ')), '')
    if f'version:{version}' not in trusted.split('\t'):
        raise ValueError('Signature is not bound to this app version; re-sign with --app-version')
    name = f'PaintDeck_{version}_x64-setup.exe'
    manifest = {'version': version, 'notes': notes,
        'pub_date': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
        'platforms': {'windows-x86_64': {
            'url': f'https://github.com/sressky12-ux/PaintDeck/releases/download/v{version}/{name}',
            'signature': signature}}}
    output.mkdir(parents=True, exist_ok=True)
    targets = [output / name, output / (name + '.sig'), output / 'latest.json']
    if any(p.exists() for p in targets):
        raise ValueError('Output assets already exist; use a fresh directory or increment the version.')
    shutil.copy2(installer, targets[0])
    targets[1].write_text(signature + '\n', encoding='utf-8')
    targets[2].write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return targets


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--installer', required=True, type=pathlib.Path)
    p.add_argument('--notes-file', required=True, type=pathlib.Path)
    p.add_argument('--output', required=True, type=pathlib.Path)
    args = p.parse_args()
    for result in prepare(pathlib.Path(__file__).resolve().parent.parent, args.installer,
                          args.notes_file.read_text('utf-8'), args.output):
        print(result)
