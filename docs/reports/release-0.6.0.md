# Release report: 0.6.0 (2026-10-16)

Anonymized. No customer org, class, field or vault name appears here. Counts come from re-extracting a copy of a real sandbox org with the release build and comparing it with the previous release.

## What shipped

No new tools. Every change makes an existing answer more correct or smaller.

- **Four kinds of metadata now count as a reference.** Fields and components on Flow screens; non-Apex Flow actions (email alerts, quick actions, external services, subflows); field bindings in LWC and Aura markup; and the column fields of Classic page-layout related lists. Each used to be invisible to where-used, dead-code and impact answers.
- **Two pairs of tools that disagreed now agree.** The save-order pair shares one disclosure and one trigger-bypass warning. The test-selection pair shares one selection walk.
- **One "not modeled" list.** The coverage report and the health check derive it from the same source.
- **Smaller envelopes.** The org-metadata disclosure moved from every response into the server instructions; each success envelope now carries a one-word marker.
- **Docs for admins.** New upgrading guide, troubleshooting guide and CLI reference; a decision record for the 16-tool default; a shorter README that opens with what the tool answers.
- **Plain MIT everywhere.** The last Commons Clause wording was removed from the README summary, the website FAQ and the consultants page. `CITATION.cff` is pinned to the shipped version.

## Measured on a real sandbox org

| Answer | Before | After |
|---|---|---|
| Fields with a page-layout referrer (of 206 custom fields on the sampled objects) | 115 | 184 |
| Layout usage edges | 151 | 762 |
| Custom fields reported `definitely_dead` | 403 | 392 |
| Flow screen-field references on one dynamic-forms flow | 0 | 16 |
| Fields referenced only from a Flow screen that now show one usage | 0 | 1 |

Eleven fields that were "definitely dead" in 0.5.0 are in use on a related list or a flow screen. The verdict was wrong before, not now.

## Upgrade note

Refresh the vault once after upgrading. The new references are read at refresh time; until then where-used and dead-code answers are the 0.5.0 ones.
