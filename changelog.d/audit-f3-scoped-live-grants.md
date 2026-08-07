### Security

- **Scoped live grants (AUDIT-F3).** Live consent is a v2 grant bound to
  Salesforce OrgId + principal (via read-only `sf org display`), with scopes
  (`aggregate` / `sample` / `users`), expiry (default 7 days), and a grant id
  disclosed on live answers. Per-call `liveEnabled: true` is no longer a
  consent substitute. Sample/user tools require an explicit scope step-up.
  Legacy v1 consent records are ignored (re-grant once).
