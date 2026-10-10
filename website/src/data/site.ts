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
  /** The maintainer's own public profile (Person.sameAs), not the repo. */
  authorProfile: "https://github.com/PranavNagrecha",
  /**
   * Other names the product is referred to by. "sf-intelligence" alone collides
   * with unrelated products, so the entity carries the descriptive forms too.
   */
  alternateName: ["Salesforce Intelligence", "sf-intelligence Salesforce MCP server"],
  /**
   * sameAs targets for the Organization and SoftwareApplication nodes (entity
   * disambiguation). Each one is a listing of THIS server, checked live:
   * the official MCP Registry entry, npm, GitHub and Glama.
   */
  sameAs: [
    "https://registry.modelcontextprotocol.io/v0/servers/io.github.PranavNagrecha%2Fsalesforce-intelligence/versions/latest",
    "https://www.npmjs.com/package/sf-intelligence",
    "https://github.com/PranavNagrecha/Salesforce-Intelligence",
    "https://glama.ai/mcp/servers/PranavNagrecha/Salesforce-Intelligence",
  ],
} as const;

export default site;
