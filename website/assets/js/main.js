/* sf-intelligence site — progressive enhancement only.
   The site is fully functional with JS disabled; this just adds polish. */
(function () {
  "use strict";

  /* ---- mobile nav toggle ---- */
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("mobile-menu");
  if (toggle && menu) {
    toggle.addEventListener("click", function () {
      var open = menu.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        menu.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---- auto-enhance: give every code block a copy button ----
     Any <pre> not already inside a .code-block (with its own .copy-btn)
     gets wrapped and a button injected, so commands are copyable on every
     page without per-page markup. */
  function makeCopyBtn() {
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.setAttribute("aria-label", "Copy to clipboard");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<rect x="9" y="9" width="13" height="13" rx="2"/>' +
      '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
      '<span class="copy-label">copy</span>';
    return btn;
  }
  document.querySelectorAll("pre").forEach(function (pre) {
    var block = pre.closest(".code-block");
    if (block) {
      // already wrapped — just ensure it has a copy button
      if (block.querySelector(".copy-btn")) return;
      var head = block.querySelector(".cb-head");
      if (!head) {
        head = document.createElement("div");
        head.className = "cb-head";
        var f = document.createElement("span");
        f.className = "fname";
        f.textContent = pre.getAttribute("data-label") || "snippet";
        head.appendChild(f);
        block.insertBefore(head, pre);
      }
      head.appendChild(makeCopyBtn());
      return;
    }
    // bare <pre> — wrap it and add chrome + button
    var wrap = document.createElement("div");
    wrap.className = "code-block";
    var hd = document.createElement("div");
    hd.className = "cb-head";
    var fname = document.createElement("span");
    fname.className = "fname";
    fname.textContent = pre.getAttribute("data-label") || "snippet";
    hd.appendChild(fname);
    hd.appendChild(makeCopyBtn());
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(hd);
    wrap.appendChild(pre);
  });

  /* ---- copy-to-clipboard for code blocks ---- */
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var sel = btn.getAttribute("data-copy-target");
      var node = sel ? document.querySelector(sel) : btn.closest(".code-block").querySelector("pre");
      if (!node) return;
      var text = node.innerText.trim();
      var done = function () {
        var label = btn.querySelector(".copy-label");
        var prev = label ? label.textContent : "";
        btn.classList.add("copied");
        if (label) label.textContent = "Copied";
        setTimeout(function () {
          btn.classList.remove("copied");
          if (label) label.textContent = prev || "Copy";
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  /* ---- mark current year in footer ---- */
  var y = document.getElementById("year");
  if (y) y.textContent = new Date().getFullYear();

  /* ---- 404: echo the path the visitor actually tried ---- */
  var pathEl = document.getElementById("path");
  if (pathEl) {
    var tried = (location.pathname + location.search).replace(/^\//, "");
    if (tried && tried !== "404.html") pathEl.textContent = tried;
  }
})();
