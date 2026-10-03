/**
 * Personas — a kind of user, as the containers that grant them access: a
 * profile, permission sets and permission set groups. Declared per vault in
 * `org-kb/config/personas.json` (never shipped with the product), or passed
 * inline. Resolved to the container ids the effective-permissions engine
 * (`computeEffectiveGrants`) composes.
 *
 * ```json
 * { "personas": { "Portal client": { "profile": "Portal Client Profile",
 *                                      "permissionSets": ["Portal_Client"],
 *                                      "permissionSetGroups": [] } } }
 * ```
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ComponentId } from '@sf-intelligence/contracts';
import { getNodeById } from '@sf-intelligence/graph';
import { z } from 'zod';

import type { Context } from '../server.js';

export const PERSONA_CONFIG_RELATIVE_PATH = join('config', 'personas.json');

const personaSchema = z.object({
  profile: z.string().min(1).optional(),
  permissionSets: z.array(z.string().min(1)).default([]),
  permissionSetGroups: z.array(z.string().min(1)).default([]),
  description: z.string().optional(),
});

export const personaConfigSchema = z.object({ personas: z.record(personaSchema).default({}) }).passthrough();

export type PersonaDefinition = z.infer<typeof personaSchema>;

/** Where the persona came from and what it resolved to. */
export interface ResolvedPersona {
  readonly name: string | null;
  readonly source: 'config' | 'inline';
  /** Container ids (`Profile:` / `PermissionSet:` / `PermissionSetGroup:`). */
  readonly containers: readonly string[];
  /** Names given that matched no container in the vault. */
  readonly unresolved: readonly string[];
}

const withPrefix = (prefix: string, name: string): string => (name.includes(':') ? name : `${prefix}${name}`);

/** Load `org-kb/config/personas.json`; `null` when absent, an error message when invalid. */
export const loadPersonaConfig = async (
  vaultRoot: string,
): Promise<{ readonly personas: Readonly<Record<string, PersonaDefinition>>; readonly error: string | null }> => {
  let text: string;
  try {
    text = await readFile(join(vaultRoot, PERSONA_CONFIG_RELATIVE_PATH), 'utf8');
  } catch {
    return { personas: {}, error: null };
  }
  try {
    const parsed = personaConfigSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { personas: {}, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
    return { personas: parsed.data.personas, error: null };
  } catch (cause: unknown) {
    return { personas: {}, error: cause instanceof Error ? cause.message : String(cause) };
  }
};

/**
 * Resolve a persona (by configured name, or inline) to container ids that
 * exist in the vault. A bare permission-set name is tried as a permission set,
 * then as a permission set group.
 */
export const resolvePersona = async (
  ctx: Context,
  input: {
    readonly persona?: string | undefined;
    readonly profile?: string | undefined;
    readonly permissionSets?: readonly string[] | undefined;
    readonly permissionSetGroups?: readonly string[] | undefined;
  },
): Promise<{ ok: true; value: ResolvedPersona } | { ok: false; message: string }> => {
  let def: PersonaDefinition;
  let name: string | null = null;
  let source: ResolvedPersona['source'] = 'inline';
  if (input.persona !== undefined) {
    const cfg = await loadPersonaConfig(ctx.vaultRoot);
    if (cfg.error !== null) return { ok: false, message: `org-kb/config/personas.json is invalid: ${cfg.error}` };
    const found = Object.entries(cfg.personas).find(([k]) => k.toLowerCase() === input.persona?.toLowerCase());
    if (found === undefined) {
      const known = Object.keys(cfg.personas);
      return {
        ok: false,
        message:
          known.length === 0
            ? `no persona '${input.persona}': org-kb/config/personas.json declares none — pass profile / permissionSets inline`
            : `no persona '${input.persona}' in org-kb/config/personas.json (declared: ${known.join(', ')})`,
      };
    }
    [name, def] = found;
    source = 'config';
  } else {
    def = {
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      permissionSets: [...(input.permissionSets ?? [])],
      permissionSetGroups: [...(input.permissionSetGroups ?? [])],
    };
  }
  const containers: string[] = [];
  const unresolved: string[] = [];
  const exists = async (id: string): Promise<boolean> => {
    const r = await getNodeById(ctx.graph, id as ComponentId);
    return r.ok && r.value !== null;
  };
  if (def.profile !== undefined) {
    const id = withPrefix('Profile:', def.profile);
    if (await exists(id)) containers.push(id);
    else unresolved.push(def.profile);
  }
  for (const ps of def.permissionSets) {
    const asPs = withPrefix('PermissionSet:', ps);
    const asPsg = withPrefix('PermissionSetGroup:', ps);
    if (await exists(asPs)) containers.push(asPs);
    else if (!ps.includes(':') && (await exists(asPsg))) containers.push(asPsg);
    else unresolved.push(ps);
  }
  for (const g of def.permissionSetGroups) {
    const id = withPrefix('PermissionSetGroup:', g);
    if (await exists(id)) containers.push(id);
    else unresolved.push(g);
  }
  if (containers.length === 0) {
    return { ok: false, message: `the persona resolves to no profile, permission set or group in this vault${unresolved.length > 0 ? ` (not found: ${unresolved.join(', ')})` : ''}` };
  }
  return { ok: true, value: { name, source, containers: [...new Set(containers)].sort(), unresolved } };
};
