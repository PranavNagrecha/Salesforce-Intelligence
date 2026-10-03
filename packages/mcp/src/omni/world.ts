import { readFile } from 'node:fs/promises';

import type { ComponentId, ComponentType, Node } from '@sf-intelligence/contracts';
import { omnistudio } from '@sf-intelligence/extractors';
import {
  buildOmniIndexes,
  getNodeById,
  normOmniLanguage as normLanguage,
  parseOmniScriptKey,
  pickOmniVersion,
  type OmniTargetResolution,
} from '@sf-intelligence/graph';
import { resolveVaultSourcePath } from '@sf-intelligence/vault';

import type { Context } from '../server.js';
import { scanAllNodesOfTypes } from '../tools/scan-all-nodes.js';

import { loadOmniConfig, type OmniConfig, type OmniConfigSource } from './config.js';

/**
 * The OmniStudio "world" one analysis call works in: every OmniScript,
 * Integration Procedure and DataMapper node in the vault, the callable-key
 * indexes the graph import resolves with (so a tool and the graph can never
 * disagree about which version a key reaches), lazily parsed source files,
 * and schema lookups (does a field exist?).
 */

/** How a callable key resolved to a node. */
export interface ResolvedTarget {
  /** The node that runs, or null when nothing in the vault answers to the key. */
  readonly node: Node | null;
  readonly resolution: OmniTargetResolution | 'not-in-vault' | 'scan-incomplete';
  /** Every other version answering to the key. */
  readonly otherVersionIds: readonly string[];
}

/** A parsed OmniScript / Integration Procedure. */
export interface LoadedProcess {
  readonly node: Node;
  readonly doc: omnistudio.OmniProcessDoc;
}

/** A parsed DataMapper. */
export interface LoadedMapper {
  readonly node: Node;
  readonly doc: omnistudio.DataMapperDoc;
}

/** A load result: the parsed file, or why it could not be read. */
export type Loaded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

/** Whether a field exists on an object, as far as the vault can tell. */
export type FieldStatus = 'exists' | 'missing' | 'unknown';

/**
 * Process-wide parse cache, keyed by vault + refresh + source path, so a
 * session that asks several questions about one script parses it once. Bounded
 * (oldest entries evicted) so a long-running server cannot grow without limit.
 */
const PARSE_CACHE = new Map<string, Loaded<omnistudio.OmniProcessDoc> | Loaded<omnistudio.DataMapperDoc>>();
const PARSE_CACHE_MAX = 4000;

const cacheGet = (key: string): unknown => PARSE_CACHE.get(key);
const cacheSet = (key: string, value: Loaded<omnistudio.OmniProcessDoc> | Loaded<omnistudio.DataMapperDoc>): void => {
  if (PARSE_CACHE.size >= PARSE_CACHE_MAX) {
    const first = PARSE_CACHE.keys().next();
    if (first.done !== true) PARSE_CACHE.delete(first.value);
  }
  PARSE_CACHE.set(key, value);
};

const OMNI_TYPES: readonly ComponentType[] = ['OmniScript', 'OmniIntegrationProcedure', 'OmniDataTransform'];

const str = (node: Node, key: string): string | null => {
  const v = node.properties[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
};

const num = (node: Node, key: string): number => {
  const v = node.properties[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

/** The OmniStudio world for one analysis call. */
export class OmniWorld {
  readonly #ctx: Context;
  readonly config: OmniConfig;
  readonly configSource: OmniConfigSource;
  readonly scripts: readonly Node[];
  readonly ips: readonly Node[];
  readonly mappers: readonly Node[];
  /** True when a node scan stopped at its residual cap (absence is then unproven). */
  readonly scanIncomplete: boolean;
  /**
   * Managed-package (Vlocity) OmniStudio in this vault: the managed namespaces
   * installed, and how many components came from a DataPack export vs the
   * Metadata API — what decides whether managed components can be missing.
   */
  readonly managedPackage: {
    readonly installedNamespaces: readonly string[];
    readonly dataPackComponents: number;
    readonly nativeComponents: number;
  };
  readonly #indexes: ReturnType<typeof buildOmniIndexes>;
  readonly #byId: ReadonlyMap<string, Node>;
  readonly #fieldsByObject = new Map<string, Promise<ReadonlyMap<string, string> | null>>();
  #objectIdsLower: Promise<ReadonlyMap<string, string>> | null = null;

  private constructor(
    ctx: Context,
    config: OmniConfig,
    configSource: OmniConfigSource,
    nodes: readonly Node[],
    scanIncomplete: boolean,
    installedNamespaces: readonly string[],
  ) {
    this.#ctx = ctx;
    this.config = config;
    this.configSource = configSource;
    this.scripts = nodes.filter((n) => n.type === 'OmniScript');
    this.ips = nodes.filter((n) => n.type === 'OmniIntegrationProcedure');
    this.mappers = nodes.filter((n) => n.type === 'OmniDataTransform');
    this.scanIncomplete = scanIncomplete;
    const fromDataPacks = nodes.filter((n) => n.properties['sourceFormat'] === 'vlocity-datapack').length;
    this.managedPackage = {
      installedNamespaces,
      dataPackComponents: fromDataPacks,
      nativeComponents: nodes.length - fromDataPacks,
    };
    this.#indexes = buildOmniIndexes(nodes);
    this.#byId = new Map(nodes.map((n) => [n.id, n]));
  }

  /** Build the world: load the config and scan every OmniStudio node. */
  static async build(ctx: Context): Promise<{ ok: true; world: OmniWorld } | { ok: false; message: string }> {
    const { config, source } = await loadOmniConfig(ctx.vaultRoot);
    const scan = await scanAllNodesOfTypes(ctx.graph, OMNI_TYPES);
    if (!scan.ok) return { ok: false, message: `graph scan failed: ${scan.error.message}` };
    // Installed managed OmniStudio namespaces — compared case-insensitively,
    // since a package's id carries whatever case its retrieve file name had.
    const packages = await scanAllNodesOfTypes(ctx.graph, ['InstalledPackage']);
    const vaulted = new Set(packages.ok ? packages.value.nodes.map((n) => n.apiName.toLowerCase()) : []);
    const installed = omnistudio.MANAGED_OMNISTUDIO_NAMESPACES.filter((ns) => vaulted.has(ns));
    return { ok: true, world: new OmniWorld(ctx, config, source, scan.value.nodes, scan.value.scanIncomplete, installed) };
  }

  /** The node with this id, when it is an OmniStudio node of this world. */
  nodeById(id: string): Node | null {
    return this.#byId.get(id) ?? null;
  }

  /** Vault refresh timestamp (stamped on every finding set). */
  get refreshedAt(): string {
    return this.#ctx.manifest.refreshedAt;
  }

  #resolve(candidates: readonly { id: string; isActive: boolean; versionNumber: number }[] | undefined, activeIsSwitch: boolean): ResolvedTarget {
    const pick = pickOmniVersion(candidates ?? [], activeIsSwitch);
    if (pick === null) {
      return { node: null, resolution: this.scanIncomplete ? 'scan-incomplete' : 'not-in-vault', otherVersionIds: [] };
    }
    return { node: this.#byId.get(pick.id) ?? null, resolution: pick.resolution, otherVersionIds: pick.others };
  }

  /** Resolve an Integration Procedure key (`Type_SubType`) to the version that runs. */
  resolveIpKey(key: string): ResolvedTarget {
    return this.#resolve(this.#indexes.ipByKey.get(key.trim()), true);
  }

  /** Resolve a DataMapper bundle name to its node (`active` is not a runtime switch). */
  resolveBundle(name: string): ResolvedTarget {
    return this.#resolve(this.#indexes.dmByName.get(name.trim()), false);
  }

  /** Every version of the script family (same Type / SubType / Language) as `node`. */
  familyOf(node: Node): readonly Node[] {
    const t = str(node, 'type');
    const s = str(node, 'subType');
    const l = str(node, 'language');
    if (t === null || s === null || l === null) return [node];
    const pool = node.type === 'OmniIntegrationProcedure' ? this.ips : this.scripts;
    return pool
      .filter((n) => str(n, 'type') === t && str(n, 'subType') === s && normLanguage(str(n, 'language') ?? '') === normLanguage(l))
      .sort((a, b) => num(a, 'versionNumber') - num(b, 'versionNumber'));
  }

  /** The active version of `node`'s family, or null when none is active. */
  activeVersionOf(node: Node): Node | null {
    const active = this.familyOf(node).filter((n) => n.properties['isActive'] === true);
    if (active.length === 0) return null;
    return active.sort((a, b) => num(b, 'versionNumber') - num(a, 'versionNumber'))[0] ?? null;
  }

  /**
   * Resolve a user selector to an OmniScript / IP node: a canonical id, a
   * unique name (`Type_SubType_Language_N`), a `Type/SubType/Language` key, or
   * an IP key. Returns every match (callers decide how to treat several).
   */
  resolveProcessSelector(selector: string, kind: 'OmniScript' | 'OmniIntegrationProcedure'): readonly Node[] {
    const sel = selector.trim();
    const pool = kind === 'OmniScript' ? this.scripts : this.ips;
    const prefixed = sel.startsWith(`${kind}:`) ? sel : `${kind}:${sel}`;
    const exact = this.#byId.get(prefixed);
    if (exact !== undefined && exact.type === kind) return [exact];
    const lower = sel.toLowerCase();
    const byUnique = pool.filter((n) => (str(n, 'uniqueName') ?? n.apiName).toLowerCase() === lower);
    if (byUnique.length > 0) return byUnique;
    if (kind === 'OmniIntegrationProcedure') {
      const r = this.resolveIpKey(sel);
      return r.node === null ? [] : [r.node];
    }
    const key = parseOmniScriptKey(sel);
    if (key === null) return [];
    return pool.filter(
      (n) => str(n, 'type') === key.type && str(n, 'subType') === key.subType && normLanguage(str(n, 'language') ?? '') === normLanguage(key.language),
    );
  }

  /** Read and parse an OmniScript / IP source file (cached). */
  async loadProcess(node: Node): Promise<Loaded<LoadedProcess>> {
    const key = `${this.#ctx.vaultRoot}|${this.refreshedAt}|${node.sourcePath}`;
    let parsed = cacheGet(key) as Loaded<omnistudio.OmniProcessDoc> | undefined;
    if (parsed === undefined) {
      const abs = resolveVaultSourcePath(this.#ctx.vaultRoot, node.sourcePath);
      parsed = omnistudio.isDataPackPath(node.sourcePath)
        ? await readDataPackParsed(abs, (dp) => {
            const r = omnistudio.parseOmniProcessDataPack(dp);
            return r.ok ? { ok: true, value: r.doc } : { ok: false, reason: r.message };
          })
        : await readParsed(abs, (text) => {
            const r = omnistudio.parseOmniProcess(text);
            return r.ok ? { ok: true, value: r.doc } : { ok: false, reason: r.message };
          });
      cacheSet(key, parsed);
    }
    return parsed.ok ? { ok: true, value: { node, doc: parsed.value } } : parsed;
  }

  /** Read and parse a DataMapper source file (cached). */
  async loadMapper(node: Node): Promise<Loaded<LoadedMapper>> {
    const key = `${this.#ctx.vaultRoot}|${this.refreshedAt}|${node.sourcePath}`;
    let parsed = cacheGet(key) as Loaded<omnistudio.DataMapperDoc> | undefined;
    if (parsed === undefined) {
      const abs = resolveVaultSourcePath(this.#ctx.vaultRoot, node.sourcePath);
      parsed = omnistudio.isDataPackPath(node.sourcePath)
        ? await readDataPackParsed(abs, (dp) => {
            const r = omnistudio.parseDataMapperDataPack(dp);
            return r.ok ? { ok: true, value: r.doc } : { ok: false, reason: r.message };
          })
        : await readParsed(abs, (text) => {
            const r = omnistudio.parseDataMapper(text);
            return r.ok ? { ok: true, value: r.doc } : { ok: false, reason: r.message };
          });
      cacheSet(key, parsed);
    }
    return parsed.ok ? { ok: true, value: { node, doc: parsed.value } } : parsed;
  }

  /** Canonical `CustomObject:` id for an API name (case-insensitive), or null when not vaulted. */
  async objectId(objectApiName: string): Promise<string | null> {
    this.#objectIdsLower ??= (async () => {
      const scan = await scanAllNodesOfTypes(this.#ctx.graph, ['CustomObject']);
      const m = new Map<string, string>();
      if (scan.ok) for (const n of scan.value.nodes) m.set(n.id.toLowerCase(), n.id);
      return m;
    })();
    const ids = await this.#objectIdsLower;
    return ids.get(`customobject:${objectApiName.trim().toLowerCase()}`) ?? null;
  }

  /**
   * Whether `object.field` exists. `exists` → the field node (case-insensitive
   * match). `missing` only when the object IS vaulted and the field is a CUSTOM
   * field (`__c`) the vault does not carry. A standard-looking field the vault
   * does not model is `unknown`, never `missing` — standard fields are only
   * partially vaulted. `Id` always exists.
   */
  async fieldStatus(objectApiName: string, fieldApiName: string): Promise<{ status: FieldStatus; fieldId: string | null }> {
    const field = fieldApiName.trim();
    const objectId = await this.objectId(objectApiName);
    if (field.toLowerCase() === 'id') {
      return { status: 'exists', fieldId: objectId === null ? null : `CustomField:${objectId.slice('CustomObject:'.length)}.Id` };
    }
    if (objectId === null) return { status: 'unknown', fieldId: null };
    const map = await this.#fieldMap(objectId);
    if (map === null) return { status: 'unknown', fieldId: null };
    const hit = map.get(field.toLowerCase());
    if (hit !== undefined) return { status: 'exists', fieldId: hit };
    return { status: /__c$/i.test(field) ? 'missing' : 'unknown', fieldId: null };
  }

  /** Lower-cased field API name → field id for one vaulted object (cached); null when the scan failed. */
  #fieldMap(objectId: string): Promise<ReadonlyMap<string, string> | null> {
    let fields = this.#fieldsByObject.get(objectId);
    if (fields === undefined) {
      fields = (async () => {
        const scan = await scanAllNodesOfTypes(this.#ctx.graph, ['CustomField'], { parentId: objectId as ComponentId });
        if (!scan.ok) return null;
        const m = new Map<string, string>();
        for (const n of scan.value.nodes) m.set(n.apiName.toLowerCase(), n.id);
        return m;
      })();
      this.#fieldsByObject.set(objectId, fields);
    }
    return fields;
  }

  /** Every vaulted field of an object (empty when the object is not vaulted). */
  async fieldsOf(objectApiName: string): Promise<readonly { readonly apiName: string; readonly id: string }[]> {
    const objectId = await this.objectId(objectApiName);
    if (objectId === null) return [];
    const map = await this.#fieldMap(objectId);
    if (map === null) return [];
    return [...map.values()]
      .map((id) => ({ apiName: id.slice(id.indexOf('.') + 1), id }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The value of a Custom Label, when vaulted. */
  async labelValue(name: string): Promise<string | null> {
    const r = await getNodeById(this.#ctx.graph, `CustomLabel:${name.trim()}` as ComponentId);
    if (!r.ok || r.value === null) return null;
    const p = r.value.properties;
    for (const k of ['value', 'labelValue', 'text']) {
      const v = p[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return r.value.label;
  }
}

/** Read a managed-package DataPack (main file + siblings) and parse it. */
const readDataPackParsed = async <T>(
  absPath: string,
  parse: (dp: omnistudio.DataPackRead) => Loaded<T>,
): Promise<Loaded<T>> => {
  const dp = await omnistudio.readDataPack(absPath);
  if (!dp.ok) return { ok: false, reason: `DataPack unreadable (${dp.message})` };
  return parse(dp.value);
};

const readParsed = async <T>(
  absPath: string,
  parse: (text: string) => Loaded<T>,
): Promise<Loaded<T>> => {
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (cause: unknown) {
    return { ok: false, reason: `source file unreadable (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  return parse(text);
};
