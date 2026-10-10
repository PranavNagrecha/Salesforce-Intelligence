/**
 * Shared sf-intelligence rows for the comparison pages, so every page states
 * the same facts about this product the same way.
 */
export const SFI = {
  what: "A free MCP server that answers questions about one Salesforce org from its metadata",
  where: "On your computer. The metadata snapshot never leaves it",
  writes: "Never. It has no way to write to the org",
  price: "Free",
  source: "Source available (MIT + Commons Clause)",
  hosts: "Claude Code, Claude Desktop, Cursor, VS Code + Copilot, Codex and other MCP clients",
  cites: "Names every component an answer relies on, and what it couldn’t check",
  setup: "One command for the demo org; one read-only refresh for your own",
} as const;

/** Date the competitor facts on the compare pages were last checked. */
export const VERIFIED = "2026-10-10";
