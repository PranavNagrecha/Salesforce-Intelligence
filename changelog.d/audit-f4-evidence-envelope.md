### Changed

- **EvidenceEnvelope v2 (AUDIT-F4).** Shared output contract
  (`EvidenceEnvelopeV2` in `@sf-intelligence/contracts`) for claims, evidence,
  coverage, freshness, pagination, and absence verdicts. Opt-in projection
  under `data.evidenceEnvelope` on `sfi.interpret` and `sfi.safe_to_delete_field`
  (legacy keys unchanged). Runtime `assertEvidenceEnvelopeV2` guards those
  handlers; not applied roster-wide.
