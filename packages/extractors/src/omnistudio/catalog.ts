/**
 * The OmniStudio element catalog — the single, declarative description of
 * every OmniScript element type and Integration Procedure step type the
 * product knows: how it touches the data JSON, what it does at runtime, which
 * configuration keys carry references, and a one-line explanation.
 *
 * Every OmniStudio analysis reads this catalog (through `taxonomy.ts` and the
 * process parser, which canonicalises each element's type here). Learning a new
 * element type, or a new spelling of one, is ONE entry in this file: every tool
 * — model, save / prefill trace, reference scan, form spec, path simulator,
 * audits — picks it up, and the shipped catalog document is regenerated from it
 * (`scripts/gen-omnistudio-catalog-doc.mjs`, checked in CI).
 *
 * An element type the catalog does not list is handled conservatively: in an
 * OmniScript it is assumed to hold a value under its name (`input`) unless its
 * name ends in "Action"; in an Integration Procedure it is `other` (its output
 * is opaque). It is never assumed to have no effect.
 *
 * Spellings: OmniStudio renamed some designer labels over releases (DataRaptor →
 * Data Mapper, REST → HTTP). `aliases` lists the alternative spellings an org's
 * metadata may carry; the parser maps them to the canonical type the engine
 * reasons about and keeps the spelling it found.
 */

/** Where the element type occurs. */
export type OmniRuntime = 'omniscript' | 'integration-procedure';

/** How an OmniScript element touches the data JSON (see `taxonomy.ts`). */
export type CatalogElementRole =
  | 'container'
  | 'input'
  | 'formula'
  | 'setValues'
  | 'customLwc'
  | 'embedded'
  | 'action'
  | 'display';

/** An Integration Procedure step's role in the IP data flow (see `taxonomy.ts`). */
export type CatalogIpStepRole =
  | 'dataMapper'
  | 'remote'
  | 'rest'
  | 'nestedIp'
  | 'setValues'
  | 'response'
  | 'block'
  | 'loop'
  | 'listMerge'
  | 'delete'
  | 'calculation'
  | 'other';

/** What an element does at runtime, beyond its data-JSON role. */
export type OmniEffect =
  | 'holds-answer'
  | 'computes-value'
  | 'writes-data-json'
  | 'renders'
  | 'groups-children'
  | 'repeats-rows'
  | 'calls-integration-procedure'
  | 'reads-records'
  | 'writes-records'
  | 'deletes-records'
  | 'transforms-json'
  | 'calls-apex'
  | 'calls-http'
  | 'calls-calculation'
  | 'sends-email'
  | 'generates-document'
  | 'navigates'
  | 'embeds-omniscript'
  | 'returns-response'
  | 'controls-flow'
  | 'handles-errors'
  | 'caches'
  | 'runs-custom-lwc'
  | 'validates';

/** One catalog entry. */
export interface OmniElementTypeInfo {
  /** The canonical type name the engine reasons about. */
  readonly type: string;
  /** Other spellings org metadata may carry for the same type. */
  readonly aliases: readonly string[];
  readonly runtimes: readonly OmniRuntime[];
  /** Data-JSON role inside an OmniScript (null when it never occurs there). */
  readonly scriptRole: CatalogElementRole | null;
  /** Data-flow role inside an Integration Procedure (null when it never occurs there). */
  readonly ipRole: CatalogIpStepRole | null;
  readonly effects: readonly OmniEffect[];
  /** `propertySetConfig` keys whose value names another component or a data key. */
  readonly referenceKeys: readonly string[];
  /** One sentence: what the element does. */
  readonly doc: string;
}

const both: readonly OmniRuntime[] = ['omniscript', 'integration-procedure'];
const os: readonly OmniRuntime[] = ['omniscript'];
const ip: readonly OmniRuntime[] = ['integration-procedure'];

const input = (type: string, doc: string, aliases: readonly string[] = []): OmniElementTypeInfo => ({
  type,
  aliases,
  runtimes: os,
  scriptRole: 'input',
  ipRole: null,
  effects: ['holds-answer'],
  referenceKeys: ['show', 'conditionType'],
  doc,
});

const display = (type: string, doc: string, effects: readonly OmniEffect[] = ['renders']): OmniElementTypeInfo => ({
  type,
  aliases: [],
  runtimes: os,
  scriptRole: 'display',
  ipRole: null,
  effects,
  referenceKeys: ['show', 'text', 'label'],
  doc,
});

/** The catalog, in documentation order (containers, inputs, display, logic, actions, IP blocks). */
export const OMNI_ELEMENT_CATALOG: readonly OmniElementTypeInfo[] = [
  // --- OmniScript containers --------------------------------------------------
  {
    type: 'Step',
    aliases: [],
    runtimes: os,
    scriptRole: 'container',
    ipRole: null,
    effects: ['groups-children', 'renders'],
    referenceKeys: ['show', 'remoteClass', 'remoteMethod'],
    doc: 'A screen of the OmniScript; its children\'s answers are stored under the step\'s name.',
  },
  {
    type: 'Block',
    aliases: [],
    runtimes: os,
    scriptRole: 'container',
    ipRole: null,
    effects: ['groups-children', 'renders'],
    referenceKeys: ['show'],
    doc: 'Groups elements on a step; its children\'s answers nest under the block\'s name, one row per entry when `repeat` is true.',
  },
  {
    type: 'Edit Block',
    aliases: ['EditBlock'],
    runtimes: os,
    scriptRole: 'container',
    ipRole: null,
    effects: ['groups-children', 'repeats-rows', 'renders', 'calls-integration-procedure'],
    referenceKeys: ['show', 'deleteIPKey', 'deleteIPExtraPayload', 'saveIPKey', 'saveIPExtraPayload', 'newIPKey'],
    doc: 'A list of saved rows shown as cards with Add / Edit / Delete; the server delete is wired by `deleteIPKey` or a `<name>-Delete` child action — `allowDelete` alone only removes the card.',
  },
  {
    type: 'Type Ahead Block',
    aliases: [],
    runtimes: os,
    scriptRole: 'container',
    ipRole: null,
    effects: ['groups-children', 'holds-answer', 'calls-integration-procedure', 'reads-records'],
    referenceKeys: ['show', 'dataJsonPath', 'integrationProcedureKey', 'bundle'],
    doc: 'A search-as-you-type input whose matching record\'s fields land in the block\'s children.',
  },
  // --- OmniScript inputs ----------------------------------------------------------
  input('Text', 'A single-line text answer; `mask`, `pattern`, `maxLength` and `minLength` constrain it.'),
  input('Text Area', 'A multi-line text answer.'),
  input('Number', 'A numeric answer.'),
  input('Currency', 'A currency answer.'),
  input('Percent', 'A percentage answer.'),
  input('Date', 'A date answer.'),
  input('Date/Time (Local)', 'A date and time answer in the user\'s time zone.', ['Date/Time']),
  input('Time', 'A time-of-day answer.'),
  input('Email', 'An email-address answer.'),
  input('Telephone', 'A telephone-number answer.', ['Phone']),
  input('URL', 'A web-address answer.'),
  input('Password', 'A masked text answer.'),
  input('Checkbox', 'A true / false answer.'),
  input('Disclosure', 'A checkbox the user must tick to accept a disclosure text.'),
  input('Radio', 'One choice among declared options; the STORED value is the option `name`, not its label.'),
  input('Radio Group', 'One choice per row of a grid of declared options.'),
  input('Select', 'One choice from a drop-down of declared (or fetched) options; the stored value is the option `name`.'),
  input('Multi-select', 'Several choices among declared options, stored `;`-separated.'),
  input('Lookup', 'Picks a record through a query; stores the chosen value and can map the record\'s fields to other elements.'),
  input('Range', 'A numeric slider answer.'),
  input('Signature', 'A captured signature image.'),
  input('File', 'Uploads files; may call Apex (`remoteClass`) to process them.'),

  input('Geolocation', 'Captures the device location.'),
  input('Selectable Items', 'Lets the user pick rows from a list supplied by the data JSON.'),
  // --- OmniScript logic ---------------------------------------------------------------
  {
    type: 'Formula',
    aliases: [],
    runtimes: os,
    scriptRole: 'formula',
    ipRole: null,
    effects: ['computes-value'],
    referenceKeys: ['expression', 'show'],
    doc: 'Computes a value from other answers (`expression`) and stores it under its name.',
  },
  {
    type: 'Aggregate',
    aliases: [],
    runtimes: os,
    scriptRole: 'formula',
    ipRole: null,
    effects: ['computes-value'],
    referenceKeys: ['expression', 'show'],
    doc: 'Sums / averages / counts a repeating answer and stores the result under its name.',
  },
  {
    type: 'Set Values',
    aliases: ['Set Values Action'],
    runtimes: both,
    scriptRole: 'setValues',
    ipRole: 'setValues',
    effects: ['writes-data-json'],
    referenceKeys: ['elementValueMap', 'show', 'executionConditionalFormula'],
    doc: 'Writes each key of `elementValueMap` into the data JSON (literals, merge fields or formulas).',
  },
  {
    type: 'Custom Lightning Web Component',
    aliases: ['Custom LWC'],
    runtimes: os,
    scriptRole: 'customLwc',
    ipRole: null,
    effects: ['runs-custom-lwc', 'renders'],
    referenceKeys: ['lwcName', 'customAttributes', 'show'],
    doc: 'Runs a custom Lightning Web Component, which may read or write ANY data key — its effect is not declared in metadata.',
  },
  {
    type: 'OmniScript',
    aliases: ['Embedded OmniScript'],
    runtimes: os,
    scriptRole: 'embedded',
    ipRole: null,
    effects: ['embeds-omniscript'],
    referenceKeys: ['Type', 'Sub Type', 'Language', 'show'],
    doc: 'Embeds another OmniScript (named by Type / Sub Type / Language), whose keys merge into this one.',
  },
  // --- OmniScript display ---------------------------------------------------------------
  display('Text Block', 'Shows formatted text; merge fields in its text read answers.'),
  display('Headline', 'Shows a heading.'),
  display('Line Break', 'Adds vertical space.'),
  display('Messaging', 'Shows an informational / warning / error message when its condition holds.'),
  display('Validation', 'Shows a message and blocks Next when its condition holds.', ['validates', 'renders']),
  display('Set Errors', 'Marks elements as in error (from a server response or a condition).', ['validates']),
  display('Chart', 'Shows a chart of data-JSON values.'),
  display('Image', 'Shows an image.'),
  display('Submit', 'Legacy submit button.'),
  // --- Actions (OmniScript and Integration Procedure) -----------------------------------
  {
    type: 'Integration Procedure Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'nestedIp',
    effects: ['calls-integration-procedure'],
    referenceKeys: ['integrationProcedureKey', 'extraPayload', 'sendJSONPath', 'sendJSONNode', 'responseJSONNode', 'responseJSONPath', 'additionalInput', 'executionConditionalFormula', 'invokeMode'],
    doc: 'Calls an Integration Procedure by key; `invokeMode` fire-and-forget / non-blocking means the response is not awaited.',
  },
  {
    type: 'DataRaptor Extract Action',
    aliases: ['Data Mapper Extract Action', 'DataMapper Extract Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'dataMapper',
    effects: ['reads-records'],
    referenceKeys: ['bundle', 'dataRaptor Input Parameters', 'additionalInput', 'responseJSONNode', 'responseJSONPath', 'executionConditionalFormula'],
    doc: 'Runs an Extract DataMapper (`bundle`) to read records into the data JSON.',
  },
  {
    type: 'DataRaptor Turbo Action',
    aliases: ['Data Mapper Turbo Action', 'DataRaptor Turbo Extract Action', 'Data Mapper Turbo Extract Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'dataMapper',
    effects: ['reads-records'],
    referenceKeys: ['bundle', 'additionalInput', 'responseJSONNode', 'responseJSONPath', 'executionConditionalFormula'],
    doc: 'Runs a Turbo Extract DataMapper (`bundle`): one object, fast read.',
  },
  {
    type: 'DataRaptor Transform Action',
    aliases: ['Data Mapper Transform Action', 'DataMapper Transform Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'dataMapper',
    effects: ['transforms-json'],
    referenceKeys: ['bundle', 'additionalInput', 'sendJSONPath', 'responseJSONNode', 'responseJSONPath', 'executionConditionalFormula'],
    doc: 'Runs a Transform DataMapper (`bundle`): reshapes JSON; only keys an item maps survive (a whitelist).',
  },
  {
    type: 'DataRaptor Post Action',
    aliases: ['DataRaptor Load Action', 'Data Mapper Load Action', 'Data Mapper Post Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'dataMapper',
    effects: ['writes-records'],
    referenceKeys: ['bundle', 'additionalInput', 'sendJSONPath', 'responseJSONNode', 'executionConditionalFormula'],
    doc: 'Runs a Load DataMapper (`bundle`) to create or update records — from an OmniScript directly, or from an Integration Procedure.',
  },
  {
    type: 'Remote Action',
    aliases: ['Apex Remote Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'remote',
    effects: ['calls-apex'],
    referenceKeys: ['remoteClass', 'remoteMethod', 'remoteOptions', 'additionalInput', 'sendJSONPath', 'responseJSONNode', 'executionConditionalFormula', 'useFuture', 'useQueueableApexRemoting'],
    doc: 'Calls an Apex class (`remoteClass`) through its routing method (`invokeMethod` / `call`), passing `remoteMethod`; `useFuture` / queueable options run it asynchronously.',
  },
  {
    type: 'HTTP Action',
    aliases: ['Rest Action', 'HTTP Request Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'rest',
    effects: ['calls-http'],
    referenceKeys: ['restPath', 'httpUrl', 'restMethod', 'namedCredential', 'restNamedCredential', 'additionalInput', 'sendJSONPath', 'responseJSONNode', 'executionConditionalFormula'],
    doc: 'Calls an HTTP endpoint (`restPath` / named credential); its response shape is not declared in metadata.',
  },
  {
    type: 'Navigate Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['navigates'],
    referenceKeys: ['targetType', 'targetId', 'omniType', 'targetName', 'integrationProcedureKey', 'show'],
    doc: 'Navigates to a page, record, or another OmniScript; may also call an Integration Procedure.',
  },
  {
    type: 'Done Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['navigates'],
    referenceKeys: ['show'],
    doc: 'Finishes the OmniScript.',
  },
  {
    type: 'Email Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'other',
    effects: ['sends-email'],
    referenceKeys: ['emailTemplateName', 'toAddress', 'emailInformation', 'executionConditionalFormula'],
    doc: 'Sends an email (template or composed) to addresses from the data JSON.',
  },
  {
    type: 'PDF Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['generates-document'],
    referenceKeys: ['show'],
    doc: 'Generates a PDF of the OmniScript.',
  },
  {
    type: 'DocuSign Envelope Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'other',
    effects: ['generates-document', 'calls-http'],
    referenceKeys: ['docuSignTemplatesGroup', 'executionConditionalFormula'],
    doc: 'Sends a DocuSign envelope.',
  },
  {
    type: 'DocuSign Signature Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['generates-document', 'calls-http'],
    referenceKeys: ['docuSignTemplatesGroup'],
    doc: 'Collects a DocuSign signature in-line.',
  },
  {
    type: 'Decision Matrix Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'calculation',
    effects: ['calls-calculation'],
    referenceKeys: ['decisionMatrixName', 'matrixName', 'additionalInput', 'executionConditionalFormula'],
    doc: 'Looks up a Decision Matrix and returns its outputs.',
  },
  {
    type: 'Expression Set Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'calculation',
    effects: ['calls-calculation'],
    referenceKeys: ['expressionSetName', 'additionalInput', 'executionConditionalFormula'],
    doc: 'Runs an Expression Set (Business Rules Engine) and returns its outputs.',
  },
  {
    type: 'Matrix Action',
    aliases: ['Calculation Matrix Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'calculation',
    effects: ['calls-calculation'],
    referenceKeys: ['matrixName', 'decisionMatrixName', 'remoteClass', 'remoteMethod', 'additionalInput', 'executionConditionalFormula'],
    doc: 'Looks up a Calculation / Decision Matrix and returns its outputs.',
  },
  {
    type: 'Calculation Action',
    aliases: ['Calculation Procedure Action'],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'calculation',
    effects: ['calls-calculation', 'calls-apex'],
    referenceKeys: ['calculationProcedure', 'expressionSetName', 'remoteClass', 'remoteMethod', 'additionalInput', 'executionConditionalFormula'],
    doc: 'Runs a Calculation Procedure / Expression Set (often through an Apex service named by `remoteClass`).',
  },
  {
    type: 'Delete Action',
    aliases: [],
    runtimes: both,
    scriptRole: 'action',
    ipRole: 'delete',
    effects: ['deletes-records'],
    referenceKeys: ['deleteSObject', 'executionConditionalFormula'],
    doc: 'Deletes records whose SObject type (`deleteSObject[].Type`) and Id it names.',
  },
  {
    type: 'Post to Object Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['writes-records'],
    referenceKeys: ['show'],
    doc: 'Legacy: writes the data JSON to an object.',
  },
  {
    type: 'Context Action',
    aliases: [],
    runtimes: os,
    scriptRole: 'action',
    ipRole: null,
    effects: ['reads-records'],
    referenceKeys: ['show'],
    doc: 'Loads the context record into the data JSON.',
  },
  {
    type: 'Chatter Action',
    aliases: [],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'other',
    effects: ['writes-records'],
    referenceKeys: ['executionConditionalFormula'],
    doc: 'Posts to Chatter.',
  },
  // --- Integration Procedure flow control ----------------------------------------------------------
  {
    type: 'Response Action',
    aliases: [],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'response',
    effects: ['returns-response'],
    referenceKeys: ['sendJSONPath', 'sendJSONNode', 'additionalOutput', 'returnOnlyAdditionalOutput', 'executionConditionalFormula'],
    doc: 'Returns the IP\'s response: the whole data JSON, a sub-path, or only `additionalOutput`.',
  },
  {
    type: 'Conditional Block',
    aliases: [],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'block',
    effects: ['controls-flow'],
    referenceKeys: ['executionConditionalFormula'],
    doc: 'Runs its child steps only when its condition holds.',
  },
  {
    type: 'Loop Block',
    aliases: [],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'loop',
    effects: ['controls-flow'],
    referenceKeys: ['loopList', 'loopOutput', 'executionConditionalFormula'],
    doc: 'Runs its child steps once per entry of `loopList`.',
  },
  {
    type: 'Cache Block',
    aliases: [],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'block',
    effects: ['controls-flow', 'caches'],
    referenceKeys: ['cacheConfig', 'executionConditionalFormula'],
    doc: 'Caches its child steps\' output; a cached run does not re-execute them.',
  },
  {
    type: 'Try Catch Block',
    aliases: ['Try-Catch Block'],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'block',
    effects: ['controls-flow', 'handles-errors', 'calls-apex'],
    referenceKeys: ['remoteClass', 'remoteMethod', 'failureResponse', 'failOnBlockError', 'executionConditionalFormula'],
    doc: 'Runs its child steps and, on failure, returns `failureResponse` and optionally calls a handler class (`remoteClass`).',
  },
  {
    type: 'List Merge Action',
    aliases: ['List Action'],
    runtimes: ip,
    scriptRole: null,
    ipRole: 'listMerge',
    effects: ['transforms-json'],
    referenceKeys: ['mergeListsOrder', 'mergeFields', 'executionConditionalFormula'],
    doc: 'Merges several lists of the data JSON into one, matching rows by key fields.',
  },
];

const byName = new Map<string, OmniElementTypeInfo>();
for (const entry of OMNI_ELEMENT_CATALOG) {
  byName.set(entry.type.toLowerCase(), entry);
  for (const alias of entry.aliases) byName.set(alias.toLowerCase(), entry);
}

/** The catalog entry for a type name or one of its aliases (case-insensitive), or null. */
export const omniElementInfo = (type: string): OmniElementTypeInfo | null => byName.get(type.trim().toLowerCase()) ?? null;

/**
 * The canonical type the engine reasons about. An alias spelling maps to its
 * canonical type; a type the catalog does not list is returned trimmed, as is.
 */
export const canonicalElementType = (type: string): string => omniElementInfo(type)?.type ?? type.trim();
