#!/usr/bin/env python3
"""Build a pinned unified homepage/deep-blue theme release with guarded scope."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

REPOSITORY = Path(__file__).resolve().parent.parent
BASELINES = (
    'a0b8bba3b71784533c5696f55569fe5ee073e2aa',
    'e8702f8a3ad1799a9b2e592e114e8ac348496aaf',
    '7ede1d73629da4aceebe8e75bb9fa5c3a3d0a858',
    '71d064b10d59624dde7950bb6efe2eadce55a6e2',
)
BASELINE = BASELINES[-1]
VERSION = '20260914_depth1'
HTML_FILES = (
    '404.html', 'about.html', 'academy.html', 'admin-atlas.html', 'admin-commerce.html',
    'admin.html', 'article-editor.html', 'article.html', 'articles.html',
    'atlas-category.html', 'atlas-series.html', 'atlas-topic.html', 'atlas.html',
    'auth-callback.html', 'board.html', 'case.html', 'checkout.html', 'community.html',
    'core-team.html', 'disclaimer.html', 'events.html', 'expert-ppt.html',
    'experts-cn.html', 'experts-intl.html', 'experts.html', 'favorites.html',
    'flagship.html', 'forgot.html', 'frontier.html', 'glomcon-guangzhou.html',
    'health.html', 'learning.html', 'login.html', 'membership.html', 'moment.html',
    'moments.html', 'my-learning.html', 'nephro-pro-module.html', 'nephro-pro.html',
    'notes.html', 'notifications.html', 'partners.html', 'post-case.html',
    'ppt-viewer.html', 'privacy.html', 'profile.html', 'qbank-admin.html',
    'qbank-test.html', 'qbank.html', 'register.html', 'research-pilot.html',
    'research.html', 'reset.html', 'search.html', 'sponsor.html', 'sponsors.html',
    'terms.html', 'training-da.html', 'training-glom.html', 'training-icu.html',
    'training-patho.html', 'training-tx.html', 'verify-doctor.html', 'videos.html',
    'watch.html',
)
FILES = (
    'assets/portal/critical-v1.webp', 'assets/portal/pathology-v1.webp',
    'assets/portal/transplant-v1.webp', 'site-light.css', 'site-page-themes.css',
    'portal-home.css', 'portal-home.js', 'home.js', 'app.js', 'portal-motion.js',
    'styles.css',
) + HTML_FILES + ('index.html',)
OPTIONAL_BEFORE = frozenset(('site-light.css', 'site-page-themes.css', 'portal-motion.js'))
UNCHANGED_FILES = FILES[:3] + ('portal-home.js', 'home.js', 'app.js')
REQUIRED_FILES = ('supabaseClient.js', 'assets/config.js', 'assets/videos.js',
                  'assets/lib/supabase.min.js', 'assets/logo.png')
STYLESHEET_LINK = re.compile(
    rb'(<link\b[^>]*\bhref\s*=\s*)(["\'])((?:\./|/)?styles\.css)'
    rb'(?:\?[^"\']*)?\2', re.IGNORECASE,
)
SCRIPTS = re.compile(rb'<script\b[^>]*>.*?</script\s*>', re.IGNORECASE | re.DOTALL)
MOTION_SCRIPT = b'<script type="module" src="portal-motion.js?v=20260914_depth1"></script>'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def immutable_commit(value):
    if re.fullmatch(r'[0-9a-f]{40}', value) is None:
        raise ValueError('--commit must be a full, immutable 40-character Git commit SHA')
    result = subprocess.run(['git', 'rev-parse', '--verify', value + '^{commit}'],
        cwd=str(REPOSITORY), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode or result.stdout.strip() != value:
        raise ValueError('Pinned Git commit is unavailable: ' + value)
    return value


def git_bytes(commit, path, optional=False):
    result = subprocess.run(['git', 'show', commit + ':' + path], cwd=str(REPOSITORY),
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        if optional:
            immutable_commit(commit)
            return None
        raise ValueError('Pinned Git resource is unavailable: ' + commit + ':' + path)
    return result.stdout


def updated_html(before):
    def replace(match):
        return match[1] + match[2] + match[3] + b'?v=' + VERSION.encode('ascii') + match[2]
    updated, count = STYLESHEET_LINK.subn(replace, before)
    if count != 1:
        raise ValueError('HTML must contain exactly one local styles.css link')
    return updated


def updated_styles(before):
    current = before
    for name in ('site-light.css', 'site-page-themes.css'):
        pattern = (rb'(@import\s+url\(["\'](?:\./)?' + re.escape(name.encode('ascii')) +
                   rb'\?v=)[^"\']+(["\']\);)')
        current, count = re.subn(pattern, lambda match: match[1] + VERSION.encode('ascii') + match[2], current)
        if count != 1:
            raise ValueError('Expected exactly one existing import for ' + name)
    return current


def validate_depth_payload(payload):
    if tuple(payload) != FILES:
        raise ValueError('Deep-blue payload must match the fixed 77-file allowlist')
    for name in HTML_FILES:
        if payload[name] != updated_html(git_bytes(BASELINE, name)):
            raise ValueError('HTML changes beyond stylesheet link version: ' + name)
    for name in UNCHANGED_FILES:
        if payload[name] != git_bytes(BASELINE, name):
            raise ValueError('Shared business JavaScript or image changed: ' + name)
    if payload['styles.css'] != updated_styles(git_bytes(BASELINE, 'styles.css')):
        raise ValueError('styles.css changes beyond the two import versions')
    if any(not payload[name].strip() for name in (
            'site-light.css', 'site-page-themes.css', 'portal-home.css', 'portal-motion.js')):
        raise ValueError('Theme and motion resources must be nonempty')
    homepage = payload['index.html']
    scripts = SCRIPTS.findall(homepage)
    if scripts.count(MOTION_SCRIPT) != 1 or [s for s in scripts if s != MOTION_SCRIPT] != SCRIPTS.findall(git_bytes(BASELINE, 'index.html')):
        raise ValueError('Homepage scripts must preserve existing business scripts and add only portal-motion.js')
    if updated_html(homepage) != homepage or b'portal-home.css?v=20260914_depth1' not in homepage:
        raise ValueError('Homepage stylesheets must use the depth release version')


def build(commit, output):
    commit = immutable_commit(commit)
    payload = {path: git_bytes(commit, path) for path in FILES}
    validate_depth_payload(payload)
    files = []
    for path in FILES:
        previous = [git_bytes(revision, path, optional=True) for revision in BASELINES]
        files.append({
            'path': path, 'sha256': digest(payload[path]), 'size': len(payload[path]),
            'allowed_before': sorted({digest(data) for data in previous if data is not None}),
            'allow_missing': path in OPTIONAL_BEFORE and any(data is None for data in previous),
        })
    for path in REQUIRED_FILES:
        git_bytes(commit, path)
    runner = git_bytes(commit, 'deploy/portal-release.py')
    compile(runner, 'portal-release.py', 'exec')
    manifest = {
        'schema': 1, 'release_profile': 'blue-depth-v1', 'domain': 'kidneysphere.com',
        'root': '/var/www/kidneysphere', 'commit': commit, 'runner_sha256': digest(runner),
        'files': files, 'required_files': list(REQUIRED_FILES),
    }
    entries = [('__main__.py', runner), ('manifest.json',
        (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))]
    entries.extend(('payload/' + path, payload[path]) for path in FILES)
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(str(output), 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 9, 14, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(str(output)) as archive:
        if archive.testzip() is not None or archive.namelist() != [name for name, _ in entries]:
            raise RuntimeError('Package entries or CRC verification failed')
        for name, data in entries:
            if archive.read(name) != data:
                raise RuntimeError('Package content mismatch: ' + name)
    print(json.dumps({
        'file': str(output), 'sha256': digest(output.read_bytes()), 'bytes': output.stat().st_size,
        'commit': commit, 'baselines': list(BASELINES), 'release_profile': 'blue-depth-v1',
        'files': list(FILES), 'scope': 'Unified homepage and theme; business scripts preserved; homepage entry last.',
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    build(arguments.commit, arguments.output)
