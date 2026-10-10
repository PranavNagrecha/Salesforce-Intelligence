/**
 * /tools.json — the tool catalog in machine-readable form, for agents and
 * directories that would otherwise scrape /tools.
 *
 * Built from src/data/tools.json (written by recalibrate.mjs from the product's
 * own registry), so it can never disagree with /tools or llms-full.txt.
 */
import type { APIRoute } from "astro";

import site from "../data/site.ts";
import siteData from "../data/site-data.json";
import toolsData from "../data/tools.json";

export const GET: APIRoute = () => {
  const tools = toolsData.sections.flatMap((s) =>
    s.tools.map((t) => ({
      name: t.name,
      group: s.label,
      description: t.description,
      core: t.core,
      readOnly: t.readOnly,
      // The release this catalog describes (each entry is true as of it).
      version: siteData.version,
    })),
  );
  const body = {
    name: site.name,
    description: "sf-intelligence, a read-only Salesforce MCP server. Every tool it lists, grouped by what it answers.",
    version: siteData.version,
    homepage: `${site.url}/`,
    npm: site.npm,
    registeredToolCount: siteData.toolCount,
    listedToolCount: tools.length,
    coreToolCount: tools.filter((t) => t.core).length,
    notes:
      "core: listed and directly invokable under the default SFI_TOOL_PROFILE=core; other tools run through sfi.run_analysis. " +
      "readOnly mirrors the MCP readOnlyHint annotation the server advertises. Registered minus listed = back-compat aliases.",
    tools,
  };
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
};
