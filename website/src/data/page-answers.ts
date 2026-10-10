/**
 * More real answers from the built-in demo org (Verdant Energy), used on the
 * use-case, compare and docs pages. Same rules as demo-answers.ts: every
 * component, id and condition was copied from the tool's actual output on the
 * release named in site-data.json, and every count shown is DERIVED from the
 * arrays below, never typed.
 *
 * Re-record with:
 *   node sf-intelligence-qa/scripts/.tmp-demo-call.mjs packages/cli/bin/sfi.js \
 *     'sfi.find_component_usages::{"componentId":"CustomField:Invoice__c.Status__c"}'
 * (each answer's `tool` field holds the exact call).
 */
import type { CitedItem, DemoAnswer } from "./demo-answers.ts";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/* ---------------------------------------------------------------------------
 * Where is a field used?   sfi.find_component_usages
 * ------------------------------------------------------------------------- */
const statusUsers: CitedItem[] = [
  {
    cite: { kind: "Apex class", name: "PaymentService", id: "ApexClass:PaymentService" },
    lead: "Reads and writes Status.",
  },
  {
    cite: { kind: "Sharing rule", name: "Share Invoices To Finance", id: "SharingRule:Invoice__c.Share_Invoices_To_Finance" },
    lead: "Uses Status in its criteria",
    text: "to decide which invoices Finance can see.",
  },
];

export const whereUsed: DemoAnswer = {
  slug: "where-used",
  persona: "Admin",
  tab: "Where is a field used",
  question: "Where is the Status field on Invoice used?",
  verdict: { tone: "neutral", pill: `${plural(statusUsers.length, "component", "components")}`, text: "reference it." },
  groups: [{ label: "Used by", items: statusUsers }],
  notes: [
    "Not checked for this question: roll-up summaries, page layout placement, flow decisions and filters, and tabs and apps. The answer names them, so an empty result there is not mistaken for “unused”.",
    "A plain text search of Apex and Lightning source found nothing extra. The answer calls that weak evidence, because code rarely spells the full Invoice__c.Status__c name.",
  ],
  next: "ask “what sets Invoice Status to Paid?” to see what PaymentService does with it.",
  tool: { name: "sfi.find_component_usages", args: { componentId: "CustomField:Invoice__c.Status__c" } },
};

/* ---------------------------------------------------------------------------
 * Explain a flow.   sfi.explain_flow
 * ------------------------------------------------------------------------- */
export const explainFlow: DemoAnswer = {
  slug: "explain-flow",
  persona: "Admin · Developer",
  tab: "Explain a flow",
  question: "What does the Project On Approve flow do?",
  verdict: { tone: "neutral", pill: "After save", text: "runs on Project when Status is Approved." },
  groups: [
    {
      label: "Starts when",
      items: [
        {
          cite: { kind: "Record-triggered flow", name: "Project On Approve", id: "Flow:Project_On_Approve" },
          lead: "A Project is saved",
          text: "with Status equal to Approved. It runs after the record is saved.",
        },
      ],
    },
    {
      label: "What it does",
      items: [
        {
          cite: { kind: "Object", name: "Permit", id: "CustomObject:Permit__c" },
          lead: "Creates a Permit record",
          text: "and sets its Project and Status fields.",
        },
      ],
    },
    {
      label: "Watch out for",
      items: [
        {
          cite: { kind: "Flow · fault handling", name: "No fault path" },
          lead: "One element has no fault path.",
          text: "If it fails, Salesforce rolls back the whole Project save, not just the flow.",
        },
      ],
    },
  ],
  notes: [
    "The flow has no decisions, so there is only one path. Conditions are read from the flow’s metadata; the tool does not run the flow.",
  ],
  next: "ask “what breaks if I deactivate Project On Approve?” before you change it.",
  tool: { name: "sfi.explain_flow", args: { flowId: "Flow:Project_On_Approve" } },
};

/* ---------------------------------------------------------------------------
 * What if I deactivate this flow?   sfi.what_if_deactivate_flow
 * ------------------------------------------------------------------------- */
const deactivateStops: CitedItem[] = [
  { cite: { kind: "Object", name: "Permit", id: "CustomObject:Permit__c" }, lead: "New Permit records stop", text: "being created when a Project is approved." },
  { cite: { kind: "Field", name: "Permit › Project", id: "CustomField:Permit__c.Project__c" }, text: "No longer set by the flow." },
  { cite: { kind: "Field", name: "Permit › Status", id: "CustomField:Permit__c.Status__c" }, text: "No longer set by the flow." },
];

export const deactivateFlow: DemoAnswer = {
  slug: "deactivate-flow",
  persona: "Admin · Architect",
  tab: "Turn off a flow",
  question: "What breaks if I deactivate the Project On Approve flow?",
  verdict: { tone: "no", pill: "Blocking", text: `it stops ${plural(deactivateStops.length, "thing", "things")} the org relies on.` },
  groups: [{ label: "Stops happening", items: deactivateStops }],
  notes: [
    "Email templates were not in the snapshot, so the answer says it can’t confirm there is nothing else, instead of calling the change safe.",
    "Apex that starts the flow by name is invisible to this check, so the answer tells you to look for code callers too.",
  ],
  next: "decide what should create Permits instead, then deactivate the flow.",
  tool: { name: "sfi.what_if_deactivate_flow", args: { flowId: "Flow:Project_On_Approve" } },
};

/* ---------------------------------------------------------------------------
 * What depends on this field?   sfi.get_impact
 * ------------------------------------------------------------------------- */
const statusDependents: CitedItem[] = [
  { cite: { kind: "Apex trigger → class", name: "ProjectTrigger › ProjectTriggerHandler", id: "ApexClass:ProjectTriggerHandler" }, lead: "Reads Status", text: "every time a Project is saved." },
  { cite: { kind: "Apex batch class", name: "IncentiveBatch", id: "ApexClass:IncentiveBatch" }, lead: "Reads Status." },
  { cite: { kind: "Flow", name: "Project On Approve", id: "Flow:Project_On_Approve" }, lead: "Starts when Status is Approved." },
  { cite: { kind: "Flow", name: "Installation On Complete", id: "Flow:Installation_On_Complete" }, lead: "Writes Status." },
  { cite: { kind: "Validation rule", name: "Complete Requires Permit", id: "ValidationRule:Project__c.Complete_Requires_Permit" }, lead: "Checks Status." },
  { cite: { kind: "Formula field", name: "Is Complete", id: "CustomField:Project__c.Is_Complete__c" }, lead: "Calculated from Status." },
  { cite: { kind: "Page layout", name: "Residential Layout", id: "Layout:Project__c.Residential Layout" }, lead: "Shows the field." },
  { cite: { kind: "Sharing rule", name: "Share Projects To Ops", id: "SharingRule:Project__c.Share_Projects_To_Ops" }, lead: "Uses Status in its criteria." },
  { cite: { kind: "CRM Analytics", name: "Project Pipeline", id: "WaveXmd:Project_Pipeline" }, lead: "References the field." },
];

export const fieldDependents: DemoAnswer = {
  slug: "field-dependents",
  persona: "Architect · Developer",
  tab: "What depends on a field",
  question: "What depends on the Status field on Project?",
  verdict: { tone: "neutral", pill: `${statusDependents.length} components`, text: "across code, automation, layouts, sharing and analytics." },
  groups: [{ label: "Depends on it", items: statusDependents }],
  notes: [
    "The answer also lists the test class that writes Status and the profiles and permission set that grant access to it. Access isn’t usage, so they are kept apart from this list.",
    "Every line says how it was found: stated in the metadata, or read from parsed Apex and formula source.",
  ],
  next: "pick a new value or rename? Ask “what if I remove the Approved value from Project Status?”",
  tool: { name: "sfi.get_impact", args: { componentId: "CustomField:Project__c.Status__c" } },
};

/* ---------------------------------------------------------------------------
 * Why can't this profile see the records?   sfi.why_cant_user_see_record
 * ------------------------------------------------------------------------- */
export const whyCantSee: DemoAnswer = {
  slug: "why-cant-see",
  persona: "Admin · Support",
  tab: "Why can’t they see it",
  question: "Why can’t Installers see Invoices?",
  verdict: { tone: "no", pill: "Blocked", text: "the profile has no Read access to Invoice." },
  groups: [
    {
      label: "What decides it",
      items: [
        {
          cite: { kind: "Profile", name: "Verdant Installer", id: "Profile:Verdant_Installer" },
          lead: "No object Read permission on Invoice.",
          text: "Without it no sharing setting can show the record, so this is the one thing to fix.",
        },
      ],
    },
    {
      label: "Also checked",
      items: [
        { cite: { kind: "Org-wide default", name: "Controlled by Parent", id: "CustomObject:Invoice__c" }, text: "Invoices follow the sharing of their parent Project." },
        { cite: { kind: "Sharing rule", name: "Share Invoices To Finance", id: "SharingRule:Invoice__c.Share_Invoices_To_Finance" }, text: "Shares some invoices with Finance, depending on each record’s values." },
        { cite: { kind: "System permission", name: "View All Data" }, text: "Not on this profile." },
      ],
    },
  ],
  notes: [
    "Manual shares, sharing sets and account teams depend on record data, so they are marked “unknown” for you to check in the org, not guessed.",
  ],
  next: "add Read on Invoice through a permission set, then ask who else that permission set reaches.",
  tool: {
    name: "sfi.why_cant_user_see_record",
    args: { userContext: { profileId: "Profile:Verdant_Installer" }, objectApiName: "Invoice__c", accessLevel: "read" },
  },
};

/* ---------------------------------------------------------------------------
 * Which fields look sensitive?   sfi.pii_inventory
 * ------------------------------------------------------------------------- */
const sensitiveFields: CitedItem[] = [
  { cite: { kind: "Currency", name: "Invoice › Amount", id: "CustomField:Invoice__c.Amount__c" } },
  { cite: { kind: "Formula", name: "Invoice › Balance", id: "CustomField:Invoice__c.Balance__c" } },
  { cite: { kind: "Currency", name: "Payment › Amount", id: "CustomField:Payment__c.Amount__c" } },
  { cite: { kind: "Currency", name: "Incentive › Amount", id: "CustomField:Incentive__c.Amount__c" } },
  { cite: { kind: "Currency", name: "Battery › Unit Cost", id: "CustomField:Battery__c.Unit_Cost__c" } },
  { cite: { kind: "Currency", name: "Solar Panel › Unit Cost", id: "CustomField:Solar_Panel__c.Unit_Cost__c" } },
  { cite: { kind: "Currency", name: "Equipment Allocation › Line Total", id: "CustomField:Equipment_Allocation__c.Line_Total__c" } },
];
/** Total custom fields the scan classified (from the tool's summary). */
export const PII_SCANNED_FIELDS = 63;

export const sensitiveData: DemoAnswer = {
  slug: "sensitive-data",
  persona: "Architect · Security",
  tab: "Sensitive fields",
  question: "Which fields look like they hold sensitive data?",
  verdict: { tone: "warn", pill: `${sensitiveFields.length} of ${PII_SCANNED_FIELDS}`, text: "fields flagged as financial data." },
  groups: [{ label: "Flagged as financial", items: sensitiveFields }],
  notes: [
    "The scan reads field names, types and descriptions, never record values. A field holding personal data under an unremarkable name won’t be flagged, so “nothing found” in a category is a starting point for review, not a clean bill.",
  ],
  next: "check which profiles and agents can read these fields before you widen access.",
  tool: { name: "sfi.pii_inventory", args: {} },
};

/* ---------------------------------------------------------------------------
 * What does this Apex class touch?   sfi.get_edges (outgoing)
 * ------------------------------------------------------------------------- */
const paymentReads: CitedItem[] = [
  { cite: { kind: "Field", name: "Invoice › Amount", id: "CustomField:Invoice__c.Amount__c" } },
  { cite: { kind: "Field", name: "Invoice › Status", id: "CustomField:Invoice__c.Status__c" } },
  { cite: { kind: "Roll-up summary", name: "Invoice › Total Paid", id: "CustomField:Invoice__c.Total_Paid__c" } },
];
const paymentWrites: CitedItem[] = [
  { cite: { kind: "Field", name: "Invoice › Status", id: "CustomField:Invoice__c.Status__c" } },
];

export const apexTouches: DemoAnswer = {
  slug: "apex-touches",
  persona: "Developer",
  tab: "What a class touches",
  question: "What does the PaymentService class read and write?",
  verdict: {
    tone: "neutral",
    pill: `${paymentReads.length} reads, ${paymentWrites.length} write`,
    text: "all on Invoice.",
  },
  groups: [
    { label: "Reads", items: paymentReads },
    { label: "Writes", items: paymentWrites },
  ],
  notes: [
    "Each field comes from the parsed Apex source. The class also queries Invoice and creates Payment records; those two were found by a pattern match, and the answer labels them that way so you know to check them.",
    "Its only caller in the org is its own test class, PaymentServiceTest, and that is the one test to run after changing it.",
  ],
  next: "ask “what tests should I run if I change PaymentService?” before you deploy.",
  tool: { name: "sfi.get_edges", args: { componentId: "ApexClass:PaymentService", direction: "outgoing" } },
};

/* ---------------------------------------------------------------------------
 * Give me a tour of this org.   sfi.org_card
 * ------------------------------------------------------------------------- */
/** Recorded from sfi.org_card on the demo org (totals and component counts). */
const ORG_CARD = {
  components: 135,
  links: 350,
  counts: { objects: 13, fields: 63, flows: 2, apexClasses: 5, triggers: 1, validationRules: 3, profiles: 3, permissionSets: 2 },
  topObjects: [
    { name: "Project", id: "CustomObject:Project__c", refs: 20 },
    { name: "Invoice", id: "CustomObject:Invoice__c", refs: 6 },
    { name: "Installation", id: "CustomObject:Installation__c", refs: 5 },
  ],
} as const;

export const orgTour: DemoAnswer = {
  slug: "org-tour",
  persona: "New to the org · Consultant",
  tab: "Tour the org",
  question: "Give me a tour of this org.",
  verdict: {
    tone: "neutral",
    pill: `${ORG_CARD.counts.objects} custom objects`,
    text: `${ORG_CARD.components} components and ${ORG_CARD.links} links between them.`,
  },
  groups: [
    {
      label: "Most connected objects",
      items: ORG_CARD.topObjects.map((o) => ({
        cite: { kind: "Custom object", name: o.name, id: o.id },
        text: `Referenced by ${o.refs} other components.`,
      })),
    },
    {
      label: "Automation and code",
      items: [
        { cite: { kind: "Flows", name: String(ORG_CARD.counts.flows) } },
        { cite: { kind: "Apex classes", name: String(ORG_CARD.counts.apexClasses) } },
        { cite: { kind: "Apex triggers", name: String(ORG_CARD.counts.triggers) } },
        { cite: { kind: "Validation rules", name: String(ORG_CARD.counts.validationRules) } },
      ],
    },
    {
      label: "Access",
      items: [
        { cite: { kind: "Profiles", name: String(ORG_CARD.counts.profiles) } },
        { cite: { kind: "Permission sets", name: String(ORG_CARD.counts.permissionSets) } },
      ],
    },
  ],
  notes: [
    "The card also lists the kinds of metadata the refresh didn’t pull (reports, Lightning pages and email templates among them), so you know what the rest of the answers can’t cover.",
  ],
  next: "start with Project, the object everything else hangs off: ask for a brief on it.",
  tool: { name: "sfi.org_card", args: {} },
};

/* ---------------------------------------------------------------------------
 * What can our AI agents reach?   sfi.ai_exposure_report
 * ------------------------------------------------------------------------- */
const agentSurfaces: CitedItem[] = [
  { cite: { kind: "Agent (bot)", name: "Verdant Support Agent", id: "Bot:Verdant_Support_Agent" }, text: "No fields mapped into its context." },
  { cite: { kind: "Agent planner", name: "Verdant Support Agent v1", id: "GenAiPlannerBundle:Verdant_Support_Agent_v1" }, text: "No actions that read or write fields." },
];

export const aiExposure: DemoAnswer = {
  slug: "ai-exposure",
  persona: "Architect · Security",
  tab: "What agents can reach",
  question: "What can our AI agents reach?",
  verdict: { tone: "ok", pill: "No fields", text: `exposed through the ${plural(agentSurfaces.length, "agent component", "agent components")} it found.` },
  groups: [{ label: "Agent setup found", items: agentSurfaces }],
  notes: [
    "This reads how the agent is configured, not what it did at run time. Dialog trees and context variables that aren’t mapped to fields are outside the check, and the answer says so.",
  ],
  next: "before adding actions to the agent, ask which sensitive fields those actions would read.",
  tool: { name: "sfi.ai_exposure_report", args: {} },
};

/** Recorded from sfi.tech_debt_score on the demo org. Higher is worse (0-100). */
export const TECH_DEBT = { score: 5, band: "low debt", scoredAreas: 3, totalAreas: 6 } as const;
