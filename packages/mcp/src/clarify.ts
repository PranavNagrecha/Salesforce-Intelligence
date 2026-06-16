/**
 * Turns the resolver's verdict into a conversation-ready next step, so the
 * Q&A experience feels like a person: when the org has several matches we ASK
 * which one; when nothing matches we OFFER to pull fresh data or stop. The MCP
 * server can't call the client's UI, so it returns this structured block and
 * the client (Claude) renders it — naturally, via its built-in clarifying-
 * question prompt (AskUserQuestion).
 */

import type { ComponentId } from '@sf-intelligence/contracts';
import type { ResolveCandidate, ResolveResult } from '@sf-intelligence/graph';

/** One pickable answer to a clarifying question. */
export interface ClarifyOption {
  /** Human label that disambiguates (e.g. "Email__c on Account (CustomField)"). */
  readonly label: string;
  /** The canonical id to use if the user picks this. */
  readonly value: ComponentId;
  /** Why this candidate matched (the evidence). */
  readonly hint: string;
}

/**
 * How the ambiguous candidates differ — tells the client the cheapest way to
 * disambiguate:
 *   - `object` — same component name on several objects (add the object name).
 *   - `type`   — same name across component types (e.g. a field and a flow).
 *   - `name`   — genuinely different names (pick one, or reword).
 */
export type DisambiguateBy = 'object' | 'type' | 'name';

/** A ready-to-ask clarifying question with mutually-exclusive options. */
export interface Clarification {
  readonly question: string;
  readonly options: readonly ClarifyOption[];
  /** The dimension along which the options differ (guides the user's answer). */
  readonly disambiguateBy: DisambiguateBy;
}

/** A suggested next step the client can offer the user. */
export interface NextAction {
  readonly action: 'use' | 'refresh' | 'narrow' | 'stop';
  readonly label: string;
  readonly reason: string;
  /** A slash command the user can run, when applicable (e.g. `/sfi-refresh`). */
  readonly command?: string;
}

/** What the client should do next given a resolution. */
export interface ClarifyResult {
  readonly clarification: Clarification | null;
  readonly nextActions: readonly NextAction[];
}

/** Cap on options offered, so the question stays answerable. */
const MAX_OPTIONS = 8;

/** Normalize a name for collision detection (lowercase, drop suffix + punctuation). */
const normName = (s: string): string =>
  s.toLowerCase().replace(/__[a-z0-9]+$/, '').replace(/[^a-z0-9]/g, '');

const optionLabel = (c: ResolveCandidate): string =>
  c.parentApiName !== null
    ? `${c.apiName} on ${c.parentApiName} (${c.type})`
    : `${c.apiName} (${c.type})`;

/**
 * Classify how the shown candidates differ, so the question can tell the user
 * the cheapest disambiguator. If they all share one normalized name they're a
 * pure collision — distinguished by object (if parents differ) or by type;
 * otherwise they are genuinely different names.
 */
const classifyDisambiguation = (
  candidates: readonly ResolveCandidate[],
): DisambiguateBy => {
  if (candidates.length < 2) return 'name';
  const names = new Set(candidates.map((c) => normName(c.apiName)));
  if (names.size > 1) return 'name';
  // Single shared name: do the parents differ (and are present)?
  const parents = new Set(candidates.map((c) => c.parentApiName ?? '∅'));
  if (parents.size > 1 && !parents.has('∅')) return 'object';
  return 'type';
};

/**
 * Build the conversation-ready next step from a resolve result + vault
 * freshness.
 *
 * - `exact`     → no question; a single `use` action.
 * - `ambiguous` → a clarifying question (one option per candidate) plus
 *   `narrow` and `refresh` next actions.
 * - `none`      → no question; offer `refresh` (with `/sfi-refresh`, naming the
 *   last-refresh time so the user can judge staleness) or `stop`.
 */
export const buildClarify = (
  query: string,
  result: ResolveResult,
  vault: { readonly refreshedAt: string },
): ClarifyResult => {
  if (result.disposition === 'exact') {
    const top = result.candidates[0];
    return {
      clarification: null,
      nextActions:
        top !== undefined
          ? [{ action: 'use', label: `Use ${top.id}`, reason: 'single confident match' }]
          : [],
    };
  }

  if (result.disposition === 'ambiguous') {
    const shown = result.candidates.slice(0, MAX_OPTIONS);
    const options = shown.map((c) => ({
      label: optionLabel(c),
      value: c.id,
      hint: c.evidence,
    }));
    const total = result.candidates.length;
    const disambiguateBy = classifyDisambiguation(shown);
    const sharedName = shown[0]?.apiName ?? query;
    // Tailor the question to the disambiguation dimension so the user knows the
    // cheapest way to answer: name the object for a cross-object collision, the
    // type for a cross-type one, else a plain pick. Stay honest about the cap
    // when more matched than we show.
    const overflow =
      total > options.length ? ` (showing the top ${options.length} of ${total})` : '';
    const question =
      disambiguateBy === 'object'
        ? `"${sharedName}" exists on ${total} objects${overflow}. Which object did you mean?`
        : disambiguateBy === 'type'
          ? `"${sharedName}" matches ${total} components of different types${overflow}. Which one?`
          : `I found ${total} matches for "${query}"${overflow}. Which did you mean?`;
    return {
      clarification: {
        question,
        options,
        disambiguateBy,
      },
      nextActions: [
        {
          action: 'narrow',
          label:
            disambiguateBy === 'object'
              ? 'Narrow by object'
              : disambiguateBy === 'type'
                ? 'Narrow by type'
                : 'Narrow by object or type',
          reason:
            disambiguateBy === 'object'
              ? 'add the object name (e.g. "Account email") to disambiguate'
              : disambiguateBy === 'type'
                ? 'add the component type (e.g. "the Status flow") to disambiguate'
                : 'add the object name or type to disambiguate',
        },
        {
          action: 'refresh',
          label: 'Pull fresh metadata from the org',
          reason: `the vault was last refreshed ${vault.refreshedAt}; refresh if you expect newer components`,
          command: '/sfi-refresh',
        },
      ],
    };
  }

  // none
  return {
    clarification: null,
    nextActions: [
      {
        action: 'refresh',
        label: 'Pull fresh metadata from the org',
        reason: `nothing matched "${query}" in the current vault (refreshed ${vault.refreshedAt}); it may be new, or the vault may be stale`,
        command: '/sfi-refresh',
      },
      {
        action: 'stop',
        label: 'Stop',
        reason: 'the term may not exist in this org — or try different wording',
      },
    ],
  };
};
