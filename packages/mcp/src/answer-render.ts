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
}

/** Render a resolve result: a verdict line + (when ambiguous) a candidate table. */
export const renderResolveMarkdown = (data: ResolveLike): string => {
  const { disposition, candidates } = data;
  if (disposition === 'none' || candidates.length === 0) {
    return 'No confident match. Try the exact API name, add the object name, or `/sfi-refresh` if it may be new.';
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
  readonly automationSummary: { readonly flows: number; readonly apexTriggers: number; readonly workflowRules: number; readonly activeRatio: number };
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
  // it never checked (PLAN-v4.0 honesty axis; see org-overview.ts `boundaries`).
  const workflowPart =
    cov && !cov.workflowRulesRetrieved
      ? 'workflow rules not retrieved'
      : `${a.workflowRules} workflow rules`;
  const integrationPart =
    cov && !cov.integrationRetrieved
      ? 'integration not retrieved'
      : `${data.integrationSummary.total} integration surfaces`;
  parts.push(
    `### Automation\n${a.flows} flows · ${a.apexTriggers} triggers · ${workflowPart}` +
      ` (${Math.round(a.activeRatio * 100)}% active) · ${integrationPart}`,
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

interface RouteLike {
  readonly question: string;
  readonly plane: 'vault' | 'live' | 'hybrid' | 'knowledge' | 'unknown';
  readonly intent: string;
  readonly tools: readonly string[];
  readonly liveRequired: boolean;
  readonly needsResolve: boolean;
  readonly reason: string;
  readonly gap: { readonly category: string; readonly note: string } | null;
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly risk?: 'informational' | 'change-planning' | 'security-sensitive' | 'destructive';
  readonly alternatives?: readonly { readonly intent: string }[];
  readonly clarification?: {
    readonly required: boolean;
    readonly question: string;
    readonly fallback?: {
      readonly intent: string;
      readonly warning: string;
    };
  } | null;
  readonly plan?: readonly {
    readonly stepId?: string;
    readonly dependsOn?: readonly string[];
    readonly question: string;
    readonly intent: string;
    readonly tools: readonly string[];
  }[];
}

/** Render a routing verdict: plane + the tool plan + honest gap note. */
export const renderRouteMarkdown = (route: RouteLike): string => {
  if (route.plane === 'unknown') {
    return (
      `I don't have a tool for **"${route.question}"** yet — ${route.reason} ` +
      `${route.gap ? `(logged as \`${route.gap.category}\`).` : ''}`
    );
  }
  const steps: string[] = [];
  // When the route asks to resolve first, a leading `sfi.resolve` in tools
  // would otherwise be listed twice — drop it so the plan reads cleanly.
  let plannedTools = route.tools;
  if (route.needsResolve) {
    steps.push('`sfi.resolve` the named component first');
    if (plannedTools[0] === 'sfi.resolve') plannedTools = plannedTools.slice(1);
  }
  steps.push(...plannedTools.map((t) => `\`${t}\``));
  const live = route.liveRequired
    ? ' Needs the opt-in live plane (`sfi.live_consent { grant: true }`).'
    : '';
  const enterprise =
    `\n\nConfidence: **${route.confidence ?? 'high'}**` +
    (route.risk !== undefined ? ` · risk: **${route.risk}**` : '') +
    (route.alternatives !== undefined && route.alternatives.length > 0
      ? ` · alternatives: ${route.alternatives.map((alternative) => `\`${alternative.intent}\``).join(', ')}`
      : '');
  const clarification =
    route.clarification?.required === true
      ? `\n\n**Stop before executing:** ${route.clarification.question}` +
        (route.clarification.fallback !== undefined
          ? `\n\nFallback warning: ${route.clarification.fallback.warning}`
          : '')
      : '';
  const compoundPlan =
    route.plan !== undefined && route.plan.length > 1
      ? `\n\nCompound plan:\n${route.plan.map((step, i) => {
          const dependency =
            step.dependsOn !== undefined && step.dependsOn.length > 0
              ? ` (after ${step.dependsOn.map((id) => `\`${id}\``).join(', ')})`
              : ' (independent)';
          return `${i + 1}. \`${step.stepId ?? `step-${i + 1}`}\` · \`${step.intent}\`${dependency}: ${step.tools.map((tool) => `\`${tool}\``).join(' → ')}`;
        }).join('\n')}`
      : '';
  return (
    `**${route.plane}** plane · intent \`${route.intent}\`. ${route.reason}${live}\n\n` +
    `Plan: ${steps.join(' → ')}` +
    enterprise +
    clarification +
    compoundPlan +
    (route.gap ? `\n\n_Partial: ${route.gap.note}_` : '')
  );
};
