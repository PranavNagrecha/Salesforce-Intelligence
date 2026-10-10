/**
 * Real answers from the built-in demo org ("Verdant Energy", a synthetic solar
 * installer that ships inside the npm package and is served by
 * `sf-intelligence demo`).
 *
 * Every component, id, count and condition below was copied from the tool's
 * actual output, recorded with the release named in site-data.json. Counts
 * shown in the UI are DERIVED from these arrays, never typed. If the demo org
 * changes, re-run the calls listed in `tool` and update this file:
 *
 *   node sf-intelligence-qa/scripts/.tmp-demo-call.mjs packages/cli/bin/sfi.js \
 *     'sfi.safe_to_delete_field::{"fieldId":"CustomField:Invoice__c.Amount__c"}'
 *
 * The plain-language wording is ours; the facts are the tool's.
 */
import handbookMarkdown from "./demo-invoice-handbook.md?raw";

export type Tone = "no" | "ok" | "warn" | "neutral";

export interface Cite {
  /** Plain-language component type, e.g. "Apex class". */
  kind: string;
  /** Readable name. */
  name?: string;
  /** Raw canonical id exactly as the tool returned it. */
  id?: string;
  /** Short API name for compact chips (chat panel). */
  api?: string;
}

export interface CitedItem {
  cite: Cite;
  /** Bold lead-in sentence. */
  lead?: string;
  text?: string;
  /** Components this item points at (e.g. a deleted field's dependents). */
  related?: Cite[];
}

export interface AnswerGroup {
  label: string;
  items: CitedItem[];
  /** Render as an ordered sequence (save order). */
  ordered?: boolean;
  /** Shown when items is empty. */
  empty?: string;
}

export interface DemoAnswer {
  slug: string;
  persona: string;
  tab: string;
  question: string;
  verdict: { tone: Tone; pill: string; text: string };
  groups: AnswerGroup[];
  /** What the tool checked: found / none found / not checked (plain category names). */
  checked?: { found: string[]; none: string[]; notChecked: string[] };
  notes: string[];
  next: string;
  tool: { name: string; args: Record<string, unknown> };
  /** Raw output excerpt to show under "See the raw answer" (verbatim). */
  raw?: { label: string; text: string };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/* ---------------------------------------------------------------------------
 * 1. Admin: can I delete a field?   sfi.safe_to_delete_field
 * ------------------------------------------------------------------------- */
const deleteBlocking: CitedItem[] = [
  {
    cite: { kind: "Apex class", name: "PaymentService", id: "ApexClass:PaymentService" },
    lead: "Reads the field.",
    text: "Salesforce will refuse the delete while this code references it.",
  },
  {
    cite: { kind: "Formula field", name: "Invoice Balance", api: "Balance__c", id: "CustomField:Invoice__c.Balance__c" },
    lead: "Uses the field",
    text: "in its formula.",
  },
  {
    cite: { kind: "Roll-up summary", name: "Project › Total Invoiced", api: "Total_Invoiced__c", id: "CustomField:Project__c.Total_Invoiced__c" },
    lead: "Sums the field",
    text: "across a project’s invoices.",
  },
];

/**
 * "Not checked" is DERIVED from the tool's own coverage report, so the list
 * cannot drift from what the tool says it skipped. `missingCoverage` is
 * copied verbatim from coverageCaveat.missingCoverage; NAME_MATCH reflects the
 * `name-match` entry in checkedCategories (status "not-checked"). A family
 * with no plain-language label fails the build instead of disappearing.
 */
const deleteMissingCoverage = [
  "AssignmentRule", "AuraDefinitionBundle", "AutoResponseRule", "CustomMetadataRecord", "Dashboard",
  "EmailTemplate", "EscalationRule", "FlexiPage", "LightningComponentBundle", "ListView", "OmniUiCard",
  "QuickAction", "Report", "ReportType", "RestrictionRule", "ScopingRule", "VisualforceComponent",
  "VisualforcePage", "WebLink",
];
const FAMILY_LABEL: Record<string, string> = {
  Report: "Reports, dashboards and list views",
  Dashboard: "Reports, dashboards and list views",
  ReportType: "Reports, dashboards and list views",
  ListView: "Reports, dashboards and list views",
  FlexiPage: "Lightning pages and components",
  LightningComponentBundle: "Lightning pages and components",
  AuraDefinitionBundle: "Lightning pages and components",
  VisualforcePage: "Visualforce",
  VisualforceComponent: "Visualforce",
  QuickAction: "Quick actions and buttons",
  WebLink: "Quick actions and buttons",
  AssignmentRule: "Assignment, auto-response and escalation rules",
  AutoResponseRule: "Assignment, auto-response and escalation rules",
  EscalationRule: "Assignment, auto-response and escalation rules",
  RestrictionRule: "Restriction and scoping rules",
  ScopingRule: "Restriction and scoping rules",
  OmniUiCard: "OmniStudio cards",
  EmailTemplate: "Email templates",
  CustomMetadataRecord: "DLRS roll-up definitions",
};
const NAME_MATCH = "Plain-text mentions of the field name in code";
const notCheckedFrom = (families: string[]): string[] => {
  const labels = families.map((f) => {
    const label = FAMILY_LABEL[f];
    if (!label) throw new Error(`demo-answers: no plain label for not-checked family "${f}"`);
    return label;
  });
  // Display order: the order of FAMILY_LABEL above (most familiar first).
  return [...new Set(Object.values(FAMILY_LABEL))].filter((l) => labels.includes(l));
};

export const deleteField: DemoAnswer = {
  slug: "delete-field",
  persona: "Admin",
  tab: "Delete a field",
  question: "Can I delete the Amount field on Invoice?",
  verdict: { tone: "no", pill: "No", text: `${plural(deleteBlocking.length, "thing depends", "things depend")} on it.` },
  groups: [{ label: "Blocking", items: deleteBlocking }],
  checked: {
    found: ["Apex", "Formulas", "Roll-ups"],
    none: ["Flows", "Workflow rules", "Validation rules"],
    notChecked: [...notCheckedFrom(deleteMissingCoverage), NAME_MATCH],
  },
  notes: [
    "“Not checked” means those kinds of metadata were not in the snapshot, so the answer says so instead of claiming nothing is there.",
    "It also flags Amount as financial data (a pattern match, not a certainty), so a delete may need a data-retention sign-off.",
  ],
  next: "change those three first, then delete the field.",
  tool: { name: "sfi.safe_to_delete_field", args: { fieldId: "CustomField:Invoice__c.Amount__c" } },
};

/* ---------------------------------------------------------------------------
 * 2. Admin / architect: who can edit?   sfi.who_can_access_object
 * ------------------------------------------------------------------------- */
const canEdit: CitedItem[] = [
  {
    cite: { kind: "Permission set", name: "Finance Team", id: "PermissionSet:Finance_Team" },
    lead: "Read, Create, Edit, View All",
    text: "on every record.",
  },
  {
    cite: { kind: "Profile", name: "Verdant Sales Rep", id: "Profile:Verdant_Sales_Rep" },
    lead: "Read, Create, Edit",
    text: "on records shared with them.",
  },
];
const leftOut: CitedItem[] = [
  { cite: { kind: "Profile", name: "Verdant Read Only", id: "Profile:Verdant_Read_Only" }, text: "Read only." },
  { cite: { kind: "Group", name: "Finance Group", id: "Group:Finance_Group" }, text: "Sharing access only." },
];

export const whoCanEdit: DemoAnswer = {
  slug: "who-can-edit",
  persona: "Admin · Architect",
  tab: "Who can edit",
  question: "Who can edit Invoices?",
  verdict: {
    tone: "neutral",
    pill: `${canEdit.length} can edit`,
    text: "one permission set and one profile.",
  },
  groups: [
    { label: "Can edit", items: canEdit },
    { label: "Left out on purpose", items: leftOut },
  ],
  notes: [
    "Record owners, manual sharing and team access are record data, not metadata, so the answer lists them as things it cannot see offline.",
  ],
  next: "Invoice sharing is Controlled by Parent, so what Sales Reps can see follows the parent record’s sharing. Review that before changing access.",
  tool: { name: "sfi.who_can_access_object", args: { componentId: "CustomObject:Invoice__c", accessLevel: "edit" } },
};

/* ---------------------------------------------------------------------------
 * 3. Developer: what runs on save?   sfi.what_happens_on_save
 * ------------------------------------------------------------------------- */
const saveSteps: CitedItem[] = [
  {
    cite: { kind: "Before trigger", name: "ProjectTrigger", id: "ApexTrigger:ProjectTrigger" },
    text: "Calls ProjectTriggerHandler, which sets Risk Score.",
  },
  {
    cite: { kind: "Validation rule", name: "Complete Requires Permit", id: "ValidationRule:Project__c.Complete_Requires_Permit" },
    text: "Blocks Status = Complete until Permit Approved is checked.",
  },
  { cite: { kind: "Save", name: "Record is saved" } },
  {
    cite: { kind: "After trigger", name: "ProjectTrigger", id: "ApexTrigger:ProjectTrigger" },
    text: "Calls ProjectTriggerHandler again.",
  },
  {
    cite: { kind: "Flow", name: "Project On Approve", id: "Flow:Project_On_Approve" },
    text: "When Status is Approved, creates a Permit record, so Permit’s own automation runs too.",
  },
  {
    cite: { kind: "Approval process", name: "Discount Approval", id: "ApprovalProcess:Project__c.Discount_Approval" },
    text: "Applies when Contract Value is over 50,000.",
  },
];

export const saveOrder: DemoAnswer = {
  slug: "save-order",
  persona: "Developer",
  tab: "What runs on save",
  question: "What runs when a Project is saved?",
  verdict: { tone: "neutral", pill: `${saveSteps.length} steps`, text: "in the order Salesforce runs them." },
  groups: [{ label: "In order", items: saveSteps, ordered: true }],
  notes: [
    "No step writes back to Project, so there is no save loop here. When one does, the answer names it.",
    "Conditions are listed, not evaluated against a specific record.",
  ],
  next: "the flow creates a Permit record, so ask the same question about Permit to see what that sets off.",
  tool: { name: "sfi.what_happens_on_save", args: { objectApiName: "Project__c", event: "update" } },
};

/* ---------------------------------------------------------------------------
 * 4. Admin: what sets a field to a value?   sfi.why_field_changed + value
 * ------------------------------------------------------------------------- */
const maySetPaid: CitedItem[] = [
  {
    cite: { kind: "Apex class", name: "PaymentService", id: "ApexClass:PaymentService" },
    lead: "Writes Status.",
    text: "The value is set in code, which the snapshot does not capture, so read the class to confirm.",
  },
];

export const setsValue: DemoAnswer = {
  slug: "sets-value",
  persona: "Admin",
  tab: "What sets a value",
  question: "What sets Invoice Status to Paid?",
  verdict: {
    tone: "warn",
    pill: `${maySetPaid.length} may set it`,
    text: "nothing sets Paid outright in the metadata.",
  },
  groups: [
    { label: "Definitely sets Paid", items: [], empty: "None found in the metadata." },
    { label: "May set Paid", items: maySetPaid },
    { label: "Cannot set Paid", items: [], empty: "None found." },
  ],
  notes: [
    "Never modelled: managed-package code and automation, dynamic Apex, integrations and API loads, data imports, and manual edits. An empty “definitely sets” list is not proof that nothing sets the value.",
  ],
  next: "open PaymentService and find where it assigns Status.",
  tool: { name: "sfi.why_field_changed", args: { fieldId: "CustomField:Invoice__c.Status__c", value: "Paid" } },
};

/* ---------------------------------------------------------------------------
 * 5. Architect / release: is this deployment risky?   sfi.review_change
 * ------------------------------------------------------------------------- */
const reviewBlocking: CitedItem[] = [
  {
    cite: { kind: "Field · deleted", name: "Invoice › Amount", id: "CustomField:Invoice__c.Amount__c" },
    lead: "Deleting it breaks what depends on it.",
    related: deleteBlocking.map((i) => i.cite),
  },
];
const reviewFirst: CitedItem[] = [
  {
    cite: { kind: "Flow · changed", name: "Project On Approve", id: "Flow:Project_On_Approve" },
    lead: "No dependents found,",
    text: "but Lightning pages, Lightning components and quick actions were not in the snapshot, so it can’t call this safe.",
  },
];

export const deployRisk: DemoAnswer = {
  slug: "deployment-risk",
  persona: "Architect · Release",
  tab: "Is this deploy risky",
  question: "Is this deployment risky? It deletes Invoice Amount and changes the Project On Approve flow.",
  verdict: {
    tone: "no",
    pill: "No-go",
    text: `${plural(reviewBlocking.length, "blocking change", "blocking changes")}, ${plural(reviewFirst.length, "to review", "to review")}.`,
  },
  groups: [
    { label: "Blocking", items: reviewBlocking },
    { label: "Review first", items: reviewFirst },
  ],
  notes: [
    "A change it cannot fully check is marked “review”, never “safe”.",
    "No overlapping field writes or save loops on Invoice or Project involve these changes.",
    "You can hand it a package.xml, a destructiveChanges.xml or the file list from a git diff instead of naming components.",
  ],
  next: "move PaymentService, the Balance formula and the roll-up off Amount, then run the review again.",
  tool: {
    name: "sfi.review_change",
    args: {
      components: [
        { componentId: "CustomField:Invoice__c.Amount__c", changeKind: "deleted" },
        { componentId: "Flow:Project_On_Approve", changeKind: "modified" },
      ],
    },
  },
};

/* ---------------------------------------------------------------------------
 * 6. New to the org: brief me on an object.   sfi.object_360 format handbook
 * ------------------------------------------------------------------------- */
export const objectBrief: DemoAnswer = {
  slug: "object-brief",
  persona: "New to the org",
  tab: "Brief me on an object",
  question: "Brief me on the Invoice object.",
  verdict: { tone: "neutral", pill: "One-page brief", text: "written for someone new to the org." },
  groups: [
    {
      label: "What it is",
      items: [
        {
          cite: { kind: "Custom object", name: "Invoice", id: "CustomObject:Invoice__c" },
          text: "An invoice billed against a Project for solar installation work. Child of Project via master-detail.",
        },
      ],
    },
    {
      label: "Key fields (top 3 of 6)",
      items: [
        { cite: { kind: "Currency · required", name: "Amount", id: "CustomField:Invoice__c.Amount__c" }, text: "Total amount billed on this invoice before payments are applied. Used by 3 components." },
        { cite: { kind: "Picklist", name: "Status", id: "CustomField:Invoice__c.Status__c" }, text: "Draft · Sent · Paid · Overdue. Used by 2 components." },
        { cite: { kind: "Roll-up summary", name: "Total Paid", id: "CustomField:Invoice__c.Total_Paid__c" }, text: "Sum of all Payment amounts applied to this invoice." },
      ],
    },
    {
      label: "Connected to",
      items: [
        { cite: { kind: "Parent · master-detail", name: "Project", id: "CustomObject:Project__c" } },
        { cite: { kind: "Child · master-detail", name: "Payment", id: "CustomObject:Payment__c" }, text: "Deleting an Invoice deletes its Payments." },
      ],
    },
  ],
  notes: [
    "The full brief also covers what runs on save, who can access it, integrations and risk signals, such as “1 of 6 custom fields have neither a description nor help text”.",
  ],
  next: "share the brief with whoever is new, then ask what runs when an Invoice is saved.",
  tool: { name: "sfi.object_360", args: { objectApiName: "Invoice__c", format: "handbook" } },
  raw: { label: "See the full brief, exactly as returned", text: handbookMarkdown.trim() },
};

/** Order used on /demo. The home page shows the first three. */
export const demoAnswers: DemoAnswer[] = [deleteField, whoCanEdit, saveOrder, setsValue, deployRisk, objectBrief];
export const homeAnswers: DemoAnswer[] = [deleteField, whoCanEdit, saveOrder];
