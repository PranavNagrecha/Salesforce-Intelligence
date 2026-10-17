import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const MARKDOWN_LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g;

function isIgnoredTarget(raw) {
  const target = raw.trim();
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target)) return true;
  if (target.startsWith('#')) return true;
  return false;
}

function pathPartOfTarget(raw) {
  const target = raw.trim();
  const hash = target.indexOf('#');
  return (hash === -1 ? target : target.slice(0, hash)).trim();
}

/**
 * @param {string} content
 * @param {string} linkingFilePath absolute path to the file containing the links
 * @param {{ exists?: (path: string) => boolean }} [options]
 * @returns {{ linkingFile: string, linkText: string, resolvedPath: string }[]}
 */
export function findBrokenRelativeLinks(content, linkingFilePath, options = {}) {
  const exists = options.exists ?? ((p) => existsSync(p));
  const failures = [];
  for (const match of content.matchAll(MARKDOWN_LINK_RE)) {
    const linkText = match[1];
    const target = match[2];
    if (isIgnoredTarget(target)) continue;
    const pathPart = pathPartOfTarget(target);
    if (!pathPart) continue;
    const resolvedPath = normalize(join(dirname(linkingFilePath), pathPart));
    if (!exists(resolvedPath)) {
      failures.push({ linkingFile: linkingFilePath, linkText, resolvedPath });
    }
  }
  return failures;
}

/**
 * @param {string} dir
 * @param {string[]} out
 * @returns {string[]}
 */
export function collectMarkdownFiles(dir, out) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectMarkdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
