### Fixed

- **PII classifier (`sfi.pii_inventory` and the compliance/AI-exposure surface):** three
  P1 misclassifications.
  - Protected-class attributes (race, ethnicity, disability, citizenship / national
    origin, religion, veteran / military status, sexual orientation, gender identity) no
    longer fall through to `public`. A new highest-sensitivity `protected` classification
    and `protected-class` category are matched from general, org-independent name tokens
    (the short `race` token matches only as a whole word, so `Grace` / `Trace` /
    `Racetrack` do not fire).
  - The health/PHI signal no longer fires on the bare 3-letter substring `phi` — "Phi
    Theta Kappa", "philosophy", and "Philadelphia" are no longer classified health. PHI is
    now recognized only from the standalone uppercase `PHI` acronym, the `protected health`
    phrase, or a specific health token (`PHI__c` / `Protected_Health_Info__c` still
    classify health).
  - A declared field-level `<securityClassification>` is now captured by the CustomField
    extractor and consumed as the highest-precedence signal: `Confidential` → `sensitive`,
    `Restricted` / `MissionCritical` → `protected`, at `declared` confidence. It sets a
    floor (escalates an innocuous-named field) but never downgrades a stronger name
    heuristic. Name/label/type/description matches remain `heuristic` confidence.
