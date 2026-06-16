/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractNamedCredential } from '../src/named-credential.js';

/**
 * Write a `.namedCredential-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempNamedCredential = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-named-cred-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractNamedCredential', () => {
  describe('happy path', () => {
    it('produces a node with all populated fields when every element is present', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>External API</label>
  <endpoint>https://api.example.com/v1</endpoint>
  <principalType>NamedUser</principalType>
  <protocol>Password</protocol>
  <username>integration_user</username>
  <generateAuthorizationHeader>true</generateAuthorizationHeader>
  <allowMergeFieldsInBody>true</allowMergeFieldsInBody>
  <allowMergeFieldsInHeader>false</allowMergeFieldsInHeader>
  <calloutOptionsGenerateAuthorizationHeader>true</calloutOptionsGenerateAuthorizationHeader>
</NamedCredential>`;
      const { dir, path } = await writeTempNamedCredential(
        'External_Api.namedCredential-meta.xml',
        xml,
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('NamedCredential:External_Api');
        expect(node.type).toBe('NamedCredential');
        expect(node.apiName).toBe('External_Api');
        expect(node.label).toBe('External API');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.lastModifiedDate).toBeNull();
        expect(node.lastModifiedBy).toBeNull();
        expect(node.apiVersion).toBeNull();
        expect(node.properties).toEqual({
          endpoint: 'https://api.example.com/v1',
          principalType: 'NamedUser',
          protocol: 'Password',
          username: 'integration_user',
          generateAuthorizationHeader: true,
          allowMergeFieldsInBody: true,
          allowMergeFieldsInHeader: false,
          calloutOptionsGenerateAuthorizationHeader: true,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults optional fields to null/false when absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Minimal</label>
  <endpoint>https://api.example.com</endpoint>
</NamedCredential>`;
      const { dir, path } = await writeTempNamedCredential(
        'Minimal.namedCredential-meta.xml',
        xml,
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          endpoint: 'https://api.example.com',
          principalType: null,
          protocol: null,
          username: null,
          generateAuthorizationHeader: false,
          allowMergeFieldsInBody: false,
          allowMergeFieldsInHeader: false,
          calloutOptionsGenerateAuthorizationHeader: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.namedCredential-meta.xml';
      const result = await extractNamedCredential(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempNamedCredential(
        'Bad.namedCredential-meta.xml',
        '<?xml version="1.0"?><NamedCredential><label>X</wrongClose></NamedCredential>',
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <NamedCredential>', async () => {
      const { dir, path } = await writeTempNamedCredential(
        'Wrong.namedCredential-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <NamedCredential> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
  <endpoint>https://api.example.com</endpoint>
</NamedCredential>`;
      const { dir, path } = await writeTempNamedCredential(
        'NoLabel.namedCredential-meta.xml',
        xml,
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('extracts with endpoint null when neither <endpoint> nor a Url parameter is present', async () => {
      // <endpoint> is OPTIONAL: new-style Named Credentials carry the URL in a
      // <namedCredentialParameters> entry instead, and a credential with
      // neither is still a valid (endpoint-less) node, not a failure.
      const xml = `<?xml version="1.0"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>No endpoint</label>
</NamedCredential>`;
      const { dir, path } = await writeTempNamedCredential(
        'NoEndpoint.namedCredential-meta.xml',
        xml,
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['endpoint']).toBeNull();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads the endpoint from a Url parameter on a new-style (SecuredEndpoint) credential', async () => {
      // New-style Named Credentials (namedCredentialType=SecuredEndpoint, API
      // 56+) have NO top-level <endpoint>; the URL lives in a
      // <namedCredentialParameters> entry with parameterName=Url. Real mass.gov
      // NCs (EXT_API_ClientInfo, MA_SSP_Notice_API, ...) use this shape and used
      // to fail extraction with 'missing required element: <endpoint>'.
      const xml = `<?xml version="1.0"?>
<NamedCredential xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>ClientInfo</label>
  <namedCredentialType>SecuredEndpoint</namedCredentialType>
  <namedCredentialParameters>
    <parameterName>Url</parameterName>
    <parameterType>Url</parameterType>
    <parameterValue>https://api.example.gov/</parameterValue>
  </namedCredentialParameters>
  <namedCredentialParameters>
    <parameterName>ExternalCredential</parameterName>
    <parameterType>Authentication</parameterType>
  </namedCredentialParameters>
</NamedCredential>`;
      const { dir, path } = await writeTempNamedCredential(
        'ClientInfo.namedCredential-meta.xml',
        xml,
      );
      try {
        const result = await extractNamedCredential(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['endpoint']).toBe(
          'https://api.example.gov/',
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
