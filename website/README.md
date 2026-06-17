# sf-intelligence — marketing & docs site

A self-contained static website for the `sf-intelligence` product. No build step,
no framework, no dependencies — just HTML, one CSS file, and a tiny progressive-
enhancement JS file. Designed to be **fully indexable by Google** and friendly to
AI answer engines, and to deploy to **Cloudflare Pages** (or any static host) with zero configuration.

> This repo intentionally ships **no Salesforce org data and no product source code** —
> only marketing/docs content. Keep it that way: build it independently of the
> private product repo so nothing sensitive (or any git history) leaks into a public repo.

## Run it locally

The pages use **root-absolute paths** (`/assets/...`, `/capabilities.html`), so opening
`index.html` directly with a `file://` URL will not load the CSS. Serve the folder over
HTTP instead — any one of these from inside this directory:

```sh
# Python 3 (preinstalled on macOS)
python3 -m http.server 8000

# or Node, if you prefer
npx serve .
```

Then open <http://localhost:8000>. Edit a file, refresh the browser — that's the loop.

## What's in here

```
index.html            Landing page (hero, features, how-it-works, trust, install)
capabilities.html     Full capability map (the 8 areas + live plane)
getting-started.html  Install + first-run guide (HowTo structured data)
faq.html              FAQ (FAQPage structured data for rich results)
404.html              Custom not-found page (served by the static host)
robots.txt            Allows all crawlers + AI bots; points to the sitemap
sitemap.xml           All four indexable pages
site.webmanifest      PWA manifest
llms.txt              Summary for AI / answer-engine crawlers (GEO)
.nojekyll             Legacy static-host marker (harmless; unused on Cloudflare)
assets/css/style.css  The single stylesheet — Terminal/Phosphor theme (VT323 + JetBrains Mono)
assets/js/main.js     Copy buttons, mobile nav, 404 path echo (site works without it)
assets/img/           Favicon, OG image, and the brand SVG diagrams
```

## SEO checklist (already done)

- Unique `<title>` + meta description, canonical URL, and robots meta on every page
- Open Graph + Twitter Card tags + a 1200×630 OG image on every page
- JSON-LD structured data: `SoftwareApplication`, `WebSite`, `Organization`,
  `BreadcrumbList`, `HowTo`, `FAQPage`, `ItemList`
- `sitemap.xml` + `robots.txt` + `llms.txt`
- Favicon set (SVG + PNG), Apple touch icon, PWA manifest, theme color
- Semantic HTML5, one `<h1>` per page, alt text on images, skip link, ARIA labels
- Design: "Terminal / Phosphor" aesthetic — pitch black, P1-phosphor green, amber accent,
  CRT scanlines, VT323 + JetBrains Mono (fonts loaded via Google Fonts with preconnect +
  `display=swap`). Honors `prefers-reduced-motion` (kills flicker/boot animation).
- Strong Core Web Vitals: a single small CSS file, no framework, no layout shift; the only
  network request beyond the page itself is the two web fonts.

## Recalibrating the numbers (single source of truth)

Every computed number on the site — tool count, skills, slash commands, component/edge
types, the ~3,100 test count + per-package table, integration-suite count — is **derived
from the product source**, not hand-maintained. Whenever the product changes, re-run:

```sh
# from this directory. Auto-detects the product repo: the PARENT (when this site is
# nested at sf-intelligence/website) or a sibling (../sf-intelligence). The product
# must be built. Override the location with SFI_PRODUCT_DIR=/path/to/sf-intelligence
node recalibrate.mjs
```

It imports the live tool registry (`V01_TOOLS`), counts every `*.test.ts` case, runs the
product's own surface math, then:
- writes **`site-data.json`** — the calibrated snapshot (diffable each run),
- regenerates **`tools.html`** and **`llms-full.txt`** from the tool registry,
- rewrites every inline number across `index.html`, `capabilities.html`, `trust.html`,
  `llms.txt`, and the OG card, and rebuilds **`og-image.png`** from the SVG,
- prints a `PREVIOUS -> NOW` diff so you see exactly what moved.

It's **idempotent** — run it any time; if nothing changed in the product, nothing changes
on the site. The per-package table on `trust.html` lives between
`<!--PKGTABLE:start-->` / `<!--PKGTABLE:end-->` markers (regenerated, don't hand-edit).
Editorial values that aren't computed from source (the CI gate list, scale budgets, the
per-package descriptions) are constants at the top of `recalibrate.mjs`.

> Requires the product built: `(cd .. && pnpm -r build)` (the product is this folder's
> parent). Run this before every deploy so the published numbers match the version you ship.

## Site URL

All absolute URLs (canonical, Open Graph, sitemap, robots, structured data) are set to
**`https://salesforce-intelligence.pages.dev`** (the Cloudflare Pages default). If you add a
**custom domain** later, re-point them in one pass (this also fixes the `recalibrate.mjs`
template so it sticks):

```sh
# from this directory — swap in your domain (no trailing slash)
OLD="https://salesforce-intelligence.pages.dev"; NEW="https://your-domain.example"
grep -rl "$OLD" --include="*.html" --include="*.xml" --include="*.txt" --include="*.mjs" . \
  | xargs sed -i '' "s|$OLD|$NEW|g"   # macOS sed; drop the '' on Linux
node recalibrate.mjs                  # regenerate tools.html + llms-full.txt with the new URL
```

## Deploy to Cloudflare Pages (same repo, this subfolder)

This site lives inside the **private** product repo at `website/`. Cloudflare Pages serves
**only the Root directory you point it at**, so the product code/history is never published.

1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick this
   private repo (Cloudflare's Git integration can read private repos).
2. Build settings:
   - **Production branch:** `main` — a stable branch, **not** `release/*`
   - **Framework preset:** None · **Build command:** *(empty)* · **Build output directory:** `/`
   - **Root directory:** `website`  ← critical; this is what keeps only the site public
3. Deploy. Every push to `main` that touches `website/` auto-deploys.

> ⚠️ Get **Root directory = `website`** right. If it's blank, Cloudflare would serve the
> repo root (the whole product). The root-absolute paths (`/assets/...`) work because
> Cloudflare serves this folder at the domain root. `.assetsignore` keeps maintainer files
> (`recalibrate.mjs`, `SEO-STRATEGY.md`, `site-data.json`) from being served.

Prefer no Git at all? Direct-upload just this folder instead:
`npx wrangler pages deploy . --project-name salesforce-intelligence`.

## Google Search Console

1. Add `https://salesforce-intelligence.pages.dev` (or your custom domain) at
   <https://search.google.com/search-console>.
2. Verify ownership — easiest is the **HTML tag** method: paste the
   `<meta name="google-site-verification" ...>` tag into the `<head>` of `index.html`
   (right under the other meta tags), redeploy, then click Verify.
3. Submit `/sitemap.xml` under **Sitemaps**.
4. Use **URL Inspection → Request indexing** on each page to speed up first indexing.
