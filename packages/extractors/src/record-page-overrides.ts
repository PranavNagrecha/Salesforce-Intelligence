/**
 * Lightning record page ACTIVATION, read from `<actionOverrides>` /
 * `<profileActionOverrides>`.
 *
 * Which Lightning record page a user sees is declared metadata, at three
 * levels: the object's org default (`CustomObject.actionOverrides`), an app
 * default (`CustomApplication.actionOverrides`), and an app + record type +
 * profile assignment (`CustomApplication.profileActionOverrides`). Only the
 * `View` action with `type` `Flexipage` assigns a record page; every other
 * override (Edit, New, a Visualforce page, …) is ignored here.
 *
 * Shared by the CustomObject and CustomApplication extractors so the two read
 * the element the same way.
 */

/** One record-page activation entry, as stored on the node's `recordPageOverrides`. */
export interface RecordPageOverride {
  /** FlexiPage api name (`<content>`). */
  readonly page: string;
  /** Object the override applies to (`<pageOrSobjectType>`; the object itself on a CustomObject). */
  readonly object: string | null;
  /** `Large` (desktop), `Small` (phone), or null when not declared. */
  readonly formFactor: string | null;
  /** `Object.RecordTypeName`, or null for every record type. */
  readonly recordType: string | null;
  /** Profile name, or null for an app / org default. */
  readonly profile: string | null;
}

const first = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

const str = (entry: Record<string, unknown>, key: string): string | null => {
  const v = first(entry[key]);
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
};

const entriesOf = (value: unknown): Record<string, unknown>[] => {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === 'object' && !Array.isArray(e),
  );
};

/**
 * Collect the View/Flexipage overrides under `rootObj[element]`. `object`
 * supplies the object when the element carries no `<pageOrSobjectType>` (the
 * CustomObject case).
 */
export const collectRecordPageOverrides = (
  rootObj: Record<string, unknown>,
  element: 'actionOverrides' | 'profileActionOverrides',
  object: string | null = null,
): RecordPageOverride[] => {
  const out: RecordPageOverride[] = [];
  for (const entry of entriesOf(rootObj[element])) {
    if (str(entry, 'actionName') !== 'View') continue;
    if ((str(entry, 'type') ?? '').toLowerCase() !== 'flexipage') continue;
    const page = str(entry, 'content');
    if (page === null) continue;
    out.push({
      page,
      object: str(entry, 'pageOrSobjectType') ?? object,
      formFactor: str(entry, 'formFactor'),
      recordType: str(entry, 'recordType'),
      profile: str(entry, 'profile'),
    });
  }
  return out;
};
