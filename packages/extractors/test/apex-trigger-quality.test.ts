/// <reference types="vitest/globals" />

/**
 * QUALITY-SCAN-SKIPS-TRIGGERS.
 *
 * `detectCodeQualityIssues` was called from `apex-class.ts` and nowhere else.
 * Measured on a real vault: ApexClass 192/192 carried `qualityIssues`,
 * **ApexTrigger 0 of 22** — while `sfi.crud_fls_audit` advertised walking
 * "every ApexClass / ApexTrigger". So a CRUD/FLS audit of a trigger returned
 * findings: [], boundaries: [], and read as clean; triggers are precisely where
 * CRUD/FLS bugs live, because a trigger does DML on `Trigger.new` in system
 * context by default.
 *
 * What this file pins:
 *
 *  1. A trigger that does unguarded SOQL / DML now produces the findings.
 *  2. `qualityIssues` is ALWAYS present — the empty array on a clean trigger is
 *     what distinguishes "scanned, clean" from "this vault never scanned it".
 *  3. The class-shaped recognizers do NOT false-fire on trigger source. A wave
 *     of false positives would be its own defect, so each one that could
 *     plausibly misfire gets an explicit negative assertion.
 *  4. `trigger-no-recursion-guard` — a recognizer that can only ever match a
 *     `trigger X on` header, and was therefore dead code — now fires.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '@sf-intelligence/contracts';

import { extractApexTrigger } from '../src/apex-trigger.js';

const META_XML = (apiVersion = 62) => `<?xml version="1.0" encoding="UTF-8"?>
<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>${apiVersion}.0</apiVersion>
    <status>Active</status>
</ApexTrigger>`;

/** Extract one trigger node from a throwaway `.trigger` + meta pair. */
const extractNode = async (
  name: string,
  body: string,
  apiVersion = 62,
): Promise<Node> => {
  const dir = await mkdtemp(join(tmpdir(), 'sfi-trigger-quality-'));
  try {
    const triggerPath = join(dir, `${name}.trigger`);
    await writeFile(triggerPath, body, 'utf-8');
    await writeFile(`${triggerPath}-meta.xml`, META_XML(apiVersion), 'utf-8');
    const result = await extractApexTrigger(triggerPath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const node = result.value.nodes[0];
    expect(node).toBeDefined();
    return node as Node;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const rulesOf = (node: Node): readonly string[] =>
  ((node.properties['qualityIssues'] ?? []) as { rule: string }[]).map(
    (i) => i.rule,
  );

/** The textbook CRUD/FLS-unsafe trigger: unguarded SOQL, then unguarded DML. */
const UNSAFE_TRIGGER = `trigger AnonTrigger on Anon__c (after insert) {
    List<Other__c> rows = [SELECT Id, Name FROM Other__c WHERE Flag__c = true];
    List<Other__c> toUpdate = new List<Other__c>();
    for (Other__c r : rows) {
        r.Name = 'changed';
        toUpdate.add(r);
    }
    update toUpdate;
}`;

/** A trigger that delegates everything and guards recursion. */
const CLEAN_TRIGGER = `trigger AnonCleanTrigger on Anon__c (after insert) {
    if (!TriggerHandler.isFirstRun) { return; }
    AnonService.handleAfterInsert(Trigger.new);
}`;

describe('extractApexTrigger — quality recognizers', () => {
  it('FAIL-BEFORE/PASS-AFTER: an unguarded SOQL + DML trigger produces CRUD/FLS findings', async () => {
    const rules = rulesOf(await extractNode('AnonTrigger', UNSAFE_TRIGGER));
    expect(rules).toContain('missing-fls-check');
    expect(rules).toContain('missing-crud-check');
  });

  it('carries the qualityIssues KEY even when the trigger is clean', async () => {
    // The three-state contract. Without the key, "scanned and clean" and "this
    // vault predates trigger scanning" are the same empty answer — which is the
    // conflation the whole product exists to refuse.
    const node = await extractNode('AnonCleanTrigger', CLEAN_TRIGGER);
    expect(Object.hasOwn(node.properties, 'qualityIssues')).toBe(true);
    expect(rulesOf(node)).not.toContain('missing-crud-check');
    expect(rulesOf(node)).not.toContain('missing-fls-check');
  });

  it('fires trigger-no-recursion-guard — a recognizer that was dead code', async () => {
    // It matches on a `trigger X on` header, which no ApexClass source carries,
    // so before triggers were scanned this rule could never fire on anything.
    expect(rulesOf(await extractNode('AnonTrigger', UNSAFE_TRIGGER))).toContain(
      'trigger-no-recursion-guard',
    );
  });

  it('does NOT fire the recursion guard when the trigger has one', async () => {
    expect(rulesOf(await extractNode('AnonCleanTrigger', CLEAN_TRIGGER))).not.toContain(
      'trigger-no-recursion-guard',
    );
  });

  describe('class-shaped recognizers do not false-fire on trigger source', () => {
    it('without-sharing-no-comment cannot fire — a trigger has no sharing keyword', async () => {
      // The recognizer's pattern requires the literal `class` keyword. A
      // trigger always runs in system mode and cannot declare sharing, so a
      // finding here would be pure noise.
      const body = `trigger AnonTrigger on Anon__c (before insert) {
    // without sharing is not a thing a trigger can declare
    Integer x = 1;
}`;
      expect(rulesOf(await extractNode('AnonTrigger', body))).not.toContain(
        'without-sharing-no-comment',
      );
    });

    it('the test-only recognizers cannot fire — a trigger is never a test class', async () => {
      // `fake-assertion` and `hardcoded-sandbox-test-data` are gated on
      // `isTest`, and the extractor passes `isTest: false` as a fact about the
      // platform: Salesforce has no @isTest trigger.
      const body = `trigger AnonTrigger on Anon__c (before insert) {
    System.assert(true);
    String u = 'someone@example.com.sandbox';
}`;
      const rules = rulesOf(await extractNode('AnonTrigger', body));
      expect(rules).not.toContain('fake-assertion');
      expect(rules).not.toContain('hardcoded-sandbox-test-data');
    });

    it('old-api-version reads the trigger meta, not a class', async () => {
      expect(
        rulesOf(await extractNode('AnonCleanTrigger', CLEAN_TRIGGER, 40)),
      ).toContain('old-api-version');
      expect(
        rulesOf(await extractNode('AnonCleanTrigger', CLEAN_TRIGGER, 62)),
      ).not.toContain('old-api-version');
    });
  });

  it('leaves every other trigger property untouched', async () => {
    // The change must ADD one key and nothing else — no reshaping of the node
    // other tools already read.
    const node = await extractNode('AnonCleanTrigger', CLEAN_TRIGGER);
    expect(Object.keys(node.properties).sort()).toEqual([
      'events',
      'isPlatformEventSubscriber',
      'lineCount',
      'qualityIssues',
      'sourceBytes',
      'status',
      'triggerObject',
    ]);
  });
});
