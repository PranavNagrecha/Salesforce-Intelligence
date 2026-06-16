/**
 * Value-change risk model + disclosure engine for the Data Steward /
 * Identity & Integration persona.
 *
 * Composes the Phase-1 field classifiers (`value-change-classification.ts`)
 * with the field's incoming graph edges to assess what breaks if the stored
 * VALUE changes. The blast radius is organized into buckets (the value-change
 * analogue of `what_if_change_field_type`'s reference walk):
 *
 *   - A `identity`        — login / SSO / federation subject (catalog).
 *   - B `integration-key` — externalId / idLookup upsert key (sync breaks).
 *   - C `uniqueness`      — unique field (colliding value fails to save).
 *   - D `automation`      — Validation/Flow/Workflow/Apex reference the field;
 *                           a value change MAY alter behavior. Whether it
 *                           actually does depends on value-literal coupling
 *                           (does the automation compare to a specific value?),
 *                           which is captured in a later phase — so this bucket
 *                           is honestly "candidate" until then.
 *   - E `save-pipeline`   — updating fires triggers/flows/rules on the object.
 *   - F `display`         — Alias / CommunityNickname / layout placement.
 *
 * Bucket G (the honesty surface — what the vault CAN'T see: external upsert
 * systems, the IdP side of SSO, dynamic Apex, managed-package internals) is
 * emitted as `disclosures`, not a bucket.
 *
 * **Why a separate model from the reference walk.** A value change can be
 * catastrophic on a field with zero references (a SAML federation key). So
 * buckets A/B/C/F come from the field's own role, NOT the reference graph;
 * the graph only adds D/F detail. The pure bucket assembly (`buildBuckets`)
 * is unit-tested without a graph; `assessValueChange` adds the I/O.
 */

import type {
  ComponentType,
  McpError,
  Node,
} from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById, listEdges, listNodesByType } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

import {
  classifyField,
  lookupIdentityCatalog,
  maxSeverity,
  parseFieldId,
  type Confidence,
  type FieldClassification,
  type Severity,
} from './value-change-classification.js';

export type Bucket =
  | 'identity'
  | 'integration-key'
  | 'uniqueness'
  | 'automation'
  | 'save-pipeline'
  | 'display'
  | 'cross-object';

export interface BucketHit {
  readonly bucket: Bucket;
  readonly severity: Severity;
  readonly confidence: Confidence;
  readonly summary: string;
  /** Component ids / flags that fired this bucket. */
  readonly evidence: readonly string[];
}

export interface ValueChangeAssessment {
  readonly fieldId: string;
  readonly object: string;
  readonly field: string;
  readonly mutable: boolean;
  readonly overallSeverity: Severity;
  readonly buckets: readonly BucketHit[];
  readonly disclosures: readonly string[];
  readonly recommendedChecks: readonly string[];
}

/**
 * Category buckets for incoming-edge source node types. Mirrors the
 * categorisation `what_if_change_field_type` uses, re-grouped for the
 * value-change lens.
 */
const SOURCE_CATEGORY: Partial<Record<ComponentType, 'automation' | 'code' | 'integration' | 'display'>> = {
  ValidationRule: 'automation',
  WorkflowRule: 'automation',
  Flow: 'automation',
  ApprovalProcess: 'automation',
  AssignmentRule: 'automation',
  EscalationRule: 'automation',
  AutoResponseRule: 'automation',
  DuplicateRule: 'automation',
  CustomField: 'automation', // a formula field referencing this one
  ApexClass: 'code',
  ApexTrigger: 'code',
  LightningComponentBundle: 'code',
  AuraDefinitionBundle: 'code',
  VisualforcePage: 'code',
  VisualforceComponent: 'code',
  ExternalService: 'integration',
  ExternalDataSource: 'integration',
  NamedCredential: 'integration',
  Layout: 'display',
  QuickAction: 'display',
  FlexiPage: 'display',
  ListView: 'display',
};

export interface EdgeSummary {
  readonly automation: readonly string[];
  readonly code: readonly string[];
  readonly integration: readonly string[];
  readonly display: readonly string[];
}

const EMPTY_EDGE_SUMMARY: EdgeSummary = {
  automation: [],
  code: [],
  integration: [],
  display: [],
};

// ---------------------------------------------------------------------------
// Pure bucket assembly (unit-tested without a graph)
// ---------------------------------------------------------------------------

/**
 * Assemble the impact buckets from a field's classification + an edge
 * summary. Pure and deterministic. Derived (non-mutable) fields short-circuit
 * to a single explanatory note — you cannot change their value directly.
 */
export const buildBuckets = (
  classification: FieldClassification,
  edges: EdgeSummary,
): readonly BucketHit[] => {
  const { object, field, mutability, upsertKey } = classification;

  if (mutability.mutability === 'derived') {
    return [
      {
        bucket: 'save-pipeline',
        severity: 'info',
        confidence: 'confirmed',
        summary: `Not directly changeable — ${mutability.reason}`,
        evidence: [],
      },
    ];
  }

  const buckets: BucketHit[] = [];

  // A — identity.
  const identity = lookupIdentityCatalog(object, field);
  if (identity !== null) {
    buckets.push({
      bucket: 'identity',
      severity: identity.severity,
      confidence: upsertKey.isUpsertKey ? 'confirmed' : 'likely',
      summary: `${identity.role} — changing the value alters how this record is identified/authenticated.`,
      evidence: ['standard-identity-field catalog'],
    });
  }

  // B — integration / upsert key. An External ID is a DESIGNED key (high);
  // a standard idLookup field is merely upsert-CAPABLE (medium).
  const keySignals = upsertKey.signals.filter((s) => s === 'externalId' || s === 'idLookup');
  if (keySignals.length > 0) {
    const designedKey = keySignals.includes('externalId');
    buckets.push({
      bucket: 'integration-key',
      severity: designedKey ? 'high' : 'medium',
      confidence: 'confirmed',
      summary: designedKey
        ? 'Upsert / integration match key (External ID) — changing the value breaks inbound matching (next sync no-matches → duplicate or error) and desyncs external systems keyed on the old value.'
        : 'Upsert-capable key (idLookup) — an integration may upsert records by this field; changing the value could break that matching.',
      evidence: [...keySignals.map((s) => `${s}=true`), ...edges.integration],
    });
  }

  // C — uniqueness (a colliding new value fails to save).
  if (upsertKey.signals.includes('unique')) {
    buckets.push({
      bucket: 'uniqueness',
      severity: 'medium',
      confidence: 'confirmed',
      summary: 'Unique field — a new value that collides with an existing record fails to save (DML error).',
      evidence: ['unique=true'],
    });
  }

  // D — value-coupled automation (candidate until value-literal coupling lands).
  const automationRefs = [...edges.automation, ...edges.code];
  if (automationRefs.length > 0) {
    buckets.push({
      bucket: 'automation',
      severity: edges.automation.length > 0 ? 'medium' : 'low',
      confidence: 'likely',
      summary:
        `${automationRefs.length} automation/code component(s) reference this field; a value change may alter routing, validation, or sharing. Declarative value-couplings (where a rule compares this field to a literal) are surfaced when found; Apex literal comparisons remain invisible.`,
      evidence: automationRefs.slice(0, 12),
    });
  }

  // F — display surfaces.
  const isDisplayIdentity = identity !== null && /display|nickname|alias/i.test(identity.role);
  if (edges.display.length > 0 || isDisplayIdentity) {
    buckets.push({
      bucket: 'display',
      severity: 'low',
      confidence: 'likely',
      summary: 'Appears on display surfaces (layouts / list views / UI); a value change is user-visible.',
      evidence: edges.display.slice(0, 8),
    });
  }

  // E — save-pipeline side effect (always true for a writable field; info-level
  // so it never inflates the headline, but flagged because bulk updates fire
  // the whole pipeline at scale).
  buckets.push({
    bucket: 'save-pipeline',
    severity: 'info',
    confidence: 'likely',
    summary: `Updating this field fires the save pipeline on ${object} (triggers / flows / rules) — relevant for bulk value changes.`,
    evidence: [],
  });

  return buckets;
};

/**
 * Generate the honesty-surface disclosures (bucket G) for the buckets that
 * fired. These name what the vault CANNOT see, so the caller never implies
 * certainty an offline metadata snapshot can't support.
 */
export const buildDisclosures = (buckets: readonly BucketHit[]): readonly string[] => {
  const out: string[] = [];
  const has = (b: Bucket): boolean => buckets.some((x) => x.bucket === b);

  if (has('integration-key')) {
    out.push(
      'The metadata declares this an upsert key, but NOT which external system upserts on it — confirm the key in your middleware / ETL (Data Loader, MuleSoft, etc.) before bulk-changing values.',
    );
  }
  if (has('identity')) {
    out.push(
      'If SSO maps users by this field, changing its value breaks login until the IdP is updated — verify with your IdP / My Domain SSO.',
    );
  }
  if (has('automation')) {
    out.push(
      'Dynamic SOQL, reflective Apex field access, and managed-package code that compare this field to a value are invisible to the scanner — the listed automations are the visible subset.',
    );
  }
  if (has('cross-object')) {
    out.push('This key is replicated by name on other objects with no formal relationship — update the copies together, or they will silently desync.');
  }
  out.push('Reports, list-view filters, and manual processes may also key on this value.');
  return out;
};

const recommendedChecksFor = (buckets: readonly BucketHit[]): readonly string[] => {
  const checks: string[] = [];
  const has = (b: Bucket): boolean => buckets.some((x) => x.bucket === b);
  if (has('integration-key')) checks.push('Confirm the external upsert key + whether the external system will re-match or duplicate on the new value.');
  if (has('uniqueness')) checks.push('Confirm the new value does not collide with an existing record (unique constraint).');
  if (has('identity')) checks.push('Confirm SSO/login impact with your IdP before changing identity values.');
  if (has('automation')) checks.push('Review the referencing automations for value-literal comparisons that the change would flip.');
  if (has('cross-object')) checks.push('Update the same-named copies on the other objects together — they are value-joined with no formal relationship.');
  checks.push('For bulk changes, stage in a sandbox and watch the save pipeline (row locks, governor limits).');
  return checks;
};

const overallSeverityOf = (buckets: readonly BucketHit[]): Severity =>
  buckets.reduce<Severity>((acc, b) => maxSeverity(acc, b.severity), 'info');

// ---------------------------------------------------------------------------
// Graph-backed assessment
// ---------------------------------------------------------------------------

/**
 * Walk a field's incoming edges and summarise the source node types into the
 * automation / code / integration / display categories the bucket model uses.
 * Skips the structural `parentOf` edge.
 */
export const summarizeIncomingEdges = async (
  ctx: Context,
  fieldId: string,
): Promise<Result<EdgeSummary, McpError>> => {
  const edgesResult = await listEdges(ctx.graph, fieldId as Node['id'], { direction: 'in' });
  if (!edgesResult.ok) {
    return err({ kind: 'internal', message: `graph query failed: ${edgesResult.error.message}` });
  }
  const automation: string[] = [];
  const code: string[] = [];
  const integration: string[] = [];
  const display: string[] = [];
  for (const edge of edgesResult.value) {
    if (edge.edgeType === 'parentOf') continue;
    const fromResult = await getNodeById(ctx.graph, edge.fromId);
    if (!fromResult.ok) {
      return err({ kind: 'internal', message: `graph query failed: ${fromResult.error.message}` });
    }
    const fromNode = fromResult.value;
    if (fromNode === null) continue;
    const category = SOURCE_CATEGORY[fromNode.type];
    if (category === 'automation') automation.push(fromNode.id);
    else if (category === 'code') code.push(fromNode.id);
    else if (category === 'integration') integration.push(fromNode.id);
    else if (category === 'display') display.push(fromNode.id);
  }
  const dedupe = (xs: string[]): string[] => [...new Set(xs)].sort();
  return ok({
    automation: dedupe(automation),
    code: dedupe(code),
    integration: dedupe(integration),
    display: dedupe(display),
  });
};

/**
 * Gate the FederationIdentifier identity bucket on the org's ACTUAL SSO
 * configuration — BOTH protocols, which differ fundamentally:
 *   - SAML: `SamlSsoConfig.identityMapping` is DECLARATIVE, so the verdict is
 *     confirmable — `FederationId` -> critical, `Username`/`UserId` -> low.
 *   - OIDC / social: the user↔identity mapping lives in the AuthProvider's
 *     Apex registration handler (+ runtime ThirdPartyAccountLink), NOT in
 *     metadata — so it can't be confirmed, only disclosed. A login-capable
 *     AuthProvider (a `registrationHandler`, or `providerType` OpenIdConnect)
 *     means FederationIdentifier MAY be the match key -> medium + disclosure.
 *     Pure data connectors (Segment / Web Data Connector / Ads) have a null
 *     handler and are correctly excluded.
 * Precedence: a confirmed SAML FederationId mapping (critical) wins; else an
 * OIDC login provider raises it to medium; else it is low.
 */
const gateFederationIdentifier = async (
  ctx: Context,
  buckets: readonly BucketHit[],
  codeRefs: readonly string[],
): Promise<Result<{ readonly buckets: BucketHit[]; readonly disclosure?: string }, McpError>> => {
  const samlRes = await listNodesByType(ctx.graph, 'SamlSsoConfig', { limit: 200 });
  if (!samlRes.ok) return err({ kind: 'internal', message: `graph query failed: ${samlRes.error.message}` });
  const apRes = await listNodesByType(ctx.graph, 'AuthProvider', { limit: 200 });
  if (!apRes.ok) return err({ kind: 'internal', message: `graph query failed: ${apRes.error.message}` });

  const configs = samlRes.value;
  const mappings = configs.map((n) => String(n.properties['identityMapping'] ?? 'Username'));
  const fedConfigs = configs.filter((n) => n.properties['identityMapping'] === 'FederationId');
  const oidcLogin = apRes.value.filter((ap) => {
    const rh = ap.properties['registrationHandler'];
    return (typeof rh === 'string' && rh.length > 0) || ap.properties['providerType'] === 'OpenIdConnect';
  });
  const others = buckets.filter((b) => b.bucket !== 'identity');

  let identity: BucketHit;
  let disclosure: string | undefined;
  if (fedConfigs.length > 0) {
    identity = {
      bucket: 'identity', severity: 'critical', confidence: 'confirmed',
      summary: `SAML SSO maps users by Federation ID (${fedConfigs.length} SamlSsoConfig) — changing this value breaks SSO login until the IdP is updated.`,
      evidence: fedConfigs.map((c) => c.id),
    };
  } else if (oidcLogin.length > 0) {
    const handlers = [...new Set(oidcLogin.map((a) => a.properties['registrationHandler']).filter((s): s is string => typeof s === 'string' && s.length > 0))];
    // Look at the handler Apex: is any handler among the ApexClasses that
    // reference FederationIdentifier (per the heuristic scanner edges)? If so,
    // the handler IS part of the OIDC identity mapping.
    const handlersRefFed = handlers.filter((h) => codeRefs.includes(`ApexClass:${h}`));
    if (handlersRefFed.length > 0) {
      identity = {
        bucket: 'identity', severity: 'medium', confidence: 'likely',
        summary: `OIDC / social SSO registration handler(s) ${handlersRefFed.join(', ')} reference FederationIdentifier (heuristic Apex scan) — it is part of the OIDC identity mapping; changing the value may break login.`,
        evidence: [...oidcLogin.map((a) => a.id), ...handlersRefFed.map((h) => `ApexClass:${h}`)],
      };
      disclosure = 'The handler-to-FederationIdentifier link is from the heuristic Apex scanner (token-level); cross-method dataflow, dynamic SOQL, and reflective field access are invisible — confirm in the handler source + ThirdPartyAccountLink.';
    } else {
      identity = {
        bucket: 'identity', severity: 'medium', confidence: 'likely',
        summary: `OIDC / social SSO login provider(s) present (${oidcLogin.map((a) => a.apiName).slice(0, 3).join(', ')}); the mapping is in an Apex registration handler — the heuristic scan found no FederationIdentifier reference there, but it may map it dynamically.`,
        evidence: oidcLogin.map((a) => a.id),
      };
      disclosure = `OIDC/social SSO maps identity in an Apex registration handler${handlers.length > 0 ? ` (${handlers.slice(0, 2).join(', ')})` : ''}; the scan saw no FederationIdentifier reference, but dynamic / reflective field access is invisible — verify the handler + ThirdPartyAccountLink before changing values.`;
    }
  } else if (configs.length > 0) {
    identity = {
      bucket: 'identity', severity: 'low', confidence: 'confirmed',
      summary: `SAML SSO maps by ${[...new Set(mappings)].join('/')}, not Federation ID, and no OIDC login provider is present — this field is not the SSO subject here.`,
      evidence: configs.map((c) => c.id),
    };
  } else {
    identity = {
      bucket: 'identity', severity: 'low', confidence: 'likely',
      summary: 'No SAML SSO config and no OIDC/social login provider in the vault — Federation ID is not in use for SSO here.',
      evidence: [],
    };
    disclosure = 'No SamlSsoConfig or login-capable AuthProvider in the vault: if SSO is configured outside retrievable metadata, changing FederationIdentifier could still affect login — verify with your IdP.';
  }
  return ok({ buckets: [identity, ...others], ...(disclosure !== undefined ? { disclosure } : {}) });
};

/**
 * Detect a cross-object "shadow join": a key field replicated by NAME on
 * other objects with no formal relationship, so the copies are value-joined
 * and a value change on one side silently desyncs the others (no
 * relationship-graph tool sees this). Fires only when the name is an External
 * ID on at least one object — a merely common field name (`Status__c` on many
 * objects) is NOT a shadow join. A cheap name pre-filter avoids the full scan
 * for non-key fields.
 */
const detectShadowJoin = async (
  ctx: Context,
  classification: FieldClassification,
): Promise<Result<BucketHit | null, McpError>> => {
  const { object, field, upsertKey } = classification;
  const keyish = upsertKey.isUpsertKey || /(_ID|_SIS_ID|Key|_uuid|_guid|Code)__c$/i.test(field);
  if (!keyish) return ok(null);

  const all: Node[] = [];
  let offset = 0;
  for (;;) {
    const res = await listNodesByType(ctx.graph, 'CustomField', { limit: 500, offset });
    if (!res.ok) return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    all.push(...res.value);
    if (res.value.length < 500) break;
    offset += 500;
  }
  const objOf = (n: Node): string => parseFieldId(n.id)?.object ?? '?';
  const sameName = all.filter((n) => parseFieldId(n.id)?.field === field);
  if (sameName.length <= 1) return ok(null);
  const masters = sameName.filter((n) => n.properties['externalId'] === true);
  if (masters.length === 0) return ok(null); // common name, not a keyed shadow join
  const otherObjects = sameName.filter((n) => objOf(n) !== object);
  if (otherObjects.length === 0) return ok(null);

  const masterObjs = [...new Set(masters.map(objOf))].sort();
  const copyObjs = [...new Set(sameName.filter((n) => n.properties['externalId'] !== true).map(objOf))].sort();
  const thisIsMaster = upsertKey.signals.includes('externalId');
  return ok({
    bucket: 'cross-object',
    severity: thisIsMaster ? 'high' : 'medium',
    confidence: 'likely',
    summary: `'${field}' is replicated on ${sameName.length} objects — External-ID key on [${masterObjs.join(', ')}]${copyObjs.length > 0 ? `, plain copy on [${copyObjs.join(', ')}]` : ''}. These are value-joined with no formal relationship; changing the value here can silently desync the copies.`,
    evidence: sameName.map((n) => n.id).sort(),
  });
};

/** Pull quoted literals (`"X"` / `'X'`) out of a condition expression. */
const extractQuotedLiterals = (expr: string): string[] => {
  const out: string[] = [];
  const re = /["']([^"']{1,40})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) out.push(m[1]!);
  return out;
};

const normalizeExpr = (expr: unknown): string =>
  typeof expr === 'string' ? expr.replace(/\s+/g, ' ').trim().slice(0, 120) : '';

/**
 * Find the declarative value-literal couplings for a field: ConditionalContext
 * nodes (validation rules, approval / workflow criteria, flow conditions)
 * whose condition references this field. Their `expression` carries the value
 * the field is compared to — so "this field is referenced" becomes "this field
 * is compared to 'Required'". Matches by canonical `fieldRefs` (populated for
 * criteria/formula kinds) OR the field name in the expression (the flow kinds,
 * where fieldRefs is empty). Apex literal comparisons are NOT here — the
 * heuristic scanner can't see them (disclosed separately).
 */
const findValueCouplings = async (
  ctx: Context,
  fieldId: string,
): Promise<Result<{ readonly expressions: string[]; readonly literals: string[] }, McpError>> => {
  const leaf = parseFieldId(fieldId)?.field ?? fieldId;
  const re = new RegExp(`\\b${leaf}\\b`);
  const matched: Node[] = [];
  let offset = 0;
  for (;;) {
    const res = await listNodesByType(ctx.graph, 'ConditionalContext', { limit: 500, offset });
    if (!res.ok) return err({ kind: 'internal', message: `graph query failed: ${res.error.message}` });
    for (const n of res.value) {
      const refs = Array.isArray(n.properties['fieldRefs']) ? (n.properties['fieldRefs'] as unknown[]) : [];
      const expr = n.properties['expression'];
      if (refs.includes(fieldId) || (typeof expr === 'string' && re.test(expr))) matched.push(n);
    }
    if (res.value.length < 500) break;
    offset += 500;
  }
  const expressions = [...new Set(matched.map((n) => normalizeExpr(n.properties['expression'])).filter((s) => s.length > 0))].slice(0, 8);
  const literals = [...new Set(matched.flatMap((n) => extractQuotedLiterals(String(n.properties['expression'] ?? ''))))].slice(0, 12);
  return ok({ expressions, literals });
};

/**
 * Full value-change assessment for one field node: classify it, walk its
 * incoming edges, assemble buckets, disclosures, recommended checks, and an
 * overall severity. The single composition both value-change tools call.
 */
export const assessValueChange = async (
  ctx: Context,
  node: Node,
): Promise<Result<ValueChangeAssessment, McpError>> => {
  const classification = classifyField(node);
  const mutable = classification.mutability.mutability === 'writable';

  // Derived fields don't need the edge walk for the value-change verdict.
  const edgesResult = mutable
    ? await summarizeIncomingEdges(ctx, node.id)
    : ok(EMPTY_EDGE_SUMMARY);
  if (!edgesResult.ok) return err(edgesResult.error);

  let buckets = buildBuckets(classification, edgesResult.value);
  const extraDisclosures: string[] = [];
  if (mutable && classification.field === 'FederationIdentifier') {
    const gated = await gateFederationIdentifier(ctx, buckets, edgesResult.value.code);
    if (!gated.ok) return err(gated.error);
    buckets = gated.value.buckets;
    if (gated.value.disclosure !== undefined) extraDisclosures.push(gated.value.disclosure);
  }
  if (mutable) {
    const shadow = await detectShadowJoin(ctx, classification);
    if (!shadow.ok) return err(shadow.error);
    if (shadow.value !== null) buckets = [...buckets, shadow.value];
  }
  // Declarative value-literal couplings: a ConditionalContext that compares
  // this field to a literal IS automation evidence — create the automation
  // bucket if a direct firer edge didn't already, else upgrade it in place.
  if (mutable) {
    const cp = await findValueCouplings(ctx, node.id);
    if (!cp.ok) return err(cp.error);
    if (cp.value.expressions.length > 0) {
      const existing = buckets.find((b) => b.bucket === 'automation');
      const enriched: BucketHit = {
        bucket: 'automation',
        severity: existing?.severity ?? 'medium',
        confidence: 'confirmed',
        summary: `Value-coupled in ${cp.value.expressions.length} declarative condition(s)${cp.value.literals.length > 0 ? ` (literals: ${cp.value.literals.slice(0, 6).join(', ')})` : ''} — changing the value may flip them. e.g. ${cp.value.expressions.slice(0, 3).join(' | ')}`,
        evidence: [...(existing?.evidence ?? []), ...cp.value.expressions.slice(0, 6)],
      };
      buckets = [...buckets.filter((b) => b.bucket !== 'automation'), enriched];
    }
  }
  return ok({
    fieldId: node.id,
    object: classification.object,
    field: classification.field,
    mutable,
    overallSeverity: overallSeverityOf(buckets),
    buckets,
    disclosures: mutable ? [...buildDisclosures(buckets), ...extraDisclosures] : [],
    recommendedChecks: mutable ? recommendedChecksFor(buckets) : ['Change the source field(s) instead — this value is derived.'],
  });
};
