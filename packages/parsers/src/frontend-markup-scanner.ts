import { err, ok, type Result } from '@sf-intelligence/core';

import type {
  FrontendFieldAccess,
  FrontendFieldAccessOrigin,
  FrontendScannerError,
} from './frontend-scanner.js';

/** @see {@link scanLwcHtml} */
export interface FrontendUnresolvedFieldBinding {
  readonly type: 'read' | 'write';
  readonly fieldName: string;
  readonly offset: number;
  readonly length: number;
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const blankOut = (text: string): string => text.replace(/[^\n]/g, ' ');

const readAttr = (attrs: string, name: string): string | null => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(['"])([^'"]*)\\1`, 'i');
  const m = attrs.match(re);
  const value = m?.[2]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
};

const parseFieldNameList = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) {
    const out: string[] = [];
    const re = /['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) {
      const name = m[1]?.trim();
      if (name !== undefined && name.length > 0) out.push(name);
    }
    return out;
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const splitQualifiedField = (
  name: string,
): { object: string; field: string } | null => {
  const dot = name.indexOf('.');
  if (dot <= 0 || dot >= name.length - 1) return null;
  return { object: name.slice(0, dot), field: name.slice(dot + 1) };
};

const PRIMITIVE_AURA_TYPES = new Set([
  'string',
  'boolean',
  'integer',
  'long',
  'double',
  'decimal',
  'date',
  'datetime',
  'time',
  'id',
  'base64',
  'object',
  'map',
  'list',
  'set',
  'aura://',
]);

const isLikelySObjectType = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (PRIMITIVE_AURA_TYPES.has(lower)) return false;
  if (lower.startsWith('aura://')) return false;
  return /^[A-Za-z][A-Za-z0-9_]*(__c|__mdt|__b)?$/.test(name);
};

interface MarkupFieldContext {
  readonly accesses: FrontendFieldAccess[];
  readonly unresolved: FrontendUnresolvedFieldBinding[];
  readonly seen: Set<string>;
  readonly seenUnresolved: Set<string>;
}

const emitResolved = (
  ctx: MarkupFieldContext,
  type: 'read' | 'write',
  object: string,
  field: string,
  offset: number,
  length: number,
  origin: FrontendFieldAccessOrigin,
): void => {
  const key = `${type}:${object}.${field}:${origin}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  ctx.accesses.push({ type, object, field, offset, length, origin });
};

const emitBare = (
  ctx: MarkupFieldContext,
  type: 'read' | 'write',
  fieldName: string,
  offset: number,
  length: number,
): void => {
  const key = `${type}:${fieldName}`;
  if (ctx.seenUnresolved.has(key)) return;
  ctx.seenUnresolved.add(key);
  ctx.unresolved.push({ type, fieldName, offset, length });
};

const bindFieldName = (
  ctx: MarkupFieldContext,
  type: 'read' | 'write',
  fieldName: string,
  objectApiName: string | null,
  offset: number,
  length: number,
): void => {
  if (objectApiName !== null) {
    emitResolved(ctx, type, objectApiName, fieldName, offset, length, 'lwc-markup');
    return;
  }
  const parsed = splitQualifiedField(fieldName);
  if (parsed !== null) {
    emitResolved(
      ctx,
      type,
      parsed.object,
      parsed.field,
      offset,
      length,
      'markup-qualified',
    );
    return;
  }
  emitBare(ctx, type, fieldName, offset, length);
};

const LWC_RECORD_FORM_TAGS = new Set([
  'lightning-record-form',
  'lightning-record-edit-form',
  'lightning-record-view-form',
]);

const recordFormAccessType = (tag: string, attrs: string): 'read' | 'write' => {
  if (tag === 'lightning-record-view-form') return 'read';
  // lightning-record-form defaults to mode="view", which still exposes inline edit.
  if (tag === 'lightning-record-form' && readAttr(attrs, 'mode')?.toLowerCase() === 'readonly') {
    return 'read';
  }
  return 'write';
};

const TAG_RE = /<\/?([A-Za-z][\w-]*(?::[\w-]+)?)([^>]*?)(\/)?>/g;

export interface FrontendMarkupScanOutput {
  readonly fieldAccesses: readonly FrontendFieldAccess[];
  readonly unresolvedFieldBindings: readonly FrontendUnresolvedFieldBinding[];
}

/**
 * Scan an LWC `.html` template for declarative field bindings on base
 * components (`lightning-input-field`, `lightning-output-field`,
 * `lightning-record-*-form` `fields` lists).
 */
export const scanLwcHtml = (
  source: string,
): Result<FrontendMarkupScanOutput, FrontendScannerError> => {
  if (source.trim().length === 0) {
    return err({
      kind: 'empty-source',
      message: 'source is empty or whitespace-only',
      offset: 0,
    });
  }

  const ctx: MarkupFieldContext = {
    accesses: [],
    unresolved: [],
    seen: new Set<string>(),
    seenUnresolved: new Set<string>(),
  };
  const stripped = source.replace(HTML_COMMENT, blankOut);
  const objectStack: (string | null)[] = [];

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(stripped)) !== null) {
    const rawTag = m[1] ?? '';
    const tag = rawTag.toLowerCase();
    const attrs = m[2] ?? '';
    const selfClosing = m[3] === '/' || attrs.trimEnd().endsWith('/');
    const isClose = stripped[m.index + 1] === '/';

    if (isClose) {
      if (LWC_RECORD_FORM_TAGS.has(tag)) objectStack.pop();
      continue;
    }

    const tagObject = readAttr(attrs, 'object-api-name');

    if (LWC_RECORD_FORM_TAGS.has(tag)) {
      const stackObject = tagObject ?? objectStack.at(-1) ?? null;
      objectStack.push(stackObject);
      const fieldsRaw = readAttr(attrs, 'fields');
      if (fieldsRaw !== null) {
        const access = recordFormAccessType(tag, attrs);
        for (const fieldName of parseFieldNameList(fieldsRaw)) {
          bindFieldName(
            ctx,
            access,
            fieldName,
            stackObject,
            m.index,
            m[0].length,
          );
        }
      }
      if (selfClosing) objectStack.pop();
      continue;
    }

    const enclosingObject =
      tagObject ?? readAttr(attrs, 'object-api-name') ?? objectStack.at(-1) ?? null;

    if (tag === 'lightning-input-field') {
      const fieldName = readAttr(attrs, 'field-name');
      if (fieldName !== null) {
        bindFieldName(ctx, 'write', fieldName, enclosingObject, m.index, m[0].length);
      }
      continue;
    }

    if (tag === 'lightning-output-field') {
      const fieldName = readAttr(attrs, 'field-name');
      if (fieldName !== null) {
        bindFieldName(ctx, 'read', fieldName, enclosingObject, m.index, m[0].length);
      }
    }
  }

  return ok({
    fieldAccesses: ctx.accesses,
    unresolvedFieldBindings: ctx.unresolved,
  });
};

const auraBindField = (
  ctx: MarkupFieldContext,
  type: 'read' | 'write',
  fieldName: string,
  objectApiName: string | null,
  offset: number,
  length: number,
): void => {
  if (objectApiName !== null) {
    emitResolved(ctx, type, objectApiName, fieldName, offset, length, 'aura-markup');
    return;
  }
  const parsed = splitQualifiedField(fieldName);
  if (parsed !== null) {
    emitResolved(
      ctx,
      type,
      parsed.object,
      parsed.field,
      offset,
      length,
      'markup-qualified',
    );
    return;
  }
  emitBare(ctx, type, fieldName, offset, length);
};

/**
 * Scan Aura markup for `force:recordData` field lists and
 * `lightning:inputField` / `lightning:outputField` bindings.
 */
export const scanAuraMarkupFields = (source: string): FrontendMarkupScanOutput => {
  const ctx: MarkupFieldContext = {
    accesses: [],
    unresolved: [],
    seen: new Set<string>(),
    seenUnresolved: new Set<string>(),
  };
  if (source.trim().length === 0) {
    return { fieldAccesses: [], unresolvedFieldBindings: [] };
  }

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(source)) !== null) {
    const rawTag = m[1] ?? '';
    const tagLower = rawTag.toLowerCase();
    const attrs = m[2] ?? '';
    if (source[m.index + 1] === '/') continue;

    const objectApiName =
      readAttr(attrs, 'sobjectType') ??
      readAttr(attrs, 'objectApiName') ??
      readAttr(attrs, 'type');
    const resolvedObject =
      objectApiName !== null && isLikelySObjectType(objectApiName)
        ? objectApiName
        : null;

    if (tagLower === 'force:recorddata') {
      const fieldsRaw = readAttr(attrs, 'fields');
      if (fieldsRaw !== null) {
        for (const fieldName of parseFieldNameList(fieldsRaw)) {
          auraBindField(ctx, 'read', fieldName, resolvedObject, m.index, m[0].length);
        }
      }
      continue;
    }

    if (tagLower === 'lightning:inputfield') {
      const fieldName = readAttr(attrs, 'fieldName');
      if (fieldName !== null) {
        const fieldObject =
          resolvedObject ??
          (() => {
            const o =
              readAttr(attrs, 'objectApiName') ?? readAttr(attrs, 'sobjectType');
            return o !== null && isLikelySObjectType(o) ? o : null;
          })();
        auraBindField(ctx, 'write', fieldName, fieldObject, m.index, m[0].length);
      }
      continue;
    }

    if (tagLower === 'lightning:outputfield') {
      const fieldName = readAttr(attrs, 'fieldName');
      if (fieldName !== null) {
        const fieldObject =
          resolvedObject ??
          (() => {
            const o =
              readAttr(attrs, 'objectApiName') ?? readAttr(attrs, 'sobjectType');
            return o !== null && isLikelySObjectType(o) ? o : null;
          })();
        auraBindField(ctx, 'read', fieldName, fieldObject, m.index, m[0].length);
      }
    }
  }

  return {
    fieldAccesses: ctx.accesses,
    unresolvedFieldBindings: ctx.unresolved,
  };
};
