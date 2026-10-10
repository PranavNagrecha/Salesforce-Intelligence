/// <reference types="vitest/globals" />

/**
 * FAIL-BEFORE/PASS-AFTER (eval B01). An Apex callout whose endpoint is a
 * literal / constant prefix concatenated with a custom metadata field or a
 * custom label read `target: 'dynamic'` with no host, no credential and no
 * word on where the rest came from, although the vault held the constant, the
 * records and the label. Synthetic fixture only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtractionResult, Node, VaultManifest } from '@sf-intelligence/contracts';
import { closeGraph, importExtractionResults, openGraph, type GraphStore } from '@sf-intelligence/graph';

import type { Context } from '../../src/server.js';
import {
  constantValueIn,
  endpointArgumentText,
  prefixNames,
  splitConcatenation,
} from '../../src/tools/apex-callout-resolve.js';
import { endpointCatalogHandler } from '../../src/tools/endpoint-catalog.js';

const MANIFEST: VaultManifest = {
  version: '0.1.0',
  refreshedAt: '2026-05-27T14:33:08Z',
  sourceOrg: 'me@example.com',
  components: { ApexClass: 9 },
  edges: {},
  sourceTreeHash: 'sha256:partial-fixture',
};

const node = (o: Partial<Node> & Pick<Node, 'id'>): Node => ({
  type: 'ApexClass',
  apiName: o.id.slice(o.id.indexOf(':') + 1),
  label: null,
  parentId: null,
  sourcePath: 'unused.xml',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});

const record = (name: string, values: Record<string, string>): Node =>
  node({
    id: `CustomMetadataRecord:Wire_Route__mdt.${name}`,
    type: 'CustomMetadataRecord',
    apiName: `Wire_Route__mdt.${name}`,
    parentId: 'CustomObject:Wire_Route__mdt',
    properties: {
      label: name,
      valuesCount: Object.keys(values).length,
      values: Object.entries(values).map(([field, value]) => ({ field, value, valueType: 'xsd:string', isMasked: false })),
    },
  });

const CLASSES: Record<string, string> = {
  Wire_Consts: [
    'public class Wire_Consts {',
    "  public static final string CALLOUT_PREFIX { get { return 'callout:'; } }",
    "  public static final String API_BASE = 'https://api.vendor-x.example.com/';",
    '}',
  ].join('\n'),
  // 'callout:' (via a constant in another class) + a custom metadata field.
  Wire_Router: [
    'public class Wire_Router {',
    '  public static HttpRequest build(String name) {',
    '    HttpRequest req = new HttpRequest();',
    '    Wire_Route__mdt route = Wire_Route__mdt.getInstance(name);',
    '    req.setEndpoint(Wire_Consts.CALLOUT_PREFIX + route.Credential_Path__c);',
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A literal host (via a constant) + a custom label.
  Wire_Status: [
    'public class Wire_Status {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    '    req.setEndpoint(Wire_Consts.API_BASE + Label.Wire_Status_Path);',
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A named credential literal + one named record's field.
  Wire_Push: [
    'public class Wire_Push {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:Wire_NC/' +",
    "        Wire_Route__mdt.getInstance('Primary').Path__c);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // Built only from a same-class constant: fully static.
  Wire_Ping: [
    'public class Wire_Ping {',
    "  private static final String FULL = 'callout:Wire_NC/v2/ping';",
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    '    req.setEndpoint(FULL);',
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // An unfinished host: 'https://api.' + label names no host.
  Wire_Region: [
    'public class Wire_Region {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('https://api.' + System.Label.Wire_Domain);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // An unterminated credential + a label whose vault value starts a path.
  Wire_Scan: [
    'public class Wire_Scan {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:Wire_NC' + Label.Wire_Scan_Path);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // Records stored the source-format way: parented on the type name WITHOUT __mdt.
  Wire_Alt: [
    'public class Wire_Alt {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    '    List<Wire_Alt__mdt> rows = [SELECT Target__c FROM Wire_Alt__mdt];',
    '    req.setEndpoint(Wire_Consts.CALLOUT_PREFIX + rows[0].Target__c);',
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A literal host with no separator before a runtime parameter (eval-review
  // regression): the classifier named this host; it must stay named, hedged.
  Wire_Vendor: [
    'public class Wire_Vendor {',
    '  public static HttpRequest build(String path) {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('https://api.vendor-y.example.com' + path);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // The common `'callout:NC' + path` idiom: the credential stays named, hedged.
  Wire_Direct: [
    'public class Wire_Direct {',
    '  public static HttpRequest build(String path) {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:Wire_NC' + path);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // The same with a label the vault does not hold.
  Wire_Missing: [
    'public class Wire_Missing {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:Wire_NC' + Label.Wire_Missing_Path);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A label the vault holds that visibly CONTINUES the name: no credential.
  Wire_Longer: [
    'public class Wire_Longer {',
    '  public static HttpRequest build() {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:Wire_NC' + Label.Wire_Suffix);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A typed variable reading a field no record sets.
  Wire_Unset: [
    'public class Wire_Unset {',
    '  public static HttpRequest build(Wire_Route__mdt route) {',
    '    HttpRequest req = new HttpRequest();',
    "    req.setEndpoint('callout:' + route.Unset_Path__c);",
    '    return req;',
    '  }',
    '}',
  ].join('\n'),
  // A bare parameter: nothing is known, no resolution block.
  Wire_Raw: [
    'public class Wire_Raw {',
    '  public static void send(String endpoint) {',
    '    HttpRequest req = new HttpRequest();',
    '    req.setEndpoint(endpoint);',
    '  }',
    '}',
  ].join('\n'),
};

describe('endpoint_catalog — partially resolved callout endpoints (eval B01)', () => {
  let dir: string;
  let store: GraphStore;
  let ctx: Context;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sfi-mcp-endpoint-partial-'));
    const classes = join(dir, 'source', 'classes');
    mkdirSync(classes, { recursive: true });
    const nodes: Node[] = [];
    for (const [name, src] of Object.entries(CLASSES)) {
      writeFileSync(join(classes, `${name}.cls`), src);
      nodes.push(node({ id: `ApexClass:${name}`, sourcePath: `source/classes/${name}.cls` }));
    }
    nodes.push(
      node({ id: 'CustomObject:Wire_Route__mdt', type: 'CustomObject' }),
      record('Primary', { Credential_Path__c: 'Wire_NC/v1/push', Path__c: 'v1/push' }),
      record('Secondary', { Credential_Path__c: 'Absent_NC/v1/other', Path__c: 'v1/other' }),
      // Same value as Primary: listed once, with both records attributed.
      record('Tertiary', { Credential_Path__c: 'Wire_NC/v1/push' }),
      node({ id: 'CustomLabel:Wire_Suffix', type: 'CustomLabel', properties: { value: '_Legacy/v1' } }),
      node({ id: 'CustomLabel:Wire_Status_Path', type: 'CustomLabel', properties: { value: 'v3/status' } }),
      node({ id: 'CustomLabel:Wire_Scan_Path', type: 'CustomLabel', properties: { value: '/v1/scan' } }),
      node({ id: 'CustomObject:Wire_Alt', type: 'CustomObject' }),
      node({
        id: 'CustomMetadataRecord:Wire_Alt.Only',
        type: 'CustomMetadataRecord',
        parentId: 'CustomObject:Wire_Alt',
        properties: { valuesCount: 1, values: [{ field: 'Target__c', value: 'Wire_NC/alt', valueType: 'string', isMasked: false }] },
      }),
      node({ id: 'NamedCredential:Wire_NC', type: 'NamedCredential', properties: { url: 'https://wire.example.com' } }),
    );
    const seed: ExtractionResult = { nodes, edges: [] };
    const opened = await openGraph(join(dir, 'g.db'));
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    const imported = await importExtractionResults(store, [seed]);
    if (!imported.ok) throw new Error(imported.error.message);
    ctx = { vaultRoot: dir, manifest: MANIFEST, graph: store };
  });

  afterAll(async () => {
    await closeGraph(store);
    rmSync(dir, { recursive: true, force: true });
  });

  const callout = async (cls: string) => {
    const r = await endpointCatalogHandler(ctx, {});
    if (!r.ok) throw new Error(r.error.message);
    return { site: r.value.data.apexCallouts.find((c) => c.sourceComponentId === `ApexClass:${cls}`), data: r.value.data };
  };

  it("'callout:' constant + custom metadata field: names the type.field, the vault values and the credential they name", async () => {
    const { site } = await callout('Wire_Router');
    // The literal part names no credential, so the target stays dynamic …
    expect(site?.target).toBe('dynamic');
    expect(site?.namedCredential).toBeNull();
    // … but where it comes from is no longer a blank.
    expect(site?.resolution?.literalPrefix).toBe('callout:');
    expect(site?.resolution?.constants).toEqual(['Wire_Consts.CALLOUT_PREFIX']);
    expect(site?.resolution?.dynamicParts).toEqual([
      expect.objectContaining({
        source: 'custom-metadata',
        customMetadataType: 'Wire_Route__mdt',
        field: 'Credential_Path__c',
        vaultValues: [
          {
            value: 'Wire_NC/v1/push',
            from: 'CustomMetadataRecord:Wire_Route__mdt.Primary',
            alsoFrom: ['CustomMetadataRecord:Wire_Route__mdt.Tertiary'],
          },
          { value: 'Absent_NC/v1/other', from: 'CustomMetadataRecord:Wire_Route__mdt.Secondary' },
        ],
        vaultValueCount: 2,
        vaultRecordCount: 3,
        // Which record runs is data: the vault lists them all and says so.
        vaultValuesNote: expect.stringContaining('not traced'),
      }),
    ]);
    // Only the value that names a credential in the catalog becomes a candidate.
    expect(site?.credentialCandidates).toEqual([
      {
        namedCredential: 'NamedCredential:Wire_NC',
        tier: 'vault-record',
        namedIn: ['CustomMetadataRecord:Wire_Route__mdt.Primary', 'CustomMetadataRecord:Wire_Route__mdt.Tertiary'],
        confidence: 'heuristic',
      },
    ]);
  });

  it('literal host constant + custom label: partially-resolved with the host, joined to the allowlist', async () => {
    const { site, data } = await callout('Wire_Status');
    expect(site?.target).toBe('partially-resolved');
    expect(site?.host).toBe('api.vendor-x.example.com');
    expect(site?.authorizedBy).toBeNull();
    expect(site?.resolution?.literalPrefix).toBe('https://api.vendor-x.example.com/');
    expect(site?.resolution?.dynamicParts).toEqual([
      expect.objectContaining({
        source: 'custom-label',
        customLabel: 'Wire_Status_Path',
        vaultValues: [{ value: 'v3/status', from: 'CustomLabel:Wire_Status_Path' }],
      }),
    ]);
    expect(data.summary.unauthorizedCalloutHosts).toContain('api.vendor-x.example.com');
  });

  it("'callout:Name/' + a named record's field, split over two lines: partially-resolved with the credential", async () => {
    const { site } = await callout('Wire_Push');
    expect(site?.target).toBe('partially-resolved');
    expect(site?.namedCredential).toBe('Wire_NC');
    expect(site?.host).toBeNull();
    expect(site?.resolution?.dynamicParts).toEqual([
      expect.objectContaining({
        source: 'custom-metadata',
        record: 'Primary',
        field: 'Path__c',
        vaultValues: [{ value: 'v1/push', from: 'CustomMetadataRecord:Wire_Route__mdt.Primary' }],
      }),
    ]);
  });

  it("'callout:Name' + a label whose vault value starts a path: the credential is named", async () => {
    const { site } = await callout('Wire_Scan');
    expect(site?.target).toBe('partially-resolved');
    expect(site?.namedCredential).toBe('Wire_NC');
    expect(site?.nameMayContinue).toBeUndefined();
  });

  it("literal host + a runtime parameter, no separator: the host stays named (hedged) and stays in unauthorizedCalloutHosts", async () => {
    const { site, data } = await callout('Wire_Vendor');
    expect(site).toMatchObject({
      target: 'partially-resolved',
      host: 'api.vendor-y.example.com',
      namedCredential: null,
      nameMayContinue: true,
      authorizedBy: null,
    });
    expect(data.summary.unauthorizedCalloutHosts).toContain('api.vendor-y.example.com');
    // The list says which host rests on a hedged name.
    expect(data.boundaries.some((b) => b.includes('api.vendor-y.example.com') && b.includes('nameMayContinue'))).toBe(true);
    // A host named outright is not in that hedge note.
    expect(data.boundaries.some((b) => b.includes('nameMayContinue') && b.includes('api.vendor-x.example.com'))).toBe(false);
  });

  it("'callout:Name' + a runtime parameter or an unknown label: the credential stays named, hedged", async () => {
    for (const cls of ['Wire_Direct', 'Wire_Missing']) {
      const { site } = await callout(cls);
      expect(site).toMatchObject({ target: 'partially-resolved', namedCredential: 'Wire_NC', host: null, nameMayContinue: true });
    }
  });

  it('names no credential when every vault value shows the name continues', async () => {
    const { site } = await callout('Wire_Longer');
    expect(site?.target).toBe('dynamic');
    expect(site?.namedCredential).toBeNull();
    expect(site?.nameMayContinue).toBeUndefined();
  });

  it('says no record sets a field when no record is named', async () => {
    const { site } = await callout('Wire_Unset');
    expect(site?.resolution?.dynamicParts[0]?.vaultValuesNote).toBe('No Wire_Route__mdt record in the vault sets Unset_Path__c.');
  });

  it('reads records parented on the bare type name (source-format record files)', async () => {
    const { site } = await callout('Wire_Alt');
    expect(site?.resolution?.dynamicParts[0]).toMatchObject({
      source: 'custom-metadata',
      customMetadataType: 'Wire_Alt__mdt',
      field: 'Target__c',
      vaultValues: [{ value: 'Wire_NC/alt', from: 'CustomMetadataRecord:Wire_Alt.Only' }],
    });
    expect(site?.credentialCandidates?.map((c) => c.namedCredential)).toEqual(['NamedCredential:Wire_NC']);
  });

  it('an endpoint built only from a constant resolves to its named credential', async () => {
    const { site } = await callout('Wire_Ping');
    expect(site?.target).toBe('named-credential');
    expect(site?.namedCredential).toBe('Wire_NC');
    expect(site?.resolution?.dynamicParts).toEqual([]);
  });

  it('does not overclaim: an unfinished host stays dynamic, and a bare parameter carries no resolution', async () => {
    const region = (await callout('Wire_Region')).site;
    expect(region?.target).toBe('dynamic');
    expect(region?.host).toBeNull();
    expect(region?.resolution?.literalPrefix).toBe('https://api.');
    expect(region?.resolution?.dynamicParts[0]).toMatchObject({
      source: 'custom-label',
      customLabel: 'Wire_Domain',
      vaultValuesNote: expect.stringContaining('not in the vault'),
    });
    const raw = (await callout('Wire_Raw')).site;
    expect(raw?.target).toBe('dynamic');
    expect(raw?.resolution).toBeUndefined();
  });
});

describe('apex-callout-resolve parsing helpers', () => {
  it('splits only on top-level +', () => {
    expect(splitConcatenation("'a+b' + f(x + y) + m[1+2] + z")).toEqual(["'a+b'", 'f(x + y)', 'm[1+2]', 'z']);
  });

  it('reads the setEndpoint argument across lines and ignores a ) inside a literal', () => {
    const code = "x\n  req.setEndpoint('callout:A/(' +\n   b.C__c);\n";
    expect(endpointArgumentText(code, 2)).toBe("'callout:A/(' +\n   b.C__c");
  });

  it('reads final fields and literal-only getters; refuses ambiguous or non-final ones', () => {
    expect(constantValueIn("static final String X = 'v';", 'x')).toBe('v');
    expect(constantValueIn("public static String X { get { return 'v'; } }", 'X')).toBe('v');
    expect(constantValueIn("class A { @TestVisible private static final String X = 'v'; }", 'X')).toBe('v');
    expect(constantValueIn("static String X = 'v';", 'X')).toBeNull();
    // A local final inside some method is not a constant of the call site.
    expect(constantValueIn("void m() { final String X = 'v'; }", 'X')).toBeNull();
    expect(constantValueIn("static final String X = 'a'; static final String X = 'b';", 'X')).toBeNull();
    // Scope is not tracked: any other declaration of the name may shadow it.
    expect(constantValueIn("static final String X = 'a'; void m() { String X = 'b'; send(X); }", 'X')).toBeNull();
    expect(constantValueIn("static final String X = 'a'; void m(String X) { send(X); }", 'X')).toBeNull();
    expect(constantValueIn("public String X { get { return compute(); } } static final String X = 'a';", 'X')).toBeNull();
  });

  it('names a credential or host outright when the name visibly ends, hedged when nothing shows', () => {
    expect(prefixNames('callout:Nc/', 'unknown')).toEqual({ namedCredential: 'Nc', host: null, nameMayContinue: false });
    expect(prefixNames('callout:Nc', 'ends')).toEqual({ namedCredential: 'Nc', host: null, nameMayContinue: false });
    expect(prefixNames('callout:Nc', 'unknown')).toEqual({ namedCredential: 'Nc', host: null, nameMayContinue: true });
    expect(prefixNames('callout:Nc', 'continues')).toEqual({ namedCredential: null, host: null, nameMayContinue: false });
    expect(prefixNames('callout:Nc_', 'unknown')).toEqual({ namedCredential: null, host: null, nameMayContinue: false });
    expect(prefixNames('https://h.example.com:8443', 'unknown')).toEqual({
      namedCredential: null,
      host: 'h.example.com',
      nameMayContinue: false,
    });
    expect(prefixNames('https://H.example.com', 'unknown')).toEqual({ namedCredential: null, host: 'h.example.com', nameMayContinue: true });
    // Cut off mid-token: no host at all.
    expect(prefixNames('https://h.example.', 'unknown').host).toBeNull();
    expect(prefixNames('https://h-', 'unknown').host).toBeNull();
    expect(prefixNames('https://api', 'unknown').host).toBeNull();
  });
});
