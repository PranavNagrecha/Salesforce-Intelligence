/**
 * The product's public-facing URLs, in one place.
 *
 * ## Why this module exists
 *
 * These strings are read by packages that cannot import each other.
 * `FEEDBACK_ISSUES_URL` lived in `packages/cli/src/commands/feedback.ts`, which
 * is fine for `doctor` but unreachable from `packages/mcp` — `cli` depends on
 * `mcp`, so an import the other way is a cycle. The alternative was a second
 * literal in the MCP tree, which is this repo's documented root cause: a copy
 * held in step by nothing but a comment. `core` is the one package both sides
 * already depend on, so the constant moves here and both sides DERIVE it.
 *
 * ## Why the MCP server needs the issues URL at all
 *
 * `sfi.setup_status` is the tool a stranger reaches when the server started but
 * found no vault. That is the single moment when a first run is most likely to
 * be failing, and it was the one surface with no way to tell the maintainer
 * anything — it offered a docs link and nothing else. The repository has had
 * issues open and unrestricted since it was published and has never received
 * one; a feedback channel that only appears in `sfi doctor` and at line 686 of
 * a 724-line README is a channel that exists for people who already succeeded.
 */

/** Public issue tracker. Also `bugs.url` in the published package manifest. */
export const FEEDBACK_ISSUES_URL =
  'https://github.com/PranavNagrecha/Salesforce-Intelligence/issues';

/** Documentation site. Also `homepage` in the published package manifest. */
export const DOCS_URL = 'https://sfi.auditforce.cloud';
