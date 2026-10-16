/**
 * Shared helpers for the core-profile skill gateway contract (Decision 2=C).
 *
 * Default SFI_TOOL_PROFILE=core advertises the core spine (incl. live_consent).
 * Every other sfi.* analysis must be invoked via sfi.run_analysis { name, args }.
 * Skills may still *name* non-core tools for routing/meaning; they must not
 * instruct a direct call.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The core roster, DERIVED from the committed ProductManifest
 * (`eval/product-manifest.json` → `tools.profiles.core`), which the gate keeps
 * in step with `packages/mcp/src/tools/tool-profile.ts` via
 * `product-manifest:check`. This used to be a hand-mirrored copy "kept in step"
 * by a comment; it drifted the first time the roster changed and the check
 * passed vacuously.
 */
const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'eval',
  'product-manifest.json',
);
const loadCoreRoster = () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const core = manifest?.tools?.profiles?.core;
  if (!Array.isArray(core) || core.length === 0) {
    throw new Error(
      `${manifestPath} has no tools.profiles.core — run \`pnpm -r build && pnpm product-manifest\` first`,
    );
  }
  return core;
};
export const CORE_PROFILE_TOOLS = Object.freeze(new Set(loadCoreRoster()));

export const GATEWAY_FOOTER = [
  '**Grounding & routing (shared contract).** For a vague or broad ask, run',
  '`sfi.route_question` through `sfi.run_analysis` first — it returns a',
  'meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a',
  'suggested plane and a `route` hint (and whether to `sfi.resolve` a name',
  'first). **Default tool profile is `core`:** only the core spine (including',
  '`sfi.live_consent`) is directly invokable. For every other `sfi.*` analysis,',
  'call `sfi.run_analysis` with `{ "name": "sfi.<tool>", "args": { … } }` (or',
  'follow `route_question.invoke`, which already wraps non-core steps).',
  'Optional: `sfi.describe_analysis` first when args are unclear. Every org',
  'fact must come from an `sfi.*` tool call, cited by its canonical id — never',
  'from memory. Build the answer only from what the tools returned, then pass',
  'it through `sfi.synthesize_answer` (via `sfi.run_analysis`), which flags any `hallucinatedIds`',
  '(canonical ids no tool produced). Full cascade: `using-sf-intelligence`.',
].join(' ');

/** Legacy footer text still present in many skills (pre-gateway). */
export const LEGACY_GATEWAY_FOOTER =
  '**Grounding & routing (shared contract).** For a vague or broad ask, call `sfi.route_question` first — in the default hybrid mode it returns a meaning-ranked `toolCandidates` shortlist (which YOU pick from) plus a suggested plane and a `route` hint (and whether to `sfi.resolve` a name first). Every org fact must come from an `sfi.*` tool call, cited by its canonical id — never from memory. Build the answer only from what the tools returned, then pass it through `sfi.synthesize_answer`, which flags any `hallucinatedIds` (canonical ids no tool produced). Full cascade: `using-sf-intelligence`.';

/**
 * Lines that look like a direct MCP invoke of a tool (not a catalog mention).
 * Captures the tool name without the sfi. prefix in group 1 when possible.
 */
export const DIRECT_INVOKE_RE =
  /(?:^|\s)(?:Call|call|Calls|calls|Fire|fire|Invoke|invoke|Run|run|Runs|runs|Use|use|Ask|ask|Query|query|Try|try|Prefer|prefer|Start with|start with)\s+(?:\*\*)?`sfi\.([a-z0-9_]+)`/gm;

export const STEP_HEADER_INVOKE_RE =
  /^#{2,4}\s+[^\n]*\b(?:Call|call|Fire|fire)\s+`sfi\.([a-z0-9_]+)`/gm;

export const CHECKLIST_CALLED_RE =
  /I called `sfi\.([a-z0-9_]+)`/g;

export function normalizeToolName(name) {
  const n = String(name ?? '').trim();
  if (n.startsWith('sfi.')) return n;
  return `sfi.${n}`;
}

export function isCoreTool(name) {
  // sfi.setup_status is served by the setup-mode server (no vault bound); it is
  // always directly callable there, so instructing it is never a gateway miss.
  if (normalizeToolName(name) === 'sfi.setup_status') return true;
  return CORE_PROFILE_TOOLS.has(normalizeToolName(name));
}

/**
 * Find direct-invoke violations in markdown.
 * @returns {{ line: number, tool: string, text: string }[]}
 */
export function findDirectInvokeViolations(markdown) {
  const lines = markdown.split('\n');
  const hits = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Already gateway-shaped lines are fine even if they mention a non-core name.
    if (/sfi\.run_analysis/.test(line)) continue;
    const patterns = [
      /(?:Call|call|Calls|calls|Fire|fire|Invoke|invoke|Run|run|Runs|runs|Use|use|Ask|ask|Query|query|Try|try|Prefer|prefer|Start with|start with)\s+(?:\*\*)?`sfi\.([a-z0-9_]+)`/g,
      // "`sfi.x` first", "→ `sfi.x`", "then `sfi.x`" are instructions too, not catalog mentions
      /`sfi\.([a-z0-9_]+)`\*?\*?\s+(?:FIRST|first)\b/g,
      /(?:→|->|then)\s+`sfi\.([a-z0-9_]+)`/g,
      /^#{2,4}\s+[^\n]*\b(?:Call|call|Fire|fire)\s+`sfi\.([a-z0-9_]+)`/g,
      /I called `sfi\.([a-z0-9_]+)`/g,
      /\*\*Fire\*\*\s+`sfi\.([a-z0-9_]+)`/g,
      /\*\*Call\*\*\s+`sfi\.([a-z0-9_]+)`/g,
    ];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const tool = normalizeToolName(m[1]);
        if (!isCoreTool(tool)) {
          const key = `${i + 1}:${tool}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ line: i + 1, tool, text: line.trim() });
        }
      }
    }
  }
  return hits;
}

/**
 * Rewrite common direct-invoke phrasings to the run_analysis gateway form.
 * Conservative: only touches clear Call/Fire/Invoke/Run + checklist lines.
 */
export function rewriteDirectInvokes(markdown) {
  let out = markdown;
  // Any paragraph that opens with the shared-contract marker is a footer, whatever
  // intermediate wording it carries (three forms existed by 0.6.0); replace it whole.
  const FOOTER_PARAGRAPH_RE = /^\*\*Grounding & routing \(shared contract\)\.\*\*[^\n]*$/gm;
  if (FOOTER_PARAGRAPH_RE.test(out)) {
    out = out.replace(FOOTER_PARAGRAPH_RE, GATEWAY_FOOTER);
  } else if (out.includes(LEGACY_GATEWAY_FOOTER)) {
    out = out.split(LEGACY_GATEWAY_FOOTER).join(GATEWAY_FOOTER);
  }

  const rewriteLine = (line) => {
    if (/sfi\.run_analysis/.test(line)) return line;

    // Checklist: "I called `sfi.foo`" → gateway wording
    line = line.replace(
      /I called `sfi\.([a-z0-9_]+)`/g,
      (full, name) => {
        const tool = normalizeToolName(name);
        if (isCoreTool(tool)) return full;
        return `I called \`sfi.run_analysis\` for \`${tool}\``;
      },
    );

    // "**Fire** `sfi.foo`" / "**Call** `sfi.foo`"
    line = line.replace(
      /\*\*(Fire|Call)\*\*\s+`sfi\.([a-z0-9_]+)`/g,
      (full, verb, name) => {
        const tool = normalizeToolName(name);
        if (isCoreTool(tool)) return full;
        return `**${verb}** \`sfi.run_analysis\` with \`{ "name": "${tool}", "args": { … } }\``;
      },
    );

    // "Call `sfi.foo`" / "Fire `sfi.foo`" / "Invoke `sfi.foo`" / "Run `sfi.foo`"
    line = line.replace(
      /\b(Call|call|Fire|fire|Invoke|invoke|Run|run|Calls|calls)\s+`sfi\.([a-z0-9_]+)`/g,
      (full, verb, name) => {
        const tool = normalizeToolName(name);
        if (isCoreTool(tool)) return full;
        const lead =
          verb[0] === verb[0].toUpperCase()
            ? verb[0].toUpperCase() + verb.slice(1).toLowerCase()
            : verb.toLowerCase();
        // "Calls" → "Call"
        const normalizedLead = lead.replace(/^calls$/i, 'Call').replace(/^Calls$/, 'Call');
        return `${normalizedLead} \`sfi.run_analysis\` with \`{ "name": "${tool}", "args": { … } }\``;
      },
    );

    return line;
  };

  out = out
    .split('\n')
    .map(rewriteLine)
    .join('\n');

  return out;
}
