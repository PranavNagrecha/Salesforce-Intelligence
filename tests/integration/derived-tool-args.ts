import type { Node } from '../../packages/contracts/src/index.js';

/**
 * Minimal, VALID arguments for every tool in the roster, derived from the
 * tool's own advertised `inputSchema` plus real ids sampled from the vault
 * under test.
 *
 * ## Why derived and not listed
 *
 * The sweep in `end-to-end.test.ts` carries a hand-written array of 141
 * `[toolName, args]` pairs. A hand-maintained roster is a vacuous gate: it
 * silently stops covering anything added after it was written. It also
 * cannot be right for long — a tool that gains a required argument keeps its
 * stale pair and starts passing on a validation error.
 *
 * Everything here is read from the registry instead:
 *
 *   - WHICH tools — `V01_TOOLS`, the same array `createServer` advertises.
 *   - WHICH arguments — `inputSchema.required`, the tool's own contract.
 *   - WHAT VALUE — `enum[0]` / `default` when the schema pins one, otherwise a
 *     real component id sampled from the graph by argument name, otherwise a
 *     type-shaped placeholder.
 *
 * A new tool therefore cannot be born uncovered, and cannot be covered with
 * arguments its schema rejects.
 *
 * ## What this is NOT
 *
 * Not a semantic fixture. A derived argument is a well-formed one, not
 * necessarily a meaningful one, and a tool that answers `invalid-query`
 * because the placeholder does not resolve has behaved correctly — a
 * structured refusal is an honest answer and the honesty laws treat it as
 * one. The sweep's job is to reach every handler and audit what comes back,
 * not to assert per-tool semantics (that is each tool's own unit suite).
 */

/** The subset of a `ToolDefinition` this module reads. */
export interface RosterEntry {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** A JSON Schema property, as far as this module cares. */
interface SchemaProperty {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly items?: SchemaProperty;
  readonly minimum?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read `inputSchema.properties` as a name -> property map. */
export const schemaProperties = (
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SchemaProperty>> => {
  const properties = schema['properties'];
  return isObject(properties)
    ? (properties as Readonly<Record<string, SchemaProperty>>)
    : {};
};

/** Read `inputSchema.required` as a list of argument names. */
export const schemaRequired = (
  schema: Readonly<Record<string, unknown>>,
): readonly string[] => {
  const required = schema['required'];
  return Array.isArray(required) ? (required.filter((k) => typeof k === 'string') as string[]) : [];
};

/**
 * Argument names that name an OBJECT SCOPE.
 *
 * Read from the schema, not from a list of tools: any tool advertising one of
 * these accepts an object scope and is therefore subject to Law 3. Deriving
 * the set this way is what makes the scope-refusal law reach tools nobody
 * remembered to add — `pii_inventory` and `record_creation_paths` were never
 * in the hand-written sweep at all.
 */
export const OBJECT_SCOPE_KEYS = ['objectApiName', 'objectId', 'object'] as const;

/**
 * An api name that provably resolves to nothing. Deliberately shaped like a
 * legal Salesforce custom-object api name so a tool cannot refuse it on
 * SYNTAX and be credited with checking EXISTENCE.
 */
export const GHOST_OBJECT = 'Zzz_Nonexistent_Object_9x7__c';

/** Real ids sampled from the vault, keyed by the argument names they satisfy. */
export interface VaultSample {
  readonly objectApiName: string;
  readonly objectId: string;
  readonly fieldId: string;
  readonly fieldApiName: string;
  readonly classApiName: string;
  readonly classId: string;
  readonly flowApiName: string;
  readonly triggerId: string;
  readonly profileId: string;
  readonly profileApiName: string;
  readonly secondProfileId: string;
  readonly permissionSetId: string;
  readonly vaultRoot: string;
}

/** Build a {@link VaultSample} from nodes already read out of the graph. */
export const sampleFromNodes = (
  byType: ReadonlyMap<string, readonly Node[]>,
  vaultRoot: string,
): VaultSample => {
  const pick = (type: string, index = 0): Node | undefined => byType.get(type)?.[index];
  const object = pick('CustomObject');
  const field = pick('CustomField');
  const apexClass = pick('ApexClass');
  const flow = pick('Flow');
  const trigger = pick('ApexTrigger');
  const profile = pick('Profile');
  const secondProfile = pick('Profile', 1);
  const permissionSet = pick('PermissionSet');
  return {
    objectApiName: object?.apiName ?? 'Account',
    objectId: object?.id ?? 'CustomObject:Account',
    fieldId: field?.id ?? 'CustomField:Account.Name',
    fieldApiName: field?.apiName ?? 'Name',
    classApiName: apexClass?.apiName ?? 'Placeholder',
    classId: apexClass?.id ?? 'ApexClass:Placeholder',
    flowApiName: flow?.apiName ?? 'Placeholder',
    triggerId: trigger?.id ?? 'ApexTrigger:Placeholder',
    profileId: profile?.id ?? 'Profile:Placeholder',
    profileApiName: profile?.apiName ?? 'Placeholder',
    secondProfileId: secondProfile?.id ?? profile?.id ?? 'Profile:Placeholder',
    permissionSetId: permissionSet?.id ?? 'PermissionSet:Placeholder',
    vaultRoot,
  };
};

/**
 * Argument name -> a real value from the vault.
 *
 * Keyed by NAME rather than by tool, so one entry serves every tool that
 * declares that argument. The 14 tools requiring `componentId` and the 14
 * requiring `objectApiName` are covered by two entries, not 28.
 */
const valueForName = (sample: VaultSample): Readonly<Record<string, unknown>> => ({
  // Object scope.
  objectApiName: sample.objectApiName,
  object: sample.objectApiName,
  objectA: sample.objectApiName,
  objectB: sample.objectApiName,
  objects: [sample.objectApiName],
  objectId: sample.objectId,
  // Generic component handles.
  componentId: sample.objectId,
  componentIds: [sample.classId],
  components: [sample.classId],
  changedComponents: [sample.classId],
  targetId: sample.objectId,
  rootId: sample.objectId,
  nodeId: sample.objectId,
  idA: sample.objectId,
  idB: sample.objectId,
  ref: sample.classId,
  // Typed handles.
  fieldId: sample.fieldId,
  fieldApiName: sample.fieldApiName,
  classApiName: sample.classApiName,
  classRef: sample.classApiName,
  flowRef: sample.flowApiName,
  triggerId: sample.triggerId,
  profileId: sample.profileId,
  profileIdA: sample.profileId,
  profileIdB: sample.secondProfileId,
  profileName: sample.profileApiName,
  permissionSetId: sample.permissionSetId,
  targetPermSets: [sample.permissionSetId],
  // Cross-vault comparison tools point both sides at this vault; the
  // comparison is then trivially empty, which is exactly a case Law 1 should
  // see a tool disclose rather than report as a silent zero.
  vaultA: sample.vaultRoot,
  vaultB: sample.vaultRoot,
  sandbox: sample.vaultRoot,
  prod: sample.vaultRoot,
  // Free-text / scalar arguments.
  query: sample.objectApiName,
  question: 'what happens when this record is saved',
  soql: `SELECT Id FROM ${sample.objectApiName}`,
  name: 'sfi.org_pulse',
  tool: 'sfi.org_pulse',
  methodName: 'execute',
  groupByField: 'OwnerId',
  event: 'insert',
  since: '2020-01-01',
  topic: 'flow-vs-apex',
  fingerprint: 'honesty-sweep',
  input: {},
});

/**
 * Derive one argument value.
 *
 * Order matters: a schema `enum` or `default` is the tool's OWN statement of
 * what it accepts and always wins over a name-keyed guess, so a tool that
 * narrows an argument cannot be handed a value it rejects.
 */
const deriveValue = (
  key: string,
  property: SchemaProperty | undefined,
  known: Readonly<Record<string, unknown>>,
): unknown => {
  if (property?.enum !== undefined && property.enum.length > 0) return property.enum[0];
  if (property?.default !== undefined) return property.default;
  if (key in known) return known[key];
  switch (property?.type) {
    case 'array': {
      const items = property.items;
      if (items?.enum !== undefined && items.enum.length > 0) return [items.enum[0]];
      return [];
    }
    case 'number':
    case 'integer':
      return property.minimum ?? 1;
    case 'boolean':
      return false;
    case 'object':
      return {};
    default:
      return 'x';
  }
};

/** Minimal valid arguments for one tool: every REQUIRED key, nothing else. */
export const deriveArgs = (
  entry: RosterEntry,
  sample: VaultSample,
): Readonly<Record<string, unknown>> => {
  const properties = schemaProperties(entry.inputSchema);
  const known = valueForName(sample);
  const args: Record<string, unknown> = {};
  for (const key of schemaRequired(entry.inputSchema)) {
    args[key] = deriveValue(key, properties[key], known);
  }
  return args;
};

/**
 * The object-scope arguments a tool advertises, or `[]`. A tool with none is
 * outside Law 3 and is NOT counted toward its anti-vacuity denominator.
 */
export const objectScopeKeys = (entry: RosterEntry): readonly string[] =>
  OBJECT_SCOPE_KEYS.filter((key) => key in schemaProperties(entry.inputSchema));

/** Arguments for the Law 3 probe: the derived args with the scope made unresolvable. */
export const deriveGhostScopeArgs = (
  entry: RosterEntry,
  sample: VaultSample,
): Readonly<Record<string, unknown>> => {
  const args: Record<string, unknown> = { ...deriveArgs(entry, sample) };
  for (const key of objectScopeKeys(entry)) {
    args[key] = key === 'objectId' ? `CustomObject:${GHOST_OBJECT}` : GHOST_OBJECT;
  }
  return args;
};
