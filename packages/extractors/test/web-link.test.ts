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
