/**
 * Guides: the Markdown collection plus the card index (src/data/guides.json).
 *
 * guides.json is the one list every listing reads (home Guides block, /blog,
 * /how-to, /errors, related links). This module checks, at build time, that
 * the two agree: every collection entry has a card, every card for a section
 * the collection owns has an entry, and every `related` link resolves to a
 * label. A mismatch fails the build instead of shipping an orphan page or an
 * unlabeled link.
 */
import { getCollection, type CollectionEntry } from "astro:content";
import data from "../data/guides.json";

export type Section = CollectionEntry<"guides">["data"]["section"];

export interface GuideCard {
  href: string;
  section: string;
  kind: "guide" | "release";
  date: string;
  home: boolean;
  title: string;
  text: string;
}

export const cards: GuideCard[] = data.guides as GuideCard[];

/** Parent page for each section's breadcrumb. Setup guides sit under Getting started. */
export const SECTION_PARENT: Record<Section, { name: string; path: string }> = {
  blog: { name: "Guides", path: "/blog" },
  "how-to": { name: "How-to guides", path: "/how-to" },
  errors: { name: "Errors", path: "/errors" },
  compare: { name: "Compare", path: "/compare" },
  setup: { name: "Getting started", path: "/getting-started" },
};

/** Labels for pages that are not guides but are common related-link targets. */
const PAGE_LABELS: Record<string, string> = {
  "/getting-started": "Getting started",
  "/demo": "See real answers from the demo org",
  "/use-cases/where-is-a-field-used": "Where is a field used?",
  "/use-cases/what-breaks-if-you-delete-a-field": "What breaks if you delete a field?",
  "/use-cases/impact-analysis": "Impact analysis",
  "/use-cases/salesforce-dependency-analysis": "Salesforce dependency analysis",
  "/use-cases/explain-a-salesforce-flow": "Explain a Salesforce Flow",
  "/use-cases/sharing-troubleshooting": "Why can't a user see a record?",
  "/compare/salesforce-dx-mcp": "sf-intelligence vs the Salesforce DX MCP server",
  "/compare/elements-cloud": "sf-intelligence vs Elements.cloud",
};

export function labelFor(href: string): string {
  const card = cards.find((c) => c.href === href);
  if (card) return card.title;
  const label = PAGE_LABELS[href];
  if (!label) throw new Error(`guides: no label for related link ${href}. Add it to guides.json or PAGE_LABELS in src/lib/guides.ts.`);
  return label;
}

let checked = false;

/** All guide entries, validated against the card index. */
export async function getGuides(): Promise<CollectionEntry<"guides">[]> {
  const entries = await getCollection("guides");
  if (!checked) {
    const problems: string[] = [];
    const collectionSections = new Set<string>(entries.map((e) => e.data.section));
    for (const e of entries) {
      if (e.data.slug !== `/${e.id}`) problems.push(`${e.id}: frontmatter slug ${e.data.slug} does not match its file path`);
      if (!cards.some((c) => c.href === e.data.slug)) problems.push(`${e.data.slug}: no card in src/data/guides.json`);
      for (const r of e.data.related) {
        try {
          labelFor(r);
        } catch (err) {
          problems.push(`${e.data.slug}: ${(err as Error).message}`);
        }
      }
    }
    for (const c of cards) {
      const section = c.href.split("/")[1];
      // Blog and compare also hold hand-written .astro pages; other sections are collection-only.
      if (collectionSections.has(section) && section !== "blog" && section !== "compare" && !entries.some((e) => e.data.slug === c.href)) {
        problems.push(`guides.json card ${c.href} has no Markdown entry`);
      }
    }
    if (problems.length) throw new Error("guides check failed:\n  " + problems.join("\n  "));
    checked = true;
  }
  return entries;
}

export async function guidesIn(section: Section) {
  return (await getGuides()).filter((e) => e.data.section === section);
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Inline Markdown to HTML for frontmatter strings (answer box, lede, FAQ
 * answers): `code`, **bold**, *italic*, [text](url). Everything else is escaped.
 */
export function inlineMd(md: string): string {
  const codes: string[] = [];
  let s = md.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${escapeHtml(c)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, href: string) => {
      const external = /^https?:/.test(href);
      return `<a href="${href}"${external ? ' rel="noopener"' : ""}>${text}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}
