import { describe, expect, it } from 'vitest';

import {
  fieldMatchesObjectScope,
  formatSfCliFailure,
  mergeInputAliases,
  parseFieldParentObjectApiName,
  resolveApexClassAlias,
  resolveContainerAlias,
  resolveFieldAlias,
  resolveObjectAlias,
  resolveObjectScopeParentId,
  toApexClassId,
  toCustomObjectId,
  toLayoutId,
  toObjectApiName,
} from '../../src/tools/input-aliases.js';

describe('mergeInputAliases', () => {
  it('copies alias when canonical is missing', () => {
    const out = mergeInputAliases(
      { query: 'customer health', limit: 5 },
      [{ canonical: 'description', aliases: ['query'] }],
    ) as Record<string, unknown>;
    expect(out.description).toBe('customer health');
    expect(out.query).toBe('customer health');
  });

  it('prefers canonical over alias', () => {
    const out = mergeInputAliases(
      { description: 'canonical', query: 'alias' },
      [{ canonical: 'description', aliases: ['query'] }],
    ) as Record<string, unknown>;
    expect(out.description).toBe('canonical');
  });
});

describe('object scope helpers', () => {
  it('resolveObjectScopeParentId coerces bare api names', () => {
    expect(resolveObjectScopeParentId({ objectId: 'Account' })).toBe(
      'CustomObject:Account',
    );
    expect(resolveObjectScopeParentId({ objectApiName: 'Payment__c' })).toBe(
      'CustomObject:Payment__c',
    );
  });

  it('fieldMatchesObjectScope matches parentId or parsed field id', () => {
    expect(
      fieldMatchesObjectScope(
        {
          id: 'CustomField:Student_Record__c.Student_SSN__c',
          parentId: 'CustomObject:Student_Record__c',
        },
        'CustomObject:Student_Record__c',
      ),
    ).toBe(true);
    expect(parseFieldParentObjectApiName('CustomField:Account.Industry__c')).toBe(
      'Account',
    );
  });
});

describe('id helpers', () => {
  it('toCustomObjectId adds prefix', () => {
    expect(toCustomObjectId('Account')).toBe('CustomObject:Account');
  });

  it('toObjectApiName strips prefix', () => {
    expect(toObjectApiName('CustomObject:Account')).toBe('Account');
  });

  it('toLayoutId adds prefix', () => {
    expect(toLayoutId('Account-Account Layout')).toBe('Layout:Account-Account Layout');
  });

  it('toApexClassId adds prefix and is idempotent', () => {
    expect(toApexClassId('My_Class')).toBe('ApexClass:My_Class');
    expect(toApexClassId('ApexClass:My_Class')).toBe('ApexClass:My_Class');
  });
});

describe('resolveObjectAlias — L2 object normalizer', () => {
  const unwrap = (r: ReturnType<typeof resolveObjectAlias>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
    return r.value;
  };
  /** Unwrap and assert a non-null resolved scope. */
  const scope = (r: ReturnType<typeof resolveObjectAlias>) => {
    const v = unwrap(r);
    if (v === null) throw new Error('expected a resolved object scope, got null');
    return v;
  };

  it('natural objectApiName ≡ canonical CustomObject componentId', () => {
    const natural = scope(resolveObjectAlias({ objectApiName: 'Widget__c' }));
    const canonical = scope(resolveObjectAlias({ componentId: 'CustomObject:Widget__c' }));
    expect(natural).toEqual({ componentId: 'CustomObject:Widget__c', object: 'Widget__c' });
    expect(natural).toEqual(canonical);
  });

  it('accepts the `object` and `objectId` aliases identically', () => {
    const byObject = scope(resolveObjectAlias({ object: 'Widget__c' }));
    const byObjectId = scope(resolveObjectAlias({ objectId: 'CustomObject:Widget__c' }));
    expect(byObject).toEqual(byObjectId);
    expect(byObject.componentId).toBe('CustomObject:Widget__c');
  });

  it('treats a bare componentId as an object only when bareComponentIdIsObject', () => {
    expect(scope(resolveObjectAlias({ componentId: 'Widget__c' })).componentId).toBe(
      'CustomObject:Widget__c',
    );
    // Polymorphic tool: a bare componentId is its OWN reverse mode, not an object.
    expect(
      unwrap(
        resolveObjectAlias(
          { componentId: 'Widget__c' },
          { bareComponentIdIsObject: false, required: false },
        ),
      ),
    ).toBeNull();
  });

  it('ignores reverse-mode componentId prefixes (Layout:/FlexiPage:/ListView:)', () => {
    for (const cid of ['Layout:Widget__c.My Layout', 'FlexiPage:My_Page', 'ListView:Widget__c.My_View']) {
      const r = resolveObjectAlias(
        { componentId: cid },
        { bareComponentIdIsObject: false, required: false },
      );
      expect(unwrap(r)).toBeNull();
    }
  });

  it('folds an object alias alongside a reverse-mode componentId', () => {
    // Polymorphic tool in OBJECT mode: reverse-prefix componentId is ignored,
    // the objectApiName resolves the scope.
    const r = resolveObjectAlias(
      { componentId: 'FlexiPage:My_Page', objectApiName: 'Widget__c' },
      { bareComponentIdIsObject: false },
    );
    expect(scope(r)).toEqual({ componentId: 'CustomObject:Widget__c', object: 'Widget__c' });
  });

  it('agreeing aliases collapse to one target (no false conflict)', () => {
    const r = resolveObjectAlias({
      objectApiName: 'Widget__c',
      componentId: 'CustomObject:Widget__c',
    });
    expect(scope(r).object).toBe('Widget__c');
  });

  it('disagreeing aliases → invalid-query', () => {
    const r = resolveObjectAlias({ objectApiName: 'Widget__c', object: 'Gadget__c' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('invalid-query');
      expect(r.error.message).toContain('different targets');
    }
  });

  it('no object named → invalid-query when required', () => {
    const r = resolveObjectAlias({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('no object named → ok(null) when not required (reverse mode)', () => {
    expect(unwrap(resolveObjectAlias({}, { required: false }))).toBeNull();
  });

  describe('unhandledPrefix', () => {
    it("DEFAULT is 'ignore' — the three polymorphic callers still reach their reverse mode", () => {
      // If this regresses, layout_assignments / lightning_pages / list_view_sharing
      // start refusing the ids they exist to accept.
      for (const cid of [
        'Layout:Widget__c.My Layout',
        'FlexiPage:My_Page',
        'ListView:Widget__c.My_View',
      ]) {
        const r = resolveObjectAlias(
          { componentId: cid },
          { bareComponentIdIsObject: false, required: false },
        );
        expect(r.ok).toBe(true);
        expect(unwrap(r)).toBeNull();
      }
    });

    it("'refuse' turns an unhandled prefix into a NAMED invalid-query, never a silent org-wide widening", () => {
      const r = resolveObjectAlias(
        { componentId: 'ApexClass:WidgetService' },
        { required: false, unhandledPrefix: 'refuse' },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe('invalid-query');
        expect(r.error.path).toBe('componentId');
        expect(r.error.message).toBe(
          "componentId 'ApexClass:WidgetService' is a ApexClass: id, and this tool scopes only " +
            'by OBJECT. It was NOT applied — pass objectApiName / object / objectId, or a ' +
            'CustomObject: id. Refusing rather than returning the org-wide report, which would ' +
            'answer a question you did not ask.',
        );
      }
    });

    it("'refuse' still accepts a CustomObject: componentId and a bare api name", () => {
      expect(
        scope(resolveObjectAlias({ componentId: 'CustomObject:Widget__c' }, { unhandledPrefix: 'refuse' }))
          .object,
      ).toBe('Widget__c');
      expect(
        scope(resolveObjectAlias({ componentId: 'Widget__c' }, { unhandledPrefix: 'refuse' })).object,
      ).toBe('Widget__c');
    });

    it("'refuse' leaves the unscoped bare call alone (ok(null), not a refusal)", () => {
      expect(unwrap(resolveObjectAlias({}, { required: false, unhandledPrefix: 'refuse' }))).toBeNull();
    });
  });
});

describe('resolveFieldAlias — L2 field normalizer', () => {
  const unwrap = (r: ReturnType<typeof resolveFieldAlias>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
    return r.value;
  };

  it('natural componentId ≡ canonical fieldId', () => {
    const byField = unwrap(resolveFieldAlias({ fieldId: 'CustomField:Widget__c.My_Field__c' }));
    const byComponent = unwrap(
      resolveFieldAlias({ componentId: 'CustomField:Widget__c.My_Field__c' }),
    );
    expect(byField).toEqual(byComponent);
    expect(byField.fieldId).toBe('CustomField:Widget__c.My_Field__c');
  });

  it('preserves the short-form value for the tool to normalize', () => {
    expect(unwrap(resolveFieldAlias({ fieldId: 'Widget__c.My_Field__c' })).fieldId).toBe(
      'Widget__c.My_Field__c',
    );
  });

  it('disagreeing fieldId / componentId → invalid-query', () => {
    const r = resolveFieldAlias({
      fieldId: 'CustomField:Widget__c.My_Field__c',
      componentId: 'CustomField:Widget__c.Other_Field__c',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('neither → invalid-query', () => {
    const r = resolveFieldAlias({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

describe('resolveApexClassAlias — L2 class normalizer', () => {
  const unwrap = (r: ReturnType<typeof resolveApexClassAlias>) => {
    if (!r.ok) throw new Error(`expected ok, got ${r.error.kind}: ${r.error.message}`);
    return r.value;
  };

  it('componentId ≡ classApiName ≡ apiName', () => {
    const byComponent = unwrap(resolveApexClassAlias({ componentId: 'ApexClass:My_Class' }));
    const byClassApi = unwrap(resolveApexClassAlias({ classApiName: 'My_Class' }));
    const byApiName = unwrap(resolveApexClassAlias({ apiName: 'My_Class' }));
    expect(byComponent).toEqual({ componentId: 'ApexClass:My_Class', apexClass: 'My_Class' });
    expect(byClassApi).toEqual(byComponent);
    expect(byApiName).toEqual(byComponent);
  });

  it('disagreeing aliases → invalid-query', () => {
    const r = resolveApexClassAlias({ classApiName: 'My_Class', apiName: 'Other_Class' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });

  it('none → invalid-query', () => {
    const r = resolveApexClassAlias({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid-query');
  });
});

describe('formatSfCliFailure', () => {
  it('appends upgrade hint for update-available stderr', () => {
    const msg = formatSfCliFailure('Warning: update available from 2.103.7 to 2.137.7');
    expect(msg).toContain('sf update');
  });
});

// =============================================================================
// FIX 5 — the missing FOURTH resolver. CLAUDE.md states the required behaviour
// verbatim ("When the selectors disagree, or none resolves, the tool refuses
// with a named `invalid-query`"), and three container-scoped tools shipped the
// opposite: a `z.preprocess` step that took the VALUE from one key and the
// PREFIX from the mere PRESENCE of another.
// =============================================================================
describe('resolveContainerAlias', () => {
  const idOf = (raw: unknown): string => {
    const r = resolveContainerAlias(raw);
    if (!r.ok) throw new Error(`unexpected refusal: ${r.error.message}`);
    return (r.value as { componentId: string }).componentId;
  };

  it('coerces per key BY THE KEY OWN NAME, never by a sibling key presence', () => {
    expect(idOf({ profileApiName: 'Alpha_Profile' })).toBe('Profile:Alpha_Profile');
    expect(idOf({ profileId: 'Alpha_Profile' })).toBe('Profile:Alpha_Profile');
    expect(idOf({ profileName: 'Alpha_Profile' })).toBe('Profile:Alpha_Profile');
    expect(idOf({ permissionSetApiName: 'Beta_Set' })).toBe('PermissionSet:Beta_Set');
    expect(idOf({ permissionSetId: 'Beta_Set' })).toBe('PermissionSet:Beta_Set');
    expect(idOf({ permissionSetName: 'Beta_Set' })).toBe('PermissionSet:Beta_Set');
    expect(idOf({ componentId: 'Alpha_Profile' })).toBe('Profile:Alpha_Profile');
  });

  it('reports containerType and apiName for both families', () => {
    const prof = resolveContainerAlias({ profileApiName: 'Alpha_Profile' });
    expect(prof.ok).toBe(true);
    if (!prof.ok) return;
    expect(prof.value).toEqual({
      componentId: 'Profile:Alpha_Profile',
      containerType: 'Profile',
      apiName: 'Alpha_Profile',
    });
    const ps = resolveContainerAlias({ permissionSetApiName: 'Beta_Set' });
    expect(ps.ok).toBe(true);
    if (!ps.ok) return;
    expect(ps.value).toEqual({
      componentId: 'PermissionSet:Beta_Set',
      containerType: 'PermissionSet',
      apiName: 'Beta_Set',
    });
  });

  it('SHAPE 1 — two selectors naming different targets refuse, naming BOTH ids', () => {
    // Pre-fix: answered about Gamma_Profile and dropped Alpha_Profile silently.
    const r = resolveContainerAlias({
      profileApiName: 'Alpha_Profile',
      profileId: 'Profile:Gamma_Profile',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.path).toBe('componentId');
    expect(r.error.message).toContain('Profile:Alpha_Profile');
    expect(r.error.message).toContain('Profile:Gamma_Profile');
  });

  it('SHAPE 2 — a profile key and a permission-set key naming different things refuse', () => {
    // Pre-fix: the value came from profileApiName and the prefix from the mere
    // PRESENCE of permissionSetApiName, producing `PermissionSet:Alpha_Profile`
    // and a component-not-found for a component nobody named.
    const r = resolveContainerAlias({
      profileApiName: 'Alpha_Profile',
      permissionSetApiName: 'Beta_Set',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Profile:Alpha_Profile');
    expect(r.error.message).toContain('PermissionSet:Beta_Set');
  });

  it('SHAPE 3 — the same bare name under both keys is TWO components, so it refuses', () => {
    // `Profile:Alpha_Profile` and `PermissionSet:Alpha_Profile` are different
    // components. Answering about either would be a guess.
    const r = resolveContainerAlias({
      profileApiName: 'Alpha_Profile',
      permissionSetApiName: 'Alpha_Profile',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toContain('Profile:Alpha_Profile');
    expect(r.error.message).toContain('PermissionSet:Alpha_Profile');
  });

  it('AGREEING aliases still resolve — the common host shape must not regress', () => {
    expect(idOf({ profileId: 'Profile:Alpha_Profile', profileApiName: 'Alpha_Profile' })).toBe(
      'Profile:Alpha_Profile',
    );
    expect(
      idOf({ componentId: 'PermissionSet:Beta_Set', permissionSetApiName: 'Beta_Set' }),
    ).toBe('PermissionSet:Beta_Set');
  });

  it('a WRONG Type: prefix passes through unchanged for the caller to reject', () => {
    // Never mangled into `Profile:CustomObject:…` — the phantom-Profile bug the
    // two tools' comments describe stays fixed.
    expect(idOf({ componentId: 'CustomObject:Widget__c' })).toBe('CustomObject:Widget__c');
  });

  it('none named → invalid-query with the natural-selector wording', () => {
    const r = resolveContainerAlias({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid-query');
    expect(r.error.message).toMatch(/name the profile or permission set/);
    expect(r.error.message).toContain('profileApiName');
  });

  it('none named with required:false → ok(null), for a legitimately unscoped axis', () => {
    const r = resolveContainerAlias({}, { required: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBeNull();
  });
});
