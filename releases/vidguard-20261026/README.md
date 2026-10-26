# vidguard-20261026 — upload form media-id guard

Released 2026-10-26 14:34 UTC to /var/www/kidneysphere on the Aliyun server.

| | |
|---|---|
| Package | `kidneysphere-vidguard-20261026.pyz`, SHA-256 `595c538b92b8795930ce6179afe8d51a7a45015b3881d2c2bd2cd2509aa0b617` |
| Source | commit `1ab81432` on `fix/upload-media-id-guard`, based on `live-snapshot-20261026` (`04c5d20`) |
| Files | `learning-center.js` b6773d92… → ff85073e…, `learning.html` 5d7f177e… → bca8d082… |
| Result | `APPLIED: 2 files; backup=/root/kidneysphere-vidguard-backups/20261026T143400Z-b92ch6pr` |
| Verified | https://kidneysphere.com/learning.html references `learning-center.js?v=20261026_vidguard1`, served bytes match the payload |

The package is `deploy.py` (as `__main__.py`) + `manifest.json` + `payload/`, built with
`python3 -m zipapp`. The runner is releases/daily-specialties-20260919/deploy.py with two
changes: its own backup directory, and every `.html` written last on apply and restored
first on rollback (scripts are served `max-age=604800, immutable`).

Rehearsed on a copy of the live tree before release: check READY, apply APPLIED, re-check
and re-apply NO_CHANGE, rollback ROLLED_BACK with both original hashes restored, and a
deliberately edited target refused with STOP on both check and apply.

Rollback (on the server, as root):

    python3 /root/kidneysphere-vidguard-20261026.pyz rollback /root/kidneysphere-vidguard-backups/20261026T143400Z-b92ch6pr
