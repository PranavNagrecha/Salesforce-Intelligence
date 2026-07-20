/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractConnectedApp } from '../src/connected-app.js';

/**
 * Write a `.connectedApp-meta.xml` file under a fresh temp directory.
 * Returns the temp-dir root (for cleanup) and the absolute file path.
 */
const writeTempConnectedApp = async (
  filename: string,
  content: string,
): Promise<{ dir: string; path: string }> => {
  const dir = await mkdtemp(join(tmpdir(), 'sf-intel-connected-app-'));
  const path = join(dir, filename);
  await writeFile(path, content, 'utf-8');
  return { dir, path };
};

describe('extractConnectedApp', () => {
  describe('happy path', () => {
    it('produces a node with all populated fields when every element is present', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My OAuth Client</label>
  <contactEmail>admin@example.com</contactEmail>
  <description>Third-party integration</description>
  <iconUrl>https://example.com/icon.png</iconUrl>
  <infoUrl>https://example.com/info</infoUrl>
  <oauthConfig>
    <consumerKey>3MVG9abc123</consumerKey>
    <callbackUrl>https://example.com/callback</callbackUrl>
    <scopes>Api</scopes>
    <scopes>RefreshToken</scopes>
    <scopes>Web</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp(
        'My_OAuth_Client.connectedApp-meta.xml',
        xml,
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.edges).toEqual([]);
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.id).toBe('ConnectedApp:My_OAuth_Client');
        expect(node.type).toBe('ConnectedApp');
        expect(node.apiName).toBe('My_OAuth_Client');
        expect(node.label).toBe('My OAuth Client');
        expect(node.parentId).toBeNull();
        expect(node.sourcePath).toBe(path);
        expect(node.lastModifiedDate).toBeNull();
        expect(node.lastModifiedBy).toBeNull();
        expect(node.apiVersion).toBeNull();
        expect(node.properties).toEqual({
          contactEmail: 'admin@example.com',
          description: 'Third-party integration',
          iconUrl: 'https://example.com/icon.png',
          infoUrl: 'https://example.com/info',
          hasOauthConfig: true,
          consumerKey: '3MVG9abc123',
          callbackUrl: 'https://example.com/callback',
          scopes: ['Api', 'RefreshToken', 'Web'],
          // CONNECTED-APP-DROPS-SAML-CONFIG: protocol discriminant + SAML flag
          // are always present; no `saml` block on an OAuth-only app.
          authProtocol: 'oauth',
          hasSamlConfig: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('defaults optional fields to null when absent', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Minimal</label>
  <contactEmail>admin@example.com</contactEmail>
  <oauthConfig>
    <consumerKey>key</consumerKey>
    <callbackUrl>https://example.com/cb</callbackUrl>
    <scopes>Api</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp(
        'Minimal.connectedApp-meta.xml',
        xml,
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties).toEqual({
          contactEmail: 'admin@example.com',
          description: null,
          iconUrl: null,
          infoUrl: null,
          hasOauthConfig: true,
          consumerKey: 'key',
          callbackUrl: 'https://example.com/cb',
          scopes: ['Api'],
          authProtocol: 'oauth',
          hasSamlConfig: false,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('scopes handling', () => {
    it('returns scopes as an array of strings preserving XML order', async () => {
      // Order matters for downstream renderers: yaml-frontmatter (per
      // journal 0060) emits arrays in insertion order. A scope-list
      // rendered out-of-order would break byte-stable golden assertions.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <contactEmail>a@b.c</contactEmail>
  <oauthConfig>
    <consumerKey>k</consumerKey>
    <callbackUrl>https://x</callbackUrl>
    <scopes>Full</scopes>
    <scopes>OpenID</scopes>
    <scopes>Email</scopes>
    <scopes>Profile</scopes>
    <scopes>RefreshToken</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp(
        'ScopeOrder.connectedApp-meta.xml',
        xml,
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['scopes']).toEqual([
          'Full',
          'OpenID',
          'Email',
          'Profile',
          'RefreshToken',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns a single-element scopes array when only one scope is declared', async () => {
      // fast-xml-parser unwraps single-occurrence children to scalars;
      // the extractor's toArray helper must normalize to a 1-element
      // array so callers can iterate uniformly.
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Test</label>
  <contactEmail>a@b.c</contactEmail>
  <oauthConfig>
    <consumerKey>k</consumerKey>
    <callbackUrl>https://x</callbackUrl>
    <scopes>Api</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp(
        'SingleScope.connectedApp-meta.xml',
        xml,
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const node = result.value.nodes[0];
        expect(node).toBeDefined();
        if (!node) return;
        expect(node.properties['scopes']).toEqual(['Api']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // CONNECTED-APP-DROPS-SAML-CONFIG: a SAML-only Connected App must not project
  // as an empty OAuth shell — its ACS / entity / issuer / subject must surface
  // and `authProtocol` must say `saml`. Secrets (certificates) are never read.
  describe('SAML config (CONNECTED-APP-DROPS-SAML-CONFIG)', () => {
    it('surfaces SAML ACS/entity/issuer/subject on a SAML-only app (not an empty OAuth shell)', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>SSO Login App</label>
  <contactEmail>admin@example.com</contactEmail>
  <samlConfig>
    <acsUrl>https://idp.example.com/acs</acsUrl>
    <certificate>MIIBogIBADANBgkq_REDACTED_KEY_MATERIAL</certificate>
    <encryptionType>None</encryptionType>
    <entityUrl>https://sp.example.com/entity</entityUrl>
    <issuer>https://idp.example.com/issuer</issuer>
    <samlNameIdFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</samlNameIdFormat>
    <samlSubjectType>federationId</samlSubjectType>
  </samlConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('SSO_Login_App.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        // NOT an empty OAuth shell.
        expect(props?.['hasOauthConfig']).toBe(false);
        expect(props?.['authProtocol']).toBe('saml');
        expect(props?.['hasSamlConfig']).toBe(true);
        expect(props?.['saml']).toEqual({
          acsUrl: 'https://idp.example.com/acs',
          entityUrl: 'https://sp.example.com/entity',
          issuer: 'https://idp.example.com/issuer',
          subjectType: 'federationId',
          nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
          encryptionType: 'None',
        });
        // Secrets are never vaulted: the certificate must NOT appear anywhere
        // in the serialized node.
        expect(JSON.stringify(result.value.nodes[0])).not.toContain('REDACTED_KEY_MATERIAL');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports authProtocol "both" when an app carries OAuth AND SAML', async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Dual</label>
  <contactEmail>a@b.c</contactEmail>
  <oauthConfig>
    <consumerKey>k</consumerKey>
    <callbackUrl>https://x</callbackUrl>
    <scopes>Api</scopes>
  </oauthConfig>
  <samlConfig>
    <acsUrl>https://idp/acs</acsUrl>
    <entityUrl>https://sp/entity</entityUrl>
    <issuer>https://idp/issuer</issuer>
    <samlSubjectType>username</samlSubjectType>
  </samlConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('Dual.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['authProtocol']).toBe('both');
        expect(props?.['hasOauthConfig']).toBe(true);
        expect(props?.['hasSamlConfig']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reports authProtocol "none" and no saml block on a Canvas/session app', async () => {
      const xml = `<?xml version="1.0"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>Canvas</label>
  <contactEmail>a@b.c</contactEmail>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('Canvas.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['authProtocol']).toBe('none');
        expect(props?.['hasSamlConfig']).toBe(false);
        expect('saml' in (props ?? {})).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe('error cases', () => {
    it('returns file-not-found when the path does not exist', async () => {
      const path = '/nonexistent/Missing.connectedApp-meta.xml';
      const result = await extractConnectedApp(path);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('file-not-found');
      expect(result.error.message).toBe('file not found');
      expect(result.error.path).toBe(path);
    });

    it('returns parse-error for malformed XML', async () => {
      const { dir, path } = await writeTempConnectedApp(
        'Bad.connectedApp-meta.xml',
        '<?xml version="1.0"?><ConnectedApp><label>X</wrongClose></ConnectedApp>',
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('parse-error');
        expect(result.error.path).toBe(path);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when the root element is not <ConnectedApp>', async () => {
      const { dir, path } = await writeTempConnectedApp(
        'Wrong.connectedApp-meta.xml',
        '<?xml version="1.0"?><Foo><bar/></Foo>',
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('expected <ConnectedApp> root');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('returns malformed-input when <label> is missing', async () => {
      const xml = `<?xml version="1.0"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <contactEmail>a@b.c</contactEmail>
  <oauthConfig>
    <consumerKey>k</consumerKey>
    <callbackUrl>https://x</callbackUrl>
    <scopes>Api</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp(
        'NoLabel.connectedApp-meta.xml',
        xml,
      );
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('malformed-input');
        expect(result.error.message).toBe('missing required element: <label>');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    // Real-org tolerance (regression: a real org's source had 3 ConnectedApps
    // — Canvas/sandbox/session apps — with no <oauthConfig>; the old strict
    // extractor dropped them as malformed). These shapes are now MODELED, not
    // rejected, with the missing pieces flagged on properties.
    it('models a ConnectedApp with no <contactEmail> (optional → null)', async () => {
      const xml = `<?xml version="1.0"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>NoEmail</label>
  <oauthConfig>
    <consumerKey>k</consumerKey>
    <callbackUrl>https://x</callbackUrl>
    <scopes>Api</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('NoEmail.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.nodes[0]?.properties['contactEmail']).toBeNull();
        expect(result.value.nodes[0]?.properties['hasOauthConfig']).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('models a ConnectedApp with no <oauthConfig> (Canvas/session app → hasOauthConfig false)', async () => {
      const xml = `<?xml version="1.0"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>NoOauth</label>
  <contactEmail>a@b.c</contactEmail>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('NoOauth.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['hasOauthConfig']).toBe(false);
        expect(props?.['consumerKey']).toBeNull();
        expect(props?.['callbackUrl']).toBeNull();
        expect(props?.['scopes']).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('models a ConnectedApp whose <oauthConfig> omits consumerKey/callbackUrl (→ null, not rejected)', async () => {
      const xml = `<?xml version="1.0"?>
<ConnectedApp xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>PartialOauth</label>
  <contactEmail>a@b.c</contactEmail>
  <oauthConfig>
    <scopes>Api</scopes>
  </oauthConfig>
</ConnectedApp>`;
      const { dir, path } = await writeTempConnectedApp('PartialOauth.connectedApp-meta.xml', xml);
      try {
        const result = await extractConnectedApp(path);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const props = result.value.nodes[0]?.properties;
        expect(props?.['hasOauthConfig']).toBe(true);
        expect(props?.['consumerKey']).toBeNull();
        expect(props?.['callbackUrl']).toBeNull();
        expect(props?.['scopes']).toEqual(['Api']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
