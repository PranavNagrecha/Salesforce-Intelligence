# Adoption baseline — the $800K OSS-asset scoreboard

**Purpose.** sf-intelligence is free, OSS, offline-first by design. Its strategic
value (the path to a ~$800K asset acquisition) is driven by **adoption + mindshare**,
not revenue. This file is the honest scoreboard: the North-star metrics, today's
baseline, the targets, and exactly how to re-measure. Re-measure at each Phase-21
workstream checkpoint and record the new column.

All numbers here are **public** (GitHub/npm APIs) — no org data. Last measured **2026-06-25**.

## Scoreboard

| Metric | Baseline (2026-06-25) | 90-day target | "$800K-credible" |
| --- | --- | --- | --- |
| GitHub stars | **0** | 250+ | 2,000+ |
| GitHub forks | 0 | 25+ | 200+ |
| External contributors | 0 (solo) | 2+ | 8+ |
| npm downloads / 30d | **1,214** (largely non-organic) | 2,000+ organic | 20,000+ organic |
| MCP directory listings | 0 | 6 | 6 + featured |
| GitHub Releases published | 0 | every shipped version | ongoing |
| Named / visible users | 0 | 3 | 15+ |
| Public proof artifacts (video/blog/posts) | 0 | video + 3 posts | ongoing cadence |

## Honest read of the baseline

- **0 stars / 0 forks / 1 contributor.** The public repo was (re)created 2026-06-17;
  it is excellent but undiscovered. This is the bottleneck — not capability.
- **~1,214 downloads/30d is largely NOT organic.** It tracks release-day spikes +
  CI/automated fetches, not real adopters. Treat organic weekly downloads (once
  registry listings + content drive traffic) as the real signal.
- **0 directory listings, 0 Releases, 0 content.** All addressable in Phase 21
  (npm metadata + server.json shipped; submissions are user-gated).
- CI is green and Actions enabled (a trust signal), and `npx sf-intelligence demo`
  now gives a zero-org trial (the #1 conversion lever).

## How to re-measure (copy/paste)

```bash
# GitHub (stars / forks / watchers / issues)
gh repo view PranavNagrecha/Salesforce-Intelligence \
  --json stargazerCount,forkCount,watchers,issues
# contributors / releases
gh api repos/PranavNagrecha/Salesforce-Intelligence/contributors --jq 'length'
gh release list -R PranavNagrecha/Salesforce-Intelligence | wc -l

# npm — latest version + last-30d downloads
npm view sf-intelligence version
curl -s "https://api.npmjs.org/downloads/range/last-month/sf-intelligence" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.downloads.reduce((a,b)=>a+b.downloads,0))})"

# AI-citation spot-check (manual): ask Perplexity/ChatGPT "best offline Salesforce MCP server"
# and record whether sf-intelligence is named.
```

## GitHub traffic capture (14-day retention)

GitHub's traffic API keeps views/clones for only ~14 days. Re-measure stars etc.
whenever you like; **traffic must be captured on a cadence** or the signal is
lost.

**Cadence:** at least weekly (daily is fine). From the product repo root:

```bash
pnpm adoption:traffic
# or: node scripts/capture-github-traffic.mjs
```

- Resolves the current repo via `gh repo view` (no hardcoded owner/repo).
- Appends one JSONL row of **aggregate** `views` + `clones` counts only
  (deliberately omits popular paths / referrers).
- Writes to `.sfi-local/adoption/github-traffic.jsonl` (gitignored). Override
  with `SFI_ADOPTION_TRAFFIC_PATH`.
- Requires `gh` authenticated with access to the traffic endpoints (`repo` scope).

## Measurement log

| Date | Stars | Forks | Contributors | npm dl/30d | Listings | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-06-25 | 0 | 0 | 1 | 1,214 | 0 | Baseline. PR #1 (Phase 21 WS-A demo + guards) open; CI green. |
