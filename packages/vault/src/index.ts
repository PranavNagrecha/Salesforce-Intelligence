/**
 * @sf-intelligence/vault
 *
 * Filesystem helpers for the `org-kb/` vault: canonical paths, manifest
 * read/write with atomic semantics, source-tree hashing, and freshness
 * decisions. Every runtime package that touches the vault on disk goes
 * through this module.
 */

export { checkFreshness } from './freshness.js';
export type { FreshnessState } from './freshness.js';
export { computeSourceTreeHash } from './hash.js';
export type { HashError } from './hash.js';
export { componentPath, snapshotPath, vaultPaths } from './layout.js';
export {
  collectVaultSourceFiles,
  resolveVaultSourcePath,
} from './source-path.js';
export type {
  CollectVaultSourceFilesOptions,
  VaultSourceFile,
} from './source-path.js';
export type { VaultLayout } from './layout.js';
export {
  backfillCoverageInMemory,
  buildCoverageEntries,
  ENTERPRISE_NOT_MODELED_TYPES,
  loadManifest,
  readCoverageEntries,
  readSkippedDirectories,
  saveManifest,
  summarizeCoverage,
} from './manifest.js';
export type {
  CoverageSummary,
  ExtendedVaultManifest,
  ManifestError,
  StagedBuildMarker,
} from './manifest.js';
export {
  acknowledgeFinding,
  findingFingerprint,
  isFingerprintSuppressed,
  loadBaseline,
  saveBaseline,
} from './baseline.js';
export type { BaselineEntry, BaselineError, BaselineFile } from './baseline.js';
export {
  ANNOTATION_KEYS,
  annotationsFor,
  annotationsPath,
  appendAnnotationEvent,
  readAnnotations,
} from './annotations.js';
export type { Annotation, AnnotationEvent, AnnotationKey } from './annotations.js';
export {
  appendDemandHit,
  appendDrainResult,
  demandQueuePath,
  queuedDrainIds,
  readDemandQueue,
} from './demand-queue.js';
export type { DemandQueueEntry } from './demand-queue.js';
export { deleteSnapshot, listSnapshots, loadSnapshot, saveSnapshot } from './snapshot.js';
export type {
  Snapshot,
  SnapshotEdge,
  SnapshotIoError,
  SnapshotMeta,
  SnapshotNode,
} from './snapshot.js';
// v3.1 — vault registry for cross-org/sandbox-vs-prod comparison tier.
export {
  findRegistryFile,
  findRegistryRoot,
  getVaultRef,
  listRegisteredVaults,
  loadRegistry,
  registerVault,
  registryPath,
  REGISTRY_FILENAME,
  resolveVault,
  saveRegistry,
} from './registry.js';
export type {
  RegistryEntry,
  RegistryError,
  VaultRef,
  VaultRegistry,
} from './registry.js';
