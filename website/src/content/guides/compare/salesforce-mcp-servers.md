---
title: "Salesforce MCP Servers Compared (2026): Which to Use"
description: "A fair 2026 comparison of Salesforce MCP servers: DX MCP, Salesforce hosted MCP, Elements.cloud, Clientell, salesforce-metadata-mcp and sf-intelligence."
slug: /compare/salesforce-mcp-servers
targetQuery: "best salesforce mcp server"
persona: "Salesforce architect, developer or admin choosing an MCP server for Claude, Cursor or VS Code"
datePublished: 2026-10-10
dateModified: 2026-10-10
faq:
  - q: "What is a Salesforce MCP server?"
    a: "A small program that lets an AI assistant such as Claude, Cursor or GitHub Copilot call Salesforce-aware tools. Some act on your org (query, update, deploy). Others read your metadata and explain it."
  - q: "Is the Salesforce DX MCP server going away?"
    a: "Yes. Its README says @salesforce/mcp reaches end of life on November 2, 2026. The npm package stays installable but gets no more releases. Salesforce names its skills repository, forcedotcom/sf-skills, as the replacement."
  - q: "Can I run more than one Salesforce MCP server at the same time?"
    a: "Yes. AI hosts load several servers side by side. A common setup pairs one server that acts on the org with one that explains the org's metadata."
  - q: "Which Salesforce MCP servers never write to the org?"
    a: "Among the ones on this page: Clientell says its MCP reads, plans and drafts only. sf-intelligence never writes. Salesforce hosted MCP, DX MCP and salesforce-metadata-mcp can all change the org."
  - q: "Does my metadata leave my computer?"
    a: "It depends on the server. Hosted and SaaS servers run in the vendor's cloud. Local servers run on your machine. With any server, your AI host sends what the tools return to its own model provider."
related:
  - /setup/vs-code-copilot
  - /how-to/pre-deployment-impact-review
  - /errors/maximum-trigger-depth-exceeded
  - /compare/salesforce-dx-mcp
  - /compare/elements-cloud
section: compare
heading: "Salesforce MCP servers compared (2026)"
answer: "Pick by job. To change records from chat, use Salesforce's hosted MCP servers. To build metadata from chat in a sandbox, salesforce-metadata-mcp has the most tools. To understand what a change will break, before you make it, use a reader such as sf-intelligence (free, local) or Elements.cloud (paid, hosted). Many teams run one of each."
schemaType: TechArticle
cta:
  question: "Is it risky to delete Invoice__c.Amount__c?"
---
*Last verified 2026-10-10. This page is published by sf-intelligence, one of the products listed. Every claim about another product links to that vendor's own page. If something is out of date, [open an issue](https://github.com/PranavNagrecha/Salesforce-Intelligence/issues) and we will fix it.*

## The six servers at a glance

| Server | Acts on the org | Reads metadata to explain it | Where it runs | Price |
|---|---|---|---|---|
| Salesforce DX MCP | Yes (deploy, retrieve, SOQL, tests) | Retrieves metadata files; no impact analysis described | Your computer | Free (Apache-2.0). End of life Nov 2, 2026 |
| Salesforce hosted MCP | Yes (records, plus custom tools) | Not described | Salesforce | Enterprise Edition and above. Usage may be billed (Flex Credits) |
| Elements.cloud MCP | No changes described | Yes, from Elements' synced copy | Elements' cloud | Licensed plan, price quoted by sales |
| Clientell MCP | No ("plans only") | Yes, plus Slack, Gmail, Jira context | Clientell's cloud | From $249/month for 10 people |
| salesforce-metadata-mcp | Yes (create objects, fields, flows, Apex and more) | Some (a read-only dependency tool) | Your computer | Free (MIT) |
| sf-intelligence | No, never | Yes, with each component cited | Your computer, offline after setup | Free (MIT + Commons Clause) |

## Salesforce DX MCP server

Salesforce's local server for developers, published as `@salesforce/mcp` ([GitHub](https://github.com/salesforcecli/mcp)).

- **What it does:** Groups tools into toolsets. They include deploying and retrieving metadata, running SOQL, running Apex tests, and managing orgs, users and DevOps Center work.
- **Setup:** `npx -y @salesforce/mcp --orgs DEFAULT_TARGET_ORG --toolsets ...` in your host's config. It uses orgs you already authorized with the Salesforce CLI.
- **Notes:** Telemetry is on by default and `--no-telemetry` turns it off. The README warns that enabling every tool "can overwhelm the LLM context".
- **Status:** The README says the package "reaches end of life on November 2nd, 2026". The [announcement issue](https://github.com/forcedotcom/mcp/issues/46) says the npm package will stay installable but deprecated, and points to Salesforce's skills repository as the replacement.

**Use it for:** deploys and test runs from chat today. Plan for the move after November.

## Salesforce hosted MCP servers

MCP endpoints that Salesforce runs for you. Salesforce announced [general availability on April 29, 2026](https://developer.salesforce.com/blogs/2026/04/salesforce-hosted-mcp-servers-are-now-generally-available).

- **What it does:** The [developer guide](https://developer.salesforce.com/docs/platform/hosted-mcp-servers/guide) lists reading, creating, updating and deleting records. You can also expose Apex invocable actions, Apex REST, flows and named queries as tools, plus Data 360 and Tableau.
- **Security:** Each user signs in with OAuth. Salesforce says CRUD, field-level security and sharing rules apply, and each action runs as that user.
- **Availability and cost:** The announcement says Enterprise Edition and above. The guide says the servers are intended for customers with Flex Credits and "you may be billed for server usage".
- **Not covered:** Neither page describes metadata dependency or impact analysis.

**Use it for:** letting an AI assistant read and update records with each user's own permissions.

## Elements.cloud MCP

A remote server on top of Elements.cloud's metadata platform ([support article](https://support.elements.cloud/en/articles/15921418-elements-mcp-server-connect-understand-secure-troubleshoot)).

- **What it does:** Answers questions from the metadata Elements has synced from your org, and runs assessments such as health checks and migration plans.
- **Setup:** A regional HTTPS endpoint with OAuth sign-in. Elements has tested it with Claude, Codex, ChatGPT and Cursor, and documents VS Code setup.
- **Cost:** MCP access is part of the Advanced Metadata Management plan. Elements' [pricing page](https://elements.cloud/pricing) lists Core from $6,800 a year for 100 org users. Advanced is quoted by sales.

**Use it for:** teams that already use Elements for documentation and governance.

## Clientell MCP

A hosted server that adds a "Context Graph" of your Salesforce metadata, plus work context from Slack, Gmail and Jira ([Clientell's comparison page](https://www.getclientell.com/compare/clientell-vs-salesforce-hosted-mcp), updated September 2, 2026).

- **What it does:** Indexes objects, fields, flows, validation rules and permission sets. Clientell says its MCP "reads, plans, and drafts only, by design". You make the change.
- **Cost:** From $249 a month for 10 people on one production org, plus $25 per extra person. A 14-day trial is offered.
- **Fair note:** Clientell's own page calls Salesforce's hosted servers "real, general-availability" and the faster path for record access.

**Use it for:** teams that want org answers that also draw on Slack, email and Jira history.

## salesforce-metadata-mcp

A community-built, MIT-licensed local server ([GitHub](https://github.com/semwalajay83-sem/salesforce-metadata-mcp), version 3.2.0 on npm).

- **What it does:** 228 tools for building and configuring an org from chat. Examples: create objects, fields, flows and Apex, and work with Agentforce, OmniStudio and DevOps Center.
- **Setup:** `npx -y salesforce-metadata-mcp` with an instance URL and access token, or other sign-in methods in its setup guide.
- **Safety:** On production orgs, a guard blocks nine risky tools by default, such as deleting metadata or records, running anonymous Apex and managing users. Creating Apex classes and triggers is not blocked. The guard does not apply to sandboxes, scratch orgs or Developer Edition orgs.
- **Context size:** Loads a small core of tools first and the rest on demand.

**Use it for:** building metadata by chat in a sandbox or scratch org.

## sf-intelligence

A free local server that reads one org's metadata and explains it ([npm](https://www.npmjs.com/package/sf-intelligence), [GitHub](https://github.com/PranavNagrecha/Salesforce-Intelligence)).

- **What it does:** Retrieves your metadata once with the Salesforce CLI, then answers offline. Typical questions: what breaks if I delete this field, what runs when I save this record, who can edit this object, is this deployment risky. Every answer names the components it is based on.
- **Never writes:** It has no tools that change the org. An optional live mode runs capped, read-only queries, and only after you turn it on.
- **Where data lives:** On your computer. Like any MCP server, your AI host sends tool answers to its own model.
- **Limits:** Answers reflect the last refresh. It does not hold record data by default. It cannot see inside managed packages. It needs Node.js 20 or later and the Salesforce CLI.
- **Hosts:** Claude Code, Claude Desktop, Cursor, VS Code with GitHub Copilot, and Codex.

**Use it for:** impact analysis, onboarding to an unfamiliar org, and pre-deployment review, at no cost and without sending metadata to a third-party service.

## Which one when

| You want to... | Use | Pair it with |
|---|---|---|
| Update records from chat, with each user's permissions | Salesforce hosted MCP | sf-intelligence, to check what a field change triggers first |
| Deploy, retrieve and run tests from chat | DX MCP (until Nov 2, 2026), or the Salesforce CLI directly | sf-intelligence, to review the change set before deploying |
| Build objects, fields and flows by chat in a sandbox | salesforce-metadata-mcp | sf-intelligence, to see what the new pieces touch |
| Keep org documentation and governance in one SaaS tool | Elements.cloud | Hosted MCP, for record work |
| Combine org structure with Slack, email and Jira history | Clientell | Hosted MCP, for record work |
| Understand impact for free, with metadata on your laptop | sf-intelligence | Any of the servers above that act |

The honest pattern: one server to **act**, one to **understand**. A server that can change the org is the wrong place to ask "is this safe?" The reverse is also true: a reader can tell you what will break, but it cannot fix it for you.

## How we checked

Each vendor claim was checked on 2026-10-10 against the vendor's own README, documentation, pricing page or announcement, linked above. Download counts and star counts were left out on purpose. They change weekly and say little about fit.
