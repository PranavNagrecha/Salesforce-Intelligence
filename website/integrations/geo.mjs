// @ts-check
/**
 * geo — generates the AI-agent surface from the BUILT site, at build time.
 *
 *   dist/llms.txt       header (src/data/llms-header.md, counts filled from
 *                       site-data.json) + every indexable page that was built,
 *                       grouped by section, each with its own <title> and
 *                       meta description.
 *   dist/llms-full.txt  llms.txt + the full tool catalog from src/data/tools.json.
 *
 * Why at build and from dist/: llms.txt used to be a hand-kept list. It
 * missed /agent-skills, /ai-safety, /blog and /use-cases, and every new post
 * was an orphan until someone remembered to add it. Reading the pages Astro
 * actually emitted makes "built but not listed" impossible, and the build
 * fails if a page lacks the title/description/canonical the entry needs.
 *
 * Runs on Cloudflare's build too: it needs only the website folder.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://sfi.auditforce.cloud";

/** Sections, in output order. First matching prefix wins; "/" matches exactly. */
const SECTIONS = [
  { title: "Start here", match: ["/", "/demo", "/getting-started", "/setup", "/mcp", "/capabilities", "/faq"] },
  { title: "Use cases", match: ["/use-cases"] },
  { title: "How-to guides", match: ["/how-to"] },
  { title: "Error guides", match: ["/errors"] },
  { title: "Compare", match: ["/compare"] },
  { title: "Blog", match: ["/blog"] },
  { title: "Reference", match: ["/tools", "/configuration", "/glossary", "/agent-skills", "/ai-safety", "/trust"] },
  { title: "Optional", match: ["/licensing"] },
];
const FALLBACK_SECTION = "More pages";

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

/** <title> without a trailing brand suffix ("| sf-intelligence", "- sf-intelligence"). */
const cleanTitle = (t) => t.replace(/\s+[|\-–—]\s+sf-intelligence$/i, "").trim();

const sectionFor = (route) => {
  for (const s of SECTIONS) {
    for (const m of s.match) {
      if (m === "/" ? route === "/" : route === m || route.startsWith(m + "/")) return s.title;
    }
  }
  return FALLBACK_SECTION;
};

/** Order inside a section: the order the prefixes are listed, hub page first, then A-Z. */
const sortKey = (route) => {
  for (const s of SECTIONS) {
    const i = s.match.findIndex((m) => (m === "/" ? route === "/" : route === m || route.startsWith(m + "/")));
    if (i !== -1) return [i, route === s.match[i] ? 0 : 1, route];
  }
  return [99, 1, route];
};

function readPage(file) {
  const html = fs.readFileSync(file, "utf8");
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1];
  const desc = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)?.[1];
  const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i)?.[1];
  const noindex = /<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(html);
  return { title: title && decode(title), desc: desc && decode(desc), canonical, noindex };
}

function fillTokens(template, data, label) {
  const out = template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    const v = data[key];
    if (v === undefined || v === null) throw new Error(`geo: ${label} uses {{${key}}}, which site-data.json does not provide`);
    return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
  });
  return out;
}

/**
 * @param {{ siteDir: string }} opts  siteDir = the website folder
 * @returns {import("astro").AstroIntegration}
 */
export default function geo({ siteDir }) {
  return {
    name: "sfi-geo",
    hooks: {
      "astro:build:done": async ({ dir, pages, logger }) => {
        const dist = fileURLToPath(dir);
        const data = JSON.parse(fs.readFileSync(path.join(siteDir, "src/data/site-data.json"), "utf8"));
        const toolsData = JSON.parse(fs.readFileSync(path.join(siteDir, "src/data/tools.json"), "utf8"));
        const tokens = {
          ...data,
          testsApprox: data.tests?.approx,
          testPackages: data.tests?.packageCount,
          listedToolCount: data.listedToolCount ?? toolsData.listedToolCount,
        };

        // ---- 1. every indexable page Astro emitted ----
        const entries = [];
        const problems = [];
        for (const { pathname } of pages) {
          const route = "/" + pathname.replace(/^\/+|\/+$/g, "");
          if (route === "/404") continue;
          const file = path.join(dist, route === "/" ? "index.html" : `${route.slice(1)}.html`);
          if (!fs.existsSync(file)) {
            // Non-HTML routes (e.g. /tools.json) arrive here too.
            continue;
          }
          const p = readPage(file);
          if (p.noindex) continue;
          if (!p.title || !p.desc || !p.canonical) {
            problems.push(`${route}: missing ${!p.title ? "<title> " : ""}${!p.desc ? "meta description " : ""}${!p.canonical ? "canonical" : ""}`);
            continue;
          }
          entries.push({ route, url: p.canonical, title: cleanTitle(p.title), desc: p.desc, section: sectionFor(route) });
        }
        if (problems.length) throw new Error("geo: pages cannot be listed in llms.txt:\n  " + problems.join("\n  "));

        // ---- 2. llms.txt ----
        const header = fillTokens(fs.readFileSync(path.join(siteDir, "src/data/llms-header.md"), "utf8"), tokens, "llms-header.md").trimEnd();
        const sectionTitles = [...SECTIONS.map((s) => s.title), FALLBACK_SECTION];
        // "Optional" has a defined meaning in the llms.txt format (skippable
        // when context is short), so it is rendered last, after Source.
        const renderSection = (title) => {
          const list = entries
            .filter((e) => e.section === title)
            .sort((a, b) => {
              const ka = sortKey(a.route);
              const kb = sortKey(b.route);
              return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
            });
          if (!list.length) return "";
          return `\n\n## ${title}\n\n` + list.map((e) => `- [${e.title}](${e.url}): ${e.desc}`).join("\n");
        };
        const body = sectionTitles.filter((t) => t !== "Optional").map(renderSection).join("");
        const optional = renderSection("Optional");
        const machine =
          "\n\n## Machine-readable\n\n" +
          [
            `- [Tool catalog as JSON](${SITE}/tools.json): every tool with its group, summary, core flag, read-only flag and the release version.`,
            `- [MCP Registry manifest](${SITE}/.well-known/mcp/server.json): a copy of the server.json published to the official MCP Registry.`,
            `- [Full context file](${SITE}/llms-full.txt): this file plus the complete tool catalog.`,
            `- [Sitemap](${SITE}/sitemap-index.xml)`,
          ].join("\n");
        const source =
          "\n\n## Source\n\n" +
          [
            "- [npm package: sf-intelligence](https://www.npmjs.com/package/sf-intelligence)",
            "- [GitHub repository](https://github.com/PranavNagrecha/Salesforce-Intelligence)",
          ].join("\n");
        const llms = header + body + machine + source + optional + "\n";
        if (/\{\{\w+\}\}/.test(llms)) throw new Error("geo: unresolved {{token}} in llms.txt");
        fs.writeFileSync(path.join(dist, "llms.txt"), llms);

        // ---- 3. llms-full.txt: llms.txt + full catalog ----
        const sections = toolsData.sections;
        const listed = sections.reduce((n, s) => n + s.tools.length, 0);
        const registered = toolsData.toolCount;
        const countPhrase = listed === registered ? `${registered}` : `${listed} listed, ${registered} registered`;
        let cat = `\n## All tools (${countPhrase})\n\nEvery read-only tool in sf-intelligence ${toolsData.version ?? data.version}, grouped by the product's own capability categories. You never call these by name: an offline router surfaces a short list and your AI assistant picks which to run. Tools marked (core) are in the default \`core\` profile and listed directly by the server; the others run through \`sfi.run_analysis\`.`;
        if (listed !== registered) {
          const aliases = registered - listed;
          cat += ` ${registered} tools are registered in this build; ${aliases} back-compat alias${aliases === 1 ? "" : "es"} fold into their canonical tool and are not listed separately.`;
        }
        cat += "\n";
        for (const s of sections) {
          cat += `\n### ${s.label} (${s.tools.length})\n\n`;
          cat += s.tools.map((t) => `- \`${t.name}\`${t.core ? " (core)" : ""}: ${t.description}`).join("\n") + "\n";
        }
        const other = sections.find((s) => s.id === "other");
        if (other && other.tools.length > 5) throw new Error(`geo: ${other.tools.length} tools under "Other" (max 5); run recalibrate.mjs`);
        fs.writeFileSync(path.join(dist, "llms-full.txt"), llms + cat);

        logger.info(`llms.txt: ${entries.length} pages in ${new Set(entries.map((e) => e.section)).size} sections; llms-full.txt: ${listed} tools`);
      },
    },
  };
}
