import { omniElementInfo } from './catalog.js';
import type { OmniTreeElement } from './process.js';

/**
 * How each OmniScript element type touches the data JSON.
 *
 *   - container  — nests its children's keys under its own name (`Step`,
 *                  `Block`, `Edit Block`, `Type Ahead Block`). An Edit Block,
 *                  and a Block with `repeat: true`, hold one row per entry.
 *   - input      — the answer is stored under the element name.
 *   - formula    — the computed result is stored under the element name.
 *   - setValues  — writes each `elementValueMap` key into the data JSON.
 *   - customLwc  — a custom Lightning Web Component: it may write ANY key
 *                  through the runtime's data-update API, and none is declared.
 *   - embedded   — an embedded OmniScript merges its own keys in.
 *   - action     — calls the server (or navigates); its response, if any,
 *                  merges at `responseJSONNode` / the root.
 *   - display    — renders only; produces no key.
 *
 * Types not listed are treated as `input` (they hold a value under their name)
 * unless their name says "Action" — a conservative default: an unknown type is
 * never assumed to produce nothing.
 */
export type ElementRole =
  | 'container'
  | 'input'
  | 'formula'
  | 'setValues'
  | 'customLwc'
  | 'embedded'
  | 'action'
  | 'display';

/** Element types whose values are a choice among declared options. */
export const CHOICE_TYPES: ReadonlySet<string> = new Set([
  'Radio',
  'Select',
  'Multi-select',
  'Radio Group',
]);

/**
 * The element's role in the data JSON (see the module header), read from the
 * element catalog (`catalog.ts`, aliases included). A type the catalog does not
 * list is an `action` when its name ends in "Action", else an `input`.
 */
export const elementRole = (type: string): ElementRole => {
  const info = omniElementInfo(type);
  if (info !== null && info.scriptRole !== null) return info.scriptRole;
  return / Action$/.test(type.trim()) ? 'action' : 'input';
};

/** True when the element holds one row per entry (Edit Block, repeating Block, repeating input). */
export const isRepeating = (element: OmniTreeElement): boolean => {
  if (element.canonicalType === 'Edit Block') return true;
  const repeat = element.config?.['repeat'];
  return repeat === true || repeat === 'true';
};

/**
 * Integration Procedure step types that read their input from the IP data
 * JSON and run something with it.
 */
export type IpStepRole =
  | 'dataMapper'
  | 'remote'
  | 'rest'
  | 'nestedIp'
  | 'setValues'
  | 'response'
  | 'block'
  | 'loop'
  | 'listMerge'
  | 'delete'
  | 'calculation'
  | 'other';

/**
 * The step's role in the IP data flow, read from the element catalog
 * (`catalog.ts`, aliases included); `other` for a type it does not list.
 */
export const ipStepRole = (type: string): IpStepRole => omniElementInfo(type)?.ipRole ?? 'other';

/**
 * Edit Block child actions the runtime binds to the card buttons:
 * `<EditBlockName>-New`, `-Edit`, `-Delete`. Returns the button, or null.
 */
export const editBlockActionKind = (
  editBlockName: string,
  childName: string,
): 'New' | 'Edit' | 'Delete' | null => {
  for (const kind of ['New', 'Edit', 'Delete'] as const) {
    if (childName === `${editBlockName}-${kind}`) return kind;
  }
  return null;
};
