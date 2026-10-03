# OmniStudio in sf-intelligence

How OmniStudio stores its logic, what sf-intelligence models from it, and where the model stops. The element-by-element
reference is the generated [element catalog](element-catalog.md).

## 1. The components

| Component | Metadata | What it is |
|---|---|---|
| OmniScript | `omniScripts/<Type>_<SubType>_<Language>_<N>.os-meta.xml` | A guided, multi-step screen flow. |
| Integration Procedure (IP) | `omniIntegrationProcedures/<Type>_<SubType>_<Language>_<N>.oip-meta.xml` | A server-side chain of steps (DataMappers, Apex, HTTP, other IPs), called by key `Type_SubType`. |
| DataMapper (DataRaptor) | `omniDataTransforms/<Name>_<N>.rpt-meta.xml` | Reads records (Extract, Turbo Extract), reshapes JSON (Transform), or writes records (Load). Called by `bundle` name. |
| FlexCard | `omniUiCard/<Name>_<Author>_<N>.ouc-meta.xml` | A card UI with a data source (DataMapper, IP, Apex, SOQL) and actions. |

Every component is versioned. **Only the ACTIVE version of an OmniScript, IP or FlexCard runs** — the others are saved
drafts. A **DataMapper's `active` flag is not a runtime switch**: the step that names its bundle runs it whatever the
flag says, so an inactive DataMapper is never "dead" on that flag alone.

Each element's real settings live in a JSON blob, `propertySetConfig`. Siblings are stored alphabetically in the XML;
the runtime order is `sequenceNumber`.

The same four components also exist as **records** of the Vlocity managed package — see
[§6](#6-managed-package-vlocity-omnistudio).

## 2. The data JSON (the core semantic)

An OmniScript runs on one JSON document. An answer is stored under its **element name**, nested under the names of the
containers it sits in: a `Text` named `City` in a block `Address` on a step `Contact` is `Contact:Address:City`. Repeating
containers (an Edit Block, a Block with `repeat: true`) hold one row per entry; `|n` addresses row *n*.

- **Merge fields** read the JSON: `%Contact:Address:City%` in OmniScripts and IPs, `{Contact.Address.City}` in some
  properties.
- **Show rules** (conditional view) compare answers: a rule over `Contact:Status` reads that key. A choice element
  (Radio, Select, Multi-select) stores the option **name**, not its label — a rule comparing the label never matches.
- **Set Values** and **Formula** elements write computed keys. A **Custom Lightning Web Component** can read or write ANY
  key; nothing declares which, so everything it touches is unknown to static analysis.
- Keys are compared **raw**: a trailing space or one underscore too many is a different key. sf-intelligence never
  normalises a key to make it match; near-misses are suggested, never auto-matched.

## 3. Calling the server

- An **Integration Procedure Action** sends a payload to an IP: `extraPayload` keys, plus the whole data JSON unless
  `sendOnlyExtraPayload` is set. The response merges at `responseJSONNode` (or the root). `invokeMode` fire-and-forget or
  non-blocking means the response is not awaited — nothing after it can depend on the call's success.
- Inside an IP, each step's output lands **under the step's name** (or `responseJSONNode`); later steps read it by merge
  field. `sendOnlyAdditionalInput` sends only `additionalInput`; `failOnStepError: false` swallows a failure, so a later
  "mark complete" step can run after a failed save. A **Response Action** returns the whole JSON, a sub-path, or only
  `additionalOutput`.
- A **Transform** DataMapper is a **whitelist**: only keys an item maps survive. An **Extract** binds an alias to an object
  in a query row and maps `alias:Field` paths; a **Load** writes `Object.Field` and upserts when it maps `Id`.
- A **Remote Action** (and any element naming a `remoteClass` — a Try Catch Block's failure handler, a Calculation Action,
  a File upload, a FlexCard Apex data source) runs an Apex class through its routing method — `invokeMethod` for
  `VlocityOpenInterface`, `call` for `System.Callable` — passing `remoteMethod` as the routed name. The exception is the
  managed runtime's own service, `<ns>.IntegrationProcedureService` (`ns` one of `vlocity_cmt`, `vlocity_ins`,
  `vlocity_ps`, `omnistudio`, or the export placeholder `%vlocity_namespace%`): it runs the **Integration Procedure** whose
  key is the `remoteMethod`, and every tool follows it as an IP call, not as Apex.
- An **Edit Block** lists saved rows as cards. Its server delete is wired by `deleteIPKey` (+ `deleteIPExtraPayload`) or a
  child action named `<EditBlock>-Delete`; `allowDelete` alone only removes the card, and the record comes back on the
  next prefill. An edited card keeps its record only when a save path carries the row's record `Id` into the write.

## 4. What sf-intelligence models

**In the graph** (every tool sees these — dead code, impact, usage, unused fields, record paths):

| Edge | From | Meaning |
|---|---|---|
| `dispatchesOmniAction` | OmniScript, IP, FlexCard, **Apex** | calls an IP (by key, or through the managed runtime's IntegrationProcedureService — `via: runtime-service`), a DataMapper (by bundle), or another OmniScript; resolved at import onto the **active** version (`targetResolution`). From Apex (`via: apex`): `<ns>.IntegrationProcedureService.runIntegrationService('Type_SubType', …)` / `<ns>.DRGlobal.process(…, 'Bundle')` with a LITERAL key — a key built at runtime is not seen |
| `callsApex` | OmniScript, IP, FlexCard | runs an Apex class named by a `remoteClass`; `methods[]` holds the routed methods, `callSites[]` every site, `entryVia: omnistudio-remote` |
| `readsFrom` | DataMapper (Extract), FlexCard (SOQL) | reads a field (`roles`: `filter` / `mapping`) or an object |
| `writesTo` | DataMapper (Load), IP (Delete Action) | writes a field; creates / upserts an object (`operation: recordCreate` / `recordUpsert`); deletes records (`operation: recordDelete`) |

Relationship paths (`alias:Parent__r.Field__c`, a SOQL `Owner.Name`) are resolved at import against the vault's lookups,
or dropped — never guessed. Active OmniScripts, IPs and FlexCards count as entry points for Apex reachability.

**On demand** (the element-level model, re-parsed from source on each call): `sfi.omni_model`, `sfi.omni_save_trace`,
`sfi.omni_prefill_trace`, `sfi.omni_dead_references`, `sfi.omni_version_diff`, `sfi.omni_edit_block_audit`,
`sfi.omni_completion_audit`, `sfi.omni_form_spec`, `sfi.omni_path_simulator`, `sfi.omni_changed_since`; an IP's
steps (nested ones included), what each calls, and what the chain reads, writes and deletes through
`sfi.integration_procedure_chain`; record-level effects through `sfi.record_delete_impact` and
`sfi.record_creation_paths`.

**Dead-end sections.** An app often adds a section to a person's journey from outside the script (a server formula, a
configuration table read by Apex). If the step that opens the section is hidden by its own show rule for some of the
people it is added for, they cannot start it. `sfi.omni_path_simulator` checks each declared section entry: it expands
the entry step's rule through the Set Values formulas that run before it and searches for answers that add the section
while hiding the step (`DEAD_END_SECTION`, with the witness answers). Declare where sections are added in
`sectionEntries` (below) or pass `sections` on the call.

## 5. Per-vault configuration

`org-kb/config/omnistudio.json` (optional) tells the engine about an org's conventions; without it the same patterns are
recognised heuristically and marked `inferred`.

| Key | Meaning |
|---|---|
| `genericUpsertAdapters` | Apex Remote Actions that write records generically (`records` + object name), so saves through them are traced |
| `genericFetchAdapters` | Apex that reads records generically (`<step>:records:<Object>`), so prefills through it are traced |
| `completionMarkers` | Calls that mark a step / section complete |
| `loggers` | Calls that log (a write that is a real use, not a save) |
| `prefixVariants` | Known key-prefix variants, used only to suggest near-misses |
| `appScope.namePrefixes` | Component name prefixes that are "the app" when auditing a whole vault (also the default app scope for counting tools when `org-kb/config/app-scope.json` is absent) |
| `sectionEntries` | Sections the app adds outside a script: `{ omniscript: "Type/SubType", step, enteredWhen, section }`, `enteredWhen` an OmniStudio formula (`%cartTotal% > 1000`) |
| `customLwcOutputs`, `launchParameters`, `sampleValues` | What custom components write, what the page passes in, sample answers for tests |

## 6. Managed-package (Vlocity) OmniStudio

OmniStudio began as the Vlocity managed package: `vlocity_cmt` (Communications, Media and Energy), `vlocity_ins`
(Insurance and Health) and `vlocity_ps` (Public Sector). There the components are **records** of package objects, not
metadata, so a Metadata API retrieve never contains them:

| Component | Managed-package records | DataPack type (export folder) |
|---|---|---|
| OmniScript | `OmniScript__c` (`IsProcedure__c = false`) + `Element__c` children | `OmniScript` |
| Integration Procedure | `OmniScript__c` (`IsProcedure__c = true`) + `Element__c` children | `IntegrationProcedure` |
| DataRaptor | `DRBundle__c` + `DRMapItem__c` items | `DataRaptor` |
| Card | `VlocityCard__c` (`Definition__c` holds the data source and states) | `VlocityCard` |

They move between orgs as **DataPacks** written by the Vlocity Build Tool: one folder per component,
`<projectPath>/<DataPackType>/<Key>/<Key>_DataPack.json`, with large JSON fields either inline, as JSON strings, or in
sibling files the field names. Field names carry the namespace (`vlocity_cmt__Type__c`) or the export placeholder
(`%vlocity_namespace%__Type__c`). The OmniStudio Migration Tool converts them to the native metadata of §1; a
mid-migration org runs both.

**How sf-intelligence reads them.** Place the export under `org-kb/source/vlocity/` (recipe in
[configuration](../configuration.md#managed-package-omnistudio-org-kbsourcevlocity)) and run `sfi refresh --no-pull`.
Each DataPack is converted to the native component's shape and extracted by **the same code** as native metadata, so
it gets the same node, edges, graph resolution and every OmniStudio tool above:

- the node carries `sourceFormat: vlocity-datapack`, its `dataPackKey`, the `managedPackageNamespace` the export was
  written in (null for the placeholder), and `dataPackWarnings` when a field could not be read; its `sourcePath` is the
  DataPack's main file, so citations point into the export;
- ids follow the native form — `OmniScript:<Type>_<SubType>_<Language>_<Version>`,
  `OmniIntegrationProcedure:<Type>_<SubType>_Procedure_<Version>` (an IP's language is `Procedure`),
  `OmniDataTransform:<Name>` (a managed DataRaptor has no version), `OmniUiCard:<Name>_<Author>_<Version>`;
- element parents are read from any of the shapes exports use (a lookup object, a source key, a parent name); an element
  whose parent is missing or in a cycle is kept at the top level with a warning, never dropped;
- DataPack types other than the four are disclosed as skipped (`skippedDirectories.vlocity`), and the refresh's
  Metadata API reconcile never deletes an export;
- a snapshot fingerprints the whole DataPack folder (main file and siblings), so `sfi.omni_changed_since` reports an
  edit to any of them.

**What the tools say about it.** Every OmniStudio tool's `trust.limitations` names the managed-package position of the
vault: an installed `vlocity_*` package with no export means its components are **missing from the answer** (not absent
from the org); with an export, how many components came from it, and that they are as current as the export. The
concept `concept:omnistudio-managed-package-records` carries the same knowledge to `sfi.interpret` (on the
InstalledPackage and on each DataPack-sourced node).

## 7. Boundaries

- Static analysis of retrieved metadata, not a runtime trace. Conditions are evaluated three-valued: an answer the model
  cannot know makes a result **UNKNOWN with a reason**, never OK and never a defect.
- Apex behind a Remote Action is not executed; what it reads or writes is attributed only where the source shows it
  (`inferred`). HTTP responses, custom Lightning Web Components and components missing from the vault are UNKNOWN.
- Some `remoteClass` values name services the OmniStudio package provides rather than org Apex; they are not in the vault.
  The metadata cannot tell such a service from a custom class the org does not have (every call to which fails at
  runtime); a targeted retrieve can — `sfi refresh --components ApexClass:<name>` returns nothing for a missing class.
- The formula evaluator computes comparisons, `AND` / `OR` / `NOT` / `IF`, `ISBLANK` / `ISNOTBLANK` and `CONTAINS`;
  any other function (date arithmetic such as `AGE`, arithmetic) is UNKNOWN, and the dead-end search treats a value
  computed that way as a free input, named in its `assumptions`.
- **Managed-package (Vlocity) OmniStudio** is modelled only from a DataPack export (§6): the vault cannot tell whether
  the export is current, and record-level runtime data (saved responses, tracking entries) is in neither form. A
  namespaced class in a `remoteClass` (`ns.ClassName`, namespaces with underscores included) is linked to its
  `ns__ClassName` component; a managed-package class other than the IntegrationProcedureService is the package's own
  code and is not in the vault.
