/**
 * MCP prompts capability (MCP-01 c) — host-agnostic generators + admin
 * playbooks.
 *
 * Claude hosts already see these as `.claude/skills/`; registering them as
 * MCP `prompts` makes the same curated routines available to any MCP client
 * (Cursor, Copilot, bare `mcp` CLIs). Content is distilled from the existing
 * admin-documentation-generators + admin-playbooks skills — not invented.
 *
 * Elicitation is intentionally NOT used here (spec redesign; keep the
 * bespoke `route_question` clarification flow).
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type GetPromptResult,
  type Prompt,
} from '@modelcontextprotocol/sdk/types.js';

/** One curated prompt: list metadata + get-time message builder. */
interface CuratedPrompt {
  readonly meta: Prompt;
  readonly build: (
    args: Readonly<Record<string, string>> | undefined,
  ) => GetPromptResult;
}

const userMessage = (text: string): GetPromptResult['messages'][number] => ({
  role: 'user',
  content: { type: 'text', text },
});

const GENERATOR_PREAMBLE = `You are driving sf-intelligence documentation generators. Rules:
- Confirm vault freshness with \`sfi.health_check\` first; if degraded/unhealthy or stale, stop and ask for \`/sfi-refresh\` (or \`/sfi-init\` if missing).
- Call the named \`sfi.generate_*\` tool; surface the returned markdown with its Q125 freshness footer intact (\`generatedAt\` + \`sourceTreeHash\`).
- Cite canonical component ids; disclose per-section confidence (\`declared\` / \`parsed\` / \`heuristic\`) and verbatim \`boundaries[]\`.
- Generators compose existing graph queries into structured markdown — they do not invent narrative beyond scaffolding.
- Read-only: never modify org metadata.`;

const PLAYBOOK_PREAMBLE = `You are running an sf-intelligence admin playbook — a named, repeatable tool batch that folds into ONE report. Rules:
1. Confirm freshness first: \`sfi.health_check\` once at the start; if \`status\` is degraded/unhealthy or \`freshness.stale\` is true, stop and route to \`/sfi-refresh\` (or \`/sfi-init\` when the vault is missing).
2. Live steps need the opt-in live plane. If off, run offline steps, then offer \`sfi.live_consent { grant: true }\` and re-run live steps — never infer live facts from the vault.
3. Cite canonical component ids; stamp provenance (\`offline_snapshot\` / \`live_org\`) and confidence. Use any tool's \`rendered\` field verbatim when present.
4. Single-fact questions belong on \`sfi.route_question\`, not a playbook.`;

const FIELD_AUDIT_PREAMBLE = `You are running an sf-intelligence FIELD AUDIT — deciding whether fields can be deleted, and what must happen first. This is a document that authorises destruction, so its value is entirely a function of whether the reader can tell your evidence apart from your inference.

The one principle everything else follows from: **population tells you how much data is in a field; it never tells you what depends on it.** The two agree on busy, obviously-live fields and diverge everywhere else — formula fields, transient state flags, integration keys, anything frozen. Every serious error in this kind of analysis comes from substituting one for the other.`;

const PROMPTS: readonly CuratedPrompt[] = [
  {
    meta: {
      name: 'sfi.generate_data_dictionary',
      description:
        'Generate a per-object schema data dictionary (fields, relationships, ERD, validation rules, layouts, automation).',
      arguments: [
        {
          name: 'objectApiName',
          description:
            'Custom object API name (e.g. Account or MyObject__c). Prefixed to CustomObject: automatically.',
          required: true,
        },
      ],
    },
    build: (args) => {
      const api = args?.['objectApiName']?.trim() || 'Account';
      const objectId = api.startsWith('CustomObject:')
        ? api
        : `CustomObject:${api}`;
      return {
        description:
          'Per-object schema documentation via sfi.generate_data_dictionary.',
        messages: [
          userMessage(
            `${GENERATOR_PREAMBLE}

Task: generate a data dictionary for \`${objectId}\`.
Call \`sfi.generate_data_dictionary\` with \`{ "objectId": "${objectId}" }\`.
Cover overview, fields, relationships, mermaid ERD, validation rules, page layouts, related triggers/flows, and boundaries.`,
          ),
        ],
      };
    },
  },
  {
    meta: {
      name: 'sfi.generate_admin_handbook',
      description:
        'Generate an org-level admin handbook (purpose, objects, automation, permissions, integrations, recent changes).',
      arguments: [
        {
          name: 'personaFocus',
          description:
            'Section emphasis: admin (default), architect, business-user, or developer.',
          required: false,
        },
      ],
    },
    build: (args) => {
      const persona = args?.['personaFocus']?.trim() || 'admin';
      return {
        description: 'Org-level admin handbook via sfi.generate_admin_handbook.',
        messages: [
          userMessage(
            `${GENERATOR_PREAMBLE}

Task: create an admin handbook for this org.
Call \`sfi.generate_admin_handbook\` with \`{ "personaFocus": "${persona}" }\`.
Default admin emphasis = permission structure + automation summary.`,
          ),
        ],
      };
    },
  },
  {
    meta: {
      name: 'sfi.generate_onboarding_doc',
      description:
        'Generate a new-hire onboarding tour (handbook + architecture + naming + glossary).',
      arguments: [
        {
          name: 'personaFocus',
          description: 'admin (default) or developer.',
          required: false,
        },
      ],
    },
    build: (args) => {
      const persona = args?.['personaFocus']?.trim() || 'admin';
      return {
        description: 'New-hire onboarding doc via sfi.generate_onboarding_doc.',
        messages: [
          userMessage(
            `${GENERATOR_PREAMBLE}

Task: write an onboarding doc for a new ${persona}.
Call \`sfi.generate_onboarding_doc\` with \`{ "personaFocus": "${persona}" }\`.
Expect sections: What This Org Does, Main Data Model, Common Workflows, How Security Works, Naming Conventions, Glossary, Key Contacts / enrichment-missing disclosure, Where To Go Next.`,
          ),
        ],
      };
    },
  },
  {
    meta: {
      name: 'sfi.generate_architecture_overview',
      description:
        'Generate a high-level architecture overview with mermaid diagrams (org structure, ERD, domains, integrations).',
    },
    build: () => ({
      description:
        'Architecture overview via sfi.generate_architecture_overview.',
      messages: [
        userMessage(
          `${GENERATOR_PREAMBLE}

Task: generate an architecture overview.
Call \`sfi.generate_architecture_overview\` with \`{}\`.
Surface all four mermaid diagrams and disclose any node-count caps from \`boundaries[]\`.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.generate_sharing_summary',
      description:
        'Generate a sharing-model summary (OWD, sharing rules, role hierarchy; optional object filter).',
      arguments: [
        {
          name: 'objectFilter',
          description: 'Optional object API name to narrow the summary.',
          required: false,
        },
      ],
    },
    build: (args) => {
      const filter = args?.['objectFilter']?.trim();
      const call =
        filter !== undefined && filter !== ''
          ? `\`sfi.generate_sharing_summary\` with \`{ "objectFilter": "${filter}" }\``
          : '`sfi.generate_sharing_summary` with `{}`';
      return {
        description: 'Sharing-model summary via sfi.generate_sharing_summary.',
        messages: [
          userMessage(
            `${GENERATOR_PREAMBLE}

Task: document the org's sharing model.
Call ${call}.
This is a static report — per-user "why can't X see Y" goes to \`sfi.why_cant_user_see_record\`, not this generator.`,
          ),
        ],
      };
    },
  },
  {
    meta: {
      name: 'sfi.generate_compliance_report',
      description:
        'Generate a PII / compliance exposure write-up from the vault inventory.',
    },
    build: () => ({
      description: 'Compliance report via sfi.generate_compliance_report.',
      messages: [
        userMessage(
          `${GENERATOR_PREAMBLE}

Task: draft a compliance / PII exposure report.
Call \`sfi.generate_compliance_report\` with \`{}\`.
Classification is heuristic (same family as \`sfi.pii_inventory\`) — surface confidence labels and boundaries; never claim regulatory certification.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.playbook_pre_deploy',
      description:
        'Pre-deploy / go-live checklist playbook (coverage, risk gate, tests, governors, CRUD/FLS, live health).',
    },
    build: () => ({
      description: 'Admin playbook: pre-deploy checklist.',
      messages: [
        userMessage(
          `${PLAYBOOK_PREAMBLE}

Playbook \`pre-deploy\` — run in order, then GO / NO-GO with blockers named:
1. \`sfi.coverage_report\` — surface any \`coverageCaveat\` first.
2. \`sfi.org_risk_report\` with \`gate: true\` — composite deploy gate (\`ready\` + \`blockers\`).
3. \`sfi.test_coverage_gaps\`
4. \`sfi.governor_limit_risks\`
5. \`sfi.find_hardcoded_values\`
6. \`sfi.crud_fls_audit\`
7. **(live)** \`sfi.live_org_health\`

Report: **GO** or **NO-GO**, then ranked blockers each with tool + id.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.playbook_onboard',
      description:
        'New-admin org tour playbook (overview, domains, architecture, integrations, permission risk, history).',
    },
    build: () => ({
      description: 'Admin playbook: inherited-org onboard tour.',
      messages: [
        userMessage(
          `${PLAYBOOK_PREAMBLE}

Playbook \`onboard\` — new-admin orientation, run in order:
1. \`sfi.org_overview\`
2. \`sfi.domain_clusters\`
3. \`sfi.generate_architecture_overview\`
4. \`sfi.integration_map\`
5. \`sfi.permission_risk_report\`
6. \`sfi.org_history\`

Report: plain-English tour, domain by domain, with ERD and who/what-to-watch callouts.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.playbook_security_audit',
      description:
        'Security / exposure audit playbook (permission risk, CRUD/FLS, sharing, PII, history gaps, compliance).',
    },
    build: () => ({
      description: 'Admin playbook: security audit.',
      messages: [
        userMessage(
          `${PLAYBOOK_PREAMBLE}

Playbook \`security-audit\` — access + exposure sweep:
1. \`sfi.permission_risk_report\`
2. \`sfi.crud_fls_audit\`
3. \`sfi.unassigned_permission_sets\` + \`sfi.empty_queues_and_groups\`
4. \`sfi.generate_sharing_summary\`
5. \`sfi.pii_inventory\`
6. \`sfi.history_tracking_gaps\`
7. \`sfi.generate_compliance_report\`
8. **(live)** \`sfi.live_inactive_users\`

Report: access matrix + ranked risks + tightening recommendation.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.playbook_cleanup',
      description:
        'Dead-vs-alive cleanup sweep playbook (unused fields/components/code; live usage confirmation).',
    },
    build: () => ({
      description: 'Admin playbook: cleanup sweep.',
      messages: [
        userMessage(
          `${PLAYBOOK_PREAMBLE}

Playbook \`cleanup\` — read-only candidates, never deletes:
1. \`sfi.unused_fields_deep\` (add \`format: 'cleanup'\` for ranked deletion candidates)
2. \`sfi.unused_components\`
3. \`sfi.find_dead_code\`
4. **(live)** \`sfi.live_report_usage\`
5. **(live)** \`sfi.live_email_template_usage\`
6. **(live)** \`sfi.live_field_population\` on top candidates

Report: quantified dead-vs-alive list by safety. Never say "safe to delete" without complete \`sfi.coverage_report\`.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.playbook_health',
      description:
        'Org health / on-fire pulse playbook (live org health + limits + offline risk).',
    },
    build: () => ({
      description: 'Admin playbook: operational health pulse.',
      messages: [
        userMessage(
          `${PLAYBOOK_PREAMBLE}

Playbook \`health\` — operational pulse (mostly live):
1. **(live)** \`sfi.live_org_health\`
2. **(live)** \`sfi.live_org_limits\`
3. \`sfi.org_risk_report\`

Report: red/amber/green pulse with specific failing signals named.`,
        ),
      ],
    }),
  },
  {
    meta: {
      name: 'sfi.field_audit',
      description:
        'Field-deletion audit: decide Keep / Review / Deprecate-then-Remove / Remove for a field or an object’s fields, tracing every dependency first. Also validates an existing field-cleanup analysis.',
      arguments: [
        {
          name: 'objectApiName',
          description:
            'The object whose fields are under audit (e.g. Account or MyObject__c).',
          required: true,
        },
        {
          name: 'fieldApiNames',
          description:
            'Optional comma-separated field api names to scope the audit. Omit to assess the whole object.',
          required: false,
        },
      ],
    },
    build: (args) => ({
      description: 'Field-deletion audit with dependency tracing.',
      messages: [
        userMessage(
          `${FIELD_AUDIT_PREAMBLE}

Object under audit: \`${args?.['objectApiName'] ?? '<objectApiName>'}\`${
            args?.['fieldApiNames'] !== undefined &&
            args['fieldApiNames'].length > 0
              ? `\nFields scoped to: ${args['fieldApiNames']}`
              : '\nScope: every custom field on the object.'
          }

Run in this order. Do not skip step 0 — it is what makes the rest trustworthy.

0. **Orient and calibrate.**
   - \`sfi.org_card\` for component counts and DECLARED coverage gaps.
   - \`sfi.coverage_report\`. If Report/Dashboard reads \`pending\`, the report pull was capped (default \`SFI_REPORTS_CAP\`=500, ranked by usage) — say so, and treat every report count as a floor, not a total.
   - **Positive control:** pick a field you can already prove is referenced, run the same tools against it, and confirm they return something. A zero from an uncalibrated method is not a finding.

1. **Per field, gather — do not judge yet.**
   - \`sfi.field_360\` — full profile across validation, formulas, writers, readers, UI, integrations.
   - \`sfi.find_field_anywhere\` — every incoming edge grouped by component type.
   - \`sfi.safe_to_delete_field\` — the verdict with its reasoning chain. Use \`format: 'checklist'\` when you want ordered pre-work.
   - \`sfi.find_formula_references\` for formula referrers.

2. **Read the structure before any number.** \`required\` + \`unique\` + \`externalId\` with no in-org writer is an integration upsert key — the strongest possible Keep, and the exact shape a naive "nothing writes it" reading calls dead. \`trackHistory: true\` means deleting the field destroys history rows permanently; no export of current values recovers them.

3. **A formula field has no population figure.** If the body references \`$User\`, \`$UserRole\`, \`$Profile\` or \`TODAY()\`, the percentage measures who ran the query. If it returns \`IF(...,1,0)\` or \`CASESAFEID(Id)\` it can never be null and measures arithmetic. Read the body; strike the number.

4. **Measure flow, not just stock** (live plane only, and only with consent): \`sfi.live_field_population\`, then \`MAX(field)\` and a future-dated count via \`sfi.live_aggregate\`. A field with 750,000 values can be frozen; a field at 0% can be load-bearing. Watch \`sfi.live_budget\`; when it runs out, say which figures are carried forward UNVERIFIED.

5. **Record ROLE, never count.** For each consumer, what would it do if the field vanished? A field used as a report or list-view **filter** does not empty the report when deleted — it silently WIDENS it. Nothing errors, so nobody reports it. That is strictly more dangerous than a lost display column.

Verdict vocabulary — four values, not three:
- **Keep** — live dependency, integration contract, or clear business value. Name the blocker, never the population.
- **Review** — genuinely ambiguous. INCOMPLETE unless it names the exact question and the named human who answers it.
- **Deprecate-then-Remove** — dead in practice but holds data, history, or cosmetic references. Needs staged retirement.
- **Remove** — no data of value, no live dependency, every surface checked-negative with a proven method.

Honesty rules, non-negotiable:
- Render any \`coverageCaveat\` BEFORE the verdict, never as a footnote.
- Separate "checked and found nothing" from "could not check". They look identical in a report and mean opposite things.
- Name the blind spots no static analysis closes: dynamically-built SOQL, reflective \`.get('Field__c')\`, field lists stored as ORG DATA in custom settings or custom metadata (invisible to metadata retrieval AND to this vault — they fail at runtime, not at deploy), external ETL job definitions, managed-package internals, private report folders, and email-template merge fields.
- Never present an \`sfi.safe_to_delete_field\` verdict of \`safe\` as permission to delete. It means no modelled dependency was found, which is a statement about coverage as much as about the field.`,
        ),
      ],
    }),
  },
];

const PROMPT_BY_NAME: ReadonlyMap<string, CuratedPrompt> = new Map(
  PROMPTS.map((p) => [p.meta.name, p]),
);

/** Curated MCP prompt roster (generators + org-wide admin playbooks). */
export const MCP_PROMPTS: readonly Prompt[] = PROMPTS.map((p) => p.meta);

/**
 * Resolve a prompts/get body for a curated prompt name.
 * Throws {@link McpError} InvalidParams when the name is unknown.
 */
export const getMcpPrompt = (
  name: string,
  args: Readonly<Record<string, string>> | undefined,
): GetPromptResult => {
  const prompt = PROMPT_BY_NAME.get(name);
  if (prompt === undefined) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
  return prompt.build(args);
};

/**
 * Register `prompts/list` and `prompts/get` on `server`.
 *
 * @example
 *   registerPrompts(server);
 */
export const registerPrompts = (server: Server): void => {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [...MCP_PROMPTS],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getMcpPrompt(name, args as Readonly<Record<string, string>> | undefined);
  });
};
