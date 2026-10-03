import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { ExtractionResult, ExtractorError, Result } from '@sf-intelligence/contracts';
import { err, ok } from '@sf-intelligence/core';

import {
  type DataPackConversion,
  type DataPackKind,
  dataPackKindOfDir,
  dataPackNodeProperties,
  dataPackToCard,
  dataPackToMapper,
  dataPackToProcess,
  isDataPackPath,
  readDataPack,
} from './omnistudio/datapack.js';

/**
 * The managed-package (Vlocity) entry into the native OmniStudio extractors.
 * Each native extractor hands a DataPack here with its own root-level
 * extraction; the DataPack is converted to the native root object
 * (`omnistudio/datapack.ts`) and extracted by exactly the code the Metadata
 * API form uses, so a managed-package component gets the same node, the same
 * edges and the same graph resolution. The node additionally carries
 * `sourceFormat: 'vlocity-datapack'`, its DataPack key and the namespace the
 * export was written in, and its `sourcePath` is the DataPack's main file.
 */

/** True when `path` is a DataPack: its `_DataPack.json` main file, or a folder (the walker's unit). */
export const isDataPackSource = async (path: string): Promise<boolean> => {
  if (isDataPackPath(path)) return true;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

/** A native extractor's root-level entry: the parsed root, the main file, the api name. */
export type RootExtractor = (
  root: Record<string, unknown>,
  mainPath: string,
  apiName: string,
) => Result<ExtractionResult, ExtractorError>;

const LABEL: Readonly<Record<DataPackKind, string>> = {
  OmniScript: 'an OmniScript',
  IntegrationProcedure: 'an Integration Procedure',
  DataRaptor: 'a DataRaptor',
  VlocityCard: 'a Card',
};

const decorate = (
  result: Result<ExtractionResult, ExtractorError>,
  conv: DataPackConversion,
  componentType: string,
): Result<ExtractionResult, ExtractorError> => {
  if (!result.ok) return result;
  const extra = dataPackNodeProperties(conv);
  return ok({
    ...result.value,
    nodes: result.value.nodes.map((n) => (n.type === componentType ? { ...n, properties: { ...n.properties, ...extra } } : n)),
  });
};

const read = async (
  path: string,
  convert: (dp: Awaited<ReturnType<typeof readDataPack>> & { ok: true }) => ReturnType<typeof dataPackToProcess>,
): Promise<Result<{ readonly conv: DataPackConversion; readonly mainPath: string }, ExtractorError>> => {
  const r = await readDataPack(path);
  if (!r.ok) return err({ kind: r.missing ? 'file-not-found' : 'parse-error', path, message: r.message });
  const conv = convert(r);
  if (!conv.ok) return err({ kind: 'malformed-input', path, message: conv.message });
  return ok({ conv: conv.value, mainPath: r.value.mainPath });
};

/** An OmniScript / Integration Procedure DataPack through `extract` (`want` is the caller's kind). */
export const extractProcessDataPack = async (
  path: string,
  want: 'OmniScript' | 'IntegrationProcedure',
  extract: RootExtractor,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const got = await read(path, (r) =>
    dataPackToProcess(r.value, dataPackKindOfDir(basename(dirname(dirname(r.value.mainPath))))),
  );
  if (!got.ok) return got;
  const { conv, mainPath } = got.value;
  if (conv.kind !== want) {
    return err({ kind: 'malformed-input', path, message: `${LABEL[conv.kind]} DataPack, not ${LABEL[want]} — its own extractor handles it` });
  }
  return decorate(
    extract({ ...conv.root }, mainPath, conv.apiName),
    conv,
    want === 'OmniScript' ? 'OmniScript' : 'OmniIntegrationProcedure',
  );
};

/** A DataRaptor DataPack through `extract`. */
export const extractMapperDataPack = async (
  path: string,
  extract: RootExtractor,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const got = await read(path, (r) => dataPackToMapper(r.value));
  if (!got.ok) return got;
  const { conv, mainPath } = got.value;
  return decorate(extract({ ...conv.root }, mainPath, conv.apiName), conv, 'OmniDataTransform');
};

/** A Card DataPack through `extract`. */
export const extractCardDataPack = async (
  path: string,
  extract: RootExtractor,
): Promise<Result<ExtractionResult, ExtractorError>> => {
  const got = await read(path, (r) => dataPackToCard(r.value));
  if (!got.ok) return got;
  const { conv, mainPath } = got.value;
  return decorate(extract({ ...conv.root }, mainPath, conv.apiName), conv, 'OmniUiCard');
};
