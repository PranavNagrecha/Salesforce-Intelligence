/**
 * `sfi annotate` — the human side of the annotations overlay
 * (P13-ANNOT-tools): state curated meaning, confirm AI proposals, list the
 * overlay, and find orphans (annotations whose component vanished).
 *
 *   sfi annotate <componentId> --key owner --value "RevOps"     # human set (confirmed)
 *   sfi annotate <componentId> --key status --unset             # remove the pair
 *   sfi annotate confirm <componentId> status                   # confirm an AI proposal
 *   sfi annotate list [componentId]                             # print the overlay
 *   sfi annotate orphans                                        # annotated ids missing from the graph
 *
 * A human `set` is written `source: 'human', confirmed: true` — a person
 * stating it IS the confirmation. `confirm` re-writes an existing AI
 * proposal's value as a human-confirmed entry.
 */

import {
  closeGraph,
  getNodeById,
  openGraphReadOnly,
} from '@sf-intelligence/graph';
import {
  ANNOTATION_KEYS,
  annotationsFor,
  appendAnnotationEvent,
  readAnnotations,
  vaultPaths,
  type AnnotationKey,
} from '@sf-intelligence/vault';
import { Command } from 'commander';

import { loadVaultConfig } from './refresh.js';

const isKey = (k: string | undefined): k is AnnotationKey =>
  k !== undefined && (ANNOTATION_KEYS as readonly string[]).includes(k);

const resolveVaultRoot = async (): Promise<string | null> => {
  const config = await loadVaultConfig(process.cwd());
  if (!config.ok) {
    process.stderr.write(`${config.error}\n`);
    return null;
  }
  return config.value.vaultRoot;
};

export const registerAnnotateCommand = (program: Command): void => {
  const annotate = program
    .command('annotate')
    .description(
      'Curated annotations overlay (meta/annotations.jsonl): state meaning the org cannot carry — owner / status / glossary / domain / note. Survives refreshes; consumed by sfi.annotations, get_component, field_360, explain_*. Subcommands: confirm, list, orphans.',
    )
    .argument('[componentId]', 'Canonical component id (e.g. CustomField:Contact.SSN__c)')
    .option('--key <key>', `Annotation key (${ANNOTATION_KEYS.join(' | ')})`)
    .option('--value <value>', 'Value to set')
    .option('--author <name>', 'Author recorded on the event', 'human')
    .option('--unset', 'Remove the (componentId, key) pair')
    .action(
      async (
        componentId: string | undefined,
        flags: {
          readonly key?: string;
          readonly value?: string;
          readonly author?: string;
          readonly unset?: boolean;
        },
      ): Promise<void> => {
        if (componentId === undefined) {
          process.stderr.write(
            'usage: sfi annotate <componentId> --key <key> (--value <v> | --unset)\n',
          );
          process.exit(1);
        }
        if (!isKey(flags.key)) {
          process.stderr.write(`--key must be one of: ${ANNOTATION_KEYS.join(', ')}\n`);
          process.exit(1);
        }
        if (flags.unset !== true && (flags.value === undefined || flags.value.length === 0)) {
          process.stderr.write('--value required (or pass --unset to remove)\n');
          process.exit(1);
        }
        const vaultRoot = await resolveVaultRoot();
        if (vaultRoot === null) process.exit(1);
        const ok = await appendAnnotationEvent(vaultRoot, {
          componentId,
          key: flags.key,
          ...(flags.unset === true ? {} : { value: flags.value as string }),
          author: flags.author ?? 'human',
          source: 'human',
          confirmed: true,
          at: new Date().toISOString(),
          op: flags.unset === true ? 'unset' : 'set',
        });
        if (!ok) {
          process.stderr.write('annotation write failed (meta/annotations.jsonl not writable)\n');
          process.exit(1);
        }
        process.stdout.write(
          flags.unset === true
            ? `unset ${componentId} ${flags.key}\n`
            : `${componentId} ${flags.key} = "${flags.value}" (human, confirmed)\n`,
        );
      },
    );

  annotate
    .command('confirm')
    .description('Confirm an AI-proposed annotation: re-writes it as a human-confirmed entry.')
    .argument('<componentId>', 'Canonical component id')
    // key is POSITIONAL: the parent `annotate` command also defines --key,
    // and commander would swallow a child --key into the parent's options.
    .argument('<key>', `Annotation key (${ANNOTATION_KEYS.join(' | ')})`)
    .option('--author <name>', 'Confirming human', 'human')
    .action(
      async (
        componentId: string,
        key: string,
        flags: { readonly author?: string },
      ): Promise<void> => {
        if (!isKey(key)) {
          process.stderr.write(`key must be one of: ${ANNOTATION_KEYS.join(', ')}\n`);
          process.exit(1);
        }
        const vaultRoot = await resolveVaultRoot();
        if (vaultRoot === null) process.exit(1);
        const existing = annotationsFor(await readAnnotations(vaultRoot), componentId).find(
          (a) => a.key === key,
        );
        if (existing === undefined) {
          process.stderr.write(`no annotation found for ${componentId} ${key}\n`);
          process.exit(1);
        }
        if (existing.confirmed) {
          process.stdout.write(`already confirmed: ${componentId} ${key} = "${existing.value}"\n`);
          return;
        }
        const ok = await appendAnnotationEvent(vaultRoot, {
          componentId,
          key,
          value: existing.value,
          author: flags.author ?? 'human',
          source: 'human',
          confirmed: true,
          at: new Date().toISOString(),
          op: 'set',
        });
        if (!ok) {
          process.stderr.write('annotation write failed\n');
          process.exit(1);
        }
        process.stdout.write(
          `confirmed: ${componentId} ${key} = "${existing.value}" (was ${existing.source} proposal)\n`,
        );
      },
    );

  annotate
    .command('list')
    .description('Print the materialized overlay (optionally for one component).')
    .argument('[componentId]', 'Canonical component id')
    .action(async (componentId: string | undefined): Promise<void> => {
      const vaultRoot = await resolveVaultRoot();
      if (vaultRoot === null) process.exit(1);
      const all = await readAnnotations(vaultRoot);
      const scoped = componentId === undefined ? all : annotationsFor(all, componentId);
      if (scoped.length === 0) {
        process.stdout.write('no annotations\n');
        return;
      }
      for (const a of scoped) {
        const flag = a.confirmed ? 'confirmed' : `UNCONFIRMED ${a.source} proposal`;
        process.stdout.write(`${a.componentId}  ${a.key} = "${a.value}"  [${a.source}, ${flag}, ${a.at}]\n`);
      }
    });

  annotate
    .command('orphans')
    .description('List annotations whose component no longer exists in the graph.')
    .action(async (): Promise<void> => {
      const vaultRoot = await resolveVaultRoot();
      if (vaultRoot === null) process.exit(1);
      const all = await readAnnotations(vaultRoot);
      const ids = [...new Set(all.map((a) => a.componentId))];
      if (ids.length === 0) {
        process.stdout.write('no annotations\n');
        return;
      }
      const opened = await openGraphReadOnly(vaultPaths(vaultRoot).graphDb);
      if (!opened.ok) {
        process.stderr.write(`graph unreadable: ${opened.error.message}\n`);
        process.exit(1);
      }
      const orphans: string[] = [];
      try {
        for (const id of ids) {
          const node = await getNodeById(opened.value, id as never);
          if (node.ok && node.value === null) orphans.push(id);
        }
      } finally {
        await closeGraph(opened.value);
      }
      if (orphans.length === 0) {
        process.stdout.write('no orphans — every annotated component exists in the graph\n');
        return;
      }
      for (const id of orphans.sort()) {
        for (const a of annotationsFor(all, id)) {
          process.stdout.write(`ORPHAN ${a.componentId}  ${a.key} = "${a.value}"  [${a.at}]\n`);
        }
      }
      process.exit(2); // distinct exit so scripts can detect orphans
    });
};
