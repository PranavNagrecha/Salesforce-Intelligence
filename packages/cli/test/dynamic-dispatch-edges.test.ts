/// <reference types="vitest/globals" />

/**
 * P21-MOAT-apex-frameworks: a dispatcher that reads a Custom Metadata type and
 * instantiates the class each record names (`Type.forName(row.Handler__c)`)
 * has a variable operand the scanner cannot resolve, but the 0.5.0 record
 * extractor already resolved every `*Class__c` / `*Handler__c` cell into a
 * `CustomMetadataRecord -> ApexClass:{value}` edge. `resolveDynamicDispatchEdges`
 * joins the two: the dispatcher gets a heuristic `references` edge to every
 * class the records of a type it reads name. Names synthetic.
 */

import type { Edge, ExtractionResult, Node } from '@sf-intelligence/contracts';

import { DYNAMIC_DISPATCH_SOURCE, resolveDynamicDispatchEdges } from '../src/refresh-pipeline.js';

const node = (o: Partial<Node> & Pick<Node, 'id' | 'type' | 'apiName'>): Node => ({
  label: null,
  parentId: null,
  sourcePath: 'x.cls',
  lastModifiedDate: null,
  lastModifiedBy: null,
  apiVersion: null,
  properties: {},
  ...o,
});
const edge = (fromId: string, toId: string, edgeType: Edge['edgeType'], properties: Record<string, unknown> = {}): Edge => ({
  fromId,
  toId,
  edgeType,
  confidence: 'heuristic',
  source: 'apex-scanner',
  properties,
});

const TYPE = 'CustomObject:Demo_Handler__mdt';
const DISPATCHER = 'ApexClass:Demo_Dispatcher';

const trigger: ExtractionResult = {
  nodes: [node({ id: 'ApexTrigger:Demo_AccountTrigger', type: 'ApexTrigger', apiName: 'Demo_AccountTrigger' })],
  edges: [edge('ApexTrigger:Demo_AccountTrigger', DISPATCHER, 'callsApex', { methods: ['dispatch'] })],
};
const dispatcher: ExtractionResult = {
  nodes: [node({ id: DISPATCHER, type: 'ApexClass', apiName: 'Demo_Dispatcher', properties: { unresolvedDynamicDispatch: 1 } })],
  edges: [edge(DISPATCHER, TYPE, 'readsFrom', { mechanism: 'soql' })],
};
const record = (name: string, handler: string): ExtractionResult => ({
  nodes: [
    node({
      id: `CustomMetadataRecord:Demo_Handler__mdt.${name}`,
      type: 'CustomMetadataRecord',
      apiName: `Demo_Handler__mdt.${name}`,
      parentId: TYPE,
    }),
  ],
  edges: [edge(`CustomMetadataRecord:Demo_Handler__mdt.${name}`, `ApexClass:${handler}`, 'references', { cellField: 'Handler_Class__c' })],
});
const handlers: ExtractionResult = {
  nodes: [
    node({ id: 'ApexClass:Demo_HandlerA', type: 'ApexClass', apiName: 'Demo_HandlerA' }),
    node({ id: 'ApexClass:Demo_HandlerB', type: 'ApexClass', apiName: 'Demo_HandlerB' }),
  ],
  edges: [],
};
/** Reads the same type but resolves nothing dynamically: a plain config reader. */
const configReader: ExtractionResult = {
  nodes: [node({ id: 'ApexClass:Demo_ConfigReader', type: 'ApexClass', apiName: 'Demo_ConfigReader' })],
  edges: [edge('ApexClass:Demo_ConfigReader', TYPE, 'references', { mechanism: 'apexStaticObjectRef' })],
};
/** Dispatches dynamically but reads no Custom Metadata: stays unresolved. */
const blindDispatcher: ExtractionResult = {
  nodes: [node({ id: 'ApexClass:Demo_BlindDispatcher', type: 'ApexClass', apiName: 'Demo_BlindDispatcher', properties: { unresolvedDynamicDispatch: 2 } })],
  edges: [],
};

const all = [trigger, dispatcher, record('Account_A', 'Demo_HandlerA'), record('Account_B', 'Demo_HandlerB'), handlers, configReader, blindDispatcher];

describe('resolveDynamicDispatchEdges', () => {
  it('mints a heuristic references edge from the dispatcher to every class the records of a type it reads name', () => {
    const out = resolveDynamicDispatchEdges(all);
    const minted = out[1]!.edges.filter((e) => e.source === DYNAMIC_DISPATCH_SOURCE);
    expect(minted.map((e) => e.toId).sort()).toEqual(['ApexClass:Demo_HandlerA', 'ApexClass:Demo_HandlerB']);
    for (const e of minted) {
      expect(e.fromId).toBe(DISPATCHER);
      expect(e.edgeType).toBe('references');
      expect(e.confidence).toBe('heuristic');
      expect(e.properties).toEqual({ mechanism: 'Type.forName', via: 'CustomMetadataRecord', customMetadataType: 'Demo_Handler__mdt' });
    }
    // The dispatcher's own edges are kept; the trigger reaches the handlers through it.
    expect(out[1]!.edges.some((e) => e.toId === TYPE)).toBe(true);
    expect(out[0]).toBe(trigger);
  });

  it('a reader with no unresolved Type.forName gets nothing; a dispatcher reading no Custom Metadata gets nothing', () => {
    const out = resolveDynamicDispatchEdges(all);
    expect(out[5]).toBe(configReader);
    expect(out[6]).toBe(blindDispatcher);
  });

  it('returns the SAME array when no class dispatches dynamically', () => {
    const quiet = [trigger, handlers, configReader];
    expect(resolveDynamicDispatchEdges(quiet)).toBe(quiet);
  });
});
