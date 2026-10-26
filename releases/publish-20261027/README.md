# publish-20261027 — draft marker, publish/unpublish buttons

Released 2026-10-26 14:59 UTC to /var/www/kidneysphere. Front end only; no restart.

| | |
|---|---|
| Package | `kidneysphere-publish-20261027.pyz`, SHA-256 `ead2c2c2bb9c3169c517b57092b358d62a215731581cdc12ae19caacac603472` |
| Source | `feat/publish-draft` @ 3194da5, based on main 068f452 |
| Files | `learning-center.js`, `learning.html` |
| Result | `APPLIED: 2 files; backup=/root/kidneysphere-publish-backups/20261026T145956Z-ofxsjwqo` |
| Verified | learning.html references `?v=20261027_publish1`; served script matches the payload |

Rollback:

    python3 /root/kidneysphere-publish-20261027.pyz rollback /root/kidneysphere-publish-backups/20261026T145956Z-ofxsjwqo
