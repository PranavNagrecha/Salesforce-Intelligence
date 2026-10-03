import { omnistudio } from '@sf-intelligence/extractors';

import type { IpModel } from './ip-model.js';
import { buildScriptModel, type ScriptElement, type ScriptModel } from './script-model.js';
import type { OmniCitation, OmniFinding } from './types.js';
import { diffVersions } from './version-diff.js';
import type { OmniWorld } from './world.js';

/**
 * Reference checks (spec F3) — does every rule, merge field and payload key
 * point at something that exists in the version that runs?
 *
 *   - DEAD_REFERENCE         — a show rule / merge field reads a key nothing in
 *                              the script produces (element, container, Set
 *                              Values key, declared LWC output, runtime or
 *                              launch key). A `defect` when nothing undeclared
 *                              could supply it, or when an EARLIER version
 *                              produced it (a rename left the reference stale);
 *                              otherwise `unknown`, naming what could.
 *   - WHITESPACE_KEY         — a key, show-rule field, payload key, merge path,
 *                              element name or Apex class / method written with
 *                              a leading or trailing space.
 *   - UNRESOLVED_PLACEHOLDER — a `%…` that never closes (it never substitutes),
 *                              or a `{…}` placeholder whose root no key matches
 *                              (it renders as literal text).
 *   - LABEL_NOT_VALUE        — a show rule compares a Radio / Select to an
 *                              option's LABEL (`value`) instead of the stored
 *                              `name`.
 */

const cite = (componentId: string, sourcePath: string, e: { readonly el: omnistudio.OmniTreeElement }): OmniCitation => ({
  componentId,
  sourcePath,
  elementPath: e.el.idPath,
  ...(e.el.line === null ? {} : { line: e.el.line }),
});

/** A reference site found in an element's settings. */
interface RefSite {
  readonly element: ScriptElement;
  /** Property path inside `propertySetConfig` (e.g. `show.rules[0].field`, `extraPayload.Details`). */
  readonly prop: string;
  readonly raw: string;
  readonly kind: 'show' | 'merge';
}

/** Collect every key reference in a script: show-rule fields and `%…%` merge fields. */
const scriptRefSites = (script: ScriptModel): RefSite[] => {
  const out: RefSite[] = [];
  for (const e of script.elements) {
    const cfg = e.el.config;
    if (cfg === null) continue;
    for (const c of omnistudio.ruleConditions(omnistudio.parseShowRule(cfg['show']))) {
      out.push({ element: e, prop: `show.${c.at}.field`, raw: c.field, kind: 'show' });
    }
    for (const site of omnistudio.stringSites(cfg)) {
      if (site.prop.startsWith('show.')) continue;
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) out.push({ element: e, prop: site.prop, raw: ref.raw, kind: 'merge' });
    }
  }
  return out;
};

/** What earlier versions of the family produced, and which names a later version renamed. */
interface HistoryEvidence {
  /** Data path → the latest earlier version (and element) that produced it. */
  readonly produced: ReadonlyMap<string, { readonly version: number | null; readonly element: string }>;
  /** Old element name → its rename (same type, parent and label key, different name). */
  readonly renamed: ReadonlyMap<string, { readonly newName: string; readonly fromVersion: number | null; readonly element: string }>;
}

const historyEvidence = async (world: OmniWorld, script: ScriptModel): Promise<HistoryEvidence> => {
  const produced = new Map<string, { version: number | null; element: string }>();
  const renamed = new Map<string, { newName: string; fromVersion: number | null; element: string }>();
  const me = script.loaded.node;
  const myVersion = typeof me.properties['versionNumber'] === 'number' ? me.properties['versionNumber'] : null;
  for (const v of world.familyOf(me)) {
    if (v.id === me.id) continue;
    const vNum = typeof v.properties['versionNumber'] === 'number' ? v.properties['versionNumber'] : null;
    if (myVersion !== null && vNum !== null && vNum > myVersion) continue;
    const loaded = await world.loadProcess(v);
    if (!loaded.ok) continue;
    const m = buildScriptModel(loaded.value, { customLwcOutputs: world.config.customLwcOutputs });
    for (const p of m.producers) {
      if (p.element === null) continue;
      const k = p.path.join(':');
      const prev = produced.get(k);
      if (prev === undefined || (prev.version ?? -1) < (vNum ?? -1)) produced.set(k, { version: vNum, element: p.element.el.idPath });
    }
    for (const r of diffVersions(loaded.value, script.loaded).renamed) {
      const prev = renamed.get(r.from.name);
      if (prev === undefined || (prev.fromVersion ?? -1) < (vNum ?? -1)) {
        renamed.set(r.from.name, { newName: r.to.name, fromVersion: vNum, element: r.to.elementPath });
      }
    }
  }
  return { produced, renamed };
};

/** Undeclared writers that could supply a key at `names` (they write anywhere). */
const couldSupply = (script: ScriptModel): string[] => {
  const out: string[] = [];
  for (const e of script.undeclaredWriters) out.push(`${e.el.type} ${e.el.idPath}`);
  for (const a of script.actions) {
    if (a.kind !== 'ipAction' && a.kind !== 'remoteAction' && a.kind !== 'dataMapperAction') continue;
    if (script.responseModeled.has(a.element.el.idPath)) continue;
    out.push(`response of ${a.element.el.idPath}${a.responseNode === null ? ' (merged at the root)' : ` (merged at ${a.responseNode.join(':')})`}`);
  }
  return out.sort();
};

/** Run the reference checks on one script. */
export const checkScriptReferences = async (
  world: OmniWorld,
  script: ScriptModel,
): Promise<OmniFinding[]> => {
  const findings: OmniFinding[] = [];
  const comp = script.componentId;
  const sp = script.sourcePath;
  const allKeys = [...new Set(script.producers.map((p) => p.path.join(':')))];
  const elementNames = [...new Set(script.producers.filter((p) => p.element !== null).map((p) => p.path.at(-1) ?? ''))];
  const history = await historyEvidence(world, script);
  const supply = couldSupply(script);
  const opts = { prefixVariants: world.config.prefixVariants };

  // --- DEAD_REFERENCE -------------------------------------------------------
  const seen = new Set<string>();
  for (const site of scriptRefSites(script)) {
    const names = omnistudio.segmentNames(omnistudio.parseKeyPath(site.raw));
    if (names.length === 0 || names.every((n) => n.trim().length === 0)) continue;
    const r = script.resolveRef(names, site.element);
    if (r.how !== 'none') continue;
    const key = `${site.element.el.idPath}\u0000${site.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const target = names.join(':');
    const near = [
      ...omnistudio.nearMisses(target, allKeys, opts),
      ...(names.length === 1 ? [] : omnistudio.nearMisses(names.at(-1) as string, elementNames, opts).map((n) => ({ ...n, candidate: `…${n.candidate}` }))),
    ];
    // A stray space whose trimmed form resolves is reported once, as WHITESPACE_KEY.
    const trimmedResolves = names.some((n) => n !== n.trim()) && script.resolveRef(names.map((n) => n.trim()), site.element).how !== 'none';
    if (trimmedResolves) continue;
    // History: an earlier version produced it, and/or the name was RENAMED.
    // A rename is strong evidence the reference is stale (a defect); a mere
    // removal is not — something undeclared may supply the key now.
    const earlier = [...history.produced.entries()].find(([k]) => k === target || omnistudio.isSuffixOf(names, k.split(':')));
    const rename = history.renamed.get(names.at(-1) ?? '');
    const defect = rename !== undefined || supply.length === 0;
    const message = `${site.kind === 'show' ? 'show rule' : 'merge field'} at ${site.prop} reads '${site.raw}', which nothing in this version produces` +
      (rename !== undefined
        ? ` — '${names.at(-1) ?? ''}' was renamed to '${rename.newName}' after version ${rename.fromVersion ?? '?'}`
        : earlier !== undefined
          ? ` (element ${earlier[1].element} produced it in version ${earlier[1].version ?? '?'})`
          : '');
    findings.push({
      code: 'DEAD_REFERENCE',
      verdict: defect ? 'defect' : 'unknown',
      componentId: comp,
      sourcePath: sp,
      elementPath: site.element.el.idPath,
      line: site.element.el.line,
      message,
      confidence: defect ? 'parsed' : 'inferred',
      ...(defect ? {} : { unknownReason: `an undeclared writer could supply it: ${supply.slice(0, 6).join('; ')}${supply.length > 6 ? ` (+${supply.length - 6} more)` : ''}` }),
      evidence: {
        reference: site.raw,
        via: site.prop,
        kind: site.kind,
        nearMiss: near,
        ...(earlier === undefined ? {} : { producedInEarlierVersion: { version: earlier[1].version, element: earlier[1].element, key: earlier[0] } }),
        ...(rename === undefined ? {} : { renamedTo: { name: rename.newName, afterVersion: rename.fromVersion, element: rename.element } }),
      },
      citations: [cite(comp, sp, site.element)],
    });
  }

  // --- WHITESPACE_KEY --------------------------------------------------------
  const ws = (elementPath: string | null, line: number | null, what: string, value: string, extra: Record<string, unknown> = {}): void => {
    findings.push({
      code: 'WHITESPACE_KEY',
      verdict: 'defect',
      componentId: comp,
      sourcePath: sp,
      elementPath,
      line,
      message: `${what} ${JSON.stringify(value)} has ${value !== value.trimStart() ? 'a leading' : 'a trailing'} space — it never matches the key ${JSON.stringify(value.trim())}`,
      confidence: 'parsed',
      evidence: { value, trimmed: value.trim(), what, ...extra },
      citations: elementPath === null ? [{ componentId: comp, sourcePath: sp }] : [{ componentId: comp, sourcePath: sp, elementPath, ...(line === null ? {} : { line }) }],
    });
  };
  for (const e of script.elements) {
    if (omnistudio.hasEdgeWhitespace(e.el.name)) ws(e.el.idPath, e.el.line, 'element name', e.el.name);
    const cfg = e.el.config;
    if (cfg === null) continue;
    for (const c of omnistudio.ruleConditions(omnistudio.parseShowRule(cfg['show']))) {
      if (omnistudio.pathHasEdgeWhitespace(omnistudio.parseKeyPath(c.field))) {
        ws(e.el.idPath, e.el.line, 'show-rule field', c.field, {
          via: `show.${c.at}.field`,
          resolvesWhenTrimmed: script.resolveRef(omnistudio.segmentNames(omnistudio.parseKeyPath(c.field.trim())), e).how !== 'none',
        });
      }
    }
    for (const mapProp of ['extraPayload', 'saveIPExtraPayload', 'deleteIPExtraPayload', 'elementValueMap']) {
      const m = cfg[mapProp];
      if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
      for (const k of Object.keys(m)) if (omnistudio.hasEdgeWhitespace(k)) ws(e.el.idPath, e.el.line, `${mapProp} key`, k, { via: mapProp });
    }
    for (const site of omnistudio.stringSites(cfg)) {
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
        if (omnistudio.pathHasEdgeWhitespace(ref.path)) ws(e.el.idPath, e.el.line, 'merge-field path', ref.raw, { via: site.prop });
      }
    }
    for (const prop of ['remoteClass', 'remoteMethod', 'integrationProcedureKey', 'bundle']) {
      const v = cfg[prop];
      if (typeof v === 'string' && omnistudio.hasEdgeWhitespace(v)) ws(e.el.idPath, e.el.line, prop, v, { via: prop, runtimeEffect: 'unknown — whether the runtime trims it is not established from metadata' });
    }
  }

  // --- UNRESOLVED_PLACEHOLDER --------------------------------------------------
  for (const e of script.elements) {
    const cfg = e.el.config;
    if (cfg === null) continue;
    for (const site of omnistudio.stringSites(cfg)) {
      for (const m of omnistudio.scanPercentRefs(site.value).malformed) {
        findings.push({
          code: 'UNRESOLVED_PLACEHOLDER',
          verdict: 'defect',
          componentId: comp,
          sourcePath: sp,
          elementPath: e.el.idPath,
          line: e.el.line,
          message: `malformed merge field ${JSON.stringify(m.fragment)} at ${site.prop} never closes, so it never substitutes`,
          confidence: 'parsed',
          evidence: { via: site.prop, fragment: m.fragment, text: site.value.length > 300 ? `${site.value.slice(0, 300)}…` : site.value },
          citations: [cite(comp, sp, e)],
        });
      }
      for (const ref of omnistudio.scanBraceRefs(site.value)) {
        const names = omnistudio.segmentNames(ref.path);
        if (script.resolveRef(names, e).how !== 'none') continue;
        if (script.resolveRef(names.slice(0, 1), e).how !== 'none') continue;
        findings.push({
          code: 'UNRESOLVED_PLACEHOLDER',
          verdict: 'unknown',
          componentId: comp,
          sourcePath: sp,
          elementPath: e.el.idPath,
          line: e.el.line,
          message: `placeholder {${ref.raw}} at ${site.prop} names no key this script produces; if this surface does not substitute it, it renders as literal text`,
          confidence: 'inferred',
          unknownReason: 'whether this property substitutes `{…}` placeholders, and from which context, is not established from metadata',
          evidence: { via: site.prop, placeholder: ref.raw },
          citations: [cite(comp, sp, e)],
        });
      }
    }
  }

  // --- LABEL_NOT_VALUE -----------------------------------------------------------
  const choiceByName = new Map<string, ScriptElement>();
  for (const e of script.elements) if (omnistudio.CHOICE_TYPES.has(e.el.canonicalType)) choiceByName.set(e.el.name, e);
  for (const e of script.elements) {
    const cfg = e.el.config;
    if (cfg === null) continue;
    for (const c of omnistudio.ruleConditions(omnistudio.parseShowRule(cfg['show']))) {
      const names = omnistudio.segmentNames(omnistudio.parseKeyPath(c.field));
      const target = choiceByName.get(names.at(-1) ?? '');
      if (target === undefined || typeof c.data !== 'string') continue;
      const options = target.el.config?.['options'];
      if (!Array.isArray(options)) continue;
      const opts = options.filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null);
      const storedMatch = opts.some((o) => String(o['name'] ?? '') === c.data);
      const labelMatch = opts.find((o) => String(o['value'] ?? '') === c.data);
      if (storedMatch || labelMatch === undefined) continue;
      findings.push({
        code: 'LABEL_NOT_VALUE',
        verdict: 'defect',
        componentId: comp,
        sourcePath: sp,
        elementPath: e.el.idPath,
        line: e.el.line,
        message: `show rule compares ${target.el.type} ${target.el.idPath} to its option LABEL ${JSON.stringify(c.data)}; the stored value is the option name ${JSON.stringify(String(labelMatch['name'] ?? ''))}`,
        confidence: 'parsed',
        evidence: { field: c.field, comparedTo: c.data, storedName: String(labelMatch['name'] ?? ''), via: `show.${c.at}` },
        citations: [cite(comp, sp, e), cite(comp, sp, target)],
      });
    }
  }
  return findings;
};

/** Whitespace checks over an Integration Procedure's steps (Apex names, payload keys, refs). */
export const checkIpWhitespace = (ip: IpModel): OmniFinding[] => {
  const findings: OmniFinding[] = [];
  for (const s of ip.steps) {
    const cfg = s.el.config;
    if (cfg === null) continue;
    const push = (what: string, value: string, via: string, extra: Record<string, unknown> = {}): void => {
      findings.push({
        code: 'WHITESPACE_KEY',
        verdict: 'defect',
        componentId: ip.componentId,
        sourcePath: ip.sourcePath,
        elementPath: s.el.idPath,
        line: s.el.line,
        message: `${what} ${JSON.stringify(value)} has ${value !== value.trimStart() ? 'a leading' : 'a trailing'} space`,
        confidence: 'parsed',
        evidence: { value, trimmed: value.trim(), via, ...extra },
        citations: [{ componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: s.el.idPath, ...(s.el.line === null ? {} : { line: s.el.line }) }],
      });
    };
    for (const prop of ['remoteClass', 'remoteMethod', 'bundle', 'integrationProcedureKey']) {
      const v = cfg[prop];
      if (typeof v === 'string' && omnistudio.hasEdgeWhitespace(v)) {
        push(prop, v, prop, { runtimeEffect: 'unknown — whether the runtime trims it is not established from metadata' });
      }
    }
    for (const mapProp of ['additionalInput', 'elementValueMap', 'additionalOutput']) {
      const m = cfg[mapProp];
      if (typeof m !== 'object' || m === null || Array.isArray(m)) continue;
      for (const k of Object.keys(m)) if (omnistudio.hasEdgeWhitespace(k)) push(`${mapProp} key`, k, mapProp);
    }
    for (const site of omnistudio.stringSites(cfg)) {
      for (const ref of omnistudio.scanPercentRefs(site.value).refs) {
        if (omnistudio.pathHasEdgeWhitespace(ref.path)) push('merge-field path', ref.raw, site.prop);
      }
      for (const m of omnistudio.scanPercentRefs(site.value).malformed) {
        findings.push({
          code: 'UNRESOLVED_PLACEHOLDER',
          verdict: 'defect',
          componentId: ip.componentId,
          sourcePath: ip.sourcePath,
          elementPath: s.el.idPath,
          line: s.el.line,
          message: `malformed merge field ${JSON.stringify(m.fragment)} at ${site.prop} never closes, so it never substitutes`,
          confidence: 'parsed',
          evidence: { via: site.prop, fragment: m.fragment },
          citations: [{ componentId: ip.componentId, sourcePath: ip.sourcePath, elementPath: s.el.idPath, ...(s.el.line === null ? {} : { line: s.el.line }) }],
        });
      }
    }
  }
  return findings;
};

/**
 * Whitespace in JSON-valued custom metadata: every object key inside a
 * `CustomMetadataRecord` value that parses as JSON. The flow that reads such a
 * record matches keys exactly, so `"flag "` never equals `"flag"`.
 */
export const checkMetadataJsonKeys = (
  records: readonly {
    readonly id: string;
    readonly sourcePath: string;
    readonly values: readonly { readonly field: string; readonly value: unknown }[];
  }[],
): OmniFinding[] => {
  const findings: OmniFinding[] = [];
  for (const r of records) {
    for (const { field, value: raw } of r.values) {
      if (typeof raw !== 'string') continue;
      const t = raw.trim();
      if (!(t.startsWith('{') || t.startsWith('['))) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(t);
      } catch {
        continue;
      }
      for (const k of omnistudio.keySites(parsed)) {
        if (!omnistudio.hasEdgeWhitespace(k.key)) continue;
        findings.push({
          code: 'WHITESPACE_KEY',
          verdict: 'defect',
          componentId: r.id,
          sourcePath: r.sourcePath,
          elementPath: `${field}.${k.prop}`,
          line: null,
          message: `custom-metadata JSON key ${JSON.stringify(k.key)} in ${field} has ${k.key !== k.key.trimStart() ? 'a leading' : 'a trailing'} space`,
          confidence: 'parsed',
          evidence: { field, key: k.key, trimmed: k.key.trim(), jsonPath: k.prop },
          citations: [{ componentId: r.id, sourcePath: r.sourcePath, elementPath: field }],
        });
      }
    }
  }
  return findings;
};
