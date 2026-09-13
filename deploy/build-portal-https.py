#!/usr/bin/env python3
"""Build the reviewed, self-contained HTTPS configuration helper deterministically."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import zipfile


def build(output):
    source = Path(__file__).with_name('portal-https.py').read_bytes()
    ast.parse(source, filename='portal-https.py')
    metadata = {
        'schema': 1,
        'purpose': 'KidneySphere scoped HTTPS configuration; DNS and renewal unchanged',
        'domains': ['kidneysphere.com', 'www.kidneysphere.com'],
        'expected_private_ip': '172.24.33.51',
        'candidate_public_ip': '101.132.173.150',
        'runner_sha256': hashlib.sha256(source).hexdigest(),
    }
    entries = {'__main__.py': source, 'release.json':
               (json.dumps(metadata, indent=2, sort_keys=True) + '\n').encode()}
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in entries.items():
            item = zipfile.ZipInfo(name, date_time=(2026, 9, 13, 0, 0, 0))
            item.compress_type = zipfile.ZIP_DEFLATED
            item.create_system = 3
            item.external_attr = 0o100644 << 16
            archive.writestr(item, data)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == list(entries)
        assert all(archive.read(name) == data for name, data in entries.items())
    blob = output.read_bytes()
    print(json.dumps({'path': str(output.resolve()), 'size': len(blob),
                      'sha256': hashlib.sha256(blob).hexdigest(),
                      'runner_sha256': metadata['runner_sha256']}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True)
    build(parser.parse_args().output)
