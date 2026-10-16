# Getting help

- **It will not connect or answers come back empty:** run `sfi doctor` in your Salesforce project; it checks the CLI, the vault, the org login and freshness and names the fix. The per-host setup pages are at [sfi.auditforce.cloud/getting-started](https://sfi.auditforce.cloud/getting-started), and [docs/guides/mcp-hosts.md](../docs/guides/mcp-hosts.md) covers config paths and logs for each host.
- **A wrong or weak answer:** `sfi feedback mark "<the question>" --wrong` records it locally; `sfi feedback export` writes a scrubbed file you can attach to a [bug report](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues/new?template=bug-report.md).
- **A reference the answer missed** (a field used in a flow or layout that the answer does not list): that is usually an extractor gap; use the [Extractor gap](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues/new?template=extractor-gap.md) template.
- **A question it should answer but cannot:** [feature request](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues/new?template=feature-request.md).
- **A security problem:** a [private advisory](https://github.com/PranavNagrecha/Salesforce-Intelligence/security/advisories/new), never a public issue. See [SECURITY.md](../SECURITY.md).

Before posting anything, replace real object, field, class, profile and user names with placeholders. The maintainer cannot accept org data, and the repository's privacy scan rejects it.
