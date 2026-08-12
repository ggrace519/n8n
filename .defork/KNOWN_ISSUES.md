# Known issues — de-fork loop

**GitHub issues are enabled on this fork — use them, not this file.**
This file is kept only as an index of what the loop has already filed, so a
fresh session doesn't re-discover and re-file the same defects.

Rebuild work itself lives in `feature_list.json`, not here.

| # | Issue | Owner / gate |
|---|---|---|
| [#13](https://github.com/ggrace519/n8n/issues/13) | Orphaned dynamic-credential entry cleanup is a no-op on unshare | Fix in `@n8n/db` + needs its own gate |
| [#18](https://github.com/ggrace519/n8n/issues/18) | Workflow review decisions not bound to the reviewed version (frontend must send `expectedVersionId`) | Frontend follow-up; backend half done |

When one is fixed: reference it from the commit and close it from the PR with
`Closes #N`, then drop its row here.
