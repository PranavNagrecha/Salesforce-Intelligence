/**
 * Answer-rendering layer — turns the densest structured tool outputs into
 * pass-through-ready Markdown, so the client can show a clean, consistent
 * answer instead of reformatting raw JSON arrays each time. Tools attach this
 * as an additive `rendered` field alongside their structured `data`; the JSON
 * remains the source of truth (a caller that wants the data still has it).
 *
 * Pure + deterministic. Scope is the high-traffic aggregate answers (resolve,
 * org_overview) and the live answers (count, field population, inactive users,
 * route), where stamping provenance + freshness on every claim is the whole
 * point. The generic helpers (`mdTable`, `renderTrustFooter`) are reusable if
 * more tools opt in later. Deliberately NOT applied to every tool — most answers
 * are small enough that the host renders them fine, and server-side prose for
 * all 120+ tools would be redundant bloat.
 */

import type { NextAction } from './clarify.js';
import type { AutomationSummary } from './tools/org-overview.js';
import { percent } from './tools/summarize-rows.js';

/** Escape a Markdown table cell (pipes + newlines would break the table). */
const cell = (v: unknown): string =>
  String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

// --- provenance footer -----------------------------------------------------

interface TrustLike {
  readonly provenance: 'offline_snapshot' | 'live_org' | 'hybrid';
  readonly freshness: {
    readonly snapshotRefreshedAt?: string | undefined;
    readonly liveQueriedAt?: string | undefined;
  };
}

/**
 * A one-line provenance + freshness stamp for an answer. This is the trust
 * discipline made visible: a live count says it is live and when it was queried;
 * a vault answer says it is a snapshot and when it was refreshed. Never claims a
 * plane it did not use.
 */
export const renderTrustFooter = (trust: TrustLike): string => {
  const live = trust.freshness.liveQueriedAt;
  const snap = trust.freshness.snapshotRefreshedAt;
  if (trust.provenance === 'live_org') {
    return `_Live org${live ? ` · queried ${live}` : ''} · read-only._`;
  }
  if (trust.provenance === 'hybrid') {
    const parts = [
      live ? `live queried ${live}` : 'live',
      snap ? `snapshot refreshed ${snap}` : 'snapshot',
    ];
    return `_Hybrid · ${parts.join(' + ')}._`;
  }
  return `_Offline snapshot${snap ? ` · refreshed ${snap}` : ''}._`;
};

/** A GitHub-flavored Markdown table from headers + string rows. Empty → ''. */
export const mdTable = (
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string => {
  if (rows.length === 0) return '';
  const head = `| ${headers.map(cell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows
    .map((r) => `| ${headers.map((_, i) => cell(r[i])).join(' | ')} |`)
    .join('\n');
  return `${head}\n${sep}\n${body}`;
};

// --- interpret (reasoning engine) ------------------------------------------

/** One interpretation row to render (structurally a `contracts.Interpretation`). */
interface InterpretationLike {
  readonly ruleId: string;
  readonly concept: string;
  readonly claim: string;
  readonly groundedIn: readonly string[];
  readonly confidence: 'declared' | 'parsed' | 'heuristic' | 'unknown';
  readonly coverageCaveat: string | null;
  /** CITED-REMEDIATION — the authored fix, present only when the rule carried one. */
  readonly remediation?: {
    readonly steps: readonly string[];
    readonly confidence: 'declared' | 'parsed' | 'heuristic' | 'unknown';
    readonly whatIfTool?: string;
  };
}

/** The `sfi.interpret` payload the renderer needs (a subset of `InterpretOutput`). */
interface InterpretationsRenderLike {
  readonly componentId: string;
  readonly componentType: string;
  readonly interpretations: readonly InterpretationLike[];
  readonly sliceTruncated: boolean;
  readonly coverageCaveat?: string;
  readonly trust: TrustLike;
  /** The page window, when the claims were paged (`sfi.interpret`). */
  readonly page?: { readonly offset: number; readonly returned: number; readonly total: number };
}

/** One line naming the page window, or '' when the page is the whole list. */
const interpretPageLine = (page: InterpretationsRenderLike['page']): string => {
  if (page === undefined || (page.offset === 0 && page.returned >= page.total)) return '';
  if (page.returned === 0) {
    return `_No claims on this page: offset ${page.offset} is past the last of ${page.total} claim(s) that fired — pass a smaller offset._`;
  }
  const next = page.offset + page.returned;
  return (
    `_Showing claims ${page.offset + 1}-${next} of ${page.total}` +
    (next < page.total ? `; pass offset: ${next} for more._` : '._')
  );
};

/**
 * Render the reasoning engine's grounded interpretations: one bullet per fired
 * concept rule (claim + confidence badge + cited component ids), closing with
 * the provenance footer. HONESTY: an EMPTY interpretation list renders the
 * verbatim "no rule fired — NOT a claim that nothing depends on it" message, so
 * an absence of matched rules is never read as an absence of dependencies.
 */
export const renderInterpretationsMarkdown = (
  data: InterpretationsRenderLike,
): string => {
  const header = `## Interpretations for \`${data.componentId}\` (${data.componentType})`;
  const pageLine = interpretPageLine(data.page);
  if (data.interpretations.length === 0 && pageLine !== '') {
    return `${header}\n\n${pageLine}\n\n${renderTrustFooter(data.trust)}`;
  }
  if (data.interpretations.length === 0) {
    return (
      `${header}\n\n` +
      `No concept rule fired for this component. This is **NOT** a claim that nothing ` +
      `depends on it — only that no curated reasoning rule matched the deterministic, ` +
      `offline graph slice assembled for it.\n\n` +
      renderTrustFooter(data.trust)
    );
  }
  const items = data.interpretations.map((i) => {
    const cited =
      i.groundedIn.length > 0
        ? `\n  Grounded in: ${i.groundedIn.map((id) => `\`${id}\``).join(', ')}`
        : '';
    const caveat = i.coverageCaveat ? `\n  Coverage caveat: ${i.coverageCaveat}` : '';
    // CITED-REMEDIATION — the authored, dependency-ordered fix steps (cited by the
    // same grounded ids, at the claim's confidence). Empty when the rule authored
    // none, so a rule WITHOUT remediation renders byte-identically. Framed as fix
    // STEPS, never a closure of the finding.
    const remediation =
      i.remediation !== undefined && i.remediation.steps.length > 0
        ? `\n  Remediation _(cited, ${i.remediation.confidence}; dependency-ordered fix steps — the engine does NOT re-verify the finding after them)_:` +
          i.remediation.steps.map((step, n) => `\n    ${n + 1}. ${step}`).join('') +
          (i.remediation.whatIfTool !== undefined
            ? `\n    Model the change with \`${i.remediation.whatIfTool}\` (models the counterfactual; does not itself close this finding).`
            : '')
        : '';
    return `- **${i.claim}** _(${i.confidence} · \`${i.ruleId}\`)_${cited}${caveat}${remediation}`;
  });
  const caveatLine = data.coverageCaveat
    ? `\n\n_Coverage: ${data.coverageCaveat}_`
    : '';
  const truncation = data.sliceTruncated
    ? `\n\n_Graph slice truncated at the hub cap — absence-based conclusions held to at most partial coverage._`
    : '';
  return (
    `${header}\n\n${pageLine !== '' ? `${pageLine}\n\n` : ''}${items.join('\n')}${caveatLine}${truncation}\n\n` +
    renderTrustFooter(data.trust)
  );
};

// --- resolve ---------------------------------------------------------------

interface ResolveCandidateLike {
  readonly apiName: string;
  readonly parentApiName: string | null;
  readonly type: string;
  readonly score: number;
  readonly evidence: string;
}
interface ResolveLike {
  readonly disposition: 'exact' | 'ambiguous' | 'none';
  readonly candidates: readonly ResolveCandidateLike[];
  readonly clarification: { readonly question: string } | null;
  /** Suggests `sfi refresh` only when a `refresh` action is on offer (never on the demo vault). */
  readonly nextActions?: readonly NextAction[];
}

/** Render a resolve result: a verdict line + (when ambiguous) a candidate table. */
export const renderResolveMarkdown = (data: ResolveLike): string => {
  const { disposition, candidates } = data;
  if (disposition === 'none' || candidates.length === 0) {
    const refresh = data.nextActions?.some((a) => a.action === 'refresh') === true;
    return `No confident match. Try the exact API name or add the object name${refresh ? ', or run `sfi refresh` if it may be new' : ''}.`;
  }
  const where = (c: ResolveCandidateLike): string =>
    c.parentApiName !== null ? `${c.apiName} on ${c.parentApiName}` : c.apiName;
  if (disposition === 'exact') {
    const top = candidates[0]!;
    return `Resolved to **${where(top)}** (${top.type}).`;
  }
  // ambiguous
  const table = mdTable(
    ['#', 'Component', 'Type', 'Score', 'Why'],
    candidates.map((c, i) => [i + 1, where(c), c.type, c.score.toFixed(2), c.evidence]),
  );
  const q = data.clarification?.question ?? `Several matches — which did you mean?`;
  return `${q}\n\n${table}`;
};

// --- org_overview ----------------------------------------------------------

interface NamedCount {
  readonly apiName: string;
}
interface OrgOverviewLike {
  readonly componentCounts: Readonly<Record<string, number>>;
  readonly topObjects: readonly (NamedCount & { readonly inboundReferences: number })[];
  readonly automationSummary: AutomationSummary;
  readonly integrationSummary: { readonly total: number };
  readonly coverage?: {
    readonly integrationRetrieved: boolean;
    readonly workflowRulesRetrieved: boolean;
    readonly frontendRetrieved: boolean;
  };
  readonly boundaries?: readonly string[];
  readonly recentActivity: {
    readonly available: boolean;
    readonly refreshCount: number;
    readonly netComponentChange: number | null;
    readonly trend: string;
    readonly lastRefreshComponentDeltas: Readonly<Record<string, number>>;
  };
}

const formatDeltas = (deltas: Readonly<Record<string, number>>): string => {
  const entries = Object.entries(deltas);
  if (entries.length === 0) return 'no component changes';
  return entries
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`)
    .join(', ');
};

/** Render an org_overview: totals table, top objects, automation, recent activity. */
export const renderOrgOverviewMarkdown = (data: OrgOverviewLike): string => {
  const total = Object.values(data.componentCounts).reduce((a, b) => a + b, 0);
  const topTypes = Object.entries(data.componentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const parts: string[] = [`## Org overview — ${total} components`];

  const typeTable = mdTable(
    ['Type', 'Count'],
    topTypes.map(([t, n]) => [t, n]),
  );
  if (typeTable !== '') parts.push(`### Largest component types\n${typeTable}`);

  if (data.topObjects.length > 0) {
    const objTable = mdTable(
      ['Object', 'Inbound refs'],
      data.topObjects.slice(0, 5).map((o) => [o.apiName, o.inboundReferences]),
    );
    parts.push(`### Most-referenced objects\n${objTable}`);
  }

  const a = data.automationSummary;
  const cov = data.coverage;
  // Don't assert "0 workflow rules" / "0 integration surfaces" for families the
  // retrieve never pulled — say "not retrieved" so the tour can't imply absence
  // it never checked (honesty axis; see org-overview.ts `boundaries`).
  const workflowPart =
    cov && !cov.workflowRulesRetrieved
      ? 'workflow rules not retrieved'
      : `${a.workflowRules} workflow rules`;
  const integrationPart =
    cov && !cov.integrationRetrieved
      ? 'integration not retrieved'
      : `${data.integrationSummary.total} integration surfaces`;
  // The percentage names the rows it was computed over (every automation
  // family with a known status), instead of hanging off the workflow-rule count.
  const activePart =
    a.measuredCount === 0
      ? 'active status not extracted'
      : `${a.activeCount} of ${a.measuredCount} automation items active ` +
        `(${percent(a.activeCount, a.measuredCount)}%)` +
        (a.activeStatusUnknownCount > 0 ? ` · ${a.activeStatusUnknownCount} without a status` : '');
  parts.push(
    `### Automation\n${a.flows} flows · ${a.apexTriggers} triggers · ` +
      `${a.approvalProcesses} approval processes · ${workflowPart} · ${activePart} · ${integrationPart}`,
  );

  const ra = data.recentActivity;
  parts.push(
    ra.available
      ? `### Recent activity\nLast refresh: ${formatDeltas(ra.lastRefreshComponentDeltas)}. ` +
          `Trend over ${ra.refreshCount} refreshes: ${ra.trend}` +
          (ra.netComponentChange !== null ? ` (net ${ra.netComponentChange > 0 ? '+' : ''}${ra.netComponentChange} components).` : '.')
      : `### Recent activity\nNo refresh history yet — run \`sfi refresh\` to start the timeline.`,
  );

  if (data.boundaries !== undefined && data.boundaries.length > 0) {
    parts.push(
      `### Coverage caveats\n` + data.boundaries.map((b) => `- ${b}`).join('\n'),
    );
  }

  return parts.join('\n\n');
};

// --- live answers ----------------------------------------------------------

interface LiveCountLike {
  readonly count: number;
  readonly soql: string;
  readonly trust: TrustLike;
}

/** Render a live count: the number + the query, with a live freshness stamp. */
export const renderLiveCountMarkdown = (data: LiveCountLike): string =>
  `**${data.count.toLocaleString('en-US')}** records.\n\n\`${data.soql}\`\n\n${renderTrustFooter(data.trust)}`;

interface FieldPopulationLike {
  readonly objectApiName: string;
  readonly fieldApiName: string;
  readonly totalCount: number;
  readonly populatedCount: number;
  readonly populationRate: number;
  readonly trust: TrustLike;
}

/** Render field population: X of Y (Z%) populate the field, with provenance. */
export const renderFieldPopulationMarkdown = (data: FieldPopulationLike): string => {
  const pct = (data.populationRate * 100).toFixed(1).replace(/\.0$/, '');
  return (
    `\`${data.objectApiName}.${data.fieldApiName}\` is populated on ` +
    `**${data.populatedCount.toLocaleString('en-US')}** of ` +
    `${data.totalCount.toLocaleString('en-US')} records (**${pct}%**).\n\n` +
    renderTrustFooter(data.trust)
  );
};

interface InactiveUserLike {
  readonly name: string;
  readonly username: string;
  readonly profileName: string | null;
  readonly lastLoginDate: string | null;
  readonly daysSinceLogin: number | null;
  readonly neverLoggedIn: boolean;
}
interface InactiveUsersLike {
  readonly days: number;
  readonly totalInactive: number;
  readonly returned: number;
  readonly capped: boolean;
  readonly users: readonly InactiveUserLike[];
  readonly trust: TrustLike;
}

/** Render inactive users: the true total + a capped table, oldest-dormant first. */
export const renderInactiveUsersMarkdown = (data: InactiveUsersLike): string => {
  const head = `**${data.totalInactive.toLocaleString('en-US')}** active users have not logged in within ${data.days} days (or never have).`;
  if (data.users.length === 0) {
    return `${head}\n\n${renderTrustFooter(data.trust)}`;
  }
  const table = mdTable(
    ['User', 'Username', 'Profile', 'Days since login'],
    data.users.map((u) => [
      u.name,
      u.username,
      u.profileName ?? '—',
      u.neverLoggedIn ? 'never' : (u.daysSinceLogin ?? '—'),
    ]),
  );
  const capped = data.capped
    ? `\n\nShowing ${data.returned} of ${data.totalInactive} (oldest-dormant first).`
    : '';
  return `${head}\n\n${table}${capped}\n\n${renderTrustFooter(data.trust)}`;
};

// --- route_question --------------------------------------------------------

/** Host-passed context disclosure attached to a route_question response. */
interface ContextAppliedLike {
  readonly anaphor: string;
  readonly substitutedComponentId?: string;
  readonly inheritedTool?: string;
  readonly selection?: string;
}

/**
 * One-line disclosure of how host-passed conversation context changed the
 * response, e.g. "Context applied: 'it' → Flow:Order_Sync (from previous turn);
 * tool inherited: sfi.explain_flow." Exported so route_question can append it
 * to an already-rendered inner response (clarification continuation, where the
 * inner rendered text — candidate list included — is reused verbatim).
 */
export const renderContextApplied = (contextApplied: ContextAppliedLike): string => {
  const substituted =
    contextApplied.substitutedComponentId ?? contextApplied.selection;
  return (
    `Context applied: '${contextApplied.anaphor}'` +
    (substituted !== undefined ? ` → ${substituted}` : '') +
    ' (from previous turn)' +
    (contextApplied.inheritedTool !== undefined
      ? `; tool inherited: \`${contextApplied.inheritedTool}\`.`
      : '.')
  );
};

interface ShortlistLike {
  readonly question: string;
  readonly toolCandidates?: readonly {
    readonly tool: string;
    readonly score: number;
    readonly plane: string;
    readonly liveRequired: boolean;
    readonly answers: string;
    readonly suggestedArgs?: Readonly<Record<string, unknown>>;
    readonly missingArgs?: readonly string[];
  }[];
  readonly clarification: { readonly required: boolean; readonly question: string; readonly options: readonly string[] } | null;
  readonly refusal?: { readonly disclosure: string; readonly readOnlyAlternative?: string };
  readonly gap: { readonly category: string; readonly note: string } | null;
  readonly entityEvidence?: { readonly warning: string | null };
  readonly contextApplied?: ContextAppliedLike;
}

/**
 * Render a route_question response: the ranked shortlist (the host picks),
 * then whatever must be read before running anything — a stop-and-ask, a
 * refusal, an honest gap, a premise warning, the context disclosure.
 */
export const renderShortlistMarkdown = (data: ShortlistLike): string => {
  const parts: string[] = [];
  const cands = data.toolCandidates ?? [];
  if (data.refusal !== undefined) {
    parts.push(
      `**"${data.question}"** — ${data.refusal.disclosure}` +
        (data.refusal.readOnlyAlternative !== undefined
          ? ` Read-only alternative: \`${data.refusal.readOnlyAlternative}\`.`
          : ''),
    );
    if (cands.length > 0) {
      parts.push(
        `**Candidate tools (transparency only — the request itself is refused/gapped; do not execute them to satisfy it):** ${cands.map((c) => `\`${c.tool}\``).join(', ')}`,
      );
    }
  } else if (cands.length === 0) {
    parts.push(
      `I don't have a tool for **"${data.question}"**${data.gap ? ` — ${data.gap.note}` : '.'}`,
    );
  } else {
    const rows = cands.map((c, i) => {
      const live = c.liveRequired ? ' · needs the opt-in live plane' : '';
      const args =
        c.suggestedArgs !== undefined ? ` · args ${JSON.stringify(c.suggestedArgs)}` : '';
      const missing =
        c.missingArgs !== undefined ? ` · still needs: ${c.missingArgs.join(', ')}` : '';
      return `${i + 1}. \`${c.tool}\` (${c.score.toFixed(3)}, ${c.plane}${live}) — ${c.answers}${args}${missing}`;
    });
    parts.push(
      `**Candidate tools for "${data.question}" (ranked by meaning; you pick, then run):**\n${rows.join('\n')}`,
    );
  }
  if (data.clarification?.required === true) {
    parts.push(
      `**Stop before executing:** ${data.clarification.question} Options: ${data.clarification.options.map((o) => `\`${o}\``).join(', ')}`,
    );
  }
  if (data.refusal === undefined && data.gap !== null && cands.length > 0) {
    parts.push(`_Gap (\`${data.gap.category}\`): ${data.gap.note}_`);
  }
  if (data.entityEvidence?.warning) {
    parts.push(data.entityEvidence.warning);
  }
  if (data.contextApplied !== undefined) {
    parts.push(renderContextApplied(data.contextApplied));
  }
  return parts.join('\n\n');
};
