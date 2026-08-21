/// <reference types="vitest/globals" />

/**
 * FLOW-TRIGGER-ORDER-EXTRACTION.
 *
 * `<triggerOrder>` is the one thing in Flow metadata that fixes the run order
 * between two record-triggered flows on the same object and timing. It was
 * never extracted, so the SOE tools had nothing to sort by and presented an
 * alphabetisation as the sequence.
 *
 * THE LOCATION IS THE TRAP. It is a TOP-LEVEL `<Flow>` child — a sibling of
 * `<start>` and `<status>` — not a `<start>` child, which is where the Flow
 * Builder UI's placement of the setting makes everyone look for it. Measured on
 * a real 275-flow vault, all 24 declarations sit after `</start>`. Reading it
 * off `<start>` finds nothing and reports every flow as declaring no order — a
 * false "checked and found none", the exact conflation this product exists to
 * refuse. The misplaced-element case below is the regression guard for that.
 *
 * The property is written on EVERY Flow node, `null` included, so a consumer
 * can tell "declares none" from "this vault never extracted it" by the key's
 * presence. Dropping the null would collapse those two into one.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Node } from '@sf-intelligence/contracts';

import { extractFlow } from '../src/flow.js';

const flowXml = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Order Probe</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <object>Anon__c</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <status>Active</status>
${body}
</Flow>`;

/** Extract one Flow node from an XML body written to a throwaway temp file. */
const extractNode = async (body: string): Promise<Node> => {
  const dir = await mkdtemp(join(tmpdir(), 'sfi-flow-trigger-order-'));
  try {
    const path = join(dir, 'OrderProbe.flow-meta.xml');
    await writeFile(path, flowXml(body), 'utf-8');
    const result = await extractFlow(path);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const node = result.value.nodes.find((n) => n.type === 'Flow');
    expect(node).toBeDefined();
    return node as Node;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe('extractFlow — <Flow><triggerOrder>', () => {
  it('extracts a declared top-level trigger order as a NUMBER', async () => {
    // `parseTagValue: false` means the parser hands over '500', not 500. A
    // string here would sort lexicographically: '1000' < '500'.
    const node = await extractNode('    <triggerOrder>500</triggerOrder>');
    expect(node.properties['triggerOrder']).toBe(500);
    expect(typeof node.properties['triggerOrder']).toBe('number');
  });

  it('orders by MAGNITUDE, not lexicographically', async () => {
    const low = await extractNode('    <triggerOrder>500</triggerOrder>');
    const high = await extractNode('    <triggerOrder>1000</triggerOrder>');
    expect(low.properties['triggerOrder'] as number).toBeLessThan(
      high.properties['triggerOrder'] as number,
    );
  });

  it('carries the key with a NULL when the flow declares no order', async () => {
    // The three-state contract: key present + null is "declares none". If the
    // null were dropped, this would be indistinguishable from an old vault.
    const node = await extractNode('    <description>no order here</description>');
    expect(Object.hasOwn(node.properties, 'triggerOrder')).toBe(true);
    expect(node.properties['triggerOrder']).toBeNull();
  });

  it('REGRESSION: a <start><triggerOrder> is NOT the declaration', async () => {
    // The element genuinely lives at the top level. A flow whose only
    // triggerOrder-looking element is nested inside <start> declares no order,
    // and reading it from there would have produced a confident wrong sequence
    // for every flow in every org.
    const dir = await mkdtemp(join(tmpdir(), 'sfi-flow-trigger-order-'));
    try {
      const path = join(dir, 'Misplaced.flow-meta.xml');
      await writeFile(
        path,
        `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>59.0</apiVersion>
    <label>Misplaced</label>
    <processType>AutoLaunchedFlow</processType>
    <start>
        <object>Anon__c</object>
        <triggerOrder>42</triggerOrder>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
    <status>Active</status>
</Flow>`,
        'utf-8',
      );
      const result = await extractFlow(path);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.value.nodes.find((n) => n.type === 'Flow') as Node;
      expect(node.properties['triggerOrder']).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a non-integer value rather than coercing it', async () => {
    for (const raw of ['abc', '5.5', '', '  ']) {
      const node = await extractNode(`    <triggerOrder>${raw}</triggerOrder>`);
      expect(node.properties['triggerOrder']).toBeNull();
    }
  });

  it('keeps the boundary values Salesforce allows', async () => {
    for (const raw of [1, 2000]) {
      const node = await extractNode(`    <triggerOrder>${raw}</triggerOrder>`);
      expect(node.properties['triggerOrder']).toBe(raw);
    }
  });

  it('adds NOTHING else — every other Flow property is untouched', async () => {
    const withOrder = await extractNode('    <triggerOrder>7</triggerOrder>');
    const without = await extractNode('    <description>x</description>');
    const keys = (n: Node) => Object.keys(n.properties).sort();
    expect(keys(withOrder)).toEqual(keys(without));
  });
});
