---
name: admin-documentation-generators
description: |
  Answers Salesforce admin documentation-generation requests:
  "generate a data dictionary for Account", "create an admin
  handbook for this org", "write an onboarding doc for a new
  developer", "generate an architecture overview", "produce a
  sharing-model summary", "draft a compliance report on PII".
  Drives the v2.5 documentation-generator tier
  (`generate_data_dictionary`, `generate_admin_handbook`,
  `generate_onboarding_doc`, `generate_architecture_overview`,
  `generate_sharing_summary`, `generate_compliance_report`). Every
  generator emits a `GeneratedDocument` with frontmatter
  (`generatedAt`, `sourceTreeHash`, `componentIds`), structured
  markdown body, per-section confidence labels, and verbatim
  `boundaries[]` disclosures. Discloses the v2.5 Q125 freshness
  disclosure on every generated doc, the inherited-confidence
  rule, the heuristic-tagged sections (Domain Clustering, PII
  Inventory, Field Label Glossary), and the v1.7-enrichment-
  missing fallback for Recent Changes / Key Contacts.
---

# Admin documentation generators

## Overview

This skill is the admin persona's companion to v2.5's six
documentation-generator tools. The admin's first-line ask is "draft
me a doc about X" — and the honest answer is a **structured
markdown** document with explicit per-section confidence labels,
verbatim boundary disclosures, and a frontmatter timestamp
naming when the underlying vault was last refreshed.

The six generators share the same output shape:

```typescript
interface GeneratedDocument {
  frontmatter: {
    title: string;
    generatedAt: string;          // ISO-8601, when the document was generated
    sourceTreeHash: string;       // The vault's manifest sourceTreeHash; ties the doc to its source state
    componentIds: ComponentId[];  // Every component the doc named, for cross-reference
  };
  body: string;                                                 // Structured markdown
  sectionConfidence: Record<string, 'declared' | 'parsed' | 'heuristic'>;
  boundaries: string[];                                          // Verbatim disclosures
}
```

The v2.5 constitutional rule is the **Q125 freshness disclosure**.
Every generated doc carries a footer line:

> Generated on `{generatedAt}` from vault at `sourceTreeHash:
> {sourceTreeHash}`. If your org has changed since this hash, the
> document is stale; re-run `/sfi-refresh` and regenerate.

This is verbatim, surfaced on every doc, regardless of which
generator produced it. The admin reading the doc weeks later can
compare the hash against the current vault and know instantly
whether to trust the content.

The boundary that matters for admins: **the document is structure,
not narrative.** v2.5 generators COMPOSE existing graph queries
(`sfi.list_components`, `sfi.org_overview`, `sfi.integration_map`,
`sfi.domain_clusters`, `sfi.pii_inventory`, `sfi.field_access_audit`)
into one markdown document. They do NOT generate prose explanations
beyond the structural scaffolding. A section labeled "Domain
Clustering" with `heuristic` confidence is the v2.0g clustering
algorithm's output; the doc surfaces the cluster labels and
per-cluster member counts, not a "this is what each cluster does"
narrative.

The skill picks the right generator by user intent, sets per-tool
parameters when the question hints at them, and SURFACES the
generated document to the user with the verbatim Q125 disclosure
intact.

## When to fire

Fire this skill on documentation-generation phrasing. Concrete
triggers:

- **"Generate a data dictionary for `Account`."** /
  **"Document the `Account` object."** /
  **"Draft me a schema doc for `Account`."** — Use
  `sfi.generate_data_dictionary` with
  `objectId: 'CustomObject:Account'`.
- **"Create an admin handbook for this org."** /
  **"Write a guide to this org for a new admin."** — Use
  `sfi.generate_admin_handbook` with appropriate `personaFocus`.
- **"Write an onboarding doc for a new developer."** /
  **"Generate an onboarding doc for new admins."** — Use
  `sfi.generate_onboarding_doc` with the matching `personaFocus`.
- **"Generate an architecture overview."** /
  **"Produce a high-level architecture diagram."** — Use
  `sfi.generate_architecture_overview`.
- **"Generate a sharing-model summary."** /
  **"Document our org's sharing model."** /
  **"Produce a security summary for `Account`."** — Use
  `sfi.generate_sharing_summary` (optionally with `objectFilter`).
- **"Draft me a compliance report on PII."** /
  **"Generate a PII inventory document."** /
  **"Produce a compliance audit for this org."** — Use
  `sfi.generate_compliance_report`.

## When NOT to fire

Defer to another skill when:

- **The user asks "what fields does Account have?"** That's
  schema lookup, not document generation. Defer to
  `answering-org-questions` → `sfi.list_components` /
  `sfi.get_component`. The data-dictionary generator is
  appropriate when the user wants a full structured doc; not
  when they want a single answer.
- **The user asks "who can see Account records?"** That's a
  sharing-troubleshooting question. Defer to
  `admin-sharing-troubleshooting` →
  `sfi.why_cant_user_see_record`. The sharing-summary generator
  produces a static report; the troubleshooting skill answers
  per-user cascades.
- **The user asks "what's the org's integration topology?"** That's
  an integration-topology question. Defer to
  `architect-integration-topology` → `sfi.integration_map`. The
  architecture-overview generator INCLUDES integration topology
  as one section; the integration-topology skill is the deep
  drill-in.
- **The user asks for a SINGLE field's documentation.** Defer to
  `developer-field-deep-dive` → `sfi.field_360`. The data
  dictionary documents every field on an OBJECT; field-360
  documents one specific field across every dimension.
- **The user wants to MODIFY metadata** ("update the Account
  description"). v2.5 is read-only. Refuse.
- **The user wants a Word / PDF export.** v2.5 emits markdown.
  Tell the admin to pipe the markdown through their preferred
  converter.

## The cascade

The six generators by user intent. They are NOT redundant — each
covers a distinct admin question shape. Pick the right entry
point.

### 1. `sfi.generate_data_dictionary` — per-object schema doc

The anchor generator. Given a `CustomObject:` id, emits a markdown
document covering:

- **Overview** — object label, plural label, API name, parent
  object (if `Master-Detail` relationship), sharing model.
- **Fields** — table of every CustomField with apiName, label,
  type, required flag, description.
- **Relationships** — outgoing lookups + master-details from this
  object to others; incoming lookups from others to this object.
- **Entity Relationship Diagram** (R6-19) — a `mermaid erDiagram`
  fence covering the SAME two directions (this object's own
  outgoing Lookup/Master-Detail fields, plus every other object's
  inbound `lookupTo` reference to it), rendered visually rather
  than tabulated. Capped at 40 relationships; the cap and the
  `lookupTo`-extraction-time scope are disclosed in `boundaries[]`.
- **Validation Rules** — every ValidationRule whose `parentId`
  matches.
- **Page Layouts** — every Layout whose `parentId` matches.
- **Related Triggers / Flows** — every ApexTrigger / Flow with a
  `triggersOn` edge to this object.
- **Boundaries** — verbatim disclosure.

```json
{ "objectId": "CustomObject:Account" }
```

Fire this when the admin asks for the object-level schema
documentation. The output is a self-contained markdown doc with
every cross-component reference in one place — the admin sends it
to the new joiner, the new joiner has everything they need to
understand this object's surface.

### 2. `sfi.generate_admin_handbook` — org-level admin guide

A wider doc covering the org's purpose, main objects, automation
summary, permission structure, integration topology, and recent
changes. Composed from `sfi.org_overview` + `sfi.integration_map`
+ per-object summaries.

Persona-driven section emphasis:

```json
{ "personaFocus": "admin" }      // default
{ "personaFocus": "architect" }  // leads with Integration Topology
{ "personaFocus": "business-user" }
{ "personaFocus": "developer" }  // adds Codebase Footprint
```

Fire this when the admin asks for an org-level guide. The default
`'admin'` persona emphasizes Permission Structure and Automation
Summary — exactly what a new admin needs to onboard.

### 3. `sfi.generate_onboarding_doc` — new-hire tour

The MOST COMPOSITE generator. Chains:
- `sfi.generate_admin_handbook` (for org context).
- `sfi.generate_architecture_overview` (architecture map).
- `sfi.org_overview` (identifies top 3 objects worth a spotlighted
  data-dictionary entry).
- `sfi.get_naming_convention_report` (conventions section).
- Custom-field-label glossary builder (heuristic on labels
  appearing in fewer than 5 objects).

```json
{ "personaFocus": "admin" }     // default
{ "personaFocus": "developer" } // adds Codebase Footprint subsections
```

Fire this when the admin asks for the new-joiner tour. The doc
covers "What This Org Does", "Main Data Model", "Common
Workflows", "How Security Works", "Naming Conventions",
"Glossary", "Key Contacts" (or v1.7-enrichment-missing
disclosure), and "Where To Go Next" (persona-specific tool
hints).

### 4. `sfi.generate_architecture_overview` — 3-4 page architecture doc

Composes `sfi.org_overview` + `sfi.domain_clusters` +
`sfi.integration_map` into a structured markdown document with
FOUR mermaid diagrams (org structure, an entity-relationship
diagram, domain clustering, integration topology) and supporting
tables.

```json
{}
```

Takes no arguments. Fire this when the admin asks for the
high-level architecture map. The mermaid diagrams render
inline in most markdown viewers; the supporting tables list
the top components per cluster.

Two of the diagrams cap their node count (Org Structure: top
5 CustomObjects by inbound references; Integration Topology:
first 20 integration surfaces — its Type/Count table is never
capped, only the diagram). When an org exceeds either cap, an
inline "showing the top/first N of M" line renders under the
diagram and `document.boundaries` gets a matching entry — a
large org's overview never silently reads as a complete
picture.

The Entity Relationship Diagram (R6-19) is a SEPARATE ranking from
Org Structure: Org Structure ranks by total inbound-reference
count (any edge type); the ERD ranks by Lookup/Master-Detail
relationship DEGREE (in + out `lookupTo` edges only) and shows the
top 12 objects — a relationship line renders ONLY when BOTH its
endpoints made that top-12 cut, so a disconnected or thinly-linked
object can be ranked-in but show no lines. Both the object cap and
the true object count are disclosed. For a complete relationship
picture of ONE object, use `sfi.generate_data_dictionary` instead
— its ERD is not object-count-capped.

### 5. `sfi.generate_sharing_summary` — per-object or org-wide sharing doc

Given an optional `objectFilter`, emits a markdown document
covering every CustomObject's OWD, the SharingRules that apply,
and the Profile / PermissionSet grants that surface as incoming
`grantedBy` edges to the object's children. Role hierarchy as a
mermaid diagram when Role nodes are present.

```json
{}                              // org-wide (capped at 50 objects)
{ "objectFilter": "Account" }   // single-object focus
```

A >50-object org's response carries `scanTruncated: true` +
`totalMatchingObjects` (the TRUE count), disclosed inline in the
document's Overview line and `boundaries` too — never silently
read as complete; narrow with `objectFilter` for full per-object
coverage of the objects the cap dropped.

Fire this when the admin asks for the sharing-model write-up. For
"why can't user X see record Y?" cascades, defer to
`admin-sharing-troubleshooting` — that's the per-user
troubleshooting tool, not the org-wide summary.

### 6. `sfi.generate_compliance_report` — PII + access audit doc

Composes `sfi.pii_inventory` + `sfi.field_access_audit` (per PII
field, capped to keep response bounded) + per-object
`sharingModel` lookup into a structured compliance report.

```json
{}
```

Takes no arguments. Fire this when the admin asks for the
compliance / PII audit document. Every PII classification inherits
the v2.0d recognizer's heuristic confidence — a field flagged as
`pii` may not store PII at runtime, and a field flagged as
`public` may. The Boundaries footer carries the recognizer-
heuristic disclosure verbatim.

## Honesty axes

### Q125 freshness disclosure (verbatim on EVERY generated doc)

> Generated on `{generatedAt}` from vault at `sourceTreeHash:
> {sourceTreeHash}`. If your org has changed since this hash, the
> document is stale; re-run `/sfi-refresh` and regenerate.

This is non-negotiable. The skill ECHOES this footer when
presenting the doc to the user; do NOT strip it during
rendering.

### Inherited-confidence rule (v2.5 constitutional)

The document is structure, not narrative. Section confidence is
inherited from the UPSTREAM edges and recognizers that produced
the section's data:

| Section / Generator | Confidence | Source |
|---|---|---|
| Fields / Validation Rules / Layouts | `declared` | Metadata XML |
| Relationships (lookup / master-detail) | `declared` | Metadata XML |
| Triggers (incoming `triggersOn`) from `ApexTrigger` | `declared` | Apex header |
| Triggers from `Flow` | `parsed` | Flow XML walker |
| Domain Clustering (in architecture / onboarding) | `heuristic` | v2.0g clustering algorithm |
| PII Inventory (in compliance / data-dictionary) | `heuristic` | v2.0d PII recognizer |
| Field Label Glossary (in onboarding / data-dictionary) | `heuristic` | Single-object-label heuristic |
| Recent Changes (in admin handbook / onboarding) | `parsed` | v1.7 enrichment (`lastModifiedDate`) |
| Key Contacts (in onboarding / handbook) | `declared` | v1.7 enrichment (`createdBy` / `lastModifiedBy`) |

When a section's confidence is `heuristic`, the per-section
disclosure is verbatim in the doc body itself (not just the
footer). The admin reading the doc sees "Domain Clustering
(heuristic)" as the section heading.

### Heuristic-tagged sections (verbatim per-section disclosures)

**Domain Clustering disclosure (in architecture-overview /
onboarding-doc / admin-handbook with `architect` persona):**

> Domain clusters are computed by the v2.0g clustering algorithm
> over the org's reference-edge density. A component's cluster
> assignment reflects which other components it interacts with
> most heavily — it does NOT reflect the team that owns the
> component or the business domain the component serves. Treat
> cluster labels as a structural recommendation, not a
> certification.

**PII Inventory disclosure (in compliance-report /
data-dictionary / admin-handbook):**

> PII classifications are emitted by the v2.0d recognizer pattern-
> matching field apiNames and labels against a known-PII keyword
> set (`SSN`, `Date_Of_Birth`, `Tax_ID`, `Drivers_License`, etc.)
> and field type / length heuristics. A field flagged as `pii`
> may not store PII at runtime; a field flagged as `public` may.
> Verify per-field intent before relying on this inventory for
> compliance attestation.

**Field Label Glossary disclosure (in onboarding-doc /
data-dictionary):**

> The glossary surfaces labels appearing on a single CustomObject
> as org-specific terminology candidates. A label appearing on
> one CustomObject MAY be org-specific terminology OR may simply
> be an underused standard label. Verify each entry's intent
> before relying on the glossary as authoritative.

### v1.7-enrichment-missing fallback (Recent Changes / Key Contacts)

The Recent Changes and Key Contacts sections in the admin handbook
and onboarding doc depend on the v1.7 Tooling-API enrichment pass
(`lastModifiedDate`, `lastModifiedBy`, `createdBy`). If the
enrichment hasn't run, BOTH sections surface the v1.7-not-
extracted disclosure rather than fabricating activity:

> The Recent Changes / Key Contacts section requires the v1.7
> Tooling-API enrichment to populate `lastModifiedDate` and
> `lastModifiedBy` on every node. Your vault was last refreshed
> without enrichment; run `/sfi-refresh --tooling-api` to
> enable. Until then, this section is suppressed rather than
> fabricated.

The admin reading the doc sees a placeholder section, not an
invented entry. This is constitutional.

### Composition vs narrative (verbatim)

> v2.5 generators COMPOSE existing graph queries
> (`sfi.org_overview`, `sfi.integration_map`,
> `sfi.domain_clusters`, etc.) into structured markdown. They do
> NOT generate prose explanations of WHY a cluster exists, WHAT
> a Flow does, or WHO the org's stakeholders are. The doc is a
> structural scaffold for an admin / architect / developer to
> READ INTO; it does not replace the admin's own write-up.

## Worked example

User: *"Generate a data dictionary for `Account`."*

Claude's flow:

1. **Classify** → per-object schema doc.
2. **Fire** `sfi.run_analysis` with `{ "name": "sfi.generate_data_dictionary", "args": { … } }` with
   `{ "objectId": "CustomObject:Account" }`.
3. **Receive** (illustrative):

```json
{
  "data": {
    "document": {
      "frontmatter": {
        "title": "Data Dictionary — Account",
        "generatedAt": "2026-05-28T14:23:17.005Z",
        "sourceTreeHash": "a1b2c3d4e5f6g7h8",
        "componentIds": ["CustomObject:Account", "CustomField:Account.Industry__c", "CustomField:Account.Tier__c", "ValidationRule:Account.Require_Industry", "Layout:Account.Standard_Layout", "ApexTrigger:AccountTrigger", "Flow:Set_Account_Region"]
      },
      "body": "# Data Dictionary — Account\n\n## Overview\n\n- **Label:** Account\n- **API Name:** `Account`\n- **Plural Label:** Accounts\n- **Sharing Model:** Private\n\n## Fields\n\n| API Name | Label | Type | Required | Description |\n|---|---|---|---|---|\n| `Industry__c` | Industry | Picklist | Yes | Industry segment for the account. |\n| `Tier__c` | Tier | Number | No | 1-4 tier classification. |\n| ...\n\n## Relationships\n\n- **Outgoing lookups:** None.\n- **Incoming lookups:** `Contact.AccountId`, `Opportunity.AccountId`, `Case.AccountId`.\n\n## Validation Rules\n\n- `ValidationRule:Account.Require_Industry` — Requires `Industry__c` to be set on save.\n\n## Page Layouts\n\n- `Layout:Account.Standard_Layout` (default for `Profile:Standard_User`).\n- `Layout:Account.Sales_Manager_Layout` (assigned to `Profile:Sales_Manager`).\n\n## Related Triggers / Flows\n\n- **Apex triggers:** `ApexTrigger:AccountTrigger` (`triggersOn`, `declared`).\n- **Flows:** `Flow:Set_Account_Region` (`triggersOn`, `parsed`).\n\n## Boundaries\n\n- ...\n- ...\n\n---\n\n_Generated on 2026-05-28T14:23:17.005Z from vault at sourceTreeHash: a1b2c3d4e5f6g7h8. If your org has changed since this hash, the document is stale; re-run `/sfi-refresh` and regenerate._\n",
      "sectionConfidence": {
        "Fields": "declared",
        "Relationships": "declared",
        "Validation Rules": "declared",
        "Page Layouts": "declared",
        "Related Triggers / Flows": "declared",
        "Boundaries": "declared"
      },
      "boundaries": [
        "Generated on 2026-05-28T14:23:17.005Z from vault at sourceTreeHash: a1b2c3d4e5f6g7h8. If your org has changed since this hash, the document is stale; re-run `/sfi-refresh` and regenerate.",
        "Field types and required flags are read from declared metadata. The 'required' flag covers metadata-required only; Apex-enforced required-ness via validation or trigger is not surfaced as required here.",
        "Layout assignments are sourced from incoming usedInLayout edges; if a Profile / Permission Set assigns the layout via runtime context (Record Type-routed), the per-context cascade lives in admin-page-layout-routing."
      ]
    }
  }
}
```

4. **Respond:**

> Generated data dictionary for `CustomObject:Account`:
>
> ```markdown
> # Data Dictionary — Account
>
> ## Overview
> - **Label:** Account
> - **API Name:** `Account`
> - **Plural Label:** Accounts
> - **Sharing Model:** Private
>
> ## Fields
> [table of 47 fields with apiName / label / type / required /
> description]
>
> ## Relationships
> - **Outgoing lookups:** None.
> - **Incoming lookups:** `Contact.AccountId`, `Opportunity.AccountId`,
>   `Case.AccountId`.
>
> ## Validation Rules
> - `ValidationRule:Account.Require_Industry` — Requires `Industry__c`
>   to be set on save.
>
> ## Page Layouts
> - `Layout:Account.Standard_Layout` (default for
>   `Profile:Standard_User`).
> - `Layout:Account.Sales_Manager_Layout` (assigned to
>   `Profile:Sales_Manager`).
>
> ## Related Triggers / Flows
> - **Apex triggers:** `ApexTrigger:AccountTrigger`
>   (`triggersOn`, `declared`).
> - **Flows:** `Flow:Set_Account_Region` (`triggersOn`, `parsed`).
>
> ## Boundaries
> - Field types and required flags are read from declared metadata.
>   The 'required' flag covers metadata-required only; Apex-enforced
>   required-ness via validation or trigger is not surfaced as
>   required here.
> - Layout assignments are sourced from incoming `usedInLayout` edges;
>   if a Profile / Permission Set assigns the layout via runtime
>   context (Record Type-routed), the per-context cascade lives in
>   `admin-page-layout-routing`.
>
> ---
>
> _Generated on 2026-05-28T14:23:17.005Z from vault at
> sourceTreeHash: a1b2c3d4e5f6g7h8. If your org has changed since
> this hash, the document is stale; re-run `/sfi-refresh` and
> regenerate._
> ```
>
> Every section above is sourced from declared metadata (XML); the
> `confidence` per section is uniformly `declared`. The doc names
> 47 fields + 1 validation rule + 2 layouts + 1 ApexTrigger + 1
> Flow (component count: 53), and the frontmatter `componentIds`
> array lists every canonical ID for cross-reference.
>
> If you want narrower or wider versions:
>
> - Just the **field list** without the rest →
>   `sfi.list_components({ type: 'CustomField', parentId:
>   'CustomObject:Account' })`.
> - **Single-field deep dive** on `Industry__c` (writers, readers,
>   v2.9 source-of-truth, similar fields) →
>   `sfi.field_360({ fieldId: 'CustomField:Account.Industry__c' })`
>   via the `developer-field-deep-dive` skill.
> - **Sharing summary** for Account (OWD + SharingRules + role
>   hierarchy) → `sfi.generate_sharing_summary({ objectFilter:
>   'Account' })`.

The response surfaces the doc verbatim with the Q125 freshness
footer intact, names every component with canonical IDs, and
points the admin at narrower / wider drill-ins.

## Anti-patterns

| Mistake | Why it's wrong |
|---|---|
| Stripping the Q125 freshness footer when presenting the doc. | The footer is constitutional. The admin reading the doc next week needs to be able to compare the `sourceTreeHash` against the current vault. Stripping it breaks the trust contract. |
| Inventing a Recent Changes / Key Contacts section when v1.7 enrichment hasn't run. | The constitutional rule is fail-conservative: surface the v1.7-not-extracted disclosure, not a fabricated entry. The admin would treat a fake "Recent Changes" entry as ground truth. |
| Paraphrasing a `heuristic`-tagged section's disclosure ("the clustering algorithm is sometimes a bit off"). | The verbatim disclosure exists for a reason — it states the failure modes precisely. Paraphrasing dilutes the warning. Use the section's verbatim disclosure intact. |
| Treating the generated doc as a narrative. | v2.5 generators emit STRUCTURE. The doc lists components, surfaces edge relationships, and tables out metadata. It does NOT explain WHY each component exists. Don't add interpretive prose to the doc; let the admin read the structure and write their own narrative if needed. |
| Calling `sfi.generate_compliance_report` and presenting PII classifications as authoritative. | The v2.0d PII recognizer is heuristic — keyword + type / length pattern matching. A field flagged `pii` may not store PII; a field flagged `public` may. State the v2.0d boundary verbatim. |
| Skipping per-section confidence labels in the response. | The admin reads the doc and acts on it. Without `(declared)` vs `(heuristic)` labels per section, the admin treats every section as equally trustworthy and misses that Domain Clustering is recognizer output, not metadata. |
| Generating the wrong doc for the user's question (e.g., generating a data dictionary when they asked "who can see Account"). | Pick the right generator. Data dictionary is for OBJECT schema. Sharing summary is for OWD / SharingRules / grants. Compliance is for PII + access. Re-route to the right entry point. |
| Concatenating multiple generated docs into one mega-doc. | v2.5 emits one doc per call. Concatenating loses the per-doc frontmatter, the per-doc sourceTreeHash mapping, and the per-doc component-id cross-reference. Surface each doc separately. |
| Calling `sfi.generate_onboarding_doc` for a quick admin question. | The onboarding doc is the MOST COMPOSITE generator — it chains four sub-generators. For a quick admin question ("how does sharing work in this org"), the sharing-summary or admin-handbook generators are tighter. |

## See also

- `architect-integration-topology` — for live integration-topology
  questions ("what subscribes to this Platform Event"). The
  architecture-overview generator includes a static integration
  map; the architect skill answers per-event cascades.
- `architect-impact-analysis` — for "what breaks if I delete this"
  cross-component analysis. Documentation generators name every
  referrer; impact analysis walks them via `sfi.get_impact`.
- `admin-sharing-troubleshooting` — for per-user sharing cascades
  ("why can't user X see record Y"). The sharing-summary
  generator is the org-wide companion.
- `admin-page-layout-routing` — for per-user layout routing
  cascades ("what layout does this user see"). The data-
  dictionary generator surfaces every layout for the object; this
  skill answers the per-user routing.
- `developer-field-deep-dive` — for per-field synthesis. The
  data-dictionary generator surfaces every field on an object;
  this skill documents ONE field across every dimension.
- `recognizing-naming-conventions` — for the conventions section
  that the admin-handbook and onboarding-doc generators surface.
  Generators show the patterns the recognizer found; this skill
  is the deep recognizer drill-in.
- `refreshing-the-org-vault` — for `/sfi-refresh` to bump the
  `sourceTreeHash`. The Q125 disclosure tells the admin to come
  here when the doc is stale.

## Verification

Before sending a response, confirm:

- [ ] I picked the right generator by user intent (data dictionary
      for per-object schema, admin handbook for org guide,
      onboarding for new-hire tour, architecture for high-level
      map, sharing summary for OWD / rules, compliance for PII).
- [ ] I surfaced the generated doc with the Q125 freshness footer
      INTACT — no stripping, no paraphrasing.
- [ ] I cited the per-section `confidence` label in the response
      so the admin can distinguish `declared` (metadata XML) from
      `parsed` (Flow walker / formula tokenizer) from `heuristic`
      (clustering / PII / glossary).
- [ ] For the `heuristic`-tagged sections (Domain Clustering, PII
      Inventory, Field Label Glossary), I surfaced the per-section
      verbatim disclosure intact rather than paraphrasing.
- [ ] When Recent Changes / Key Contacts would depend on v1.7
      enrichment, I surfaced the v1.7-not-extracted disclosure
      and did NOT fabricate activity.
- [ ] I cited every component named in the doc by canonical ID.
- [ ] I did NOT add interpretive prose to the doc beyond the
      structural scaffold.
- [ ] I did NOT concatenate multiple generated docs into one
      response; each doc surfaced separately with its own
      frontmatter and footer.
- [ ] I offered the admin a concrete next step (narrower drill-in
      via field-360, broader context via a sibling generator, or
      a refresh via /sfi-refresh when the hash is stale).

---

**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). **Default tool profile is `core`:** only the core spine (including `sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis, call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or follow `route_question.invoke`, which already wraps non-core steps). Optional: `sfi.describe_analysis` first when args are unclear. Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.
