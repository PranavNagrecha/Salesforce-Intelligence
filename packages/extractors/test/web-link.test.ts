/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractWebLink } from '../src/web-link.js';

/**
 * B-EXTRACTOR-FIELD-WEBLINK (bug 2 of 2): The WebLink extractor was not
 * capturing <openType> from the XML, so consumers received a null/missing
 * property and the product falsely disclaimed that openType could not be
 * confirmed from vault data.
 *
 * Fixture mirrors Contact/webLinks/GoogleMaps.webLink-meta.xml from the real
 * org vault (openType=newWindow).
 */

const writeWebLinkXml = async (
  objectName: string,
  linkName: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-weblink-'));
  const webLinksDir = join(dir, 'objects', objectName, 'webLinks');
  await mkdir(webLinksDir, { recursive: true });
  const path = join(webLinksDir, `${linkName}.webLink-meta.xml`);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

/** Mirrors Contact/webLinks/GoogleMaps.webLink-meta.xml from real org vault. */
const GOOGLEMAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>GoogleMaps</fullName>
    <availability>online</availability>
    <displayType>link</displayType>
    <encodingKey>UTF-8</encodingKey>
    <hasMenubar>false</hasMenubar>
    <hasScrollbars>true</hasScrollbars>
    <hasToolbar>false</hasToolbar>
    <height>600</height>
    <isResizable>true</isResizable>
    <linkType>url</linkType>
    <masterLabel>Google Maps</masterLabel>
    <openType>newWindow</openType>
    <position>none</position>
    <protected>false</protected>
    <showsLocation>false</showsLocation>
    <showsStatus>false</showsStatus>
    <url>http://maps.google.com/maps?f=q&amp;hl=en&amp;q={!Contact.MailingStreet}+{!Contact.MailingCity}+{!Contact.MailingState}&amp;om=1</url>
</WebLink>
`;

describe('WebLink openType extraction', () => {
  it('captures openType=newWindow from the XML properties', async () => {
    const { dir, path } = await writeWebLinkXml('Contact', 'GoogleMaps', GOOGLEMAPS_XML);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.value.nodes[0];
      expect(node).toBeDefined();
      expect(node?.id).toBe('WebLink:Contact.GoogleMaps');

      // openType must be extracted and equal to the literal XML value.
      expect(node?.properties['openType']).toBe('newWindow');

      // Other existing properties must remain intact.
      expect(node?.properties['linkType']).toBe('url');
      expect(node?.properties['displayType']).toBe('link');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits openType=null when the element is absent', async () => {
    const noOpenTypeXml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>SAPApproval</fullName>
    <availability>online</availability>
    <displayType>button</displayType>
    <linkType>javascript</linkType>
    <masterLabel>SAP Approval</masterLabel>
    <url>javascript:void(0);</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Opportunity', 'SAPApproval', noOpenTypeXml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const node = result.value.nodes[0];
      // When absent from the XML, openType should be null (nullable string
      // contract), never undefined or a fabricated default.
      expect(node?.properties['openType']).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WEBLINK-FLOW-URL-UNGRAPHED (P1): custom buttons/links whose URL is
 * `/flow/{ApiName}?...` are the primary business entry to a screen flow, but
 * the extractor only edged `{!Object.Field}` merge fields — never the launched
 * Flow. `review_change` delete on the button returned `safe`, and Flow usages
 * omitted the launcher. The extractor now emits a heuristic `references` edge
 * to `Flow:{ApiName}`.
 *
 * Synthetic fixture mirrors the SHAPE of a real `/flow/` launcher button
 * (generic object + flow names, no org identifiers).
 */
describe('WebLink /flow/ launcher edges (WEBLINK-FLOW-URL-UNGRAPHED)', () => {
  it('emits a heuristic references edge to the launched Flow for a /flow/ button URL', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Create_Budget</fullName>
    <displayType>button</displayType>
    <linkType>url</linkType>
    <masterLabel>Create Budget</masterLabel>
    <openType>replace</openType>
    <url>/flow/Budget_Entry_Form?vParentId={!Campaign.Id}&amp;retURL={!Campaign.Id}</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Campaign', 'Create_Budget', xml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const flowEdge = result.value.edges.find((e) => e.toId === 'Flow:Budget_Entry_Form');
      // Pre-fix this edge was NEVER emitted — only the {!Campaign.Id} field ref
      // and the parentOf edge existed.
      expect(flowEdge).toBeDefined();
      if (!flowEdge) return;
      expect(flowEdge.fromId).toBe('WebLink:Campaign.Create_Budget');
      expect(flowEdge.edgeType).toBe('references');
      expect(flowEdge.confidence).toBe('heuristic');
      expect(flowEdge.source).toBe('web-link-extractor');
      expect(flowEdge.properties).toEqual({ targetKind: 'flow' });

      // The pre-existing merge-field edge to the own-object Id field is intact.
      expect(
        result.value.edges.some((e) => e.toId === 'CustomField:Campaign.Id'),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('also recognizes the /lightning/flow/{ApiName} route form', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Run_Intake</fullName>
    <displayType>button</displayType>
    <linkType>url</linkType>
    <masterLabel>Run Intake</masterLabel>
    <url>/lightning/flow/Intake_Screen_Flow</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Contact', 'Run_Intake', xml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const flowEdge = result.value.edges.find(
        (e) => e.toId === 'Flow:Intake_Screen_Flow',
      );
      expect(flowEdge).toBeDefined();
      expect(flowEdge?.properties).toEqual({ targetKind: 'flow' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('emits no Flow edge for a non-flow URL', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Open_Home</fullName>
    <displayType>link</displayType>
    <linkType>url</linkType>
    <masterLabel>Open Home</masterLabel>
    <url>https://example.com/reflow/not-a-flow</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Account', 'Open_Home', xml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // `/reflow/` must NOT match the `/flow/` route (word-boundary on the
      // leading slash).
      expect(result.value.edges.some((e) => e.toId.startsWith('Flow:'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * WEBLINK-UNDERSCORE-MERGE-FIELD-UNGRAPHED (P2): WebLink URLs using the classic
 * underscore merge-field form (`{!Object_Field}`) produced NO field references,
 * while the dotted `{!Object.Field}` form correctly edged. The extractor now
 * accepts the underscore form (anchored on the owning object) for both standard
 * and custom (`__c`) fields.
 *
 * Synthetic fixture mirrors the SHAPE of the real Account GoogleMaps button
 * (generic field names, no org identifiers).
 */
describe('WebLink underscore merge fields (WEBLINK-UNDERSCORE-MERGE-FIELD-UNGRAPHED)', () => {
  it('edges {!Object_Field} underscore tokens to own-object CustomField refs', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>GoogleMaps</fullName>
    <displayType>link</displayType>
    <linkType>url</linkType>
    <masterLabel>Google Maps</masterLabel>
    <openType>newWindow</openType>
    <url>http://maps.google.com/maps?q={!Account_BillingStreet}+{!Account_BillingCity}+{!Account_BillingState}</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Account', 'GoogleMaps', xml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const fieldTargets = result.value.edges
        .filter((e) => e.edgeType === 'references' && e.toId.startsWith('CustomField:'))
        .map((e) => e.toId)
        .sort();
      // Pre-fix this was `[]` — the underscore form produced no field edges.
      expect(fieldTargets).toEqual([
        'CustomField:Account.BillingCity',
        'CustomField:Account.BillingState',
        'CustomField:Account.BillingStreet',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads underscore custom (__c) fields and ignores cross-object underscore tokens', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<WebLink xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Do_Thing</fullName>
    <displayType>button</displayType>
    <linkType>url</linkType>
    <masterLabel>Do Thing</masterLabel>
    <url>/apex/p?a={!Account_My_Field__c}&amp;b={!Contact_Other_Field__c}</url>
</WebLink>
`;
    const { dir, path } = await writeWebLinkXml('Account', 'Do_Thing', xml);
    try {
      const result = await extractWebLink(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const fieldTargets = result.value.edges
        .filter((e) => e.toId.startsWith('CustomField:'))
        .map((e) => e.toId);
      // Own-object custom field is captured (with its __c suffix); the
      // cross-object Contact token must NOT produce an Account edge.
      expect(fieldTargets).toEqual(['CustomField:Account.My_Field__c']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
