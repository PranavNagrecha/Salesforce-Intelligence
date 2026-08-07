### Added

- **Untrusted org-metadata branding (AUDIT-F8).** Contracts expose
  `UntrustedOrgText` / `ContentPolicy` / `ORG_METADATA_CONTENT_POLICY`.
  `sfi.get_component` and `sfi.resolve` add additive `labelOrgText` /
  `descriptionOrgText` fields; the MCP dispatcher stamps `contentPolicy` on
  success envelopes so hosts treat org strings as data, never instructions or
  consent. Markdown escaping remains a renderer concern
  (`escapeMarkdownInline` exported from `@sf-intelligence/renderers`).
