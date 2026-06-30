import type { IAilyHostAPI, IDirent, IFileSystem } from '../../core/host-api';
import type {
  ProjectRelatedContentGroup,
  ProjectRelatedFileEntry,
  RelatedContentScope,
} from './project-related-file.types';
import { resolveProjectAssetsRootDir } from '../../../../utils/project-log.utils';

const RELATED_URLS_FILE_NAME = 'RELATED_URLS.txt';

interface FileDialogSelection {
  canceled: boolean;
  filePaths: string[];
}

interface PickAndCopyResult {
  readonly addedEntries: readonly ProjectRelatedFileEntry[];
  readonly skippedOriginalPaths: readonly string[];
  readonly invalidOriginalPaths: readonly string[];
}

type FileDialogLike = Pick<IAilyHostAPI['dialog'], 'selectFiles'>;

export class ProjectRelatedFileStorage {
  constructor(
    private readonly host: Pick<IAilyHostAPI, 'fs' | 'path' | 'dialog'>,
  ) {}

  list(scope: RelatedContentScope, projectPath: string, _sessionId?: string): ProjectRelatedFileEntry[] {
    if (scope !== 'project') {
      return [];
    }

    const assetsRootDir = this.resolveAssetsRootDir(projectPath);
    if (!assetsRootDir || !this.host.fs.existsSync(assetsRootDir)) {
      return [];
    }

    const fileEntries = readDirEntries(this.host.fs, assetsRootDir)
      .filter((entry) => !entry.name.startsWith('.') && entry.name !== RELATED_URLS_FILE_NAME)
      .map((entry) => this.toAssetEntry(assetsRootDir, entry))
      .sort((left, right) => compareAssetEntries(left, right));

    return [
      ...fileEntries,
      ...this.readUrlEntries(projectPath),
    ];
  }

  listGrouped(
    scope: RelatedContentScope,
    projectPath: string,
    sessionId?: string,
  ): ProjectRelatedContentGroup[] {
    const entries = this.list(scope, projectPath, sessionId);
    const orderedTypes: readonly ProjectRelatedFileEntry['type'][] = [
      'file',
      'folder',
      'link',
    ];

    return orderedTypes
      .map((type) => ({
        type,
        entries: entries.filter((entry) => entry.type === type),
      }))
      .filter((group) => group.entries.length > 0);
  }

  async pickAndCopy(
    scope: RelatedContentScope,
    projectPath: string,
    sessionId?: string,
  ): Promise<PickAndCopyResult> {
    if (scope !== 'project') {
      return { addedEntries: [], skippedOriginalPaths: [], invalidOriginalPaths: [] };
    }

    const result = await this.host.dialog.selectFiles({
      title: '选择文件或文件夹',
      properties: ['multiSelections', 'openFile', 'openDirectory'],
      filters: [{ name: '所有文件', extensions: ['*'] }],
    }) as FileDialogSelection | null | undefined;

    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { addedEntries: [], skippedOriginalPaths: [], invalidOriginalPaths: [] };
    }

    return this.importPaths(scope, projectPath, result.filePaths, sessionId);
  }

  importPaths(
    scope: RelatedContentScope,
    projectPath: string,
    sourcePaths: readonly string[],
    _sessionId?: string,
  ): PickAndCopyResult {
    if (scope !== 'project') {
      return { addedEntries: [], skippedOriginalPaths: [], invalidOriginalPaths: [] };
    }

    const assetsRootDir = this.requireAssetsRootDir(projectPath);
    this.ensureDir(assetsRootDir);

    const addedEntries: ProjectRelatedFileEntry[] = [];
    const skippedOriginalPaths: string[] = [];
    const invalidOriginalPaths: string[] = [];

    for (const sourcePath of sourcePaths) {
      const normalizedSourcePath = typeof sourcePath === 'string' ? sourcePath.trim() : '';
      if (!normalizedSourcePath || !this.host.fs.existsSync(normalizedSourcePath)) {
        invalidOriginalPaths.push(sourcePath);
        continue;
      }

      const originalName = this.host.path.basename(normalizedSourcePath);
      const importDecision = this.resolveImportDecision(assetsRootDir, normalizedSourcePath, originalName);
      if (importDecision.action === 'skip') {
        skippedOriginalPaths.push(sourcePath);
        continue;
      }
      if (importDecision.action === 'reuse') {
        skippedOriginalPaths.push(sourcePath);
        addedEntries.push(this.createEntryFromAbsolutePath(assetsRootDir, importDecision.existingPath));
        continue;
      }

      this.copyPath(normalizedSourcePath, importDecision.destinationPath);
      addedEntries.push(this.createEntryFromAbsolutePath(assetsRootDir, importDecision.destinationPath));
    }

    return { addedEntries, skippedOriginalPaths, invalidOriginalPaths };
  }

  importLinks(
    scope: RelatedContentScope,
    projectPath: string,
    urls: readonly string[],
    _sessionId?: string,
  ): PickAndCopyResult {
    if (scope !== 'project') {
      return { addedEntries: [], skippedOriginalPaths: [], invalidOriginalPaths: [] };
    }

    const assetsRootDir = this.requireAssetsRootDir(projectPath);
    this.ensureDir(assetsRootDir);

    const existingUrls = this.readStoredUrls(projectPath);
    const existingKeys = new Set(existingUrls.map((url) => this.normalizeUrlKey(url)).filter(Boolean));
    const nextUrls = [...existingUrls];
    const addedEntries: ProjectRelatedFileEntry[] = [];
    const skippedOriginalPaths: string[] = [];
    const invalidOriginalPaths: string[] = [];

    for (const rawUrl of urls) {
      const normalizedUrl = this.normalizeUrl(rawUrl);
      if (!normalizedUrl) {
        invalidOriginalPaths.push(rawUrl);
        continue;
      }

      const urlKey = this.normalizeUrlKey(normalizedUrl);
      if (urlKey && existingKeys.has(urlKey)) {
        skippedOriginalPaths.push(rawUrl);
        addedEntries.push(this.createLinkEntry(normalizedUrl));
        continue;
      }

      nextUrls.push(normalizedUrl);
      if (urlKey) {
        existingKeys.add(urlKey);
      }
      addedEntries.push(this.createLinkEntry(normalizedUrl));
    }

    this.writeStoredUrls(projectPath, nextUrls);
    return { addedEntries, skippedOriginalPaths, invalidOriginalPaths };
  }

  importPathReferences(
    scope: RelatedContentScope,
    projectPath: string,
    sourcePaths: readonly string[],
    sessionId?: string,
  ): PickAndCopyResult {
    return this.importPaths(scope, projectPath, sourcePaths, sessionId);
  }

  remove(
    scope: RelatedContentScope,
    projectPath: string,
    entry: ProjectRelatedFileEntry,
    _sessionId?: string,
  ): void {
    if (scope !== 'project') {
      return;
    }

    if (entry.type === 'link') {
      const targetKey = this.normalizeUrlKey(entry.absolutePath);
      const nextUrls = this.readStoredUrls(projectPath)
        .filter((url) => this.normalizeUrlKey(url) !== targetKey);
      this.writeStoredUrls(projectPath, nextUrls);
      return;
    }

    if (!this.host.fs.existsSync(entry.absolutePath)) {
      return;
    }

    const stat = this.host.fs.statSync(entry.absolutePath);
    if (stat.isDirectory()) {
      this.host.fs.rmdirSync(entry.absolutePath, { recursive: true, force: true });
      return;
    }

    this.host.fs.unlinkSync(entry.absolutePath);
  }

  buildPromptText(
    scope: RelatedContentScope,
    projectPath: string,
    sessionId?: string,
  ): string {
    if (scope !== 'project') {
      return '';
    }

    return [
      'Project assets are stored under the project asset directory.',
      'When the user asks about attached, related, or imported project materials, interpret that request as referring to the project asset directory by default.',
      'Do not expand such asset-oriented requests to memory stores or unrelated project files unless the user clearly asks for those broader sources.',
      'For questions about what related materials exist, inspect the asset root first and derive the answer from that inventory instead of inferring from other prompt context.',
      'Use assets_tool with action="list" and path="." to inspect the asset root when needed.',
      'If an asset entry is a directory, continue by listing that directory progressively instead of trying to read it like a file.',
      'Use assets_tool to list and read these project assets when the user refers to attached files, folders, videos, FFS resources, or related URLs.',
      'When checking related links, read RELATED_URLS.txt from the asset directory rather than assuming URLs from memory or environment context.',
    ].join('\n');
  }

  private toAssetEntry(
    assetsRootDir: string,
    entry: IDirent,
  ): ProjectRelatedFileEntry {
    const absolutePath = this.host.path.join(assetsRootDir, entry.name);
    return this.createEntryFromAbsolutePath(assetsRootDir, absolutePath, entry.isDirectory() ? 'folder' : 'file');
  }

  private createEntryFromAbsolutePath(
    assetsRootDir: string,
    absolutePath: string,
    forcedType?: ProjectRelatedFileEntry['type'],
  ): ProjectRelatedFileEntry {
    const normalizedRelativePath = this.normalizeRelativeAssetPath(
      this.host.path.relative(assetsRootDir, absolutePath),
    );
    const type = forcedType ?? (this.host.fs.statSync(absolutePath).isDirectory() ? 'folder' : 'file');
    return {
      type,
      name: this.host.path.basename(absolutePath),
      absolutePath,
      relativePath: normalizedRelativePath,
    };
  }

  private createLinkEntry(url: string): ProjectRelatedFileEntry {
    return {
      type: 'link',
      name: this.buildLinkName(url),
      absolutePath: url,
      relativePath: url,
      originalPath: url,
    };
  }

  private resolveImportDecision(
    assetsRootDir: string,
    sourcePath: string,
    originalName: string,
  ): { action: 'copy'; destinationPath: string } | { action: 'reuse'; existingPath: string } | { action: 'skip' } {
    let candidateName = originalName;
    let candidatePath = this.host.path.join(assetsRootDir, candidateName);
    let suffixIndex = 2;

    while (this.host.fs.existsSync(candidatePath)) {
      const sourceHash = this.computePathHash(sourcePath);
      const existingHash = this.computePathHash(candidatePath);
      if (sourceHash === existingHash) {
        return { action: 'reuse', existingPath: candidatePath };
      }

      candidateName = withUniqueNameSuffix(originalName, suffixIndex);
      candidatePath = this.host.path.join(assetsRootDir, candidateName);
      suffixIndex += 1;
    }

    return {
      action: 'copy',
      destinationPath: candidatePath,
    };
  }

  private copyPath(sourcePath: string, destinationPath: string): void {
    if (this.host.fs.copySync) {
      this.host.fs.copySync(sourcePath, destinationPath);
      return;
    }

    const sourceStat = this.host.fs.statSync(sourcePath);
    if (sourceStat.isDirectory()) {
      this.copyDirectory(sourcePath, destinationPath);
      return;
    }

    this.copyFile(sourcePath, destinationPath);
  }

  private copyDirectory(sourceDir: string, destinationDir: string): void {
    this.ensureDir(destinationDir);

    for (const entry of readDirEntries(this.host.fs, sourceDir)) {
      const sourcePath = this.host.path.join(sourceDir, entry.name);
      const destinationPath = this.host.path.join(destinationDir, entry.name);
      if (entry.isDirectory()) {
        this.copyDirectory(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        this.copyFile(sourcePath, destinationPath);
      }
    }
  }

  private copyFile(sourcePath: string, destinationPath: string): void {
    const rawFs = this.host.fs as IFileSystem & {
      readFileAsBase64?: (path: string) => string;
      writeBase64File?: (path: string, base64: string) => void;
    };

    if (typeof rawFs.readFileAsBase64 === 'function' && typeof rawFs.writeBase64File === 'function') {
      rawFs.writeBase64File(destinationPath, rawFs.readFileAsBase64(sourcePath));
      return;
    }

    const content = this.host.fs.readFileSync(sourcePath);
    this.host.fs.writeFileSync(destinationPath, content);
  }

  private computePathHash(targetPath: string): string {
    const stat = this.host.fs.statSync(targetPath);
    return stat.isDirectory()
      ? this.computeDirectoryHash(targetPath)
      : this.computeFileHash(targetPath);
  }

  private computeDirectoryHash(targetDir: string): string {
    const digestParts: string[] = [];
    this.collectDirectoryFingerprint(targetDir, targetDir, digestParts);
    return hashText(digestParts.join('\n'));
  }

  private collectDirectoryFingerprint(
    rootDir: string,
    currentDir: string,
    digestParts: string[],
  ): void {
    const entries = readDirEntries(this.host.fs, currentDir)
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = this.host.path.join(currentDir, entry.name);
      const relativePath = this.normalizeRelativeAssetPath(
        this.host.path.relative(rootDir, absolutePath),
      );

      if (entry.isDirectory()) {
        digestParts.push(`dir:${relativePath}`);
        this.collectDirectoryFingerprint(rootDir, absolutePath, digestParts);
        continue;
      }

      digestParts.push(`file:${relativePath}:${this.computeFileHash(absolutePath)}`);
    }
  }

  private computeFileHash(filePath: string): string {
    const rawFs = this.host.fs as IFileSystem & {
      readFileAsBase64?: (path: string) => string;
    };

    if (typeof rawFs.readFileAsBase64 === 'function') {
      return hashBase64(rawFs.readFileAsBase64(filePath));
    }

    return hashText(this.host.fs.readFileSync(filePath));
  }

  private readUrlEntries(projectPath: string): ProjectRelatedFileEntry[] {
    return this.readStoredUrls(projectPath).map((url) => this.createLinkEntry(url));
  }

  private readStoredUrls(projectPath: string): string[] {
    const urlsFilePath = this.resolveRelatedUrlsFilePath(projectPath);
    if (!urlsFilePath || !this.host.fs.existsSync(urlsFilePath)) {
      return [];
    }

    try {
      return this.host.fs.readFileSync(urlsFilePath, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  private writeStoredUrls(projectPath: string, urls: readonly string[]): void {
    const urlsFilePath = this.resolveRelatedUrlsFilePath(projectPath);
    if (!urlsFilePath) {
      return;
    }

    const uniqueUrls: string[] = [];
    const seen = new Set<string>();
    for (const url of urls) {
      const normalizedUrl = this.normalizeUrl(url);
      if (!normalizedUrl) {
        continue;
      }
      const key = this.normalizeUrlKey(normalizedUrl);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      uniqueUrls.push(normalizedUrl);
    }

    this.ensureDir(this.host.path.dirname(urlsFilePath));
    const content = uniqueUrls.length > 0 ? `${uniqueUrls.join('\n')}\n` : '';
    this.host.fs.writeFileSync(urlsFilePath, content, 'utf-8');
  }

  private resolveRelatedUrlsFilePath(projectPath: string): string | undefined {
    const assetsRootDir = this.resolveAssetsRootDir(projectPath);
    return assetsRootDir
      ? this.host.path.join(assetsRootDir, RELATED_URLS_FILE_NAME)
      : undefined;
  }

  private resolveAssetsRootDir(projectPath: string): string | undefined {
    const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!normalizedProjectPath) {
      return undefined;
    }

    return resolveProjectAssetsRootDir(normalizedProjectPath, this.host.path) ?? undefined;
  }

  private requireAssetsRootDir(projectPath: string): string {
    const assetsRootDir = this.resolveAssetsRootDir(projectPath);
    if (!assetsRootDir) {
      throw new Error('Project assets directory is unavailable.');
    }

    return assetsRootDir;
  }

  private ensureDir(dirPath: string): void {
    if (!this.host.fs.existsSync(dirPath)) {
      this.host.fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private normalizeUrl(value: string): string | undefined {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) {
      return undefined;
    }

    try {
      return new URL(trimmed).toString();
    } catch {
      return undefined;
    }
  }

  private normalizeUrlKey(value: string): string {
    return value.trim().toLowerCase();
  }

  private buildLinkName(url: string): string {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname === '/' ? '' : parsed.pathname;
      return `${parsed.hostname}${path}`;
    } catch {
      return url;
    }
  }

  private normalizeRelativeAssetPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  }
}

function readDirEntries(
  fs: Pick<IFileSystem, 'readdirSync' | 'readDirSync' | 'statSync'>,
  dirPath: string,
): IDirent[] {
  if (fs.readDirSync) {
    return fs.readDirSync(dirPath);
  }

  return fs.readdirSync(dirPath).map((name) => ({
    name,
    isDirectory: () => fs.statSync(`${dirPath}/${name}`).isDirectory(),
    isFile: () => fs.statSync(`${dirPath}/${name}`).isFile(),
  }));
}

function compareAssetEntries(
  left: ProjectRelatedFileEntry,
  right: ProjectRelatedFileEntry,
): number {
  if (left.type !== right.type) {
    return left.type.localeCompare(right.type);
  }
  return left.name.localeCompare(right.name);
}

function withUniqueNameSuffix(name: string, index: number): string {
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex <= 0) {
    return `${name}-${index}`;
  }

  return `${name.slice(0, extensionIndex)}-${index}${name.slice(extensionIndex)}`;
}

function hashText(value: string): string {
  return simpleHash(value);
}

function hashBase64(value: string): string {
  return simpleHash(value);
}

function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
