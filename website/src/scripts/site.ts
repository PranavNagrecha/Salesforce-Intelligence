/* sf-intelligence site behaviour. Progressive enhancement only: every page is
   readable and navigable with JavaScript off. Bundled and content-hashed by
   Astro (replaces the old unhashed /assets/main.js). */

const live = (): HTMLElement => {
  let el = document.getElementById("sr-live");
  if (!el) {
    el = document.createElement("p");
    el.id = "sr-live";
    el.className = "sr-only";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
};

/* ---- Tabs: any [role=tablist] controls the panels named in aria-controls.
   A URL hash naming a panel (or a tab) opens that tab on load. ---- */
function initTabs(): void {
  document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((list) => {
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'));
    const select = (tab: HTMLElement, focus: boolean): void => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls") || "");
        if (panel) {
          panel.hidden = !on;
          panel.removeAttribute("data-tab-hidden");
        }
      });
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (e) => {
        let n: HTMLElement | null = null;
        if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") n = tabs[0];
        else if (e.key === "End") n = tabs[tabs.length - 1];
        if (n) {
          e.preventDefault();
          select(n, true);
        }
      });
    });
    if (!tabs.length) return;
    const hash = decodeURIComponent(location.hash.slice(1));
    const fromHash = hash
      ? tabs.find((t) => t.id === hash || t.getAttribute("aria-controls") === hash || t.dataset.slug === hash)
      : undefined;
    select(fromHash ?? tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? tabs[0], false);
    if (fromHash) list.scrollIntoView({ block: "start" });
  });
}

/* ---- Copy to clipboard, with a textarea fallback for non-secure contexts ---- */
function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => fallbackCopy(text),
    );
  }
  return Promise.resolve(fallbackCopy(text));
}
function copyIcon(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.setAttribute("aria-label", "Copy to clipboard");
  btn.innerHTML = '<span class="copy-label">Copy</span>';
  return btn;
}
function textFor(btn: HTMLElement): string {
  const direct = btn.getAttribute("data-copy");
  if (direct) return direct;
  const targetId = btn.getAttribute("data-target");
  if (targetId) return document.getElementById(targetId)?.textContent?.trim() ?? "";
  const legacy = btn.getAttribute("data-copy-target");
  if (legacy) return (document.querySelector(legacy) as HTMLElement | null)?.innerText.trim() ?? "";
  const block = btn.closest(".code-block, .code-card");
  return (block?.querySelector("pre") as HTMLElement | null)?.innerText.trim() ?? "";
}
function initCopy(): void {
  /* Older pages: give every bare <pre> a framed block and a copy button. */
  document.querySelectorAll<HTMLPreElement>("pre").forEach((pre) => {
    if (pre.closest(".code-card, .tool-call, .no-copy")) return;
    let block = pre.closest(".code-block");
    if (!block) {
      block = document.createElement("div");
      block.className = "code-block";
      pre.parentNode?.insertBefore(block, pre);
      block.appendChild(pre);
    }
    if (block.querySelector(".copy-btn")) return;
    let head = block.querySelector(".cb-head");
    if (!head) {
      head = document.createElement("div");
      head.className = "cb-head";
      const f = document.createElement("span");
      f.className = "fname";
      f.textContent = pre.getAttribute("data-label") || "Snippet";
      head.appendChild(f);
      block.insertBefore(head, pre);
    }
    head.appendChild(copyIcon());
  });

  document.querySelectorAll<HTMLElement>(".copy-btn").forEach((btn) => {
    const label = btn.querySelector(".copy-label");
    const original = (label ?? btn).textContent ?? "Copy";
    btn.addEventListener("click", () => {
      void copyText(textFor(btn)).then((ok) => {
        (label ?? btn).textContent = ok ? "Copied" : "Press Ctrl+C";
        live().textContent = ok ? "Copied to clipboard" : "Copy failed. Select the text and copy it manually.";
        window.setTimeout(() => {
          (label ?? btn).textContent = original;
        }, 1800);
      });
    });
  });
}

/* ---- Mobile menu ---- */
function initMenu(): void {
  const btn = document.querySelector<HTMLButtonElement>(".menu-btn");
  const nav = document.getElementById("site-nav");
  if (!btn || !nav) return;
  const set = (open: boolean): void => {
    nav.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  btn.addEventListener("click", () => set(!nav.classList.contains("open")));
  nav.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).tagName === "A") set(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && nav.classList.contains("open")) {
      set(false);
      btn.focus();
    }
  });
}

/* ---- Theme toggle: data-theme on <html> overrides the OS preference ---- */
function initTheme(): void {
  const root = document.documentElement;
  const btn = document.getElementById("theme-btn");
  if (!btn) return;
  const isDark = (): boolean => {
    const t = root.getAttribute("data-theme");
    if (t) return t === "dark";
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  };
  const label = (): void => {
    btn.textContent = isDark() ? "Switch to light" : "Switch to dark";
  };
  label();
  btn.addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sfi-theme", next);
    } catch {
      /* private mode: the choice lasts for this page only */
    }
    label();
  });
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", label);
}

/* ---- 404: echo the path the visitor tried ---- */
function initNotFound(): void {
  const el = document.getElementById("path");
  if (!el) return;
  const tried = (location.pathname + location.search).replace(/^\//, "");
  if (tried && tried !== "404.html" && tried !== "404") el.textContent = "/" + tried;
}

initTabs();
initCopy();
initMenu();
initTheme();
initNotFound();
