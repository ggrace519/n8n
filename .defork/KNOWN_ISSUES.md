# Known issues — de-fork loop

**GitHub issues are enabled on this fork — use them, not this file.**
This file is kept only as an index of what the loop has already filed, so a
fresh session doesn't re-discover and re-file the same defects.

Rebuild work itself lives in `feature_list.json`, not here.

| # | Issue | Owner / gate |
|---|---|---|
| [#7](https://github.com/ggrace519/n8n/issues/7) | `node-rsa` 2.0.0 override is incompatible with samlify's signing path | Unfixed — crosses a repo-wide dependency override |
| [#8](https://github.com/ggrace519/n8n/issues/8) | Public API allows a non-owner to delete a tag | Triage at **A10-cli-green** |
| [#13](https://github.com/ggrace519/n8n/issues/13) | Orphaned dynamic-credential entry cleanup is a no-op on unshare | Fix in `@n8n/db` + needs its own gate |

When one is fixed: reference it from the commit and close it from the PR with
`Closes #N`, then drop its row here.
