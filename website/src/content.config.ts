/**
 * Content collections.
 *
 * `guides` holds the Markdown articles under src/content/guides/<section>/<name>.md
 * (blog posts, how-to pages, error pages, comparison round-ups, setup guides).
 * One dynamic route per section renders them through ArticleLayout:
 *   src/pages/{blog,how-to,errors,compare,setup}/[slug].astro
 *
 * The entry id is the file path without ".md" ("how-to/delete-picklist-value"),
 * and the frontmatter `slug` must equal "/" + id, so the URL can never drift
 * from the file that produces it.
 */
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

export const SECTIONS = ["blog", "how-to", "errors", "compare", "setup"] as const;

/** YAML dates parse to Date; keep them as YYYY-MM-DD strings for JSON-LD and display. */
const isoDate = z.union([z.date(), z.string()]).transform((v) =>
  (v instanceof Date ? v.toISOString() : v).slice(0, 10),
);

const guides = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/guides",
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
  schema: z
    .object({
      title: z.string().min(10).max(70),
      description: z.string().min(70).max(170),
      slug: z.string().regex(/^\/[a-z0-9-]+\/[a-z0-9-]+$/),
      section: z.enum(SECTIONS),
      targetQuery: z.string(),
      persona: z.string().optional(),
      datePublished: isoDate,
      dateModified: isoDate,
      /** Visible H1. */
      heading: z.string(),
      /** Answer-first box, inline Markdown. */
      answer: z.string().optional(),
      /** Lede under the H1 (release posts), inline Markdown. */
      intro: z.string().optional(),
      schemaType: z.enum(["Article", "TechArticle", "HowTo"]).default("Article"),
      steps: z.array(z.string()).optional(),
      /** Inline Markdown answers. Rendered with FAQPage JSON-LD. */
      faq: z.array(z.object({ q: z.string(), a: z.string() })).default([]),
      related: z.array(z.string().regex(/^\/[a-z0-9/-]*$/)).default([]),
      /** End-of-page demo CTA; false when the page carries its own (host-specific setup pages). */
      cta: z.union([z.literal(false), z.object({ question: z.string() })]).default({ question: "Can I delete the Amount field on Invoice?" }),
    })
    .refine((d) => d.slug.split("/")[1] === d.section, { message: "slug must start with /<section>/" }),
});

export const collections = { guides };
