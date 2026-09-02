import { Injectable } from '@angular/core';
import { parse as parseJavaScript } from 'acorn';
import { ElectronService } from '@core/platform/public-api';
import { AILY_LOCAL_LIBRARY_SOURCES_KEY } from './local-library-sync.service';
import {
  AILY_LINUX_NPM_SCOPE,
  AILY_NPM_SCOPE,
  AILY_PACKAGE_SCOPES,
  isAilyCoreLibraryPackageName,
  isAilyLibraryPackageName,
} from '@shared/public-api';

export const AILY_BLOCKLY_LIBRARY_REQUIRED_FILES = ['package.json', 'block.json', 'toolbox.json', 'generator.js'] as const;

const AILY_BLOCKLY_LIBRARY_TOOLBOX_ITEM_KINDS = new Set(['category', 'block', 'label', 'sep', 'separator', 'button']);
const PACKAGE_SCAN_DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

export type BlocklyLibraryPackageSource = 'declared' | 'node_modules';

export interface BlocklyLibraryPackageRef {
  name: string;
  path: string;
  source?: BlocklyLibraryPackageSource;
}

export interface BlocklyInstalledLibraryPackage {
  name: string;
  version: string;
  description: string;
  author: any;
  nickname: string;
  icon: string;
  keywords: any[];
  path: string;
  source: BlocklyLibraryPackageSource;
}

export interface BlocklyLibraryPackagePaths {
  packageJson: string;
  blockJson: string;
  toolboxJson: string;
  generatorJs: string;
  readme: string;
  readmeAi: string;
  srcDir: string;
  srcArchive: string;
  i18nDir: string;
  pinmapsDir: string;
}

export interface BlocklyLibraryPackageSnapshot {
  ref: BlocklyLibraryPackageRef;
  paths: BlocklyLibraryPackagePaths;
  packageJson: any | null;
  blockJson: any | null;
  toolboxJson: any | null;
  toolboxRoot: any | null;
  readErrors: string[];
}

export interface BlocklyLibraryDiagnostics {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface BlocklyLibrarySubmissionPackage {
  packageJson: any;
  blockJson: any;
  toolboxJson: any;
  generatorJs: string;
  readme: string;
  readmeAi: string;
  i18n: Record<string, any>;
  pinmaps: Record<string, any>;
}

export interface BlocklyLibrarySubmissionBundle {
  package: BlocklyLibrarySubmissionPackage;
  srcArchivePath?: string;
  srcArchiveOutputPath?: string;
  srcDirectoryPath?: string;
}

export interface BlocklyLibraryMetadataUpdateResult {
  renamed: boolean;
  projectPackageJsonUpdated: boolean;
  requiresProjectReload: boolean;
  previousPackageName?: string;
  nextPackageName?: string;
}

interface BlocklyLibraryMetadataTarget {
  packagePath: string;
  nextPackagePath: string;
}

@Injectable({
  providedIn: 'root',
})
export class BlocklyLibraryPackageService {
  constructor(private electronService: ElectronService) { }

  isLibraryPackageName(packageName: string): boolean {
    return isAilyLibraryPackageName(packageName);
  }

  compareLibraryNames(a: string, b: string): number {
    const aIsCore = isAilyCoreLibraryPackageName(a);
    const bIsCore = isAilyCoreLibraryPackageName(b);
    if (aIsCore && !bIsCore) {
      return -1;
    }
    if (!aIsCore && bIsCore) {
      return 1;
    }
    return a.localeCompare(b);
  }

  getPackagePath(projectPath: string, packageName: string): string {
    return this.electronService.pathJoin(projectPath, 'node_modules', ...packageName.split('/'));
  }

  getPackageRef(projectPath: string, packageName: string, source?: BlocklyLibraryPackageSource): BlocklyLibraryPackageRef {
    return {
      name: packageName,
      path: this.getPackagePath(projectPath, packageName),
      source,
    };
  }

  getPackagePaths(packagePath: string): BlocklyLibraryPackagePaths {
    return {
      packageJson: this.electronService.pathJoin(packagePath, 'package.json'),
      blockJson: this.electronService.pathJoin(packagePath, 'block.json'),
      toolboxJson: this.electronService.pathJoin(packagePath, 'toolbox.json'),
      generatorJs: this.electronService.pathJoin(packagePath, 'generator.js'),
      readme: this.electronService.pathJoin(packagePath, 'readme.md'),
      readmeAi: this.electronService.pathJoin(packagePath, 'readme_ai.md'),
      srcDir: this.electronService.pathJoin(packagePath, 'src'),
      srcArchive: this.electronService.pathJoin(packagePath, 'src.7z'),
      i18nDir: this.electronService.pathJoin(packagePath, 'i18n'),
      pinmapsDir: this.electronService.pathJoin(packagePath, 'pinmaps'),
    };
  }

  isPackageReady(projectPath: string, packageName: string): boolean {
    const packagePath = this.getPackagePath(projectPath, packageName);
    return AILY_BLOCKLY_LIBRARY_REQUIRED_FILES.every((fileName) =>
      this.electronService.exists(this.electronService.pathJoin(packagePath, fileName)),
    );
  }

  updateLibraryPackageJsonMetadata(ref: BlocklyLibraryPackageRef, metadataPatch: Record<string, unknown>): BlocklyLibraryMetadataUpdateResult {
    const safePatch = metadataPatch || {};
    const nextPackageName = typeof safePatch['name'] === 'string' ? safePatch['name'].trim() : '';
    if (nextPackageName && !this.isLibraryPackageName(nextPackageName)) {
      throw new Error(`库名不合规: ${nextPackageName}`);
    }
    if (nextPackageName && nextPackageName !== ref.name) {
      return this.renameLibraryPackageMetadata(ref, safePatch, nextPackageName);
    }

    const targetPaths = this.resolveMetadataTargetPackagePaths(ref);
    if (targetPaths.length === 0) {
      throw new Error(`未找到可写入的本地库 package.json (${ref.path})`);
    }

    for (const packagePath of targetPaths) {
      this.writePackageJsonPatch(packagePath, safePatch);
    }

    return {
      renamed: false,
      projectPackageJsonUpdated: false,
      requiresProjectReload: false,
    };
  }

  async scanInstalledLibraries(projectPath: string): Promise<BlocklyInstalledLibraryPackage[]> {
    const nodeModulesPath = this.electronService.pathJoin(projectPath, 'node_modules');
    if (!this.pathExists(nodeModulesPath)) {
      return [];
    }

    const libraries = new Map<string, BlocklyInstalledLibraryPackage>();
    for (const packageName of this.getDeclaredLibraryPackageNames(projectPath)) {
      const packageInfo = this.scanSingleLibraryPackage(
        this.getPackagePath(projectPath, packageName),
        packageName,
        'declared',
      );
      if (packageInfo) {
        libraries.set(packageInfo.name, packageInfo);
      }
    }

    for (const scope of AILY_PACKAGE_SCOPES) {
      const scopePath = this.electronService.pathJoin(nodeModulesPath, scope);
      if (this.isDirectory(scopePath)) {
        for (const dirName of this.readDirectoryNames(scopePath)) {
          if (!dirName.startsWith('lib-')) {
            continue;
          }

          const packageName = `${scope}/${dirName}`;
          if (libraries.has(packageName)) {
            continue;
          }

          const packageInfo = this.scanSingleLibraryPackage(
            this.electronService.pathJoin(scopePath, dirName),
            packageName,
            'node_modules',
          );
          if (packageInfo) {
            libraries.set(packageInfo.name, packageInfo);
          }
        }
      }
    }

    return Array.from(libraries.values()).sort((a, b) => this.compareLibraryNames(a.name, b.name));
  }

  readLibraryPackage(projectPath: string, packageName: string): BlocklyLibraryPackageSnapshot {
    return this.readLibraryPackageByRef(this.getPackageRef(projectPath, packageName));
  }

  readLibraryPackageByRef(ref: BlocklyLibraryPackageRef): BlocklyLibraryPackageSnapshot {
    const paths = this.getPackagePaths(ref.path);
    const readErrors: string[] = [];
    const packageJson = this.readRequiredJsonFile(paths.packageJson, 'package.json', readErrors);
    const toolboxJson = this.readRequiredJsonFile(paths.toolboxJson, 'toolbox.json', readErrors);
    const blockJson = this.readRequiredJsonFile(paths.blockJson, 'block.json', readErrors);

    return {
      ref,
      paths,
      packageJson,
      blockJson,
      toolboxJson,
      toolboxRoot: this.getCompatibleToolboxRoot(toolboxJson),
      readErrors,
    };
  }

  validateLibraryPackage(snapshot: BlocklyLibraryPackageSnapshot, expectedPackageName?: string): BlocklyLibraryDiagnostics {
    const errors = [...snapshot.readErrors];
    const warnings: string[] = [];

    if (snapshot.packageJson !== null) {
      this.validatePackageJson(snapshot.packageJson, snapshot.paths.packageJson, errors, expectedPackageName);
    }
    if (snapshot.blockJson !== null) {
      this.validateBlockJson(snapshot.blockJson, snapshot.paths.blockJson, errors);
    }
    if (snapshot.toolboxJson !== null) {
      this.validateToolboxJson(snapshot.toolboxJson, snapshot.paths.toolboxJson, errors, warnings);
    }

    this.checkRequiredGeneratorFile(snapshot.paths.generatorJs, errors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  readLibrarySubmissionPackage(projectPath: string, packageName: string): BlocklyLibrarySubmissionBundle {
    return this.readLibrarySubmissionPackageByRef(this.getPackageRef(projectPath, packageName));
  }

  readLibrarySubmissionPackageByRef(ref: BlocklyLibraryPackageRef): BlocklyLibrarySubmissionBundle {
    const snapshot = this.readLibraryPackageByRef(ref);
    const diagnostics = this.validateLibraryPackage(snapshot, ref.name);
    if (!diagnostics.valid) {
      throw new Error(diagnostics.errors.join('\n'));
    }

    const paths = snapshot.paths;
    const readme = this.readOptionalTextFile(paths.readme);
    const readmeAi = this.readOptionalTextFile(paths.readmeAi);
    const generatorJs = this.readRequiredTextFile(paths.generatorJs, 'generator.js');
    const i18n = this.readJsonDirectory(paths.i18nDir);
    const pinmaps = this.readJsonDirectory(paths.pinmapsDir);
    const srcArchivePath = this.pathExists(paths.srcArchive) ? paths.srcArchive : undefined;

    return {
      package: {
        packageJson: snapshot.packageJson,
        blockJson: snapshot.blockJson,
        toolboxJson: snapshot.toolboxJson,
        generatorJs,
        readme,
        readmeAi,
        i18n,
        pinmaps,
      },
      srcArchivePath,
      srcArchiveOutputPath: paths.srcArchive,
      srcDirectoryPath: paths.srcDir,
    };
  }

  getCompatibleToolboxRoot(toolboxJson: any): any {
    if (Array.isArray(toolboxJson) && toolboxJson.length === 1) {
      return toolboxJson[0];
    }

    return toolboxJson;
  }

  getIntegrityFileSignature(filePath: string): string {
    try {
      if (!this.electronService.exists(filePath)) {
        return `${filePath}:missing`;
      }

      const stat = window['fs'].statSync(filePath);
      return `${filePath}:${Number(stat?.mtimeMs) || 0}:${Number(stat?.size) || 0}`;
    } catch (error) {
      return `${filePath}:stat-error:${this.formatError(error)}`;
    }
  }

  private getDeclaredLibraryPackageNames(projectPath: string): string[] {
    const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
    if (!this.pathExists(packageJsonPath)) {
      return [];
    }

    let packageJson: any;
    try {
      packageJson = this.readJsonFile(packageJsonPath, 'package.json');
    } catch (error) {
      console.error('[PackageScan] failed to read project package.json:', error);
      return [];
    }

    const packageNames = new Set<string>();
    for (const field of PACKAGE_SCAN_DEPENDENCY_FIELDS) {
      const dependencies = packageJson?.[field];
      if (!dependencies || typeof dependencies !== 'object') {
        continue;
      }

      for (const packageName of Object.keys(dependencies)) {
        if (this.isLibraryPackageName(packageName)) {
          packageNames.add(packageName);
        }
      }
    }

    return Array.from(packageNames);
  }

  private scanSingleLibraryPackage(
    packagePath: string,
    packageName: string,
    source: BlocklyLibraryPackageSource,
  ): BlocklyInstalledLibraryPackage | null {
    try {
      const paths = this.getPackagePaths(packagePath);
      if (!this.pathExists(paths.packageJson) || !this.pathExists(paths.toolboxJson)) {
        return null;
      }

      const packageJson = this.readJsonFile(paths.packageJson, 'package.json');
      let toolboxRoot: any = null;
      try {
        toolboxRoot = this.getCompatibleToolboxRoot(this.readJsonFile(paths.toolboxJson, 'toolbox.json'));
      } catch {
        toolboxRoot = null;
      }
      const name = typeof packageJson.name === 'string' && packageJson.name
        ? packageJson.name
        : packageName;

      return {
        name,
        version: packageJson.version || '1.0.0',
        description: packageJson.description || '',
        author: packageJson.author || 'unknown',
        nickname: packageJson.nickname || name,
        icon: toolboxRoot?.icon || 'fa-light fa-cube',
        keywords: Array.isArray(packageJson.keywords) ? packageJson.keywords : [],
        path: packagePath,
        source,
      };
    } catch (error) {
      console.error(`扫描包 ${packageName} 失败:`, error);
      return null;
    }
  }

  private readRequiredJsonFile(filePath: string, fileName: string, errors: string[]): any | null {
    if (!this.electronService.exists(filePath)) {
      errors.push(`${fileName} 不合规: 文件不存在 (${filePath})`);
      return null;
    }

    try {
      return this.readJsonFile(filePath, fileName);
    } catch (error) {
      errors.push(`${fileName} 不合规: ${this.formatError(error)}`);
      return null;
    }
  }

  private readJsonFile(filePath: string, fileName: string): any {
    let content: string;
    try {
      content = this.electronService.readFile(filePath);
    } catch (error) {
      throw new Error(`读取失败 (${filePath})，${this.formatError(error)}`);
    }

    try {
      return JSON.parse(content);
    } catch (error) {
      throw new Error(`JSON 格式错误 (${filePath})，${this.formatError(error)}`);
    }
  }

  private assertPackageJsonPatchWritten(filePath: string, safePatch: Record<string, unknown>): void {
    const writtenPackageJson = this.readJsonFile(filePath, 'package.json');
    for (const [key, value] of Object.entries(safePatch)) {
      if (JSON.stringify(writtenPackageJson?.[key]) !== JSON.stringify(value)) {
        throw new Error(`写入校验失败 (${filePath})，字段 ${key} 未正确保存`);
      }
    }
  }

  private renameLibraryPackageMetadata(ref: BlocklyLibraryPackageRef, safePatch: Record<string, unknown>, nextPackageName: string): BlocklyLibraryMetadataUpdateResult {
    const projectPath = this.resolveProjectPathFromPackageRef(ref);
    const projectPackageJsonPath = projectPath ? this.electronService.pathJoin(projectPath, 'package.json') : '';
    const projectPackageJson = this.readProjectPackageJson(projectPath);
    const targets = this.resolveMetadataRenameTargets(ref, nextPackageName, projectPath, projectPackageJson);
    if (targets.length === 0) {
      throw new Error(`未找到可重命名的本地库 package.json (${ref.path})`);
    }

    this.assertRenameTargetsAvailable(targets);
    for (const target of targets) {
      this.writePackageJsonPatch(target.packagePath, safePatch);
    }

    for (const target of targets) {
      this.movePackageDirectory(target.packagePath, target.nextPackagePath);
    }

    const projectPackageJsonUpdated = !!projectPackageJson && !!projectPackageJsonPath
      ? this.updateProjectPackageJsonForLibraryRename(
        projectPackageJsonPath,
        projectPackageJson,
        ref.name,
        nextPackageName,
        projectPath,
        targets,
      )
      : false;

    return {
      renamed: true,
      projectPackageJsonUpdated,
      requiresProjectReload: true,
      previousPackageName: ref.name,
      nextPackageName,
    };
  }

  private writePackageJsonPatch(packagePath: string, safePatch: Record<string, unknown>): void {
    const paths = this.getPackagePaths(packagePath);
    const packageJson = this.readJsonFile(paths.packageJson, 'package.json');
    const nextPackageJson = {
      ...packageJson,
      ...safePatch,
    };

    this.electronService.writeFile(
      paths.packageJson,
      `${JSON.stringify(nextPackageJson, null, 2)}\n`,
    );
    this.assertPackageJsonPatchWritten(paths.packageJson, safePatch);
  }

  private resolveMetadataRenameTargets(
    ref: BlocklyLibraryPackageRef,
    nextPackageName: string,
    projectPath: string,
    projectPackageJson: any | null,
  ): BlocklyLibraryMetadataTarget[] {
    const targets: BlocklyLibraryMetadataTarget[] = [];
    const seen = new Set<string>();
    const addTarget = (packagePath: string, nextPackagePath: string) => {
      if (!packagePath || !nextPackagePath) {
        return;
      }
      if (!this.pathExists(this.getPackagePaths(packagePath).packageJson)) {
        return;
      }
      const key = this.normalizePathKey(packagePath);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      targets.push({ packagePath, nextPackagePath });
    };

    if (ref.path && projectPath && this.isPackagePathUnderProjectNodeModules(ref.path, projectPath)) {
      addTarget(ref.path, this.getPackagePath(projectPath, nextPackageName));
    } else {
      addTarget(ref.path, this.replacePackageDirectoryName(ref.path, nextPackageName));
    }

    const realPath = this.getRealPackagePath(ref.path);
    if (realPath && this.normalizePathKey(realPath) !== this.normalizePathKey(ref.path)) {
      addTarget(realPath, this.replacePackageDirectoryName(realPath, nextPackageName));
    }

    const localSourcePath = this.resolveLocalLibrarySourcePath(ref.name, projectPackageJson);
    addTarget(localSourcePath, this.replacePackageDirectoryName(localSourcePath, nextPackageName));

    const fileDependencyPath = this.resolveFileDependencyPackagePath(ref.name, projectPath, projectPackageJson);
    addTarget(fileDependencyPath, this.replacePackageDirectoryName(fileDependencyPath, nextPackageName));

    return targets;
  }

  private assertRenameTargetsAvailable(targets: BlocklyLibraryMetadataTarget[]): void {
    for (const target of targets) {
      if (this.normalizePathKey(target.packagePath) === this.normalizePathKey(target.nextPackagePath)) {
        continue;
      }
      if (this.pathExists(target.nextPackagePath)) {
        throw new Error(`目标库目录已存在，无法重命名: ${target.nextPackagePath}`);
      }
    }
  }

  private movePackageDirectory(sourcePath: string, destinationPath: string): void {
    if (this.normalizePathKey(sourcePath) === this.normalizePathKey(destinationPath)) {
      return;
    }

    const parentPath = window['path']?.dirname?.(destinationPath);
    if (parentPath && !this.pathExists(parentPath)) {
      window['fs'].mkdirSync(parentPath, { recursive: true });
    }

    try {
      window['fs'].renameSync(sourcePath, destinationPath);
    } catch (error: any) {
      const message = error?.message || String(error);
      if (error?.code !== 'EXDEV' && error?.code !== 'EPERM' && !message.includes('cross-device')) {
        throw error;
      }
      window['fs'].copySync(sourcePath, destinationPath);
      if (!this.pathExists(this.getPackagePaths(destinationPath).packageJson)) {
        throw new Error(`目录复制失败: ${sourcePath} -> ${destinationPath}`);
      }
      window['fs'].rmdirSync(sourcePath, { recursive: true, force: true });
    }
  }

  private updateProjectPackageJsonForLibraryRename(
    projectPackageJsonPath: string,
    projectPackageJson: any,
    previousPackageName: string,
    nextPackageName: string,
    projectPath: string,
    targets: BlocklyLibraryMetadataTarget[],
  ): boolean {
    let changed = false;
    const dependencyPath = this.findProjectLocalDependencyPath(projectPath, targets);
    for (const field of PACKAGE_SCAN_DEPENDENCY_FIELDS) {
      const dependencies = projectPackageJson?.[field];
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) || dependencies[previousPackageName] === undefined) {
        continue;
      }

      const previousSpec = dependencies[previousPackageName];
      const previousDependencyPath = this.resolveFileDependencySpecPath(projectPath, previousSpec);
      const renamedDependencyPath = this.findRenamedSourcePath(previousDependencyPath, targets);
      delete dependencies[previousPackageName];
      const nextDependencyPath = renamedDependencyPath || dependencyPath;
      dependencies[nextPackageName] = nextDependencyPath
        ? this.toFileDependencySpec(projectPath, nextDependencyPath)
        : previousSpec;
      changed = true;
    }

    const sources = projectPackageJson?.[AILY_LOCAL_LIBRARY_SOURCES_KEY];
    if (sources && typeof sources === 'object' && !Array.isArray(sources) && sources[previousPackageName] !== undefined) {
      const previousSourcePath = String(sources[previousPackageName] || '');
      const sourcePath = this.findRenamedSourcePath(previousSourcePath, targets);
      delete sources[previousPackageName];
      sources[nextPackageName] = sourcePath || previousSourcePath;
      changed = true;
    }

    const usedLibraries = projectPackageJson?.['ailyBlocklyUsedLibraries'];
    if (usedLibraries && typeof usedLibraries === 'object' && !Array.isArray(usedLibraries) && usedLibraries[previousPackageName] !== undefined) {
      usedLibraries[nextPackageName] = usedLibraries[previousPackageName];
      delete usedLibraries[previousPackageName];
      changed = true;
    }

    if (changed) {
      this.writeProjectPackageJson(projectPackageJsonPath, projectPackageJson);
    }
    return changed;
  }

  private writeProjectPackageJson(projectPackageJsonPath: string, projectPackageJson: any): void {
    const content = `${JSON.stringify(projectPackageJson, null, 2)}\n`;
    this.electronService.writeFile(projectPackageJsonPath, content);

    const pathApi = window['path'];
    if (!pathApi?.dirname || !pathApi?.join) {
      return;
    }

    const tempPackageJsonPath = pathApi.join(pathApi.dirname(projectPackageJsonPath), '.temp', 'package.json');
    if (this.pathExists(tempPackageJsonPath)) {
      this.electronService.writeFile(tempPackageJsonPath, content);
    }
  }

  private findProjectLocalDependencyPath(projectPath: string, targets: BlocklyLibraryMetadataTarget[]): string {
    const localLibrariesRoot = this.normalizePathKey(this.electronService.pathJoin(projectPath, 'local-libraries'));
    const nodeModulesRoot = this.normalizePathKey(this.electronService.pathJoin(projectPath, 'node_modules'));
    return targets.find(target => this.normalizePathKey(target.nextPackagePath).startsWith(`${localLibrariesRoot}/`))?.nextPackagePath
      || targets.find(target => this.normalizePathKey(target.nextPackagePath).startsWith(`${nodeModulesRoot}/`))?.nextPackagePath
      || '';
  }

  private findRenamedSourcePath(previousSourcePath: string, targets: BlocklyLibraryMetadataTarget[]): string {
    if (!previousSourcePath) {
      return '';
    }

    const sourceKey = this.normalizePathKey(previousSourcePath);
    return targets.find(target => this.normalizePathKey(target.packagePath) === sourceKey)?.nextPackagePath || '';
  }

  private toFileDependencySpec(projectPath: string, packagePath: string): string {
    const pathApi = window['path'];
    if (!projectPath || !pathApi?.relative || !pathApi?.isAbsolute) {
      return `file:${packagePath}`;
    }

    const relativePath = pathApi.relative(projectPath, packagePath);
    if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) {
      return `file:${packagePath}`;
    }

    return `file:${relativePath.replace(/[\\]+/g, '/')}`;
  }

  private resolveFileDependencySpecPath(projectPath: string, dependencySpec: unknown): string {
    if (typeof dependencySpec !== 'string' || !dependencySpec.startsWith('file:')) {
      return '';
    }

    const filePath = dependencySpec.slice(5);
    if (!filePath) {
      return '';
    }

    if (window['path']?.isAbsolute?.(filePath)) {
      return filePath;
    }

    return projectPath ? this.electronService.pathJoin(projectPath, filePath) : '';
  }

  private isPackagePathUnderProjectNodeModules(packagePath: string, projectPath: string): boolean {
    const packageKey = this.normalizePathKey(packagePath);
    const nodeModulesKey = this.normalizePathKey(this.electronService.pathJoin(projectPath, 'node_modules'));
    return packageKey.startsWith(`${nodeModulesKey}/`);
  }

  private replacePackageDirectoryName(packagePath: string, packageName: string): string {
    if (!packagePath) {
      return '';
    }

    const pathApi = window['path'];
    if (!pathApi?.dirname || !pathApi?.join) {
      return '';
    }

    const packageDirName = packageName.split('/').filter(Boolean).pop() || '';
    return packageDirName ? pathApi.join(pathApi.dirname(packagePath), packageDirName) : '';
  }

  private resolveMetadataTargetPackagePaths(ref: BlocklyLibraryPackageRef): string[] {
    const targetPaths: string[] = [];
    const seen = new Set<string>();
    const addTarget = (packagePath: string | undefined) => {
      if (!packagePath) {
        return;
      }
      const packageJsonPath = this.getPackagePaths(packagePath).packageJson;
      if (!this.pathExists(packageJsonPath)) {
        return;
      }
      const key = this.normalizePathKey(packagePath);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      targetPaths.push(packagePath);
    };

    addTarget(ref.path);
    addTarget(this.getRealPackagePath(ref.path));

    const projectPath = this.resolveProjectPathFromPackageRef(ref);
    const projectPackageJson = this.readProjectPackageJson(projectPath);
    addTarget(this.resolveLocalLibrarySourcePath(ref.name, projectPackageJson));
    addTarget(this.resolveFileDependencyPackagePath(ref.name, projectPath, projectPackageJson));

    return targetPaths;
  }

  private getRealPackagePath(packagePath: string): string {
    try {
      const realPath = window['fs']?.realpathSync?.(packagePath);
      return typeof realPath === 'string' ? realPath : '';
    } catch {
      return '';
    }
  }

  private resolveProjectPathFromPackageRef(ref: BlocklyLibraryPackageRef): string {
    if (!ref.path || !ref.name) {
      return '';
    }

    const pathApi = window['path'];
    if (!pathApi?.dirname || !pathApi?.basename) {
      return '';
    }

    let dir = ref.path;
    for (const _ of ref.name.split('/').filter(Boolean)) {
      dir = pathApi.dirname(dir);
    }

    if (pathApi.basename(dir) !== 'node_modules') {
      return '';
    }

    return pathApi.dirname(dir);
  }

  private readProjectPackageJson(projectPath: string): any | null {
    if (!projectPath) {
      return null;
    }

    const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
    if (!this.pathExists(packageJsonPath)) {
      return null;
    }

    try {
      return this.readJsonFile(packageJsonPath, 'package.json');
    } catch {
      return null;
    }
  }

  private resolveLocalLibrarySourcePath(packageName: string, packageJson: any | null): string {
    const sources = packageJson?.[AILY_LOCAL_LIBRARY_SOURCES_KEY];
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)) {
      return '';
    }

    const sourcePath = sources[packageName];
    return typeof sourcePath === 'string' ? sourcePath : '';
  }

  private resolveFileDependencyPackagePath(packageName: string, projectPath: string, packageJson: any | null): string {
    const dependencySpec = packageJson?.dependencies?.[packageName]
      ?? packageJson?.devDependencies?.[packageName]
      ?? packageJson?.optionalDependencies?.[packageName]
      ?? '';
    if (typeof dependencySpec !== 'string' || !dependencySpec.startsWith('file:')) {
      return '';
    }

    const filePath = dependencySpec.slice(5);
    if (!filePath) {
      return '';
    }

    if (window['path']?.isAbsolute?.(filePath)) {
      return filePath;
    }

    return projectPath ? this.electronService.pathJoin(projectPath, filePath) : '';
  }

  private normalizePathKey(packagePath: string): string {
    return packagePath.replace(/[\\/]+/g, '/').toLowerCase();
  }

  private readRequiredTextFile(filePath: string, fileName: string): string {
    if (!this.pathExists(filePath)) {
      throw new Error(`${fileName} 不合规: 文件不存在 (${filePath})`);
    }

    try {
      const content = this.electronService.readFile(filePath);
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('文件内容为空');
      }
      return content;
    } catch (error) {
      throw new Error(`${fileName} 不合规: 读取失败 (${filePath})，${this.formatError(error)}`);
    }
  }

  private readOptionalTextFile(filePath: string): string {
    if (!this.pathExists(filePath)) {
      return '';
    }

    try {
      return this.electronService.readFile(filePath) || '';
    } catch {
      return '';
    }
  }

  private readJsonDirectory(dirPath: string): Record<string, any> {
    const result: Record<string, any> = {};
    if (!this.pathExists(dirPath) || !this.isDirectory(dirPath)) {
      return result;
    }

    for (const fileName of this.readDirectoryNames(dirPath)) {
      if (!fileName.endsWith('.json')) {
        continue;
      }
      const filePath = this.electronService.pathJoin(dirPath, fileName);
      if (!this.pathExists(filePath) || this.isDirectory(filePath)) {
        continue;
      }
      const key = fileName.slice(0, -'.json'.length);
      result[key] = this.readJsonFile(filePath, fileName);
    }
    return result;
  }

  private validatePackageJson(packageJson: any, filePath: string, errors: string[], expectedPackageName?: string) {
    if (!this.isPlainObject(packageJson)) {
      errors.push(`package.json 不合规: 顶层必须是对象 (${filePath})`);
      return;
    }

    const packageNameValue = packageJson['name'];
    if (typeof packageNameValue !== 'string' || !packageNameValue.trim()) {
      errors.push(`package.json 不合规: 缺少字符串字段 name (${filePath})`);
    } else {
      const packageName = packageNameValue.trim();
      if (!this.isLibraryPackageName(packageName)) {
        errors.push(
          `package.json 不合规: name 必须以 ${AILY_NPM_SCOPE}/lib- 或 ${AILY_LINUX_NPM_SCOPE}/lib- 开头，当前为 ${packageName} (${filePath})`,
        );
      }
      if (expectedPackageName && packageName !== expectedPackageName) {
        errors.push(`package.json 不合规: name 与待加载库名不一致，期望 ${expectedPackageName}，当前为 ${packageName} (${filePath})`);
      }
    }

    const packageVersionValue = packageJson['version'];
    if (typeof packageVersionValue !== 'string' || !packageVersionValue.trim()) {
      errors.push(`package.json 不合规: 缺少字符串字段 version (${filePath})`);
    }
  }

  private validateBlockJson(blockJson: any, filePath: string, errors: string[]) {
    if (!Array.isArray(blockJson)) {
      errors.push(`block.json 不合规: 顶层必须是 block 定义数组 (${filePath})`);
      return;
    }

    if (blockJson.length === 0) {
      errors.push(`block.json 不合规: 至少需要包含一个 block 定义 (${filePath})`);
      return;
    }

    const seenTypes = new Set<string>();
    blockJson.forEach((block: any, index: number) => {
      const location = `block.json[${index}]`;
      if (!this.isPlainObject(block)) {
        errors.push(`${location} 不合规: 每个 block 定义必须是对象 (${filePath})`);
        return;
      }

      const blockType = block['type'];
      if (typeof blockType !== 'string' || !blockType.trim()) {
        errors.push(`${location} 不合规: 缺少字符串字段 type (${filePath})`);
      } else if (seenTypes.has(blockType)) {
        errors.push(`${location} 不合规: block type 重复: ${blockType} (${filePath})`);
      } else {
        seenTypes.add(blockType);
      }

      if (block['message0'] !== undefined && typeof block['message0'] !== 'string') {
        errors.push(`${location} 不合规: message0 必须是字符串 (${filePath})`);
      }

      Object.keys(block)
        .filter((key) => /^args\d+$/.test(key) && block[key] !== undefined)
        .forEach((key) => {
          if (!Array.isArray(block[key])) {
            errors.push(`${location}.${key} 不合规: 必须是数组 (${filePath})`);
          }
        });
    });
  }

  private validateToolboxJson(toolboxJson: any, filePath: string, errors: string[], warnings: string[]) {
    if (Array.isArray(toolboxJson)) {
      if (toolboxJson.length === 1) {
        const errorCountBefore = errors.length;
        this.validateToolboxItem(toolboxJson[0], 'toolbox.json[0]', filePath, errors);
        if (errors.length === errorCountBefore) {
          warnings.push(`toolbox.json 兼容加载: 顶层是单元素数组，已使用 toolbox.json[0] 加载。建议去掉最外层 [] (${filePath})`);
        }
        return;
      }

      errors.push(`toolbox.json 不合规: 顶层必须是单个 toolbox item 对象，不能是数组。请去掉最外层 [] (${filePath})`);
      return;
    }

    this.validateToolboxItem(toolboxJson, 'toolbox.json', filePath, errors);
  }

  private validateToolboxItem(item: any, location: string, filePath: string, errors: string[]) {
    if (!this.isPlainObject(item)) {
      errors.push(`${location} 不合规: toolbox item 必须是对象 (${filePath})`);
      return;
    }

    const itemKind = item['kind'];
    if (typeof itemKind !== 'string' || !itemKind.trim()) {
      errors.push(`${location} 不合规: 缺少字符串字段 kind (${filePath})`);
      return;
    }

    const kind = itemKind.trim().toLowerCase();
    if (!AILY_BLOCKLY_LIBRARY_TOOLBOX_ITEM_KINDS.has(kind)) {
      errors.push(`${location} 不合规: 不支持的 kind: ${itemKind} (${filePath})`);
      return;
    }

    if (kind === 'category') {
      if (typeof item['name'] !== 'string' || !item['name'].trim()) {
        errors.push(`${location} 不合规: category 缺少字符串字段 name (${filePath})`);
      }
      if (!Array.isArray(item['contents'])) {
        errors.push(`${location} 不合规: category.contents 必须是数组 (${filePath})`);
        return;
      }
      item['contents'].forEach((child: any, index: number) => {
        this.validateToolboxItem(child, `${location}.contents[${index}]`, filePath, errors);
      });
      return;
    }

    if (kind === 'block') {
      if (typeof item['type'] !== 'string' || !item['type'].trim()) {
        errors.push(`${location} 不合规: block 缺少字符串字段 type (${filePath})`);
      }
    }

    if (kind === 'label' && item['text'] !== undefined && typeof item['text'] !== 'string') {
      errors.push(`${location} 不合规: label.text 必须是字符串 (${filePath})`);
    }

    if (kind === 'button' && item['text'] !== undefined && typeof item['text'] !== 'string') {
      errors.push(`${location} 不合规: button.text 必须是字符串 (${filePath})`);
    }

    if (Array.isArray(item['contents'])) {
      item['contents'].forEach((child: any, index: number) => {
        this.validateToolboxItem(child, `${location}.contents[${index}]`, filePath, errors);
      });
    }
  }

  private checkRequiredGeneratorFile(filePath: string, errors: string[]) {
    if (!this.electronService.exists(filePath)) {
      errors.push(`generator.js 不合规: 文件不存在 (${filePath})`);
      return;
    }

    try {
      const generatorSource = this.electronService.readFile(filePath);
      const syntaxError = this.getJavaScriptSyntaxError(generatorSource);
      if (syntaxError) {
        errors.push(`generator.js 不合规: JS 语法错误 (${filePath})，${syntaxError}`);
      }
    } catch (error) {
      errors.push(`generator.js 不合规: 读取失败 (${filePath})，${this.formatError(error)}`);
    }
  }

  private getJavaScriptSyntaxError(source: string): string | null {
    try {
      parseJavaScript(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowHashBang: true,
      });
      return null;
    } catch (error) {
      return this.formatError(error);
    }
  }

  private readDirectoryNames(dirPath: string): string[] {
    try {
      const entries = window['fs'].readDirSync(dirPath) || [];
      return entries
        .map((entry: any) => entry?.name || entry)
        .filter((name: any): name is string => typeof name === 'string' && !!name);
    } catch {
      return [];
    }
  }

  private pathExists(path: string): boolean {
    try {
      return this.electronService.exists(path);
    } catch {
      return false;
    }
  }

  private isDirectory(path: string): boolean {
    try {
      return window['fs'].isDirectory(path);
    } catch {
      return false;
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isPlainObject(value: any): value is Record<string, any> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
}
