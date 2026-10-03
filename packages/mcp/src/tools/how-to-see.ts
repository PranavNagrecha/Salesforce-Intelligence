/**
 * Handler for `sfi.how_to_see` (spec F8) — the exact Setup / App Launcher click
 * path a reviewer follows to see a component, worded with the vault's labels,
 * for the "How to see it" steps of a finding. Offline and deterministic.
 *
 * Optional `elementPath` (an OmniScript element, IP step or DataMapper row) and
 * `object` (for a permission set / profile's object settings) add the last hop.
 */

import type { ComponentId, McpError, McpResponse, Node } from '@sf-intelligence/contracts';
import { err, ok, type Result } from '@sf-intelligence/core';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

export const howToSeeInputSchema = z.object({
  componentId: z.string().min(1),
  /** OmniScript element path, IP step path, or DataMapper row (`item[3]`). */
  elementPath: z.string().min(1).optional(),
  /** For a permission set / profile: the object whose settings to open. */
  object: z.string().min(1).optional(),
});

export type HowToSeeInput = z.infer<typeof howToSeeInputSchema>;

/** Response payload. */
export interface HowToSeeOutput {
  readonly componentId: string;
  readonly componentType: string;
  /** The click path, one hop per entry. */
  readonly steps: readonly string[];
  /** A Lightning Setup URL path (relative to the org's domain) when one is deterministic. */
  readonly urlPath: string | null;
  /** `declared` for a fixed Setup page; `inferred` for the Quick Find fallback. */
  readonly confidence: 'declared' | 'inferred';
}

const labelOf = (n: Node): string => n.label ?? n.apiName;

const objectLabel = async (ctx: Context, object: string): Promise<string> => {
  const n = await getNodeById(ctx.graph, `CustomObject:${object}` as ComponentId);
  return n.ok && n.value !== null ? labelOf(n.value) : object;
};

const versionLabel = (n: Node): string => {
  const v = n.properties['versionNumber'];
  return v === undefined || v === null ? 'the active version' : `version ${String(v).replace(/\.0$/, '')}`;
};

/** The `sfi.how_to_see` handler. */
export const howToSeeHandler = async (
  ctx: Context,
  input: HowToSeeInput,
): Promise<Result<McpResponse<HowToSeeOutput>, McpError>> => {
  const found = await getNodeById(ctx.graph, input.componentId as ComponentId);
  if (!found.ok) return err({ kind: 'internal', message: `graph query failed: ${found.error.message}` });
  if (found.value === null) {
    return err({ kind: 'component-not-found', message: `no component \`${input.componentId}\` in this vault`, path: 'componentId' });
  }
  const n = found.value;
  const parentObject = n.parentId?.startsWith('CustomObject:') === true ? n.parentId.slice('CustomObject:'.length) : null;
  const element = input.elementPath === undefined ? [] : [`open ${input.elementPath}`];
  let steps: string[];
  let urlPath: string | null = null;
  let confidence: HowToSeeOutput['confidence'] = 'declared';
  switch (n.type) {
    case 'CustomObject':
      steps = ['Setup', 'Object Manager', labelOf(n)];
      urlPath = `/lightning/setup/ObjectManager/${n.apiName}/Details/view`;
      break;
    case 'CustomField':
      steps = ['Setup', 'Object Manager', await objectLabel(ctx, parentObject ?? ''), 'Fields & Relationships', labelOf(n)];
      urlPath = parentObject === null ? null : `/lightning/setup/ObjectManager/${parentObject}/FieldsAndRelationships/view`;
      break;
    case 'ValidationRule':
      steps = ['Setup', 'Object Manager', await objectLabel(ctx, parentObject ?? ''), 'Validation Rules', labelOf(n)];
      urlPath = parentObject === null ? null : `/lightning/setup/ObjectManager/${parentObject}/ValidationRules/view`;
      break;
    case 'RecordType':
      steps = ['Setup', 'Object Manager', await objectLabel(ctx, parentObject ?? ''), 'Record Types', labelOf(n)];
      break;
    case 'Layout':
      steps = ['Setup', 'Object Manager', await objectLabel(ctx, parentObject ?? n.apiName.split('-')[0] ?? ''), 'Page Layouts', labelOf(n)];
      break;
    case 'ApexTrigger':
      steps = ['Setup', 'Apex Triggers', n.apiName];
      urlPath = '/lightning/setup/ApexTriggers/home';
      break;
    case 'ApexClass':
      steps = ['Setup', 'Apex Classes', n.apiName];
      urlPath = '/lightning/setup/ApexClasses/home';
      break;
    case 'Flow':
      steps = ['Setup', 'Flows', labelOf(n), 'open the active version'];
      urlPath = '/lightning/setup/Flows/home';
      break;
    case 'PermissionSet':
      steps = ['Setup', 'Permission Sets', labelOf(n), ...(input.object === undefined ? [] : ['Object Settings', await objectLabel(ctx, input.object)])];
      urlPath = '/lightning/setup/PermSets/home';
      break;
    case 'PermissionSetGroup':
      steps = ['Setup', 'Permission Set Groups', labelOf(n)];
      urlPath = '/lightning/setup/PermSetGroups/home';
      break;
    case 'Profile':
      steps = ['Setup', 'Profiles', labelOf(n), ...(input.object === undefined ? [] : ['Object Settings', await objectLabel(ctx, input.object)])];
      urlPath = '/lightning/setup/EnhancedProfiles/home';
      break;
    case 'DuplicateRule':
      steps = ['Setup', 'Duplicate Rules', labelOf(n)];
      urlPath = '/lightning/setup/DuplicateRules/home';
      break;
    case 'CustomMetadataRecord': {
      const [type = '', record = n.apiName] = n.apiName.split('.');
      steps = ['Setup', 'Custom Metadata Types', type, 'Manage Records', record];
      urlPath = '/lightning/setup/CustomMetadata/home';
      break;
    }
    case 'OmniScript':
      steps = [
        'App Launcher',
        'OmniStudio',
        'OmniScripts',
        `${String(n.properties['type'] ?? '?')} / ${String(n.properties['subType'] ?? '?')}`,
        `${versionLabel(n)} (${String(n.properties['language'] ?? '?')})`,
        ...element,
      ];
      break;
    case 'OmniIntegrationProcedure':
      steps = ['App Launcher', 'OmniStudio', 'Integration Procedures', `${String(n.properties['type'] ?? '?')}_${String(n.properties['subType'] ?? '?')}`, versionLabel(n), ...element];
      break;
    case 'OmniDataTransform':
      steps = ['App Launcher', 'OmniStudio', 'Data Mappers', String(n.properties['name'] ?? n.apiName), ...element];
      break;
    case 'OmniUiCard':
      steps = ['App Launcher', 'OmniStudio', 'FlexCards', String(n.properties['name'] ?? n.apiName), versionLabel(n)];
      break;
    case 'FlexiPage':
      steps = ['Setup', 'Lightning App Builder', labelOf(n)];
      urlPath = '/lightning/setup/FlexiPageList/home';
      break;
    case 'LightningComponentBundle':
      steps = ['Setup', 'Lightning Components', n.apiName];
      break;
    default:
      steps = ['Setup', `Quick Find: "${labelOf(n)}"`];
      confidence = 'inferred';
  }
  return ok({
    data: { componentId: n.id, componentType: n.type, steps, urlPath, confidence },
    vaultState: { sourceTreeHash: ctx.manifest.sourceTreeHash, refreshedAt: ctx.manifest.refreshedAt },
  });
};
