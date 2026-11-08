export interface Issue { path: string; message: string }
export interface Destination { id: string; name: string; path: string; writable: boolean; availableTo: string[] }
export interface SourceRecord { path: string; repository?: string; revision?: string; subpath?: string; replaced?: boolean }
export interface StoredSkill { id: string; name: string; description: string; linkName: string; canonicalPath: string; contentHash: string; sources: SourceRecord[]; enabled: boolean; destinations: string[]; linkedDestinations: string[]; issues: Issue[] }
export interface SkillSummary extends StoredSkill { contentState: 'ready' | 'changed' | 'missing' | 'invalid' }
export interface SkillDetail extends SkillSummary { markdown: string }
export interface ImportOrigin { path: string; name: string }
export interface ScannedSkill { sourcePath?: string; id: string; name: string; description: string; path: string; realPath: string; contentHash: string; linkName: string; destinations: string[]; aliases: string[]; external: boolean; issues: Issue[]; preview?: string }
export interface ScanResult { skills: ScannedSkill[]; destinations: Destination[]; issues: Issue[] }
export interface DuplicateGroup { name: string; skillIds: string[] }
export interface SkillConflict { name: string; skillIds: string[]; reasons: ('display-name' | 'link-name')[]; managed: { name: string; linkName: string; path: string; description: string; contentHash: string; preview?: string }[] }
export type BrokenLink = { path: string; target: string } & ({ kind: 'restore'; skillId: string } | { kind: 'remove' });
export interface SetupPreview extends ScanResult {
  kind: 'setup';
  selectedSkillIds?: string[];
  storePath: string;
  existing: Pick<StoredSkill, 'name' | 'linkName' | 'canonicalPath' | 'contentHash' | 'destinations' | 'sources' | 'enabled'>[];
  previewId: string;
  duplicates: DuplicateGroup[];
  conflicts: SkillConflict[];
  brokenLinks: BrokenLink[];
}
export interface SetupApply { previewId: string; skillIds: string[]; destinations: string[]; names?: { skillId: string; name: string }[] }
export interface OperationResult { ok: boolean; issues: Issue[]; skills: SkillSummary[] }
export interface ImportPreview { kind: 'import'; previewId: string; skills: ScannedSkill[]; issues: Issue[]; duplicates: DuplicateGroup[]; conflicts: SkillConflict[]; existing: SetupPreview['existing'] }
export interface ImportApply { previewId: string; skillIds: string[]; destinations: string[]; names?: { skillId: string; name: string }[] }
export interface AppError { message: string; code: string }
export type BulkAction = 'enable' | 'disable' | 'delete' | 'keep';
export interface BulkResult extends OperationResult { failedIds: string[] }
export interface RestorePreview { previewId: string; backupPath: string; skills: { id: string; name: string; locations: string[]; preservedLocations: string[]; exportOnlyLocations: string[] }[]; issues: Issue[] }
export interface RestoreResult extends OperationResult { backupPath: string }
export interface SkillsBridge {
  bulk(action: BulkAction, ids: string[]): Promise<BulkResult>;
  restorePreview(): Promise<RestorePreview>;
  restoreApply(previewId: string): Promise<RestoreResult>;
  revealExport(): Promise<void>;
  chooseFolder(): Promise<string | null>;
  acceptChanges(id: string): Promise<OperationResult>;
  scan(): Promise<ScanResult>;
  list(): Promise<SkillSummary[]>;
  detail(id: string): Promise<SkillDetail>;
  setupPreview(): Promise<SetupPreview>;
  setupApply(request: SetupApply): Promise<OperationResult>;
  fixBrokenLinks(previewId: string): Promise<OperationResult>;
  enable(id: string): Promise<OperationResult>;
  disable(id: string): Promise<OperationResult>;
  setDestinations(id: string, destinationIds: string[]): Promise<OperationResult>;
  delete(id: string): Promise<OperationResult>;
  removeMissing(id: string): Promise<OperationResult>;
  importPreview(source: string): Promise<ImportPreview | SetupPreview>;
  importApply(request: ImportApply): Promise<OperationResult>;
  rescan(): Promise<SkillSummary[]>;
  reveal(id: string): Promise<void>;
  browseMarketplace(): Promise<void>;
  cancelImport(): Promise<void>;
}
