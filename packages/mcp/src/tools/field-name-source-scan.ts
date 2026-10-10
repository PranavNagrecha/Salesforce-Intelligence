/**
 * Name-only field references in source the graph does not model (B10 / ADM-1).
 *
 * Some references never become an edge because the source names the field
 * without saying which object it belongs to:
 *   - an Apex string constant that is spliced into dynamic SOQL
 *     (`'Id, Status__c, Amount__c'`);
 *   - an Integration Procedure or OmniScript JSON path
 *     (`"itemList:Status__c"`, `%Mapper:Invoice_1:Status__c%`).
 *
 * Salesforce does not block the delete on any of them; they break at runtime.
 * This module greps the retrieved Apex and OmniStudio source for the field's
 * API name as a whole token and returns the components that mention it but
 * have no modeled edge to it. A match is `name-only`: the object is NOT
 * verified, so a same-named field on another object also matches. Callers
 * must present matches as "review", never as a proven dependency.
 *
 * Kept in its own module so the delete tool, and later get_impact, share one
 * scan rather than two copies.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { listEdges } from '@sf-intelligence/graph';

import type { Context } from '../server.js';

/** Source directory + suffix -> component type the file is (id = `Type:<stem>`). */
const SCANNED_SOURCES: readonly {
  readonly dir: string;
  readonly suffix: string;
  readonly type: string;
}[] = [
  { dir: 'classes', suffix: '.cls', type: 'ApexClass' },
  { dir: 'triggers', suffix: '.trigger', type: 'ApexTrigger' },
  { dir: 'omniIntegrationProcedures', suffix: '.oip-meta.xml', type: 'OmniIntegrationProcedure' },
  { dir: 'omniScripts', suffix: '.os-meta.xml', type: 'OmniScript' },
  { dir: 'omniDataTransforms', suffix: '.rpt-meta.xml', type: 'OmniDataTransform' },
  { dir: 'omniUiCard', suffix: '.ouc-meta.xml', type: 'OmniUiCard' },
];

/** The families this scan reads (drives the `name-match` checked category). */
export const NAME_SCAN_FAMILIES: readonly string[] = SCANNED_SOURCES.map((s) => s.type);

/** Matching components kept before the scan reports `truncated`. */
const COMPONENT_LIMIT = 200;
/** Files read concurrently. */
const READ_BATCH = 32;
/** Characters of context kept on each side of the match in a snippet. */
const SNIPPET_CONTEXT = 70;

export interface NameOnlyFieldMatch {
  readonly id: ComponentId;
  readonly type: string;
  readonly path: string;
  /** First matching line in the file. */
  readonly line: number;
  /** Matching lines in the file. */
  readonly lines: number;
  readonly snippet: string;
  /**
   * Same-named fields on OTHER objects this component has a modeled reference
   * to. When present, the mention may well be one of those, not this field.
   */
  readonly alsoModeledOn?: readonly ComponentId[];
}

export type NameOnlyScanResult =
  | {
      readonly status: 'scanned';
      readonly matches: readonly NameOnlyFieldMatch[];
      readonly filesScanned: number;
      /** Files read per family. 0 for a family whose source this scan cannot read (e.g. a DataPack export). */
      readonly filesByFamily: Readonly<Record<string, number>>;
      readonly truncated: boolean;
      readonly unreadable: number;
    }
  | { readonly status: 'skipped'; readonly reason: string };

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const clip = (line: string, token: RegExp): string => {
  const m = token.exec(line);
  if (m === null || line.length <= SNIPPET_CONTEXT * 2) return line;
  const start = Math.max(0, m.index - SNIPPET_CONTEXT);
  const end = Math.min(line.length, m.index + m[0].length + SNIPPET_CONTEXT);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
};

/**
 * Grep Apex + OmniStudio source for `fieldApiName` as a whole token and return
 * the components that mention it, minus `knownReferrerIds` (already modeled).
 * Only custom fields (`__c`) are scanned: a standard name such as `Status` or
 * `Name` matches far too much to mean anything, so it is `skipped` with a reason.
 */
export const scanNameOnlyFieldReferences = async (
  ctx: Context,
  fieldApiNameIn: string,
  knownReferrerIds: ReadonlySet<string>,
  /** The field's object; enables the `alsoModeledOn` hint. Defaults to the `Object.` prefix of `fieldApiNameIn`. */
  objectApiNameIn?: string | null,
): Promise<NameOnlyScanResult> => {
  // Accept `Field__c` or `Object.Field__c`.
  const fieldApiName = fieldApiNameIn.slice(fieldApiNameIn.lastIndexOf('.') + 1);
  if (!/__c$/i.test(fieldApiName)) {
    return {
      status: 'skipped',
      reason: 'standard field names are too common to match by name in source',
    };
  }
  const pattern = `(?<![A-Za-z0-9_])${escapeRegex(fieldApiName)}(?![A-Za-z0-9_])`;
  const token = new RegExp(pattern, 'i');
  // Read only the six flat source directories (`source/<dir>/`), not the whole
  // tree: walking every report and profile made the scan cost seconds per call.
  const files: { readonly type: string; readonly stem: string; readonly rel: string }[] = [];
  for (const src of SCANNED_SOURCES) {
    let names: string[];
    try {
      names = await readdir(join(ctx.vaultRoot, 'source', src.dir));
    } catch {
      continue; // family absent from this vault
    }
    for (const name of names.sort()) {
      if (!name.endsWith(src.suffix)) continue;
      files.push({
        type: src.type,
        stem: name.slice(0, -src.suffix.length),
        rel: `source/${src.dir}/${name}`,
      });
    }
  }
  const matches: NameOnlyFieldMatch[] = [];
  let unreadable = 0;
  let truncated = false;
  for (let i = 0; i < files.length; i += READ_BATCH) {
    const batch = files.slice(i, i + READ_BATCH);
    const texts = await Promise.all(
      batch.map((f) => readFile(join(ctx.vaultRoot, f.rel), 'utf-8').catch(() => null)),
    );
    batch.forEach((f, j) => {
      const text = texts[j];
      if (text === null || text === undefined) {
        unreadable += 1;
        return;
      }
      const id = `${f.type}:${f.stem}`;
      if (knownReferrerIds.has(id) || !token.test(text)) return;
      if (matches.length >= COMPONENT_LIMIT) {
        truncated = true;
        return;
      }
      const lines = text.split('\n');
      const hit = lines.findIndex((l) => token.test(l));
      matches.push({
        id: id as ComponentId,
        type: f.type,
        path: f.rel,
        line: hit + 1,
        lines: lines.filter((l) => token.test(l)).length,
        snippet: clip((lines[hit] ?? '').trim(), token),
      });
    });
  }
  // Precision hint: a component that already references a same-named field on
  // another object probably means that one. Kept as a hint, not a filter — a
  // dynamic field list can name both.
  const objectRaw =
    objectApiNameIn ??
    (fieldApiNameIn.includes('.') ? fieldApiNameIn.slice(0, fieldApiNameIn.lastIndexOf('.')) : null);
  const objectApiName = objectRaw === null ? null : objectRaw.toLowerCase();
  const suffix = `.${fieldApiName.toLowerCase()}`;
  const annotated = await Promise.all(
    matches.map(async (m): Promise<NameOnlyFieldMatch> => {
      if (objectApiName === null) return m;
      const out = await listEdges(ctx.graph, m.id, { direction: 'out' });
      if (!out.ok) return m;
      const others = [
        ...new Set(
          out.value
            .map((e) => e.toId as string)
            .filter((to) => {
              const lower = to.toLowerCase();
              return (
                lower.startsWith('customfield:') &&
                lower.endsWith(suffix) &&
                lower !== `customfield:${objectApiName}${suffix}`
              );
            }),
        ),
      ].sort();
      return others.length > 0 ? { ...m, alsoModeledOn: others as ComponentId[] } : m;
    }),
  );
  return {
    status: 'scanned',
    matches: annotated.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    filesScanned: files.length,
    filesByFamily: Object.fromEntries(
      NAME_SCAN_FAMILIES.map((family) => [family, files.filter((f) => f.type === family).length]),
    ),
    truncated,
    unreadable,
  };
};
