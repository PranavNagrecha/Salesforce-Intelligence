### Added
- **Reasoning model — nineteen more offline concepts (123 → 142 concepts, 174 → 193
  rules), completing the concept-model build-out.** A parallel mining pass (one agent per
  extractor family) surfaced these by finding EMITTED node/edge properties that no concept
  bound yet; each grounds on a verified-emitted property, ships a firing `interpret()` seed
  proof, and is NL-reachable via its grow-forever funnel card. By family:
  - **Fields / objects** — `object-deployment-status-in-development` (In Development objects
    hidden without Customize Application), `object-autonumber-name-field` (auto-numbered
    record Name), `global-value-set-has-inactive-value` / `standard-value-set-has-inactive-value`
    (deactivated values retained on records).
  - **Apex** — `apex-test-hardcoded-sandbox-data` (tests bound to sandbox-specific data).
  - **Sharing** — `restriction-rule-inactive` (inactive restriction rule enforces nothing).
  - **Automation** — `approval-process-pending-lock-editability` (who can edit a
    pending-approval record), `approval-process-recall-unlocks-record`.
  - **Integration / async** — `auth-provider-registration-handler-apex-hook` (SSO JIT
    provisioning runs Apex), `platform-event-channel-member-filtered-stream` (channel
    filter narrows the delivered stream), `external-service-registration-incomplete`,
    `named-credential-per-user-principal` (per-user external identity).
  - **OmniStudio** — `omnistudio-test-procedure-scope`, `dataraptor-load-fires-assignment-rules`,
    `omnistudio-metadata-cache-disabled`.
  - **Misc metadata** — `static-resource-public-cache-control-exposure` (public cache =
    session-less readable), `custom-metadata-record-protected-namespace-scoped`,
    `email-template-unavailable-hidden`, `group-role-subordinates-transitive-membership`.
  Grounding for every concept was independently verified against the extractor source; one
  mined candidate (`permission-set-group-recalculation-stale`) was **rejected** because its
  recalculation status is a runtime property no extractor emits offline — not shipped rather
  than phantom-grounded. Deterministic and offline throughout.
