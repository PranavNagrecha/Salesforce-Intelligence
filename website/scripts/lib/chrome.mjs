/**
 * chrome.mjs — a minimal headless-Chrome driver with no npm dependencies.
 *
 * Starts a local Chrome/Chromium with remote debugging and speaks the DevTools
 * protocol over Node's built-in WebSocket (Node 22+). Enough for the two jobs
 * the site scripts need: measure a page at a given viewport width
 * (crawl-test's overflow gate) and screenshot an HTML card (render-og).
 *
 * Chrome is found from $CHROME_PATH, then the usual macOS / Linux / Windows
 * install locations, then `google-chrome` / `chromium` on PATH.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of CANDIDATES) if (fs.existsSync(c)) return c;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const p = execFileSync("which", [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch {
      /* not on PATH */
    }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch Chrome and return a browser handle. Call `close()` when done. */
export async function launch() {
  const exe = findChrome();
  if (!exe) throw new Error("No Chrome/Chromium found. Install Chrome or set CHROME_PATH.");
  if (typeof WebSocket !== "function") throw new Error("Node 22+ is required (global WebSocket).");
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfi-chrome-"));
  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(userDir, "DevToolsActivePort");
  let wsPath = null;
  let port = null;
  for (let i = 0; i < 100 && !wsPath; i++) {
    await sleep(100);
    if (fs.existsSync(portFile)) {
      const [p, ws] = fs.readFileSync(portFile, "utf8").trim().split("\n");
      if (p && ws) { port = p; wsPath = ws; }
    }
  }
  if (!wsPath) {
    proc.kill();
    throw new Error("Chrome did not start (no DevToolsActivePort).");
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const waitFor = (method, sessionId, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => { listeners.delete(fn); reject(new Error(`timeout waiting for ${method}`)); }, timeoutMs);
      const fn = (msg) => {
        if (msg.method === method && msg.sessionId === sessionId) {
          clearTimeout(t);
          listeners.delete(fn);
          resolve(msg.params);
        }
      };
      listeners.add(fn);
    });

  /** Open a page at a viewport; returns helpers bound to that page. */
  async function newPage({ width, height, deviceScaleFactor = 1, colorScheme = "light" }) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    await s("Runtime.enable");
    await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: width < 600 });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
    return {
      async goto(url) {
        const loaded = waitFor("Page.loadEventFired", sessionId);
        await s("Page.navigate", { url });
        await loaded;
        // Web fonts settle after load; layout is measured after they do.
        await s("Runtime.evaluate", { expression: "document.fonts ? document.fonts.ready.then(() => true) : true", awaitPromise: true });
      },
      async evaluate(fnSource) {
        const r = await s("Runtime.evaluate", { expression: `(${fnSource})()`, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed");
        return r.result.value;
      },
      async screenshot(file) {
        const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        fs.writeFileSync(file, Buffer.from(data, "base64"));
      },
      close: () => send("Target.closeTarget", { targetId }),
    };
  }

  async function close() {
    try { await send("Browser.close"); } catch { /* already gone */ }
    ws.close();
    proc.kill();
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { newPage, close };
}
