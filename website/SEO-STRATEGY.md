# sf-intelligence — SEO & Traffic Strategy

> Planning doc for the marketing site. Not part of the deployed site. Delete or
> gitignore before pushing the public repo if you'd rather keep it private.
> Keyword volumes/difficulty are **ESTIMATES** — DataForSEO/Google APIs were not
> connected when this was written. Re-validate with `/seo-dataforseo` or Search
> Console once live.

Date: 2026-06-04 (rev 2026-06-12) · Site: live · canonical URL `https://salesforce-intelligence.pages.dev` (Cloudflare Pages)

---

## 0. The one-paragraph reality check

A brand-new domain with zero authority does not rank for competitive terms for
months. For a niche developer tool, **search is not the top of the funnel — it's
the closer.** Discovery happens in MCP registries, GitHub/npm, and communities;
AI assistants and Google then send people who already heard the name to this
site to convert. So this plan optimizes the site for **(a) winnable long-tail +
AI-citation queries** and pours first-90-days energy into **(b) the registries
and communities that actually drive the first visitors.**

---

## 1. Positioning: pick the niche the giants left open

The "Salesforce MCP server" space is already crowded — and mostly by Salesforce
itself:

| Competitor | What it is | Why we don't fight it head-on |
| --- | --- | --- |
| **Salesforce DX MCP Server** (`salesforcecli/mcp`) | Official, 60+ tools: DevOps, LWC, deploy/retrieve, run Apex/tests | First-party; owns the head term; **writes/deploys**. |
| **Salesforce Data 360 MCP**, **Metadata API Context MCP**, **Agentforce Vibes MCP** | Official, dev/data/agent tasks | First-party, dev-task oriented. |
| **advancedcommunities/salesforce-mcp-server** | Community MCP: Apex exec, SOQL, metadata mgmt | Live + **write-capable**. |
| **Sweep** | Commercial SaaS: metadata ingest + process mining + dependency mapping | Paid platform, not free/local/MCP-first. |
| **Elements.cloud / Metazoa Snapshot / Salto / Strongpoint (Netwrix) / Sonar** | Paid enterprise org-documentation & dependency platforms | Expensive, not conversational, not MCP-native. |

**Our wedge (say it everywhere):** the only **free, offline, read-only,
MCP-native** tool built for *understanding* a Salesforce org — impact analysis,
dependency tracing, permissions, and documentation — that **never writes to the
org** and **answers from real metadata, not a guess.** "Read-only / offline /
safe / grounded" is the entire differentiation. Lead with it.

---

## 2. Keyword strategy (mapped to pages)

Don't target the head term "Salesforce MCP server" head-on (Salesforce.com wins).
Target it *modified* and go deep on problem/long-tail intent where intent is high
and competition is thin.

### Tier A — primary, winnable, money intent
| Keyword (est. difficulty) | Target page | Notes |
| --- | --- | --- |
| offline Salesforce knowledge base | `/` | Near-zero competition; our exact category. |
| read-only Salesforce MCP server | `/` + new `/mcp` | Modifier makes the head term winnable. |
| Salesforce impact analysis tool (free) | `/capabilities` + new use-case page | "what breaks if I delete…" |
| Salesforce metadata dependency analysis | `/capabilities` | Strong, specific. |
| free Salesforce org documentation tool | new use-case page | vs paid Elements/Metazoa. |
| generate Salesforce data dictionary | use-case page | Feature → query match. |

### Tier B — problem queries (great for use-case pages + GEO)
- "what breaks if I delete a field in Salesforce"
- "where is this field used in Salesforce"
- "why can't a user see a record Salesforce"
- "what runs when a record is saved Salesforce order of execution"
- "find unused fields / dead Apex Salesforce"
- "document an inherited Salesforce org"
- "Salesforce sandbox vs production metadata diff"

### Tier C — informational / GEO (FAQ + glossary; AI-citation bait)
- "is a Salesforce MCP server safe / read-only"
- "does an MCP server send my Salesforce data to the cloud"
- "what is a Salesforce MCP server"
- "best Salesforce MCP servers" (get listed in others' listicles)
- "Salesforce metadata MCP for Claude / Cursor"

### Tier D — comparison / alternative (high commercial intent)
- "sf-intelligence vs Salesforce DX MCP Server"
- "free alternative to Elements.cloud / Metazoa Snapshot / Sonar"
- "read-only alternative to salesforce-mcp-server"

### Existing-page keyword map
| Page | Primary | Secondary |
| --- | --- | --- |
| `/` | offline Salesforce knowledge base | read-only Salesforce MCP server; ask your Salesforce org questions |
| `/capabilities.html` | Salesforce impact analysis tool | dependency analysis; metadata tools; what-if change analysis |
| `/getting-started.html` | install Salesforce MCP server (Claude) | set up sf-intelligence; Salesforce CLI MCP |
| `/faq.html` | is a Salesforce MCP server read-only | offline Salesforce metadata; data privacy |

✅ Done already: "Salesforce" now in every `<title>` and `<h1>`; key phrases in hero.
⚠️ Keep density natural (~1–1.5%); do not replace every "org" with "Salesforce org".

---

## 3. Content roadmap (what to build next)

The 5 pages cover the product. Traffic needs **intent-matched pages** beyond it.
Priority order:

1. **`/mcp` (or reframe home section)** — "Read-only Salesforce MCP server" landing.
   Targets the modified head term; explains MCP setup for Claude/Cursor/Codex.
2. **Use-case pages** (one tight page each — these match Tier-B problem queries 1:1):
   - `/use-cases/impact-analysis` — "what breaks if I delete a Salesforce field"
   - `/use-cases/org-documentation` — "document an inherited Salesforce org"
   - `/use-cases/sharing-troubleshooting` — "why can't a user see a record"
   - `/use-cases/code-quality` — dead Apex, governor limits, test gaps
3. **Comparison pages** (use the `/seo-competitor-pages` skill):
   - `/compare/salesforce-dx-mcp-server` (official vs read-only/offline)
   - `/compare/elements-cloud-alternative` / `/compare/metazoa-alternative` (free vs paid)
4. **`/glossary`** — short, citable definitions ("MCP", "metadata vault", "provenance",
   "impact analysis", "order of execution"). Excellent GEO/AI-citation surface.
5. **Light blog/changelog** — release notes + 1 post/month on a Tier-B problem.
   Cadence over volume; thin content hurts.

Each new page: unique title/description/canonical, one `<h1>` with the target term,
`BreadcrumbList` + (use-case) `HowTo` or (comparison) `FAQPage`/`Article` schema,
internal links to/from `/capabilities` and `/`.

---

## 4. Non-search acquisition (the real first-90-days traffic)

This is how anyone hears about it at all. Do these **before/at launch.**

### A. MCP registries (highest leverage — high-intent audience)
Prepare the metadata once (name, one-liner, description, install command, repo URL,
license, tags: `salesforce`, `metadata`, `read-only`, `offline`), then submit to:
1. **Official MCP Registry** (`registry.modelcontextprotocol.io`) — canonical, do first.
2. **mcp.so** — most cited when people search "list of MCP servers." Highest leverage.
3. **Glama** (`glama.ai/mcp`) — curated; needs README + valid license + no vulns → you
   qualify (MIT + Commons Clause, clean). The "seal of approval."
4. **Smithery** (`smithery.ai`).
5. **PulseMCP** — largest hand-reviewed directory.
6. **`punkpeye/awesome-mcp-servers`** (GitHub PR) + other `awesome-mcp` lists.
7. Secondary aggregators (aiagentslist, tokenmix, popularaitools listicles).

### B. GitHub + npm
- Treat the **README as your real landing page** — it's what devs read first.
- GitHub topics: `mcp`, `model-context-protocol`, `salesforce`, `salesforce-cli`,
  `metadata`, `claude`. npm `keywords` field: same set.
- Ask early users for stars; pin the repo; clear LICENSE + SECURITY + CONTRIBUTING.

### C. Community (where Salesforce people are)
- r/salesforce, **Salesforce Stack Exchange**, Trailblazer Community, Salesforce
  Discord/Slack groups.
- **Salesforce Ben** actively covers MCP (they published an MCP explainer) — pitch a
  mention or guest post; it's the genre's biggest blog.
- LinkedIn (Salesforce admin/dev influencers), **dev.to**, **Show HN** at launch.

### D. GEO / AI-search (compounding, low-effort)
- `llms.txt` is already shipped. Make the site **the obviously-correct answer** to
  "read-only / offline Salesforce MCP server" so ChatGPT/Claude/Perplexity cite it.
- Get into others' "best Salesforce MCP servers" listicles (Sweep, Salesforce Ben).
- Keep passages short, declarative, and factual (the FAQ + glossary are built for this).

---

## 5. Implementation checklist

### Pre-launch (do now, before go-live) — mostly done
- [x] Unique title/description/canonical/robots per page
- [x] "Salesforce" in every `<h1>` and `<title>`
- [x] OG/Twitter + 1200×630 card; favicon set; manifest; theme-color
- [x] JSON-LD: SoftwareApplication, WebSite, Organization, BreadcrumbList, HowTo, FAQPage, ItemList
- [x] sitemap.xml, robots.txt (AI crawlers allowed), llms.txt
- [x] Responsive verified; lab CWV healthy (system → web fonts now, swap + preconnect)
- [x] **Google site verification** meta tag on homepage (2026-06-10)
- [x] **MCP landing page** `/mcp.html` — read-only Salesforce MCP server (2026-06-10, release/0.1.10)
- [x] **Use-case pages** — `/use-cases/impact-analysis.html`, `/use-cases/sharing-troubleshooting.html` (2026-06-10)
- [x] **Comparison page** — `/compare/salesforce-dx-mcp.html` (2026-06-10)
- [x] **Glossary** — `/glossary.html` for GEO/AI citation (2026-06-10)
- [x] **Phase 13 feature surfacing** — configuration.html + homepage 0.1.10 highlights (2026-06-10)
- [ ] **Optimize OG PNG** — currently ~700 KB; target < 200 KB (visual asset only, no rush)
- [ ] Run `/seo-audit` against the local site (technical/schema/content) and fix findings
- [ ] Prepare the **registry submission metadata** packet (one-time, reused everywhere)

### Launch week
- [ ] Deploy to the public GitHub Pages repo (built clean — no PII / no product source)
- [ ] Submit to the 6 MCP registries (Section 4A)
- [ ] Verify in **Google Search Console**, submit sitemap, Request Indexing per page
- [ ] (Optional) Bing Webmaster Tools + IndexNow
- [ ] GitHub topics + npm keywords set; README polished
- [ ] Show HN + 1 community post (r/salesforce or Salesforce Ben pitch)

### Post-launch (weeks 2–12)
- [ ] Run `/seo-google` (GSC + PageSpeed/CrUX + GA4) once data accrues
- [ ] Build use-case pages (Section 3.2) — 1/week
- [ ] Build 2 comparison pages (Section 3.3)
- [ ] `/seo-dataforseo` to replace the estimated volumes with real ones; reprioritize

---

## 6. KPI targets — **ESTIMATES** for a zero-authority niche dev-tool site

| Metric | Launch | 3 mo | 6 mo | 12 mo |
| --- | --- | --- | --- | --- |
| Organic clicks/mo | 0 | 50–150 | 200–600 | 800–2,500 |
| Ranked keywords (top 20) | 0 | 10–25 | 40–90 | 120–250 |
| Referral (registries+community)/mo | 0 | 300–800 | 500–1,500 | 1,000–3,000 |
| GitHub stars | — | 50–200 | 200–600 | 600–2,000 |
| Indexed pages | 0 | 5–8 | 12–18 | 20–30 |
| Lab CWV (LCP/CLS/INP) | green | green | green | green |

Reality: **referral + AI-citation traffic will exceed organic search for the first
6+ months.** Search compounds later. Treat npm installs / GitHub stars as the real
north-star, not search clicks.
