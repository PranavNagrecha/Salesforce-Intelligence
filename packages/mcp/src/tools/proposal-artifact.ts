/**
 * Shared "proposal artifact" builder (Finding #35 — write-side proposal
 * artifacts v1).
 *
 * A verdict tool (safe_to_delete_field, unused_fields_deep, …) hands its
 * finding to a builder here and gets back a {@link ProposalArtifact}: a set of
 * LOCAL metadata-API files (`package.xml` and/or `destructiveChanges.xml`) plus
 * a self-justifying evidence trail. The host writes those strings to disk (or
 * prints them) and the human feeds them to their OWN deploy tool (Gearset /
 * Copado / `sf project deploy`).
 *
 * **Read-only posture is load-bearing.** Every function in this module is a
 * PURE STRING TRANSFORM. It never connects to an org, never shells to the `sf`
 * CLI, never touches the live plane, and never writes a file itself — the MCP
 * handler returns the artifact as string content and the host decides what to
 * do with it. The `docs/architecture.md` "No org write path — emits local
 * proposal artifacts only" row is literally true because of this constraint; a
 * posture-gate test (`proposal-posture.test.ts`) asserts this module's import
 * closure reaches no deploy / org-connect / live-plane seam. Do NOT add such an
 * import here.
 *
 * The precedent is the `ps-diff` / `vr-draft` embryos that already ship this
 * exact "propose a local artifact, never deploy" boundary under the same doc.
 * package.xml generation is reused verbatim from `export-manifest.ts`
 * (`groupComponentIds`); destructiveChanges.xml is its sibling here.
 */
import {
  buildExportManifest,
  escapeXml,
  groupComponentIds,
  type ExportManifestSkipped,
  type ExportManifestTypeBucket,
} from './export-manifest.js';

/** Current `ProposalArtifact` schema version — see `docs/schemas/proposal.schema.json`. */
export const PROPOSAL_SCHEMA_VERSION = '1.0';

/** Default metadata API version stamped into a generated (empty) package.xml. */
const SF_API_VERSION = '62.0';

/** XML namespace + prolog shared by every emitted Package document. */
const XML_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>';
const PACKAGE_OPEN = '<Package xmlns="http://soap.sforce.com/2006/04/metadata">';
const PACKAGE_CLOSE = '</Package>';

/**
 * The verbatim, always-present disclosure. It is BOTH a required schema field
 * and the lead line of every file's evidence comment (R2 — a wrong
 * destructiveChanges.xml deletes prod metadata if deployed blindly, so the
 * artifact leads with a REVIEW-before-deploy banner and the coverage caveat).
 */
export const PROPOSAL_DISCLOSURE =
  'sfi proposal artifacts are LOCAL FILES ONLY. sfi generates package.xml / ' +
  'destructiveChanges.xml for a human to REVIEW and feed to their OWN deploy ' +
  'tool (Gearset / Copado / `sf project deploy`); sfi never deploys, writes, ' +
  'or connects to the org. REVIEW BEFORE DEPLOY: the analysis is against your ' +
  'last vault refresh, not live prod — a destructiveChanges.xml permanently ' +
  'deletes metadata, so verify the verdict, evidence, and coverage caveat ' +
  'below against your org first.';

/** Which kind of change a proposal describes. */
export type ProposalKind = 'destructive' | 'deploy';

/** One local file the host writes (or prints). Never written by this module. */
export interface ProposalFile {
  /** Relative file name, e.g. `destructiveChanges.xml` / `package.xml`. */
  readonly path: string;
  /** The file's full text content, including the leading evidence comment. */
  readonly contents: string;
}

/**
 * The self-justifying evidence a verdict tool supplies. Rendered BOTH as the
 * structured `evidence` field on the artifact AND as a leading
 * `<!-- sfi proposal … -->` comment block inside every generated file.
 */
export interface ProposalEvidence {
  /** The tool's verdict/confidence for this proposal (e.g. `safe`, `blocking`, `high`). */
  readonly verdict: string;
  /** The vault's `sourceTreeHash` the analysis ran against. */
  readonly sourceTreeHash: string;
  /** The vault's `refreshedAt` timestamp. */
  readonly refreshedAt: string;
  /** Per-finding evidence lines, each ideally naming its confidence. */
  readonly reasons: readonly string[];
  /** The tool's `boundaries[]` / coverage-caveat text, carried VERBATIM. */
  readonly disclosures: readonly string[];
}

/** Per-type rollup of the components in the proposal. */
export type ProposalTypeBucket = ExportManifestTypeBucket;

/** Payload returned to a caller (and, once serialized, to the host). */
export interface ProposalArtifact {
  readonly schemaVersion: string;
  readonly kind: ProposalKind;
  /** One-line human summary of what the proposal does. */
  readonly headline: string;
  /** The local files to write; never written by sfi. */
  readonly files: readonly ProposalFile[];
  readonly summary: {
    readonly kind: ProposalKind;
    readonly componentCount: number;
    readonly byType: readonly ProposalTypeBucket[];
  };
  /** Ids dropped as malformed or synthetic/non-deployable, with the reason. */
  readonly skipped: readonly ExportManifestSkipped[];
  readonly evidence: ProposalEvidence;
  readonly disclosure: string;
}

/**
 * Make a string safe to place inside an XML comment. The XML spec forbids the
 * literal `--` (double-hyphen) anywhere in comment content and forbids a
 * comment ending in `-`; a run of 2+ hyphens (CLI flags like `--with-reports`,
 * arrows like `-->`, `read-->edit`) collapses to an em-dash so the comment stays
 * well-formed. A lone `-` is legal and preserved. Newlines separate content
 * lines from the `-->` terminator so a line-final `-` never abuts the close.
 */
export const sanitizeXmlComment = (s: string): string =>
  s.replace(/-{2,}/g, '—');

/**
 * Render the leading `<!-- sfi proposal … -->` evidence block. Leads with the
 * REVIEW-before-deploy banner + verdict so a human scanning the raw file sees
 * the honesty caveat first, then the components, evidence, and verbatim
 * disclosures. Every line is `--`-sanitized for XML well-formedness.
 */
export const renderEvidenceComment = (
  kind: ProposalKind,
  componentIds: readonly string[],
  evidence: ProposalEvidence,
): string => {
  const lines: string[] = [
    `sfi proposal — ${kind === 'destructive' ? 'DELETE' : 'DEPLOY'} (${componentIds.length} component(s))`,
    'REVIEW BEFORE DEPLOY: analysis is against your last vault refresh, NOT live prod. sfi never deploys or writes to the org.',
    `verdict: ${evidence.verdict}`,
    `vault sourceTreeHash: ${evidence.sourceTreeHash}`,
    `vault refreshedAt: ${evidence.refreshedAt}`,
    'components:',
    ...componentIds.map((id) => `  - ${id}`),
  ];
  if (evidence.reasons.length > 0) {
    lines.push('evidence:', ...evidence.reasons.map((r) => `  - ${r}`));
  }
  if (evidence.disclosures.length > 0) {
    lines.push('disclosures:', ...evidence.disclosures.map((d) => `  - ${d}`));
  }
  const body = lines.map((l) => sanitizeXmlComment(`  ${l}`)).join('\n');
  return `<!--\n${body}\n-->`;
};

/**
 * Emit the populated `destructiveChanges.xml` body for a set of component ids.
 * Sibling of `buildExportManifest`: same `groupComponentIds` grouping (de-dupe,
 * sort, NON_DEPLOYABLE_TYPES skip, metadata-name mapping, XML escaping) — the
 * only difference from a package.xml is that a destructiveChanges file carries
 * NO `<version>` (the accompanying package.xml holds the version, per the
 * Salesforce Metadata API convention). Pure: returns a string, deploys nothing.
 */
export const buildDestructiveChanges = (
  componentIds: readonly string[],
  comment?: string,
): { readonly xml: string; readonly grouping: ReturnType<typeof groupComponentIds> } => {
  const grouping = groupComponentIds(componentIds);
  const xml = [
    XML_PROLOG,
    ...(comment !== undefined ? [comment] : []),
    PACKAGE_OPEN,
    ...grouping.typesXml,
    PACKAGE_CLOSE,
    '',
  ].join('\n');
  return { xml, grouping };
};

/** Emit an empty `package.xml` (version only) that accompanies a delete bundle. */
const buildEmptyPackageXml = (apiVersion: string, comment?: string): string =>
  [
    XML_PROLOG,
    ...(comment !== undefined ? [comment] : []),
    PACKAGE_OPEN,
    `  <version>${escapeXml(apiVersion)}</version>`,
    PACKAGE_CLOSE,
    '',
  ].join('\n');

/**
 * Build a full DELETE proposal for a set of component ids: a populated
 * `destructiveChanges.xml` + an empty `package.xml`, each led by the shared
 * evidence comment. LOCAL FILES ONLY — the caller returns these strings; sfi
 * never deploys them.
 */
export const buildDeleteProposal = (
  componentIds: readonly string[],
  evidence: ProposalEvidence,
  options?: { readonly apiVersion?: string; readonly headline?: string },
): ProposalArtifact => {
  const apiVersion = options?.apiVersion ?? SF_API_VERSION;
  const comment = renderEvidenceComment('destructive', componentIds, evidence);
  const destructive = buildDestructiveChanges(componentIds, comment);
  const packageXml = buildEmptyPackageXml(apiVersion, comment);
  const headline =
    options?.headline ??
    `Proposes deletion of ${destructive.grouping.memberCount} component(s) via destructiveChanges.xml (verdict: ${evidence.verdict}).`;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: 'destructive',
    headline,
    files: [
      { path: 'destructiveChanges.xml', contents: destructive.xml },
      { path: 'package.xml', contents: packageXml },
    ],
    summary: {
      kind: 'destructive',
      componentCount: destructive.grouping.memberCount,
      byType: destructive.grouping.byType,
    },
    skipped: destructive.grouping.skipped,
    evidence,
    disclosure: PROPOSAL_DISCLOSURE,
  };
};

/**
 * Build a non-destructive DEPLOY proposal: a single `package.xml` listing the
 * component ids, led by the shared evidence comment. REUSES `buildExportManifest`
 * verbatim for the package.xml body, then splices the evidence comment in after
 * the XML prolog. LOCAL FILE ONLY — the caller returns the string; sfi never
 * deploys it. Used for a "pull these components to hand-edit / hand-merge"
 * proposal (e.g. the two profiles of a merge).
 */
export const buildDeployProposal = (
  componentIds: readonly string[],
  evidence: ProposalEvidence,
  options?: { readonly apiVersion?: string; readonly headline?: string },
): ProposalArtifact => {
  const apiVersion = options?.apiVersion ?? SF_API_VERSION;
  const manifest = buildExportManifest(componentIds, apiVersion);
  const comment = renderEvidenceComment('deploy', componentIds, evidence);
  const packageXml = manifest.packageXml.replace(
    `${XML_PROLOG}\n`,
    `${XML_PROLOG}\n${comment}\n`,
  );
  const headline =
    options?.headline ??
    `Proposes a package.xml deploy of ${manifest.summary.memberCount} component(s) (verdict: ${evidence.verdict}).`;
  return {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    kind: 'deploy',
    headline,
    files: [{ path: 'package.xml', contents: packageXml }],
    summary: {
      kind: 'deploy',
      componentCount: manifest.summary.memberCount,
      byType: manifest.summary.byType,
    },
    skipped: manifest.skipped,
    evidence,
    disclosure: PROPOSAL_DISCLOSURE,
  };
};
