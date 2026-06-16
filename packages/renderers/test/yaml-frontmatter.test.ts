/// <reference types="vitest/globals" />

import { serializeFrontmatter } from '../src/yaml-frontmatter.js';

describe('serializeFrontmatter', () => {
  describe('scalars', () => {
    it('emits bare strings, numbers, booleans, and null', () => {
      const out = serializeFrontmatter({
        name: 'Account',
        count: 42,
        active: true,
        disabled: false,
        owner: null,
      });
      // Keys must be sorted alphabetically at the top level.
      expect(out).toBe(
        'active: true\ncount: 42\ndisabled: false\nname: Account\nowner: null',
      );
    });

    it('emits integers without a fractional part', () => {
      // JSON has no float/int distinction; an integer parses as a Number
      // with no fractional component and must serialize as a bare integer.
      expect(serializeFrontmatter({ apiVersion: 62 })).toBe('apiVersion: 62');
    });

    it('preserves a fractional number as written', () => {
      expect(serializeFrontmatter({ ratio: 0.5 })).toBe('ratio: 0.5');
    });
  });

  describe('string quoting', () => {
    it('quotes the empty string', () => {
      expect(serializeFrontmatter({ s: '' })).toBe('s: ""');
    });

    it('quotes strings containing a comma', () => {
      expect(serializeFrontmatter({ s: 'a, b' })).toBe('s: "a, b"');
    });

    it('quotes strings containing colon-space', () => {
      expect(serializeFrontmatter({ s: 'foo: bar' })).toBe('s: "foo: bar"');
    });

    it('does NOT quote strings with colon-without-space', () => {
      // Bare colon (no trailing space) is YAML-safe in plain-scalar form;
      // this matches the golden's `id: CustomObject:CustomerProject__c`.
      expect(serializeFrontmatter({ id: 'CustomObject:Foo' })).toBe('id: CustomObject:Foo');
    });

    it('quotes strings with leading whitespace', () => {
      expect(serializeFrontmatter({ s: ' leading' })).toBe('s: " leading"');
    });

    it('quotes strings with trailing whitespace', () => {
      expect(serializeFrontmatter({ s: 'trailing ' })).toBe('s: "trailing "');
    });

    it('quotes strings starting with a hyphen', () => {
      expect(serializeFrontmatter({ s: '-dash' })).toBe('s: "-dash"');
    });

    it('quotes strings containing a hash', () => {
      expect(serializeFrontmatter({ s: 'foo#bar' })).toBe('s: "foo#bar"');
    });

    it('quotes strings that look like YAML booleans/nulls', () => {
      expect(serializeFrontmatter({ a: 'true', b: 'False', c: 'yes', d: 'NO', e: 'null', f: '~' })).toBe(
        'a: "true"\nb: "False"\nc: "yes"\nd: "NO"\ne: "null"\nf: "~"',
      );
    });

    it('escapes embedded double-quotes, backslashes, newlines, tabs, CR', () => {
      expect(
        serializeFrontmatter({
          s: 'a"b\\c\nd\te\rf',
        }),
      ).toBe('s: "a\\"b\\\\c\\nd\\te\\rf"');
    });

    it('quotes strings containing brackets, braces, or other special chars', () => {
      expect(serializeFrontmatter({ s: '[a]', t: '{b}', u: '*c', v: '!d' })).toBe(
        's: "[a]"\nt: "{b}"\nu: "*c"\nv: "!d"',
      );
    });
  });

  describe('nested maps', () => {
    it('indents nested maps with two spaces per level and sorts each level', () => {
      const out = serializeFrontmatter({
        outer: {
          z: 1,
          a: 'hi',
        },
        first: 'x',
      });
      expect(out).toBe('first: x\nouter:\n  a: hi\n  z: 1');
    });

    it('supports deeper nesting recursively', () => {
      const out = serializeFrontmatter({
        a: {
          b: {
            c: 'leaf',
          },
        },
      });
      expect(out).toBe('a:\n  b:\n    c: leaf');
    });
  });

  describe('arrays of primitives', () => {
    it('serializes an array of plain strings as a block sequence', () => {
      expect(serializeFrontmatter({ picklistValues: ['January', 'February', 'March'] })).toBe(
        'picklistValues:\n  - January\n  - February\n  - March',
      );
    });

    it('preserves insertion order; does NOT sort elements', () => {
      // Insertion order is load-bearing for trigger events, modifier
      // sequences, etc. — sorting would mis-render the source meaning.
      // Using values that would each sort differently to prove order:
      // alphabetical sort would put 'after' before 'before'.
      expect(serializeFrontmatter({ events: ['beforeUpdate', 'afterInsert', 'afterDelete'] })).toBe(
        'events:\n  - beforeUpdate\n  - afterInsert\n  - afterDelete',
      );
    });

    it('quotes array elements that would parse ambiguously', () => {
      // Same quoting rules as map scalars: colon-space, leading dash,
      // hash, brackets, and YAML reserved literals all force quoting.
      expect(
        serializeFrontmatter({
          quirky: ['foo: bar', '-leading', 'with#hash', 'true', '[bracket]', 'plain'],
        }),
      ).toBe(
        'quirky:\n  - "foo: bar"\n  - "-leading"\n  - "with#hash"\n  - "true"\n  - "[bracket]"\n  - plain',
      );
    });

    it('serializes mixed primitive arrays (numbers, booleans, nulls)', () => {
      expect(serializeFrontmatter({ foo: [42, true, null, false, 0] })).toBe(
        'foo:\n  - 42\n  - true\n  - null\n  - false\n  - 0',
      );
    });

    it('renders an empty array inline as []', () => {
      expect(serializeFrontmatter({ events: [] })).toBe('events: []');
    });

    it('renders an array nested inside a map at the right indent', () => {
      // Picklist values inside a properties map: the `- ` indent is two
      // spaces deeper than the owning `picklistValues:` key.
      const out = serializeFrontmatter({
        properties: {
          dataType: 'Picklist',
          picklistValues: ['A', 'B', 'C'],
        },
      });
      expect(out).toBe(
        'properties:\n  dataType: Picklist\n  picklistValues:\n    - A\n    - B\n    - C',
      );
    });

    it('serializes an array at the top level of frontmatter', () => {
      // Top-level array values still get the `- ` indent at depth 1
      // (two spaces), one step deeper than the owning key at depth 0.
      expect(serializeFrontmatter({ tags: ['edu', 'pilot', 'demo'] })).toBe(
        'tags:\n  - edu\n  - pilot\n  - demo',
      );
    });

    it('interleaves an array key with sibling scalar keys in sorted order', () => {
      const out = serializeFrontmatter({
        zebra: 'last',
        items: ['x', 'y'],
        alpha: 1,
      });
      expect(out).toBe('alpha: 1\nitems:\n  - x\n  - y\nzebra: last');
    });
  });

  describe('arrays of plain objects', () => {
    it('serializes an array of plain objects as a block-sequence of mappings', () => {
      // Profile.layoutAssignments shape: each entry is { layout, recordType }
      // with `recordType: null` rendered as the YAML scalar `null` (not
      // omitted, not `~`).
      const out = serializeFrontmatter({
        layoutAssignments: [
          { layout: 'Account-Account Layout', recordType: null },
          { layout: 'Account-Partner Account Layout', recordType: 'Account.Partner' },
        ],
      });
      expect(out).toBe(
        'layoutAssignments:\n' +
          '  - layout: Account-Account Layout\n' +
          '    recordType: null\n' +
          '  - layout: Account-Partner Account Layout\n' +
          '    recordType: Account.Partner',
      );
    });

    it('renders an empty array of objects inline as []', () => {
      // Empty arrays do not need the type information to disambiguate;
      // existing inline-`[]` behavior is preserved.
      expect(serializeFrontmatter({ layoutAssignments: [] })).toBe('layoutAssignments: []');
    });

    it('serializes a single-entry array of objects', () => {
      expect(serializeFrontmatter({ items: [{ a: 1 }] })).toBe(
        'items:\n  - a: 1',
      );
    });

    it('sorts object keys alphabetically inside each array element', () => {
      // Insertion order inside each object is { zebra, alpha, monkey };
      // the renderer must reorder to { alpha, monkey, zebra } to keep the
      // output byte-stable across re-runs that hit a different insertion
      // order from JSON.parse / object spread.
      const out = serializeFrontmatter({
        items: [
          { zebra: 1, alpha: 2, monkey: 3 },
        ],
      });
      expect(out).toBe('items:\n  - alpha: 2\n    monkey: 3\n    zebra: 1');
    });

    it('serializes mixed scalar value types within object fields', () => {
      // Profile.recordTypeVisibilities shape exercises this:
      // { recordType: string, default: boolean, visible: boolean | null }
      const out = serializeFrontmatter({
        recordTypeVisibilities: [
          { recordType: 'Account.Partner', default: true, visible: false },
          { recordType: 'Account.Customer', default: false, visible: null },
        ],
      });
      expect(out).toBe(
        'recordTypeVisibilities:\n' +
          '  - default: true\n' +
          '    recordType: Account.Partner\n' +
          '    visible: false\n' +
          '  - default: false\n' +
          '    recordType: Account.Customer\n' +
          '    visible: null',
      );
    });

    it('applies scalar string-escape rules to nested-object values', () => {
      // Values inside the object follow the same quoting rules as top-level
      // scalars: colon-space, leading dash, hash, brackets, and reserved
      // literals all force quoting. Dash-without-leading and bare colons
      // pass through unquoted (matches `Account-Account Layout`).
      const out = serializeFrontmatter({
        items: [
          {
            colonSpace: 'foo: bar',
            hash: 'with#hash',
            leadingDash: '-leading',
            reserved: 'true',
            ok: 'Account-Account Layout',
          },
        ],
      });
      expect(out).toBe(
        'items:\n' +
          '  - colonSpace: "foo: bar"\n' +
          '    hash: "with#hash"\n' +
          '    leadingDash: "-leading"\n' +
          '    ok: Account-Account Layout\n' +
          '    reserved: "true"',
      );
    });

    it('renders array-of-objects deterministically across repeated calls', () => {
      // Byte-stability under repeated serialization is the load-bearing
      // contract: the vault output is committed to Git, so two runs against
      // the same input must produce identical bytes.
      const input = {
        layoutAssignments: [
          { layout: 'Account-Account Layout', recordType: null },
          { layout: 'Contact-Contact Layout', recordType: null },
        ],
      };
      const first = serializeFrontmatter(input);
      const second = serializeFrontmatter(input);
      expect(first).toBe(second);
    });

    it('interleaves an array-of-objects key with sibling scalar keys in sorted order', () => {
      // Top-level key sort still applies; the array-of-objects renderer
      // does not affect outer-map ordering.
      const out = serializeFrontmatter({
        zebra: 'last',
        items: [{ a: 1 }, { a: 2 }],
        alpha: 1,
      });
      expect(out).toBe(
        'alpha: 1\nitems:\n  - a: 1\n  - a: 2\nzebra: last',
      );
    });

    it('throws on nested objects inside array elements (depth limit)', () => {
      // Depth-4 ceiling: outer property -> array -> object -> inner array
      // -> scalar. A nested object as a field value would push to depth 5,
      // which we deliberately reject so the YAML stays readable.
      expect(() =>
        serializeFrontmatter({ items: [{ inner: { a: 1 } }] }),
      ).toThrow(/depth limit 4/);
    });

    it('throws on arrays of arrays', () => {
      expect(() => serializeFrontmatter({ items: [[1, 2]] })).toThrow(
        /nested arrays are not supported/,
      );
    });

    it('throws on arrays that mix objects with scalars', () => {
      expect(() =>
        serializeFrontmatter({ items: [{ a: 1 }, 'string'] }),
      ).toThrow(/mixed scalars and objects/);
    });

    it('throws on arrays containing class instances (non-plain objects)', () => {
      // Class instances are not safe to enumerate with `Object.keys` for
      // YAML emission (prototype methods, accessors, etc.). Reject early.
      class NotPlain {
        readonly x = 1;
      }
      expect(() => serializeFrontmatter({ items: [new NotPlain()] })).toThrow(
        /plain objects or scalars/,
      );
    });
  });

  describe('arrays of objects with inner scalar arrays (depth-4)', () => {
    it('serializes the v2.0a conditionsMirror shape', () => {
      // The driving use case per `ConditionalContextSemantics.md` §"The
      // `properties.conditions[]` property mirror": each firer carries its
      // conditions inline so the property-read path doesn't require a
      // graph hop. `fieldRefs` is the canonical CustomField id list per
      // condition. Per-object keys sort alphabetically; inner-array
      // element order is preserved (matches the top-level scalar-array
      // rule).
      const out = serializeFrontmatter({
        conditionsMirror: [
          {
            kind: 'criteria',
            conditionContextId:
              'ConditionalContext:WorkflowRule:Account.UpdateIndustry.condition-0',
            expression: "Industry__c == 'Tech'",
            fieldRefs: ['CustomField:Account.Industry__c'],
          },
          {
            kind: 'formula',
            conditionContextId: 'ConditionalContext:ValidationRule:Foo',
            expression: 'AND(IsActive, NOT(ISBLANK(Name)))',
            fieldRefs: [
              'CustomField:Foo.IsActive__c',
              'CustomField:Foo.Name',
            ],
          },
        ],
      });
      expect(out).toBe(
        'conditionsMirror:\n' +
          '  - conditionContextId: ' +
            'ConditionalContext:WorkflowRule:Account.UpdateIndustry.condition-0\n' +
          '    expression: "Industry__c == \'Tech\'"\n' +
          '    fieldRefs:\n' +
          '      - CustomField:Account.Industry__c\n' +
          '    kind: criteria\n' +
          '  - conditionContextId: ConditionalContext:ValidationRule:Foo\n' +
          '    expression: "AND(IsActive, NOT(ISBLANK(Name)))"\n' +
          '    fieldRefs:\n' +
          '      - CustomField:Foo.IsActive__c\n' +
          '      - CustomField:Foo.Name\n' +
          '    kind: formula',
      );
    });

    it('renders an empty inner array inline as []', () => {
      // Empty inner arrays mirror the top-level empty-array rule
      // (`serializeMap` emits `key: []` inline). Keeping the same shape
      // here means re-rendering an empty-`fieldRefs` mirror entry stays
      // byte-stable regardless of which level the empty array sits at.
      expect(serializeFrontmatter({ items: [{ a: 1, refs: [] }] })).toBe(
        'items:\n  - a: 1\n    refs: []',
      );
    });

    it('preserves inner-array element order with multiple strings', () => {
      // The brief: inner-array element order is the declared order (no
      // sort), even though the per-object keys around it sort. The
      // outer-array sibling-key sort still applies (`a` before `refs`).
      const out = serializeFrontmatter({
        items: [
          { refs: ['z', 'a', 'm'], a: 1 },
        ],
      });
      expect(out).toBe(
        'items:\n' +
          '  - a: 1\n' +
          '    refs:\n' +
          '      - z\n' +
          '      - a\n' +
          '      - m',
      );
    });

    it('renders null elements inside inner arrays as the YAML null scalar', () => {
      // `null` flows through `serializeScalar` and emits the bare `null`
      // literal (the same rule as top-level array elements). Inner-array
      // elements stay in declared order.
      expect(serializeFrontmatter({ items: [{ refs: [null, 'x'] }] })).toBe(
        'items:\n  - refs:\n      - null\n      - x',
      );
    });

    it('applies scalar quoting rules to inner-array element strings', () => {
      // Inner-array values flow through `serializeScalar` and inherit the
      // same quoting rules as top-level scalars. Two paths matter for the
      // conditionsMirror use case: bare colons (`CustomField:Foo.Bar`)
      // pass through unquoted; embedded `: ` and other special characters
      // force double-quoting.
      const out = serializeFrontmatter({
        items: [
          {
            refs: [
              'CustomField:Foo.Bar',
              'foo: bar',
              '-leading',
              'true',
            ],
          },
        ],
      });
      expect(out).toBe(
        'items:\n' +
          '  - refs:\n' +
          '      - CustomField:Foo.Bar\n' +
          '      - "foo: bar"\n' +
          '      - "-leading"\n' +
          '      - "true"',
      );
    });

    it('renders depth-4 arrays-of-objects deterministically across repeated calls', () => {
      // Byte-stability under repeated serialization is the load-bearing
      // contract — the vault output is committed to Git. Two runs against
      // the same depth-4 input must produce identical bytes.
      const input = {
        conditionsMirror: [
          {
            kind: 'criteria' as const,
            conditionContextId: 'ConditionalContext:WR:Account.A.condition-0',
            expression: 'X',
            fieldRefs: ['CustomField:Account.X__c'],
          },
        ],
      };
      const first = serializeFrontmatter(input);
      const second = serializeFrontmatter(input);
      expect(first).toBe(second);
    });

    it('throws on nested-array elements inside inner arrays (depth-5)', () => {
      // `[[1]]` inside an object's array value pushes to depth 5
      // (outer -> array -> object -> inner array -> inner-inner array
      // -> scalar). The renderer refuses; the extractor surface does not
      // emit shapes this deep.
      expect(() =>
        serializeFrontmatter({ items: [{ a: [[1]] }] }),
      ).toThrow(/depth limit 4/);
    });

    it('throws on object elements inside inner arrays (depth-5)', () => {
      // An object element inside the inner array also pushes to depth 5
      // (outer -> array -> object -> inner array -> object -> scalar);
      // same depth-limit refusal as the nested-array case.
      expect(() =>
        serializeFrontmatter({ items: [{ a: [{ b: 1 }] }] }),
      ).toThrow(/depth limit 4/);
    });
  });
});
