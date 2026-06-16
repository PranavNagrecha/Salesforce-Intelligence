/**
 * Pure-function renderers that turn graph data into Markdown documents.
 *
 * Each renderer is synchronous, deterministic, and disk-free: it takes
 * structured input (a Node plus its incident edges) and returns a
 * `RendererOutput`. Persistence is the caller's responsibility.
 */

export { renderApexMarkdown } from './apex-markdown.js';
export { renderComponentMarkdown } from './component-markdown.js';
export { renderFlowMarkdown } from './flow-markdown.js';
export {
  ORG_CARD_MAX_BYTES,
  renderOrgCard,
  type OrgCardAutomationRow,
  type OrgCardInput,
  type OrgCardNamingObservation,
  type OrgCardRendered,
  type OrgCardTopObject,
} from './org-card.js';
export { renderVaultIndex } from './vault-index.js';
export { serializeFrontmatter } from './yaml-frontmatter.js';
