/**
 * Canonical site-wide constants. One place to change brand/URL/identity so
 * every page + the SEO graph stay consistent. Numbers that move with the
 * product (tool count, tests) live in site-data.json, not here.
 */
const site = {
  name: "sf-intelligence",
  url: "https://sfi.auditforce.cloud",
  author: "Pranav Nagrecha",
  tagline: "Offline, read-only Salesforce org intelligence for AI agents.",
  npm: "https://www.npmjs.com/package/sf-intelligence",
  github: "https://github.com/PranavNagrecha/Salesforce-Intelligence",
  registry: "https://registry.modelcontextprotocol.io",
  feedbackEmail: "pranav.sfintelligence@gmail.com",
  googleVerification: "xUHB6uzGiSz1XncxiHLSMgTBPG616W90lZH_0eA30LU",
  /** sameAs targets for the Organization node (entity disambiguation). */
  sameAs: [
    "https://www.npmjs.com/package/sf-intelligence",
    "https://github.com/PranavNagrecha/Salesforce-Intelligence",
  ],
} as const;

export default site;
