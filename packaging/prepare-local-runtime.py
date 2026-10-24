"""Assemble a relocatable, offline CPU runtime from SHA-pinned public archives.

Build-time only. Takes a cache containing downloads/, wheels/, runtime/models/
and runtime/licenses/. Does not copy a developer installation or run pip.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import zipfile


def digest(file):
    return hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()


def verified(file, expected):
    if not file.is_file() or digest(file) != expected:
        raise ValueError(f'Pinned archive or model is missing or changed: {file.name}')
    return file


def extract(archive, destination, wheel=False):
    with zipfile.ZipFile(archive) as contents:
        for item in contents.infolist():
            parts = PurePosixPath(item.filename).parts
            if not parts or item.is_dir():
                continue
            if item.filename.startswith('/') or any(p in ('..', '') or ':' in p or '\\' in p for p in parts):
                raise ValueError('Unsafe archive member')
            if any(p == '__pycache__' for p in parts) or parts[-1].endswith(('.pyc', '.pyo')):
                continue
            if wheel and parts[0].endswith('.data'):
                # Console scripts/headers are build conveniences, not worker dependencies.
                if len(parts) < 3 or parts[1] not in ('purelib', 'platlib'):
                    continue
                parts = parts[2:]
            output = destination.joinpath(*parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            data = contents.read(item)
            if output.exists() and output.read_bytes() != data:
                raise ValueError(f'Conflicting runtime archive member: {item.filename}')
            output.write_bytes(data)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    cache, output = args.cache_dir.resolve(), args.output_dir.resolve()
    lock_path = Path(__file__).with_name('local-material-runtime.lock.json')
    lock = json.loads(lock_path.read_text(encoding='utf-8'))
    verified(Path(__file__).with_name('local-material-requirements.txt'), lock['requirementsSHA256'])
    archive = verified(cache / 'downloads' / f"python-{lock['pythonVersion']}-embed-amd64.zip", lock['pythonArchiveSHA256'])
    inputs = [(verified(cache / 'wheels' / w['name'], w['sha256']), w) for w in lock['wheels']]
    model_inputs = [(verified(cache / 'runtime' / m['file'], m['sha256']), m) for m in lock['models'].values()]
    license_file = verified(cache / 'runtime/licenses/MEDIAPIPE_LICENSE.txt', lock['mediapipeLicenseSHA256'])
    # A fresh destination prevents stale dependencies/customer files entering a build.
    if output.exists():
        raise ValueError('Output already exists; choose a fresh runtime directory')
    output.mkdir(parents=True)
    extract(archive, output)
    site = output / 'Lib/site-packages'
    for file, wheel in inputs:
        extract(file, site, wheel=True)
    for file, model in model_inputs:
        target = output / model['file']
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
    (output / 'licenses').mkdir()
    shutil.copyfile(license_file, output / 'licenses/MEDIAPIPE_LICENSE.txt')
    # Never consult PATH, the working directory or a system Python installation.
    (output / 'python313._pth').write_text('python313.zip\n.\nLib/site-packages\nimport site\n', encoding='utf-8')
    verified(output / 'python.exe', lock['pythonExecutableSHA256'])
    files = [{'path': p.relative_to(output).as_posix(), 'bytes': p.stat().st_size, 'sha256': digest(p)}
             for p in sorted(output.rglob('*')) if p.is_file()]
    manifest = dict(lock, lockSHA256=digest(lock_path), files=files)
    (output / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(json.dumps({'runtime': str(output), 'files': len(files), 'bytes': sum(f['bytes'] for f in files),
                      'source': 'pinned-public-archives', 'networkCalls': 0, 'containsCustomerMedia': False}))


if __name__ == '__main__':
    main()
