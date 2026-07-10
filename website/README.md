# sf-intelligence — marketing & docs site (Astro)

The product's public site, rebuilt on **Astro** (static output). Deploys to
**Cloudflare Pages**. Same Terminal/Phosphor design as before; the framework
buys reusable components, a typed data pipeline, an auto-generated priority
sitemap, and a single SEO component so every page ships correct
canonical/OG/JSON-LD by construction.

> Ships **no product source and no org data** — Cloudflare serves only `dist/`,
> which is built from `src/` + `public/`. The product source never enters the
> output.

## Develop

```sh
npm install
npm run dev          # http://localhost:4321
npm run build        # → dist/  (static)
npm run preview -- --port 4455   # serve the build
npm run crawl-test   # crawler-friendliness gate against the running preview
```

## Structure

```
src/
  data/site.ts            Brand/URL/identity constants (one source of truth)
  data/site-data.json     COMPUTED numbers (tool count, tests…) — from recalibrate.mjs
  data/tools.json         Grouped tool registry — from recalibrate.mjs
  components/SeoHead.astro Every page's <head>: title/canonical/OG/Twitter/JSON-LD @graph
  components/Header,Footer Shared nav/footer (incl. visible GitHub link)
  layouts/Base.astro      html/head/body shell; inlines the CSS
  layouts/DocPage.astro   Base + breadcrumb sub-hero for content pages
  pages/*.astro           One file per route (use-cases/ and compare/ are nested)
  styles/style.css        Terminal/Phosphor theme (ported verbatim)
public/                   Verbatim assets: robots.txt, llms.txt, llms-full.txt,
                          _headers, site.webmanifest, assets/img/, GSC verify file
scripts/crawl-test.mjs    The crawlability CI gate (no deps)
recalibrate.mjs           Regenerates the data files from the built product
```

## Recalibrate (the numbers)

Every computed number is derived from the **product source**, not hand-typed.
Run this from the product repo (it imports `packages/mcp/dist`) — it does NOT
run in Cloudflare's build (Cloudflare only sees this folder):

```sh
# product must be built first: (cd .. && pnpm -r build)
node recalibrate.mjs
```

It writes `src/data/site-data.json` + `src/data/tools.json` and regenerates
`public/llms.txt` + `public/llms-full.txt`. Astro renders the numbers from those
files at build time (Zod-shaped `.json` imports — a shape mismatch is a build
error, not a silent stale number). Run it before every deploy that follows a
product release.

## Cloudflare Pages settings (CHANGE from the old static config)

The old site had no build step. Astro needs one:

| Setting | Old | New |
|---|---|---|
| Root directory | `website` | `website` (unchanged) |
| Framework preset | None | None (static Astro needs no adapter) |
| Build command | *(empty)* | `npm run build` |
| Build output directory | `/` | `dist` |
| Node version | — | `22` (`.nvmrc` present) |

`public/_headers` (cache/security) and the GSC verification file carry over
verbatim. `404.astro` is auto-served by Cloudflare on unmatched routes.

## SEO / crawler gate

`npm run crawl-test` asserts, for every sitemap URL: 200 · one self-canonical ·
one index H1 · valid JSON-LD · no noindex · description in range · og/twitter
present · every internal link resolves · no orphan pages · robots welcomes AI
crawlers. Wire it into CI on any change to this folder, and run it post-deploy
against the live URL.
