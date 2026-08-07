/// <reference types="vitest/globals" />

import { afterEach, beforeEach, vi } from 'vitest';

import type { ToolingApiAuth } from '../src/auth.js';
import {
  createToolingApiClient,
  type FetchFn,
  type FetchResponse,
} from '../src/client.js';

beforeEach(() => {
  // AUDIT-F2: Tooling HTTP requires salesforce-read (refresh elevates in prod).
  vi.stubEnv('SFI_NETWORK_MODE', 'salesforce-read');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const AUTH: ToolingApiAuth = {
  accessToken: 'TOKEN_xxx',
  instanceUrl: 'https://my-org.my.salesforce.com',
  apiVersion: '60.0',
};

const makeResponse = (
  status: number,
  body: string,
  headerEntries: ReadonlyArray<readonly [string, string]> = [],
): FetchResponse => {
  const map = new Map<string, string>(
    headerEntries.map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
};

interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

const recordingFetch = (
  responses: readonly FetchResponse[],
): { readonly fetch: FetchFn; readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  let i = 0;
  const fetch: FetchFn = async (input, init) => {
    calls.push({ url: input, headers: init?.headers ?? {} });
    const r = responses[i++];
    if (r === undefined) {
      throw new Error(`recordingFetch: no response queued for call ${i}`);
    }
    return r;
  };
  return { fetch, calls };
};

describe('createToolingApiClient.query', () => {
  it('issues a GET against /services/data/v{apiVersion}/tooling/query with the SOQL encoded', async () => {
    const { fetch, calls } = recordingFetch([
      makeResponse(200, JSON.stringify({ done: true, records: [{ Id: 'X' }] })),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<{ Id: string }>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ Id: 'X' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      `${AUTH.instanceUrl}/services/data/v60.0/tooling/query?q=${encodeURIComponent('SELECT Id FROM ApexClass')}`,
    );
    expect(calls[0]!.headers).toMatchObject({
      Authorization: `Bearer ${AUTH.accessToken}`,
    });
  });

  it('follows nextRecordsUrl until done:true and concatenates the records', async () => {
    const page1 = makeResponse(
      200,
      JSON.stringify({
        done: false,
        nextRecordsUrl: '/services/data/v60.0/tooling/query/01-2000',
        records: [{ Id: 'a' }, { Id: 'b' }],
      }),
    );
    const page2 = makeResponse(
      200,
      JSON.stringify({
        done: true,
        records: [{ Id: 'c' }],
      }),
    );
    const { fetch, calls } = recordingFetch([page1, page2]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<{ Id: string }>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.Id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe(
      `${AUTH.instanceUrl}/services/data/v60.0/tooling/query/01-2000`,
    );
  });

  it('returns auth-expired on 401', async () => {
    const { fetch } = recordingFetch([makeResponse(401, '')]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth-expired');
  });

  it('returns rate-limit on 429 and parses Retry-After header (seconds → ms)', async () => {
    const { fetch } = recordingFetch([
      makeResponse(429, '', [['Retry-After', '30']]),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
    expect(result.error.retryAfterMs).toBe(30_000);
  });

  it('returns rate-limit on 429 and falls back to a 60s window from Sforce-Limit-Info', async () => {
    const { fetch } = recordingFetch([
      makeResponse(429, '', [['Sforce-Limit-Info', 'api-usage=3500/3500']]),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('rate-limit');
    expect(result.error.retryAfterMs).toBe(60_000);
  });

  it('returns query-failed on 4xx (e.g., INVALID_FIELD)', async () => {
    const { fetch } = recordingFetch([
      makeResponse(400, '[{"message":"INVALID_FIELD","errorCode":"INVALID_FIELD"}]'),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT NoSuchField FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('query-failed');
    expect(result.error.message).toContain('400');
  });

  it('returns internal-error on 5xx', async () => {
    const { fetch } = recordingFetch([makeResponse(503, 'down')]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('internal-error');
  });

  it('returns malformed-response when the body is not valid JSON', async () => {
    const { fetch } = recordingFetch([makeResponse(200, 'not-json')]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-response');
  });

  it('returns malformed-response when records is not an array', async () => {
    const { fetch } = recordingFetch([
      makeResponse(200, JSON.stringify({ done: true, records: 'oops' })),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-response');
  });

  it('returns malformed-response when done:false carries no nextRecordsUrl', async () => {
    const { fetch } = recordingFetch([
      makeResponse(200, JSON.stringify({ done: false, records: [] })),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('malformed-response');
  });

  it('returns network-error when fetch itself rejects', async () => {
    const fetch: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('SELECT Id FROM ApexClass');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('network-error');
    expect(result.error.message).toContain('ECONNREFUSED');
  });

  it('rejects an empty SOQL without spawning a request', async () => {
    let called = false;
    const fetch: FetchFn = async () => {
      called = true;
      return makeResponse(200, '');
    };
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.query<unknown>('');
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe('createToolingApiClient.getDependencies', () => {
  it('queries MetadataComponentDependency WHERE RefMetadataComponentId = componentId', async () => {
    const { fetch, calls } = recordingFetch([
      makeResponse(
        200,
        JSON.stringify({
          done: true,
          records: [
            {
              Id: 'dep-1',
              MetadataComponentId: '01p',
              MetadataComponentType: 'ApexClass',
              MetadataComponentName: 'Caller',
              RefMetadataComponentId: '00N',
              RefMetadataComponentType: 'CustomField',
              RefMetadataComponentName: 'Industry__c',
            },
          ],
        }),
      ),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.getDependencies('00N');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.RefMetadataComponentId).toBe('00N');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('MetadataComponentDependency');
    expect(calls[0]!.url).toContain(encodeURIComponent("RefMetadataComponentId = '00N'"));
  });

  it('escapes single quotes in the componentId to avoid SOQL injection', async () => {
    const { fetch, calls } = recordingFetch([
      makeResponse(200, JSON.stringify({ done: true, records: [] })),
    ]);
    const client = createToolingApiClient({ auth: AUTH, fetch });
    const result = await client.getDependencies("evil'id");
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toContain(encodeURIComponent("RefMetadataComponentId = 'evil\\'id'"));
  });

  it('rejects an empty componentId', async () => {
    const client = createToolingApiClient({ auth: AUTH });
    const result = await client.getDependencies('');
    expect(result.ok).toBe(false);
  });
});
