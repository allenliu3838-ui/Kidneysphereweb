# health-20261027 — playback health check + media-id lock

Released 2026-10-26 14:49 UTC to /var/www/kidneysphere; API restarted with `pm2 restart ks-api`.

| | |
|---|---|
| Package | `kidneysphere-health-20261027.pyz`, SHA-256 `6a5609cb1ae0ee5756fbb572721f8df0e5075f2d2c21035e76af8608a91e67eb` |
| Source | `feat/media-health-check` @ 102def6, based on main 94d71e9 |
| Files | `learning-center.js`, `learning.html`, `netlify/functions/video-upload-auth.js`, `server/index.js` |
| Result | `APPLIED: 4 files; backup=/root/kidneysphere-health-backups/20261026T144956Z-5kylui1w` |
| Verified | ks-api online after restart; /api/health ok; new /api/videos/upload-credentials/status answers 401 without a token (directly and through nginx); learning.html references `?v=20261027_health1` and the served script matches the payload |

Runner: the vidguard runner, extended to files in subdirectories of the root (relative
paths only, no `..`, parent must exist; refused traversal rehearsed). It does not restart
anything; the API restart is a separate step.

Server layout found while releasing: the API is PM2 app `ks-api` (id 0) running
`node /var/www/kidneysphere/server/index.js`. PM2 also lists `ks-doctor-api` (online) and
`kidneysphere-functions` (stopped, 75 restarts) — the latter predates this release.

Rollback:

    python3 /root/kidneysphere-health-20261027.pyz rollback /root/kidneysphere-health-backups/20261026T144956Z-5kylui1w && pm2 restart ks-api
