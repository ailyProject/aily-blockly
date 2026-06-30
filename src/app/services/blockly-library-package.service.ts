import { Injectable } from '@angular/core';
import { parse as parseJavaScript } from 'acorn';
import { ElectronService } from './electron.service';

export const AILY_BLOCKLY_LIBRARY_PACKAGE_PREFIX = '@aily-project/lib-';
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

@Injectable({
  providedIn: 'root',
})
export class BlocklyLibraryPackageService {
  constructor(private electronService: ElectronService) { }

  isLibraryPackageName(packageName: string): boolean {
    return typeof packageName === 'string' && packageName.startsWith(AILY_BLOCKLY_LIBRARY_PACKAGE_PREFIX);
  }

  compareLibraryNames(a: string, b: string): number {
    const aIsCore = a.startsWith('@aily-project/lib-core-');
    const bIsCore = b.startsWith('@aily-project/lib-core-');
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
    };
  }

  isPackageReady(projectPath: string, packageName: string): boolean {
    const packagePath = this.getPackagePath(projectPath, packageName);
    return AILY_BLOCKLY_LIBRARY_REQUIRED_FILES.every((fileName) =>
      this.electronService.exists(this.electronService.pathJoin(packagePath, fileName)),
    );
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

    const scopePath = this.electronService.pathJoin(nodeModulesPath, '@aily-project');
    if (this.isDirectory(scopePath)) {
      for (const dirName of this.readDirectoryNames(scopePath)) {
        if (!dirName.startsWith('lib-')) {
          continue;
        }

        const packageName = `@aily-project/${dirName}`;
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
      if (!packageName.startsWith(AILY_BLOCKLY_LIBRARY_PACKAGE_PREFIX)) {
        errors.push(`package.json 不合规: name 必须以 ${AILY_BLOCKLY_LIBRARY_PACKAGE_PREFIX} 开头，当前为 ${packageName} (${filePath})`);
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
