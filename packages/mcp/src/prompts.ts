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
