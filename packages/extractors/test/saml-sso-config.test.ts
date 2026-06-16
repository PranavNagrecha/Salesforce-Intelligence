/// <reference types="vitest/globals" />

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractSamlSsoConfig } from '../src/saml-sso-config.js';

let dir: string;
const write = async (name: string, xml: string): Promise<string> => {
  const p = join(dir, name);
  await writeFile(p, xml, 'utf-8');
  return p;
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'sfi-saml-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('extractSamlSsoConfig', () => {
  it('parses identityMapping=FederationId from a real-shape SSO config', async () => {
    // Mirrors a real Entra_ID_SSO config.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SamlSsoConfig xmlns="http://soap.sforce.com/2006/04/metadata">
    <identityLocation>SubjectNameId</identityLocation>
    <identityMapping>FederationId</identityMapping>
    <issuer>https://sts.windows.net/14300171/</issuer>
    <samlEntityId>https://example.my.salesforce.com</samlEntityId>
</SamlSsoConfig>`;
    const p = await write('Entra_ID_SSO.samlssoconfig-meta.xml', xml);
    const r = await extractSamlSsoConfig(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const n = r.value.nodes[0]!;
    expect(n.id).toBe('SamlSsoConfig:Entra_ID_SSO');
    expect(n.type).toBe('SamlSsoConfig');
    expect(n.properties['identityMapping']).toBe('FederationId');
    expect(n.properties['issuer']).toBe('https://sts.windows.net/14300171/');
    expect(r.value.edges).toHaveLength(0);
  });

  it('parses identityMapping=UserId (a config that is NOT federation-keyed)', async () => {
    const xml = `<?xml version="1.0"?><SamlSsoConfig><identityMapping>UserId</identityMapping></SamlSsoConfig>`;
    const p = await write('UserIdConfig.samlssoconfig-meta.xml', xml);
    const r = await extractSamlSsoConfig(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]!.properties['identityMapping']).toBe('UserId');
  });

  it('defaults identityMapping to Username when the element is absent', async () => {
    const xml = `<?xml version="1.0"?><SamlSsoConfig><issuer>x</issuer></SamlSsoConfig>`;
    const p = await write('Legacy.samlssoconfig-meta.xml', xml);
    const r = await extractSamlSsoConfig(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodes[0]!.properties['identityMapping']).toBe('Username');
  });

  it('errors on a non-SamlSsoConfig root', async () => {
    const p = await write('Bad.samlssoconfig-meta.xml', '<?xml version="1.0"?><Nope></Nope>');
    const r = await extractSamlSsoConfig(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('malformed-input');
  });
});
