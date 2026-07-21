### Added
- **Reasoning model — fourteen more offline concepts (109 → 123 concepts, 159 → 174
  rules), all NL-reachable via the grow-forever funnel.** A parallel design pass (one
  grounding-verifier agent per candidate) produced these; each grounds on an
  already-extracted property/edge with no new engine primitive, ships a firing
  `interpret()` seed proof, and gets its own funnel card:
  - **`field-restricted-global-value-set`** — a picklist bound to a global value set marked
    `restricted` is a closed vocabulary (out-of-set writes rejected; edits ripple to every
    consumer).
  - **`field-picklist-has-retired-values`** — a picklist retaining deactivated
    (`isActive=false`) values keeps them on existing records though they are no longer
    selectable.
  - **`approval-process-inactive-dead`** — an inactive approval process cannot be submitted to.
  - **`escalation-rule-time-deferred`** — an active escalation rule's actions fire from a
    background time-based process, not synchronously on save.
  - **`auto-response-rule-first-match-starvation`** — a catch-all auto-response entry ordered
    before specific entries starves them (first-match).
  - **`record-type-business-process-binding`** — a record type naming a business process
    constrains the stage/status picklist for its records.
  - **`apex-dynamic-reflective-surface`** — dynamic/reflective Apex (dynamic SOQL, describe
    reflection) is an analysis blind spot and injection surface (heuristic).
  - **`named-credential-merge-fields-injectable`** — a named credential allowing merge fields
    in header/body can interpolate record/user data into outbound requests.
  - **`connected-app-saml-sso-federation`** — a SAML-protocol connected app is an inbound SSO
    federation trust surface.
  - **`apex-fake-assertion-test`** — a test with tautological assertions inflates coverage
    without verifying behavior (heuristic).
  - **`entitlement-process-inactive`** — an inactive entitlement process applies no SLA
    milestones to new entitlements.
  - **`omnistudio-inactive-component-version`** — only the active version of a versioned
    OmniStudio component is invoked at runtime.
  - **`required-field-absent-from-all-layouts`** — a required field on no page layout cannot
    be supplied through the UI, so UI inserts fail (absence-shaped).
  - **`dataraptor-errors-ignored`** — a DataRaptor with Ignore Errors continues past
    row-level failures rather than aborting.
  Grounding for every concept was independently verified against the extractor source before
  integration. Deterministic and offline — cited `groundedIn`, confidence-tiered claims, no
  LLM, no live org read.
