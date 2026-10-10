/**
 * rehype plugin for Markdown pages (src/content/guides). Applies the site's
 * markup conventions at build time so Markdown cannot ship the bugs the
 * hand-written pages were fixed for:
 *
 *   - every <table> gets class "doc-table" (there is no bare `table` CSS rule;
 *     `npm run verify-markup` fails the build on an unclassed table)
 *   - every <pre> is wrapped in the framed .code-block with a .cb-head label,
 *     the same markup the older pages use, so the copy button lands in the
 *     header without a layout shift (site.ts only appends the button);
 *     shell and one-line blocks get "wrap" so a long command is never clipped
 *
 * No dependencies: walks the hast tree directly.
 */
const LABELS = {
  bash: "Terminal",
  sh: "Terminal",
  shell: "Terminal",
  json: "JSON",
  jsonc: "JSON",
  toml: "TOML",
  xml: "XML",
  yaml: "YAML",
  text: "Text",
};

const el = (tagName, className, children) => ({
  type: "element",
  tagName,
  properties: className ? { className: [className] } : {},
  children,
});

function textOf(node) {
  if (node.type === "text") return node.value;
  return (node.children ?? []).map(textOf).join("");
}

function langOf(pre) {
  const code = pre.children.find((c) => c.type === "element" && c.tagName === "code");
  const fromCode = (code?.properties?.className ?? []).find((c) => String(c).startsWith("language-"));
  const fromPre = pre.properties?.dataLanguage;
  return (fromCode ? String(fromCode).slice(9) : fromPre) || "";
}

const isDevDetails = (n) => n.tagName === "details" && (n.properties?.className ?? []).includes("tool-call");

/*
 * Raw tool output inside "For developers" (<details class="tool-call">)
 * stays a plain <pre>: no copy button, the same look as the /demo disclosure.
 * In Markdown the <details> tags reach this plugin as separate `raw` siblings
 * around the fenced block, so track open/close across siblings as well.
 */
const OPEN_DEV = /<details\b[^>]*class="[^"]*\btool-call\b/;
const CLOSE_DETAILS = /<\/details>/;

function walk(node, inDev = false) {
  if (!node.children) return;
  let dev = inDev;
  node.children = node.children.map((child) => {
    if (child.type === "raw") {
      if (OPEN_DEV.test(child.value)) dev = true;
      if (CLOSE_DETAILS.test(child.value)) dev = inDev;
      return child;
    }
    if (child.type !== "element") return child;
    if (child.tagName === "table") {
      const cls = child.properties.className ?? [];
      if (!cls.includes("doc-table")) child.properties.className = [...cls, "doc-table"];
    }
    if (child.tagName === "pre" && !dev) {
      const lang = langOf(child);
      const label = LABELS[lang] ?? "Snippet";
      const block = el("div", "code-block", [el("div", "cb-head", [el("span", "fname", [{ type: "text", value: label }])]), child]);
      // Shell commands and one-liners wrap; a clipped command looks complete when it isn't.
      if (LABELS[lang] === "Terminal" || !textOf(child).trim().includes("\n")) block.properties.className.push("wrap");
      return block;
    }
    walk(child, dev || isDevDetails(child));
    return child;
  });
}

export default function rehypeGuides() {
  return (tree) => walk(tree);
}
