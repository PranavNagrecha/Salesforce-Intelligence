/**
 * The OmniStudio source-coverage disclosures, in ONE place. Every OmniStudio
 * tool that states where its components come from carries the same sentence,
 * so a change in what the product models (a new source format) changes every
 * tool at once instead of leaving four copies saying the old thing.
 */

/**
 * Native vs managed-package (Vlocity) OmniStudio (Q180 anchor): where each
 * kind of component comes from, and what the vault cannot know about it.
 */
export const NATIVE_VS_VLOCITY_DISCLOSURE =
  'Industries Native OmniStudio metadata (`.os-meta.xml`, `.oip-meta.xml`, `.rpt-meta.xml`, `.ouc-meta.xml`, ' +
  '`.decisionTable-meta.xml`) is read from the Metadata API retrieve. Managed-package (Vlocity) OmniStudio — ' +
  'namespaces `vlocity_cmt__`, `vlocity_ins__`, `vlocity_ps__`, or the `omnistudio__` managed runtime — stores ' +
  'OmniScripts, Integration Procedures, DataRaptors and Cards as RECORDS that no Metadata API retrieve contains: ' +
  'they are modelled only from a Vlocity Build Tool DataPack export placed under org-kb/source/vlocity/ (their ' +
  'nodes carry `sourceFormat: vlocity-datapack`), and the vault cannot tell whether that export is current. ' +
  'Mid-migration orgs may show partial coverage.';

/** What the vault knows about managed-package OmniStudio (`OmniWorld.managedPackage`). */
export interface ManagedPackageCoverage {
  readonly installedNamespaces: readonly string[];
  readonly dataPackComponents: number;
  readonly nativeComponents: number;
}

const VLOCITY_NAMESPACES: ReadonlySet<string> = new Set(['vlocity_cmt', 'vlocity_ins', 'vlocity_ps']);

/**
 * Limitations that follow from the vault's managed-package OmniStudio — empty
 * when nothing applies. A Vlocity package installed with no DataPack export
 * means any components it still holds are MISSING from every answer, not
 * absent from the org (a fully migrated org may hold none).
 */
export const managedPackageLimitations = (mp: ManagedPackageCoverage): string[] => {
  const out: string[] = [];
  const vlocity = mp.installedNamespaces.filter((ns) => VLOCITY_NAMESPACES.has(ns));
  const exportHint =
    'export them with the Vlocity Build Tool (`vlocity packExport`, DataPack types OmniScript, IntegrationProcedure, DataRaptor, VlocityCard) into org-kb/source/vlocity/ and run `sfi refresh --no-pull`';
  if (vlocity.length > 0 && mp.dataPackComponents === 0) {
    out.push(
      `This org has the Vlocity managed package (${vlocity.join(', ')}) installed. Its OmniStudio components are records the Metadata API retrieve never contains, so any it still has are NOT in this answer. To model them, ${exportHint}.`,
    );
  } else if (mp.installedNamespaces.includes('omnistudio') && mp.dataPackComponents === 0 && mp.nativeComponents === 0) {
    out.push(
      `The OmniStudio managed package (omnistudio) is installed but the vault holds no OmniStudio components: if this org runs the managed-package runtime, its components are records the Metadata API retrieve never contains. To model them, ${exportHint}.`,
    );
  }
  if (mp.dataPackComponents > 0) {
    out.push(
      `${mp.dataPackComponents} OmniStudio component(s) come from a Vlocity DataPack export under org-kb/source/vlocity/ — as current as that export, not as the last metadata refresh.`,
    );
  }
  return out;
};
