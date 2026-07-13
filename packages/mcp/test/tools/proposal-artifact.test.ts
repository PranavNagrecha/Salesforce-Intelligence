/// <reference types="vitest/globals" />
/**
 * Finding #35 — the shared proposal-artifact builder. `buildDeleteProposal` /
 * `buildDestructiveChanges` are PURE, so this is a fast T-unit that pins the
 * load-bearing guarantees: a well-formed `destructiveChanges.xml` (populated,
 * NO `<version>`) + an empty `package.xml` (WITH `<version>`), the correct
 * members under the deployable `<name>`, synthetic/malformed ids skipped, and a
 * self-justifying evidence comment that stays a valid XML comment even when the
 * verbatim disclosures carry CLI flags (`--with-reports`) or arrows (`-->`).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildDeleteProposal,
  buildDeployProposal,
  buildDestructiveChanges,
  PROPOSAL_SCHEMA_VERSION,
  renderEvidenceComment,
  sanitizeXmlComment,
  type ProposalEvidence,
} from '../../src/tools/proposal-artifact.js';

type JsonSchema = Record<string, unknown>;

/** Minimal draft-07 subset validator (mirrors compare-components-ps-diff.test.ts). */
function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  path: string,
  errors: string[],
): void {
  if (typeof schema.$ref === 'string') {
    const parts = schema.$ref.replace(/^#\//, '').split('/');
    let resolved: unknown = root;
    for (const p of parts) resolved = (resolved as Record<string, unknown>)[p];
    validateAgainstSchema(value, resolved as JsonSchema, root, path, errors);
    return;
  }
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
    }
    return;
  }
  const type = schema.type;
  if (type === undefined) return;
  if (type === 'string' && typeof value !== 'string') errors.push(`${path}: expected string`);
  if (type === 'integer' && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
  if (type === 'boolean' && typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected array`);
      return;
    }
    const items = schema.items as JsonSchema | undefined;
    if (items) value.forEach((v, i) => validateAgainstSchema(v, items, root, `${path}[${i}]`, errors));
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return;
    }
    const obj = value as Record<string, unknown>;
    const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
    const required = (schema.required as string[] | undefined) ?? [];
    for (const req of required) {
      if (!(req in obj)) errors.push(`${path}: missing required '${req}'`);
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) errors.push(`${path}: unexpected property '${k}'`);
      }
    }
    for (const [k, sub] of Object.entries(props)) {
      if (k in obj) validateAgainstSchema(obj[k], sub, root, `${path}.${k}`, errors);
    }
  }
}

const SCHEMA: JsonSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../docs/schemas/proposal.schema.json', import.meta.url)),
    'utf8',
  ),
) as JsonSchema;

/** Strip XML comments + prolog so the tag-balance check ignores comment bodies. */
const stripCommentsAndProlog = (xml: string): string =>
  xml.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?xml[^>]*\?>/g, '');

/** Minimal well-formedness check: tags balance and nest (comments/prolog stripped). */
const isWellFormed = (xml: string): boolean => {
  const body = stripCommentsAndProlog(xml);
  const stack: string[] = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w.-]*)(\s[^>]*)?(\/?)>/g)) {
    const closing = m[1] === '/';
    const name = m[2] ?? '';
    const selfClose = m[4] === '/';
    if (selfClose) continue;
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
};

/** Every XML comment in `xml` obeys the `--`-free / not-ending-in-`-` rules. */
const commentsAreValid = (xml: string): boolean => {
  for (const m of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    const inner = m[1] ?? '';
    if (inner.includes('--')) return false;
    if (inner.endsWith('-')) return false; // would make an illegal `--->`
  }
  return true;
};

const EVIDENCE: ProposalEvidence = {
  verdict: 'safe',
  sourceTreeHash: 'sha256:fixture',
  refreshedAt: '2026-05-27T14:33:08Z',
  reasons: ['no incoming dependency edges found'],
  disclosures: [
    'run `sfi refresh --with-reports` for a full uncapped pull',
    'read-->edit level changes are invisible',
  ],
};

const fileByPath = (
  files: readonly { path: string; contents: string }[],
  path: string,
): string => files.find((f) => f.path === path)?.contents ?? '';

describe('Finding #35 — buildDeleteProposal', () => {
  it('emits a populated destructiveChanges.xml (no <version>) + an empty package.xml (with <version>)', () => {
    const artifact = buildDeleteProposal(
      ['CustomField:Account.Legacy__c'],
      EVIDENCE,
    );
    expect(artifact.schemaVersion).toBe(PROPOSAL_SCHEMA_VERSION);
    expect(artifact.kind).toBe('destructive');
    expect(artifact.files.map((f) => f.path).sort()).toEqual([
      'destructiveChanges.xml',
      'package.xml',
    ]);

    const destructive = fileByPath(artifact.files, 'destructiveChanges.xml');
    const pkg = fileByPath(artifact.files, 'package.xml');

    // destructiveChanges lists the field under the deployable <name>, no <version>.
    expect(destructive).toContain('<members>Account.Legacy__c</members>');
    expect(destructive).toContain('<name>CustomField</name>');
    expect(destructive).not.toContain('<version>');

    // package.xml is empty of types but carries the version.
    expect(pkg).toContain('<version>62.0</version>');
    expect(pkg).not.toContain('<types>');

    expect(isWellFormed(destructive)).toBe(true);
    expect(isWellFormed(pkg)).toBe(true);
    expect(artifact.summary.componentCount).toBe(1);
    expect(artifact.summary.byType[0]).toMatchObject({
      type: 'CustomField',
      metadataName: 'CustomField',
      members: 1,
    });
  });

  it('carries the verdict + REVIEW banner + sourceTreeHash + component id in the evidence comment of every file', () => {
    const artifact = buildDeleteProposal(
      ['CustomField:Account.Legacy__c'],
      { ...EVIDENCE, verdict: 'blocking' },
    );
    for (const file of artifact.files) {
      expect(file.contents).toMatch(/<!--[\s\S]*sfi proposal[\s\S]*-->/);
      expect(file.contents).toContain('verdict: blocking');
      expect(file.contents).toMatch(/REVIEW BEFORE DEPLOY/i);
      expect(file.contents).toContain('sha256:fixture');
      expect(file.contents).toContain('CustomField:Account.Legacy__c');
      // The disclosures ride inline verbatim (post `--` sanitization).
      expect(file.contents).toMatch(/with-reports/);
      expect(commentsAreValid(file.contents)).toBe(true);
    }
    // The structured evidence mirrors what the comment carries.
    expect(artifact.evidence.verdict).toBe('blocking');
    expect(artifact.disclosure).toMatch(/LOCAL FILES ONLY|never deploys/i);
  });

  it('skips synthetic + malformed ids and escapes XML special characters in members', () => {
    const artifact = buildDeleteProposal(
      [
        'CustomField:Account.Weird & <Name>__c',
        'ConditionalContext:WorkflowRule:Account.R.cond-0', // synthetic → skip
        'NoColonId', // malformed → skip
      ],
      EVIDENCE,
    );
    const destructive = fileByPath(artifact.files, 'destructiveChanges.xml');
    expect(destructive).toContain(
      '<members>Account.Weird &amp; &lt;Name&gt;__c</members>',
    );
    expect(isWellFormed(destructive)).toBe(true);
    const skippedIds = artifact.skipped.map((s) => s.id);
    expect(skippedIds).toContain('NoColonId');
    expect(skippedIds.some((id) => id.startsWith('ConditionalContext:'))).toBe(
      true,
    );
    expect(artifact.summary.componentCount).toBe(1);
  });

  it('produces a well-formed (empty) destructiveChanges bundle for zero components', () => {
    const artifact = buildDeleteProposal([], {
      ...EVIDENCE,
      verdict: 'high-confidence-unused (0 field(s))',
    });
    const destructive = fileByPath(artifact.files, 'destructiveChanges.xml');
    expect(destructive).not.toContain('<types>');
    expect(isWellFormed(destructive)).toBe(true);
    expect(commentsAreValid(destructive)).toBe(true);
    expect(artifact.summary.componentCount).toBe(0);
  });
});

describe('Finding #35 — sanitizeXmlComment / renderEvidenceComment', () => {
  it('collapses runs of 2+ hyphens so a comment stays well-formed', () => {
    expect(sanitizeXmlComment('--with-reports')).not.toContain('--');
    expect(sanitizeXmlComment('a-->b')).not.toContain('--');
    expect(sanitizeXmlComment('single-hyphen')).toBe('single-hyphen'); // lone `-` preserved
  });

  it('renders a valid comment even when reasons/disclosures carry `--` and `-->`', () => {
    const comment = renderEvidenceComment('destructive', ['CustomField:X.Y__c'], {
      ...EVIDENCE,
      reasons: ['flag --no-reports skips the pull', 'arrow --> here'],
      disclosures: ['a really----long dash run'],
    });
    // Whole comment is a single well-formed comment with no interior `--`.
    const wrapped = `<root>${comment}</root>`;
    expect(commentsAreValid(wrapped)).toBe(true);
    expect(comment.startsWith('<!--')).toBe(true);
    expect(comment.endsWith('-->')).toBe(true);
  });
});

describe('Finding #35 — buildDeployProposal (non-destructive package.xml)', () => {
  it('emits a single package.xml naming the components under <version>, with an evidence comment', () => {
    const artifact = buildDeployProposal(
      ['Profile:SalesA', 'Profile:SalesB'],
      { ...EVIDENCE, verdict: 'review' },
    );
    expect(artifact.kind).toBe('deploy');
    expect(artifact.files.map((f) => f.path)).toEqual(['package.xml']);
    const pkg = fileByPath(artifact.files, 'package.xml');
    expect(pkg).toContain('<members>SalesA</members>');
    expect(pkg).toContain('<members>SalesB</members>');
    expect(pkg).toContain('<name>Profile</name>');
    expect(pkg).toContain('<version>62.0</version>');
    // The evidence comment sits between the prolog and the <Package> element.
    expect(pkg).toMatch(/<\?xml[^>]*\?>\n<!--[\s\S]*?-->\n<Package/);
    expect(pkg).toContain('verdict: review');
    expect(isWellFormed(pkg)).toBe(true);
    expect(commentsAreValid(pkg)).toBe(true);
    expect(artifact.summary.componentCount).toBe(2);
  });
});

describe('Finding #35 — proposal output conforms to docs/schemas/proposal.schema.json', () => {
  it('a delete proposal validates against the published JSON Schema', () => {
    const artifact = buildDeleteProposal(
      ['CustomField:Account.Legacy__c', 'ValidationRule:Account.R1'],
      EVIDENCE,
    );
    const errors: string[] = [];
    validateAgainstSchema(artifact, SCHEMA, SCHEMA, '$', errors);
    expect(errors).toEqual([]);
  });

  it('a deploy proposal validates against the published JSON Schema', () => {
    const artifact = buildDeployProposal(['Profile:SalesA', 'Profile:SalesB'], EVIDENCE);
    const errors: string[] = [];
    validateAgainstSchema(artifact, SCHEMA, SCHEMA, '$', errors);
    expect(errors).toEqual([]);
  });

  it('the validator actually rejects a malformed payload (not a no-op)', () => {
    const broken = { ...buildDeleteProposal([], EVIDENCE), summary: 'oops', extra: 1 };
    const errors: string[] = [];
    validateAgainstSchema(broken, SCHEMA, SCHEMA, '$', errors);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('Finding #35 — buildDestructiveChanges (low-level sibling of buildExportManifest)', () => {
  it('groups + sorts + de-dupes members per type, identical to the package.xml grouping', () => {
    const { xml, grouping } = buildDestructiveChanges([
      'CustomField:Account.B__c',
      'CustomField:Account.A__c',
      'CustomField:Account.A__c', // duplicate
      'ValidationRule:Account.R1',
    ]);
    expect(grouping.memberCount).toBe(3); // de-duped
    // Members sorted within a type: A before B.
    expect(xml.indexOf('Account.A__c')).toBeLessThan(xml.indexOf('Account.B__c'));
    expect(xml).toContain('<name>ValidationRule</name>');
    expect(isWellFormed(xml)).toBe(true);
  });
});
