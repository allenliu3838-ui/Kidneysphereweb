#!/usr/bin/env python3
"""Read-only deployment inventory; never open .env, credentials or user data."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

PORTAL_SHA = "7a5b5227457125b3410a0865520ab36d55b56699"
DOCTOR_SHA = "e28760e2f0695785822962632844799d8645031d"
PORTAL_FILES = {
    "app.js": (
        "879d1288bdf00264093b75e890f0f38085f36f9049d50394b4625567edcc5ee5",
        "cc177e5988934c2e9b9c763ef8ed1895618ff4d12a713aeaf7d1d6e706cc6334"),
    "index.html": (
        "9686117f60b4cec22f201463781a979f6ed5e8873b2e3ea20fa37defd379727e",
        "092f901f40a8b0ccc78b45305aaa3f589d6ded88e54cb709548d4ce55e9cfb80"),
    "portal-home.css": (
        "1fa89a026d2e71ced059a3c5cdef2343e4c448b65f343147824149806279de12",
        "e865748832e34aafd639cee9e219773a3b804fe63d8b69877e79ae6de4b07729"),
    'qbank-data.js': (None, '966b09a9c7c6b4bee1f7b738d80b38ff226eab0f0559d66137ce45ddbfaa2100'),
    'qbank.js': ('c43a5b2409117f051b7ac670743990780967bddfb75df45b5689f680d8abeb69', '75af3fea2cc36d1bd122b79428566f9241a5694208655d9140de736ee96818bb'),
    'qbank-test.js': ('94634af3cc0e36749da558caad119fffe72f5ddda8702bed77635358a64d0953', 'c00bf146d87e5e6e15d9536b923e2ea52b008c555732cc16fe7b4f908059b22a'),
    'qbank-parser.js': ('8531dc4f066723886cb71708c678c3f4d6658f096a6d7b4b89be6d1ce17ee3ae', 'f85d818ab4b366b0dc06b666c0b07f92f026b6ba991a79534e5b4c9428cd58fc'),
    'qbank-admin.js': ('a86f74cd71033e96e00022df547d741a793669669a587dc0e93522ec8bd9514b', '1c5e08ff433a731f0ba6c1266f24d6d22f83094352030835d40cf86ec7787b8e'),
    'qbank.html': ('bd3ef5b3bff21a65a93c8f8ad54c6ff6d230b6aaebc68766dfb9e65c2edd735f', '939c8680de9221d0ef08e4d709c0394ef2f178284bd7c79846729df869172343'),
    'qbank-test.html': ('2c3d5219dbb9539b0e785ba2197f49386fef138ff7cef84c09db9bc5dac985c4', '6fce0434c26865eb64ee7b2cfbbc52d99b26daecbe52ecc747c561e3ebb9361f'),
    'qbank-admin.html': ('2ab3e16397d7e2cf0dde52cacbc2908ad3111d98ba2956a71444f9e944d30fb6', 'a348c9b804dd991ad19ebfb192ffc457c0a0f09bcfeab7bd68863df29b8590e7'),
}


def run(args, cwd=None):
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=20)
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return -1, ""


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def directory(path):
    return {"path": str(path), "exists": path.is_dir(),
            "resolved": str(path.resolve()), "symlink": path.is_symlink()}


def git_state(path):
    if not path.is_dir():
        return {"is_repository": False}
    code, sha = run(["git", "-C", str(path), "rev-parse", "HEAD"])
    if code or not re.fullmatch(r"[0-9a-f]{40}\s*", sha):
        return {"is_repository": False}
    _, branch = run(["git", "-C", str(path), "branch", "--show-current"])
    status_code, changes = run(["git", "--no-optional-locks", "-C", str(path), "status", "--porcelain", "--untracked-files=no"])
    # Filenames only: do not print diffs, remotes, config or environment values.
    return {"is_repository": True, "head": sha.strip(), "branch": branch.strip(),
            "tracked_status_available": status_code == 0,
            "tracked_changes": changes.splitlines()[:40],
            "untracked_files_not_inspected": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--portal-root", default="/var/www/kidneysphere")
    parser.add_argument("--doctor-root", default="/var/www/kidneysphere-doctor")
    parser.add_argument("--skip-nginx", action="store_true")
    args = parser.parse_args()
    portal = Path(args.portal_root).absolute()
    doctor = Path(args.doctor_root).absolute()
    report = {
        "mode": "READ_ONLY_NO_DEPLOYMENT", "fixed_targets": {
            "portal": PORTAL_SHA, "doctor": DOCTOR_SHA},
        "portal": directory(portal), "doctor_repository": directory(doctor),
        "doctor_dist": directory(doctor / "dist"),
    }
    report["portal"]["git"] = git_state(portal)
    report["doctor_repository"]["git"] = git_state(doctor)
    checked = {}
    for name, (before, after) in PORTAL_FILES.items():
        p = portal / name
        row = {"exists": p.is_file(), "symlink": p.is_symlink()}
        if p.is_file():
            try:
                value = digest(p)
                row.update(sha256=value, bytes=p.stat().st_size,
                    state="target" if value == after else "known_previous" if value == before else "unrecognized_do_not_overwrite")
            except OSError:
                row["state"] = "unreadable_do_not_overwrite"
        checked[name] = row
    report["portal"]["runtime_files"] = checked
    report["portal"]["homepage_dependencies_exist"] = {
        name: (portal / name).is_file() for name in (
            "styles.css", "site-light.css", "site-page-themes.css", "portal-home.js",
            "portal-motion.js", "home.js", "assets/logo.png", "assets/portal/pathology-v1.webp",
            "assets/portal/critical-v1.webp", "assets/portal/transplant-v1.webp")}
    for name in ("node", "npm", "git"):
        code, result = run([name, "--version"])
        report[name] = result.strip() if code == 0 and re.fullmatch(r"[a-zA-Z0-9. +_\-\n]+", result) else "unavailable"
    try:
        raw = json.loads((doctor / "dist/build.json").read_text())
        build_id = raw.get("build_id")
        report["doctor_dist"]["build_id"] = build_id if isinstance(build_id, str) and re.fullmatch(r"(?:[0-9a-f]{8,40}|local_[a-z0-9]+)", build_id) else "unrecognized"
    except (OSError, ValueError, AttributeError):
        report["doctor_dist"]["build_id"] = "unavailable"
    for label, path in (("portal", portal), ("doctor", doctor)):
        try:
            report[label + "_disk_free_bytes"] = shutil.disk_usage(path).free
        except OSError:
            report[label + "_disk_free_bytes"] = None
    if not args.skip_nginx:
        code, config = run(["nginx", "-T"])
        report["nginx_configuration_test_ok"] = code == 0
        # Only routing directives and source filenames are allowed out.
        # No certificate, auth, proxy header, environment or key contents.
        report["nginx_routing_only"] = [line.strip() for line in config.splitlines()
            if re.match(r"^# configuration file |^\s*(?:listen|server_name|root|alias)\s+", line)][:200]
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
