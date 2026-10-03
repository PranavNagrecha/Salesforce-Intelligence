import { basename, dirname } from 'node:path';

import { err, ok, type Result } from '@sf-intelligence/core';
import { omnistudio } from '@sf-intelligence/extractors';

/**
 * The managed-package (Vlocity) side of every OmniStudio tool that re-reads a
 * component's source. A node whose `sourcePath` is a DataPack main file
 * (`sourceFormat: vlocity-datapack`) is read as its DataPack — main file plus
 * sibling files — and converted to the same root object the Metadata API XML
 * parses to (`<OmniScript>`, `<OmniIntegrationProcedure>`,
 * `<OmniDataTransform>`, `<OmniUiCard>`), so each tool's own walk runs
 * unchanged on either form and the two can never be read differently.
 */

/** Which native root a DataPack converts to. */
export type OmniSourceKind = 'process' | 'mapper' | 'card';

/** True when a node's source is a managed-package DataPack rather than Metadata API XML. */
export const isDataPackSourcePath = (sourcePath: string): boolean => omnistudio.isDataPackPath(sourcePath);

/** Why a DataPack could not be read: its main file is gone, or it is not a readable component. */
export interface DataPackReadFailure {
  readonly missing: boolean;
  readonly message: string;
}

/** Read the DataPack at `absPath` and convert it to its native-shaped root object. */
export const readDataPackRoot = async (
  absPath: string,
  kind: OmniSourceKind,
): Promise<Result<Record<string, unknown>, DataPackReadFailure>> => {
  const dp = await omnistudio.readDataPack(absPath);
  if (!dp.ok) return err({ missing: dp.missing, message: `failed to read DataPack at ${absPath}: ${dp.message}` });
  const conv =
    kind === 'process'
      ? omnistudio.dataPackToProcess(dp.value, omnistudio.dataPackKindOfDir(basename(dirname(dirname(dp.value.mainPath)))))
      : kind === 'mapper'
        ? omnistudio.dataPackToMapper(dp.value)
        : omnistudio.dataPackToCard(dp.value);
  if (!conv.ok) return err({ missing: false, message: `DataPack at ${absPath} could not be read as a component: ${conv.message}` });
  return ok({ ...conv.value.root });
};
