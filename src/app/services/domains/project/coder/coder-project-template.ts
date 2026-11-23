import { valid } from 'semver';

export const CODER_TEMPLATE_DIRECTORY = 'template_arduino';
export const LEGACY_CODER_TEMPLATE_DIRECTORY = 'template_arrduino';
export const CODER_SOURCE_ENTRY = 'src/main.cpp';
export const DEFAULT_CODER_ARDUINO_SOURCE = `#include <Arduino.h>

void setup() {
  // put your setup code here, to run once:
}

void loop() {
  // put your main code here, to run repeatedly:
}
`;

export interface CoderProjectPackageManifest {
  type?: string;
  entry?: string;
  devmode?: string;
  framework?: string;
  sourceRoots?: string[];
  dependencies?: Record<string, string>;
  boardDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export function isCoderProjectPackage(manifest: unknown): manifest is CoderProjectPackageManifest {
  return Boolean(manifest)
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && (manifest as CoderProjectPackageManifest).type === 'coder';
}

const CODER_TEMPLATE_LIBRARY = /^@aily-project(?:-coder)?\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Only an explicit project receipt proves that a dependency was injected by its board template. */
export function readCoderBoardTemplateDependencies(
  manifest: CoderProjectPackageManifest | undefined,
  boardPackageName: string | undefined,
): Record<string, string> {
  if (!isCoderProjectPackage(manifest) || !boardPackageName || !manifest.dependencies?.[boardPackageName]) return {};
  const receipt = manifest['coderBoardTemplateDependencies'] as {
    schemaVersion?: unknown; boardPackageName?: unknown; dependencies?: unknown;
  } | undefined;
  if (receipt?.schemaVersion !== 1 || receipt.boardPackageName !== boardPackageName
    || !receipt.dependencies || typeof receipt.dependencies !== 'object' || Array.isArray(receipt.dependencies)) return {};
  return Object.fromEntries(Object.entries(receipt.dependencies)
    .filter(([name, range]) => CODER_TEMPLATE_LIBRARY.test(name) && typeof range === 'string' && range.trim()));
}

/** Never claim an existing user dependency, even when the new template requests the same version. */
export function recordCoderBoardTemplateDependencies(
  manifest: CoderProjectPackageManifest,
  boardPackageName: string,
  templateDependencies: Record<string, string>,
  preservedDependencies: Record<string, string> = {},
): void {
  manifest['coderBoardTemplateDependencies'] = {
    schemaVersion: 1,
    boardPackageName,
    dependencies: Object.fromEntries(Object.entries(templateDependencies)
      .filter(([name, range]) => CODER_TEMPLATE_LIBRARY.test(name) && typeof range === 'string' && range.trim()
        && !Object.prototype.hasOwnProperty.call(preservedDependencies, name))),
  };
}

export function applyCoderProjectPackageConfig(
  manifest: CoderProjectPackageManifest,
  boardPackageName: string,
  boardRange: string,
  currentManifest?: CoderProjectPackageManifest,
): void {
  const currentEntry = typeof currentManifest?.entry === 'string' && currentManifest.entry.trim()
    ? currentManifest.entry.replace(/\\/g, '/')
    : CODER_SOURCE_ENTRY;
  manifest.type = 'coder';
  manifest.entry = currentEntry;
  manifest.devmode = 'arduino';
  manifest.framework = 'arduino';
  manifest.sourceRoots = ['src', 'libraries'];
  if (currentManifest?.['arduinoSketch'] === true) {
    manifest['arduinoSketch'] = true;
    manifest.sourceRoots = ['.', 'src', 'sketch/libraries'];
  }
  manifest.dependencies = {
    ...(manifest.dependencies || {}),
    [boardPackageName]: boardRange,
  };
  manifest.boardDependencies = {
    ...(manifest.boardDependencies || {}),
    [boardPackageName]: boardRange,
  };
}

interface CoderTemplatePathApi {
  join(...parts: string[]): string;
  isExists(path: string): boolean;
}

interface CoderTemplateFsApi extends CoderTemplateReadApi {
  copyCoderTemplateDirectory(source: string, destination: string): void;
  copySync(source: string, destination: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  writeFileSync(path: string, content: string): void;
}

/**
 * Prefer the correctly named Arduino template while retaining compatibility with
 * board packages published with the historical `template_arrduino` typo.
 */
export function resolveCoderTemplatePath(
  boardPackagePath: string,
  pathApi: CoderTemplatePathApi,
): string {
  const canonicalPath = pathApi.join(boardPackagePath, CODER_TEMPLATE_DIRECTORY);
  if (pathApi.isExists(canonicalPath)) {
    return canonicalPath;
  }

  const legacyPath = pathApi.join(boardPackagePath, LEGACY_CODER_TEMPLATE_DIRECTORY);
  return pathApi.isExists(legacyPath) ? legacyPath : canonicalPath;
}

interface CoderProjectCreationTemplate {
  packagePath: string;
  sourceDirectory?: string;
}

export function resolveCoderProjectCreationTemplate(
  boardPackagePath: string,
  pathApi: CoderTemplatePathApi,
): CoderProjectCreationTemplate {
  const coderTemplatePath = resolveCoderTemplatePath(boardPackagePath, pathApi);
  const coderPackagePath = pathApi.join(coderTemplatePath, 'package.json');
  return {
    packagePath: pathApi.isExists(coderPackagePath)
      ? coderPackagePath
      : pathApi.join(boardPackagePath, 'template', 'package.json'),
    sourceDirectory: pathApi.isExists(coderTemplatePath) ? coderTemplatePath : undefined,
  };
}

interface CoderTemplateReadApi {
  lstatSync(path: string): { _isDirectory: boolean; _isFile: boolean };
  readFileSync(path: string): string;
}

function readTemplateManifest(path: string, fsApi: CoderTemplateReadApi): CoderProjectPackageManifest | undefined {
  if (!fsApi.lstatSync(path)._isFile) return undefined;
  const manifest = JSON.parse(fsApi.readFileSync(path));
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : undefined;
}

export function findReusableCoderBoardTemplate(
  boardPackagePath: string,
  board: { name: string; version: string },
  pathApi: CoderTemplatePathApi,
  fsApi: CoderTemplateReadApi,
): CoderProjectCreationTemplate | undefined {
  const version = String(board.version || '').trim();
  if (!valid(version)) return undefined;

  try {
    if (!fsApi.lstatSync(boardPackagePath)._isDirectory) return undefined;
    const manifest = readTemplateManifest(pathApi.join(boardPackagePath, 'package.json'), fsApi);
    if (manifest?.['name'] !== board.name || manifest['version'] !== version) return undefined;
    if (!readTemplateManifest(pathApi.join(boardPackagePath, 'board.json'), fsApi)) return undefined;

    const template = resolveCoderProjectCreationTemplate(boardPackagePath, pathApi);
    if (template.sourceDirectory && !fsApi.lstatSync(template.sourceDirectory)._isDirectory) return undefined;
    if (!readTemplateManifest(template.packagePath, fsApi)) return undefined;
    return template;
  } catch {
    return undefined;
  }
}

/**
 * Copy the dedicated template, then fill in any missing Arduino entry source.
 * Older board packages may still supply the entry's contents in project.aci.
 */
export function copyCoderArduinoTemplate(
  template: CoderProjectCreationTemplate,
  projectPath: string,
  pathApi: CoderTemplatePathApi,
  fsApi: CoderTemplateFsApi,
): string {
  const manifest = pathApi.isExists(template.packagePath) && readTemplateManifest(template.packagePath, fsApi);
  if (!manifest) {
    throw new Error(`Coder 板卡模板缺少有效的 package.json: ${template.packagePath}`);
  }

  const { entry: declaredEntry = CODER_SOURCE_ENTRY } = manifest;
  const entry = typeof declaredEntry === 'string' ? declaredEntry.replace(/\\/g, '/') : '';
  const entryParts = entry.split('/');
  if (!/\.(ino|cpp)$/i.test(entry) || /[<>:"|?*\x00-\x1f]/.test(entry)
    || entryParts.some(part => !part || part.trim() !== part || part.endsWith('.'))) {
    throw new Error(`Coder 板卡模板的 entry 必须是工程源码目录内的 .ino 或 .cpp 相对路径: ${template.packagePath}`);
  }

  if (template.sourceDirectory) {
    if (typeof fsApi.copyCoderTemplateDirectory !== 'function') {
      throw new Error('Coder 板卡模板复制需要更新后的 Electron 宿主，请完整重启应用');
    }
    fsApi.copyCoderTemplateDirectory(template.sourceDirectory, projectPath);
  }

  const sketchRoot = pathApi.join(projectPath, 'sketch');
  const sourceRoot = manifest['arduinoSketch'] === true ? projectPath : sketchRoot;
  const sourcePath = pathApi.join(sourceRoot, ...entryParts);
  fsApi.mkdirSync(pathApi.join(sketchRoot, 'libraries'), { recursive: true });
  fsApi.writeFileSync(pathApi.join(projectPath, 'package.json'), JSON.stringify(manifest, null, 2));
  if (pathApi.isExists(sourcePath)) {
    if (!fsApi.lstatSync(sourcePath)._isFile) {
      throw new Error(`Coder 板卡模板的编译入口必须是文件: ${entry}`);
    }
    return entry;
  }

  const sourceDirectory = entryParts.slice(0, -1);
  if (sourceDirectory.length) {
    fsApi.mkdirSync(pathApi.join(sourceRoot, ...sourceDirectory), { recursive: true });
  }
  const legacySource = template.sourceDirectory && pathApi.join(template.sourceDirectory, 'project.aci');
  if (legacySource && pathApi.isExists(legacySource)) {
    if (!fsApi.lstatSync(legacySource)._isFile) {
      throw new Error(`Coder 板卡模板的 project.aci 必须是文件: ${legacySource}`);
    }
    fsApi.copySync(legacySource, sourcePath);
  } else {
    fsApi.writeFileSync(sourcePath, DEFAULT_CODER_ARDUINO_SOURCE);
  }
  return entry;
}
