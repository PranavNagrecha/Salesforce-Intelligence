/**
 * The Vlocity Build Tool DataPack layout, at the one layer every package can
 * read. A DataPack is a FOLDER, `<projectPath>/<DataPackType>/<Key>/`, whose
 * main file is `<Key>_DataPack.json`; its large JSON fields live in sibling
 * files of that folder. A component built from a DataPack therefore spans the
 * whole folder: anything that fingerprints, caches or reconciles "the
 * component's source" must read the folder, not only the main file.
 */

/** The main file of a DataPack folder ends with this. */
export const DATAPACK_FILE_SUFFIX = '_DataPack.json';

/** True when a path names a DataPack main file. */
export const isDataPackPath = (path: string): boolean => path.endsWith(DATAPACK_FILE_SUFFIX);
