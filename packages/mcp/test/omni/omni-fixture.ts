/// <reference types="vitest/globals" />

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ExtractionResult, VaultManifest } from '@sf-intelligence/contracts';
import {
  extractCustomField,
  extractCustomMetadataRecord,
  extractCustomObject,
  extractOmniDataTransform,
  extractOmniIntegrationProcedure,
  extractOmniScript,
} from '@sf-intelligence/extractors';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';

/**
 * A synthetic OmniStudio app (spec §13) — Acme names only — that reproduces
 * each OmniStudio defect pattern exactly once, with a clean twin beside it:
 *
 *   1. a Transform whose input key differs from the screen element by one
 *      underscore → NEVER_SAVED + near-miss + ORPHAN_WRITE (`AcmeQty__c` vs
 *      `Acme_Qty__c`); `Acme_Note__c` is the saved twin;
 *   2. a show rule on an element renamed between v1 and v2 → DEAD_REFERENCE +
 *      version-diff rename (`OldWrapChoice` → `WrapChoice`);
 *   3. whitespace in a payload key, a custom-metadata JSON key, a show-rule
 *      field and a remoteMethod → WHITESPACE_KEY ×4;
 *   4. Edit Blocks: no delete wiring / deleteIPKey / `-Delete` child only /
 *      deleteIPKey without payload → SCREEN_ONLY_DELETE on the first,
 *      DELETE_KEY_NO_PAYLOAD on the last;
 *   5. a shared mapper mapping `Id` from one card type's Id element only →
 *      EDIT_INSERTS_DUPLICATE on the second card type;
 *   6. a completion step not conditioned on the write's success, writes with
 *      `failOnStepError: false` → COMPLETE_WITHOUT_SUCCESS;
 *   9. inputs with mask / pattern / maxLength, an optional pattern-only field,
 *      a pattern invalid under the `v` flag and `^[0-9]+$` under a 5-digit mask;
 *  10. a Transform with JSON input → no CustomObject from its input prefix;
 *  11. an OmniScript calling an IP by key (two versions, one active) and a
 *      DataMapper by bundle (`_1` suffix) → both edges resolve;
 *  12. a Radio with `{name: Yes, value: Label_Yes}` and two show rules — one
 *      comparing `Yes`, one `Label_Yes` → LABEL_NOT_VALUE on the second only.
 */

const psc = (o: unknown): string =>
  JSON.stringify(o).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface El {
  readonly name: string;
  readonly type: string;
  readonly cfg?: Record<string, unknown>;
  readonly children?: readonly El[];
}

const renderEl = (e: El, seq: number, level: number, tag: string): string => {
  const kids = (e.children ?? []).map((c, i) => renderEl(c, i, level + 1, 'childElements')).join('');
  return `<${tag}>${kids}
<isActive>true</isActive>
<level>${level}.0</level>
<name>${e.name}</name>
<propertySetConfig>${psc(e.cfg ?? {})}</propertySetConfig>
<sequenceNumber>${seq}.0</sequenceNumber>
<type>${e.type}</type>
</${tag}>
`;
};

export const script = (o: {
  type: string;
  subType: string;
  language: string;
  version: number;
  active: boolean;
  elements: readonly El[];
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">
<isActive>${o.active}</isActive>
<isIntegrationProcedure>false</isIntegrationProcedure>
<isWebCompEnabled>true</isWebCompEnabled>
<language>${o.language}</language>
<name>${o.type}_${o.subType}</name>
${o.elements.map((e, i) => renderEl(e, i, 0, 'omniProcessElements')).join('')}<omniProcessType>OmniScript</omniProcessType>
<subType>${o.subType}</subType>
<type>${o.type}</type>
<uniqueName>${o.type}_${o.subType}_${o.language}_${o.version}</uniqueName>
<versionNumber>${o.version}.0</versionNumber>
</OmniScript>
`;

export const ip = (o: { type: string; subType: string; version: number; active: boolean; elements: readonly El[] }): string => `<?xml version="1.0" encoding="UTF-8"?>
<OmniIntegrationProcedure xmlns="http://soap.sforce.com/2006/04/metadata">
<isActive>${o.active}</isActive>
<isIntegrationProcedure>true</isIntegrationProcedure>
<language>English</language>
<name>${o.type}_${o.subType}</name>
${o.elements.map((e, i) => renderEl(e, i, 0, 'omniProcessElements')).join('')}<omniProcessKey>${o.type}_${o.subType}</omniProcessKey>
<omniProcessType>Integration Procedure</omniProcessType>
<subType>${o.subType}</subType>
<type>${o.type}</type>
<uniqueName>${o.type}_${o.subType}_English_${o.version}</uniqueName>
<versionNumber>${o.version}.0</versionNumber>
</OmniIntegrationProcedure>
`;

export const dm = (o: { name: string; type: string; items: readonly Record<string, string>[] }): string => `<?xml version="1.0" encoding="UTF-8"?>
<OmniDataTransform xmlns="http://soap.sforce.com/2006/04/metadata">
<active>false</active>
<inputType>JSON</inputType>
<name>${o.name}</name>
${o.items
  .map(
    (it) =>
      `<omniDataTransformItem>\n${Object.entries(it)
        .map(([k, v]) => `<${k}>${v}</${k}>`)
        .join('\n')}\n<name>${o.name}</name>\n</omniDataTransformItem>\n`,
  )
  .join('')}<outputType>${o.type === 'Load' ? 'SObject' : 'JSON'}</outputType>
<type>${o.type}</type>
<uniqueName>${o.name}_1</uniqueName>
<versionNumber>1.0</versionNumber>
</OmniDataTransform>
`;

const opt = (name: string, value: string): { name: string; value: string } => ({ name, value });

/** The v2 (active) cart script's elements; v1 differs by one renamed Radio. */
const cartElements = (wrapChoiceName: string): El[] => [
  {
    name: 'CartStep',
    type: 'Step',
    cfg: { label: 'Cart' },
    children: [
      // (1) + (4a): the near-miss key, and an Edit Block with no delete wiring.
      {
        name: 'LineEditBlock',
        type: 'Edit Block',
        cfg: { allowNew: true, allowEdit: true, allowDelete: true },
        children: [
          { name: 'AcmeQty__c', type: 'Number', cfg: { label: 'Acme_Label_Qty', required: true } },
          { name: 'Acme_Note__c', type: 'Text', cfg: { label: 'Acme_Label_Note' } },
          { name: 'Acme_Color__c', type: 'Text', cfg: {} },
        ],
      },
      // (4b) deleteIPKey + payload.
      {
        name: 'GiftEditBlock',
        type: 'Edit Block',
        cfg: { allowDelete: true, deleteIPKey: 'Acme_DeleteRow', deleteIPExtraPayload: { sObjectId: '%Id%' } },
        children: [{ name: 'Acme_Gift_Text__c', type: 'Text', cfg: {} }],
      },
      // (4c) only a `-Delete` child.
      {
        name: 'WrapEditBlock',
        type: 'Edit Block',
        cfg: { allowDelete: true },
        children: [
          { name: 'Acme_Wrap_Text__c', type: 'Text', cfg: {} },
          { name: 'WrapEditBlock-Delete', type: 'Integration Procedure Action', cfg: { integrationProcedureKey: 'Acme_DeleteRow', extraPayload: {}, sendOnlyExtraPayload: false } },
        ],
      },
      // (4d) deleteIPKey with no payload.
      {
        name: 'NoteEditBlock',
        type: 'Edit Block',
        cfg: { allowDelete: true, deleteIPKey: 'Acme_DeleteRow' },
        children: [{ name: 'Acme_Note_Text__c', type: 'Text', cfg: {} }],
      },
      // (12) a Radio and two show rules on it; (2) the renamed element.
      {
        name: wrapChoiceName,
        type: 'Radio',
        cfg: { label: 'Acme_Label_Wrap', options: [opt('Yes', 'Label_Yes'), opt('No', 'Label_No')] },
      },
      {
        name: 'WrapNoteBlock',
        type: 'Block',
        cfg: { show: { group: { operator: 'AND', rules: [{ field: 'WrapChoice', condition: '=', data: 'Yes' }] } } },
        children: [{ name: 'Acme_Wrap_Note__c', type: 'Text', cfg: {} }],
      },
      {
        name: 'WrapLabelBlock',
        type: 'Block',
        cfg: { show: { group: { operator: 'AND', rules: [{ field: 'WrapChoice', condition: '=', data: 'Label_Yes' }] } } },
        children: [{ name: 'Acme_Wrap_Label_Note__c', type: 'Text', cfg: {} }],
      },
      {
        name: 'OldChoiceBlock',
        type: 'Block',
        cfg: { show: { group: { operator: 'AND', rules: [{ field: 'CartStep:OldWrapChoice', condition: '=', data: 'Yes' }] } } },
        children: [{ name: 'Acme_Old_Note__c', type: 'Text', cfg: {} }],
      },
      // (9) form-spec inputs.
      { name: 'Acme_Zip__c', type: 'Text', cfg: { mask: '99999', pattern: '^[0-9]+$', maxLength: '5', required: true } },
      { name: 'Acme_Code__c', type: 'Text', cfg: { pattern: "^[a-z/'-]+$" } },
      { name: 'Acme_Ext__c', type: 'Text', cfg: { pattern: '^[0-9]+$', maxLength: '4', required: false } },
    ],
  },
  // (3c) a show rule whose field has a trailing space.
  {
    name: 'ErrorStep',
    type: 'Step',
    cfg: { show: { group: { operator: 'AND', rules: [{ field: 'saveFlag ', condition: '=', data: 'false' }] } } },
  },
  // F2 prefill: brings the saved lines back on load.
  {
    name: 'PrefillCart',
    type: 'Integration Procedure Action',
    cfg: { integrationProcedureKey: 'Acme_CartPrefill', sendOnlyExtraPayload: true, extraPayload: { cartId: '%ContextId%' } },
  },
  // (1)(3a)(11) the save call: by IP key, a payload key with a leading space.
  {
    name: 'SaveCart',
    type: 'Integration Procedure Action',
    cfg: {
      integrationProcedureKey: 'Acme_SaveCart',
      sendOnlyExtraPayload: true,
      extraPayload: { step: '2', Lines: '%CartStep:LineEditBlock%', ' sectionName': 'Cart' },
    },
  },
];

/** The pet script: two card types sharing one mapper (5). */
const petElements: El[] = [
  {
    name: 'PetStep',
    type: 'Step',
    children: [
      // F4 DELETE_WITHOUT_GUARD: the pet card deletes Acme_Pet__c rows, whose
      // Acme_Pet_Toy__c children keep a blank lookup (SetNull) and nothing guards it.
      {
        name: 'PetEditBlock',
        type: 'Edit Block',
        cfg: { allowEdit: true, allowDelete: true, deleteIPKey: 'Acme_DeleteRow', deleteIPExtraPayload: { sObjectId: '%Id%' } },
        children: [
          { name: 'PetEditBlockRecId', type: 'Formula', cfg: { expression: '%PetStep:PetEditBlock|n:Id%', hide: true } },
          { name: 'Acme_Pet_Name__c', type: 'Text', cfg: {} },
          { name: 'PetEditBlock-Edit', type: 'Integration Procedure Action', cfg: { integrationProcedureKey: 'Acme_SavePets', sendJSONNode: 'PetDetails', extraPayload: { step: '1' } } },
        ],
      },
      {
        name: 'ToyEditBlock',
        type: 'Edit Block',
        cfg: { allowEdit: true },
        children: [
          { name: 'ToyEditBlockRecId', type: 'Formula', cfg: { expression: '%PetStep:ToyEditBlock|n:Id%', hide: true } },
          { name: 'Acme_Pet_Name__c', type: 'Text', cfg: {} },
          { name: 'ToyEditBlock-Edit', type: 'Integration Procedure Action', cfg: { integrationProcedureKey: 'Acme_SavePets', sendJSONNode: 'ToyDetails', extraPayload: { step: '2' } } },
        ],
      },
    ],
  },
];

const saveCartSteps = (logMethod: string): El[] => [
  {
    name: 'TryBlock',
    type: 'Try Catch Block',
    cfg: { failOnBlockError: true, remoteClass: 'Acme_Logger', remoteMethod: logMethod },
    children: [
      {
        name: 'LineTransform',
        type: 'DataRaptor Transform Action',
        cfg: {
          bundle: 'AcmeLineTransform',
          sendOnlyAdditionalInput: true,
          additionalInput: { LineEditBlock: '%Lines%' },
          executionConditionalFormula: '%step% == 2 && ISNOTBLANK(%Lines%)',
          failOnStepError: false,
        },
      },
      {
        name: 'UpsertLines',
        type: 'Remote Action',
        cfg: {
          remoteClass: 'Acme_GenericUpsert',
          remoteMethod: 'upsertRecords',
          sendOnlyAdditionalInput: true,
          additionalInput: { records: '%LineTransform:LineEditBlock%', objectApiName: 'Acme_Order__c' },
          executionConditionalFormula: '%step% == 2 && ISNOTBLANK(%Lines%)',
          failOnStepError: false,
        },
      },
      // (6) completion marker, unconditional.
      {
        name: 'MarkComplete',
        type: 'Remote Action',
        cfg: { remoteClass: 'Acme_SectionService', remoteMethod: 'updateStepStatus', sendOnlyAdditionalInput: true, additionalInput: { section: 'Cart' }, failOnStepError: false },
      },
    ],
  },
  {
    name: 'Respond',
    type: 'Response Action',
    cfg: { returnOnlyAdditionalOutput: true, additionalOutput: { saveFlag: '=true' } },
  },
];

const savePetsSteps: El[] = [
  {
    name: 'PetTransform',
    type: 'DataRaptor Transform Action',
    cfg: { bundle: 'AcmeGenericTransform', sendOnlyAdditionalInput: true, additionalInput: { block: '%PetDetails%' }, executionConditionalFormula: '%step% == 1' },
  },
  {
    name: 'ToyTransform',
    type: 'DataRaptor Transform Action',
    cfg: { bundle: 'AcmeGenericTransform', sendOnlyAdditionalInput: true, additionalInput: { block: '%ToyDetails%' }, executionConditionalFormula: '%step% == 2' },
  },
  {
    name: 'UpsertPet',
    type: 'Remote Action',
    cfg: { remoteClass: 'Acme_GenericUpsert', remoteMethod: 'upsertRecords', sendOnlyAdditionalInput: true, additionalInput: { records: '%PetTransform:out%', objectApiName: 'Acme_Pet__c' }, executionConditionalFormula: '%step% == 1' },
  },
  {
    name: 'UpsertToy',
    type: 'Remote Action',
    cfg: { remoteClass: 'Acme_GenericUpsert', remoteMethod: 'upsertRecords', sendOnlyAdditionalInput: true, additionalInput: { records: '%ToyTransform:out%', objectApiName: 'Acme_Pet__c' }, executionConditionalFormula: '%step% == 2' },
  },
];

/** A built fixture vault. */
export interface OmniFixture {
  readonly ctx: Context;
  readonly vaultRoot: string;
  readonly store: GraphStore;
  readonly cleanup: () => Promise<void>;
}

const FIELDS: Record<string, string[]> = {
  Acme_Order__c: ['Acme_Qty__c', 'Acme_Note__c', 'Acme_Color__c'],
  Acme_Pet__c: ['Acme_Pet_Name__c'],
  Acme_Pet_Toy__c: [],
};

/** Write the synthetic source tree, extract it, and import it into a fresh graph. */
export const buildOmniFixture = async (
  options: {
    readonly config?: Record<string, unknown>;
    /** More OmniScripts (`file` under omniScripts/, `body` from {@link script}). */
    readonly extraOmniScripts?: readonly { readonly file: string; readonly body: string }[];
  } = {},
): Promise<OmniFixture> => {
  const tmp = mkdtempSync(join(tmpdir(), 'sfi-omni-fixture-'));
  const vaultRoot = join(tmp, 'org-kb');
  const src = join(vaultRoot, 'source', 'main', 'default');
  const files: { path: string; body: string; extract: (p: string) => Promise<{ ok: boolean; value?: ExtractionResult }> }[] = [];
  const add = (rel: string, body: string, extract: (p: string) => Promise<{ ok: boolean; value?: ExtractionResult }>): void => {
    files.push({ path: join(src, rel), body, extract });
  };
  add('omniScripts/Acme_Cart_English_1.os-meta.xml', script({ type: 'Acme', subType: 'Cart', language: 'English', version: 1, active: false, elements: cartElements('OldWrapChoice') }), extractOmniScript);
  add('omniScripts/Acme_Cart_English_2.os-meta.xml', script({ type: 'Acme', subType: 'Cart', language: 'English', version: 2, active: true, elements: cartElements('WrapChoice') }), extractOmniScript);
  add('omniScripts/Acme_Pets_English_1.os-meta.xml', script({ type: 'Acme', subType: 'Pets', language: 'English', version: 1, active: true, elements: petElements }), extractOmniScript);
  add('omniIntegrationProcedures/Acme_SaveCart_English_1.oip-meta.xml', ip({ type: 'Acme', subType: 'SaveCart', version: 1, active: false, elements: saveCartSteps('LogError') }), extractOmniIntegrationProcedure);
  add('omniIntegrationProcedures/Acme_SaveCart_English_2.oip-meta.xml', ip({ type: 'Acme', subType: 'SaveCart', version: 2, active: true, elements: saveCartSteps(' LogError') }), extractOmniIntegrationProcedure);
  add('omniIntegrationProcedures/Acme_SavePets_English_1.oip-meta.xml', ip({ type: 'Acme', subType: 'SavePets', version: 1, active: true, elements: savePetsSteps }), extractOmniIntegrationProcedure);
  add(
    'omniIntegrationProcedures/Acme_DeleteRow_English_1.oip-meta.xml',
    ip({ type: 'Acme', subType: 'DeleteRow', version: 1, active: true, elements: [{ name: 'DeleteIt', type: 'Remote Action', cfg: { remoteClass: 'Acme_Utility', remoteMethod: 'deleteFromPayload' } }] }),
    extractOmniIntegrationProcedure,
  );
  add(
    'omniDataTransforms/AcmeLineTransform_1.rpt-meta.xml',
    dm({
      name: 'AcmeLineTransform',
      type: 'Transform',
      items: [
        { inputFieldName: 'LineEditBlock:Acme_Qty__c', outputFieldName: 'LineEditBlock:Acme_Qty__c', outputObjectName: 'json' },
        { inputFieldName: 'LineEditBlock:Acme_Note__c', outputFieldName: 'LineEditBlock:Acme_Note__c', outputObjectName: 'json' },
        { inputFieldName: 'LineEditBlock:Id', outputFieldName: 'LineEditBlock:Id', outputObjectName: 'json' },
        { inputFieldName: 'LineEditBlock:Acme_Color__c', outputFieldName: 'LineEditBlock:Acme_Color__c', outputObjectName: 'json' },
      ],
    }),
    extractOmniDataTransform,
  );
  add(
    'omniDataTransforms/AcmeGetLines_1.rpt-meta.xml',
    dm({
      name: 'AcmeGetLines',
      type: 'Extract',
      items: [
        { inputObjectName: 'Acme_Order__c', inputFieldName: 'Id', filterOperator: '=', filterValue: 'cartId', outputFieldName: 'ord', outputObjectName: 'json' },
        { inputFieldName: 'ord:Acme_Note__c', outputFieldName: 'CartStep:LineEditBlock:Acme_Note__c', outputObjectName: 'json' },
        { inputFieldName: 'ord:Acme_Color__c', outputFieldName: 'CartStep:LineEditBlock:Colour', outputObjectName: 'json' },
      ],
    }),
    extractOmniDataTransform,
  );
  add(
    'omniIntegrationProcedures/Acme_CartPrefill_English_1.oip-meta.xml',
    ip({
      type: 'Acme',
      subType: 'CartPrefill',
      version: 1,
      active: true,
      elements: [
        { name: 'GetLines', type: 'DataRaptor Extract Action', cfg: { bundle: 'AcmeGetLines', sendOnlyAdditionalInput: true, additionalInput: { cartId: '%cartId%' } } },
        { name: 'Respond', type: 'Response Action', cfg: { sendJSONPath: 'GetLines' } },
      ],
    }),
    extractOmniIntegrationProcedure,
  );
  add(
    'omniDataTransforms/AcmeGenericTransform_1.rpt-meta.xml',
    dm({
      name: 'AcmeGenericTransform',
      type: 'Transform',
      items: [
        { inputFieldName: 'block:PetEditBlockRecId', outputFieldName: 'out:Id', outputObjectName: 'json' },
        { inputFieldName: 'block:Acme_Pet_Name__c', outputFieldName: 'out:Acme_Pet_Name__c', outputObjectName: 'json' },
      ],
    }),
    extractOmniDataTransform,
  );
  for (const [object, fields] of Object.entries(FIELDS)) {
    add(`objects/${object}/${object}.object-meta.xml`, `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n<deploymentStatus>Deployed</deploymentStatus>\n<label>${object}</label>\n<nameField><label>Name</label><type>Text</type></nameField>\n<pluralLabel>${object}s</pluralLabel>\n<sharingModel>ReadWrite</sharingModel>\n</CustomObject>\n`, extractCustomObject);
    for (const f of fields) {
      add(
        `objects/${object}/fields/${f}.field-meta.xml`,
        `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n<fullName>${f}</fullName>\n<label>${f}</label>\n<type>Text</type>\n<length>80</length>\n</CustomField>\n`,
        extractCustomField,
      );
    }
  }
  // A SetNull lookup from Acme_Pet_Toy__c to Acme_Pet__c (orphaned on delete).
  add(
    'objects/Acme_Pet_Toy__c/fields/Acme_Pet__c.field-meta.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n<fullName>Acme_Pet__c</fullName>\n<deleteConstraint>SetNull</deleteConstraint>\n<label>Pet</label>\n<referenceTo>Acme_Pet__c</referenceTo>\n<relationshipName>Toys</relationshipName>\n<type>Lookup</type>\n</CustomField>\n',
    extractCustomField,
  );
  // (3b) custom metadata whose JSON value has a key with a trailing space.
  add(
    'objects/Acme_Setting__mdt/Acme_Setting__mdt.object-meta.xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n<label>Acme Setting</label>\n<pluralLabel>Acme Settings</pluralLabel>\n<visibility>Public</visibility>\n</CustomObject>\n',
    extractCustomObject,
  );
  add(
    'customMetadata/Acme_Setting.Rec1.md-meta.xml',
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n<label>Rec1</label>\n<protected>false</protected>\n<values>\n<field>Acme_Rules__c</field>\n<value xsi:type="xsd:string">{"isPremium ": "true"}</value>\n</values>\n</CustomMetadata>\n`,
    extractCustomMetadataRecord,
  );

  for (const extra of options.extraOmniScripts ?? []) add(`omniScripts/${extra.file}`, extra.body, extractOmniScript);

  const results: ExtractionResult[] = [];
  for (const f of files) {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, f.body, 'utf-8');
    const r = await f.extract(f.path);
    if (!r.ok || r.value === undefined) throw new Error(`fixture extraction failed for ${f.path}: ${JSON.stringify(r)}`);
    results.push(r.value);
  }
  if (options.config !== undefined) {
    mkdirSync(join(vaultRoot, 'config'), { recursive: true });
    writeFileSync(join(vaultRoot, 'config', 'omnistudio.json'), JSON.stringify(options.config), 'utf-8');
  }
  mkdirSync(join(vaultRoot, 'graph'), { recursive: true });
  const opened = await openGraph(join(vaultRoot, 'graph', 'graph.duckdb'));
  if (!opened.ok) throw new Error(`openGraph failed: ${opened.error.message}`);
  const store = opened.value;
  const imported = await importExtractionResults(store, results);
  if (!imported.ok) throw new Error(`import failed: ${imported.error.message}`);
  const manifest: VaultManifest = {
    version: '0.3.3',
    refreshedAt: '2026-10-02T00:00:00Z',
    sourceOrg: 'fixture@example.com',
    components: {},
    edges: {},
    sourceTreeHash: 'sha256:omni-fixture',
  };
  const ctx = { vaultRoot, manifest, graph: store } as unknown as Context;
  return {
    ctx,
    vaultRoot,
    store,
    cleanup: async () => {
      await closeGraph(store);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
};
