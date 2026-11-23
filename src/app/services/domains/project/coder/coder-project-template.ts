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

interface CoderTemplateFsApi {
  copySync(source: string, destination: string): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string): string;
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

export function resolveCoderProjectCreationTemplate(
  boardPackagePath: string,
  pathApi: CoderTemplatePathApi,
): { templatePath: string; useDefaultSource: boolean } {
  const coderTemplatePath = resolveCoderTemplatePath(boardPackagePath, pathApi);
  if (pathApi.isExists(coderTemplatePath)) {
    return { templatePath: coderTemplatePath, useDefaultSource: false };
  }
  return {
    templatePath: pathApi.join(boardPackagePath, 'template'),
    useDefaultSource: true,
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
): ReturnType<typeof resolveCoderProjectCreationTemplate> | undefined {
  const version = String(board.version || '').trim();
  if (!valid(version)) return undefined;

  try {
    if (!fsApi.lstatSync(boardPackagePath)._isDirectory) return undefined;
    const manifest = readTemplateManifest(pathApi.join(boardPackagePath, 'package.json'), fsApi);
    if (manifest?.['name'] !== board.name || manifest['version'] !== version) return undefined;
    if (!readTemplateManifest(pathApi.join(boardPackagePath, 'board.json'), fsApi)) return undefined;

    const template = resolveCoderProjectCreationTemplate(boardPackagePath, pathApi);
    if (!fsApi.lstatSync(template.templatePath)._isDirectory) return undefined;
    if (!readTemplateManifest(pathApi.join(template.templatePath, 'package.json'), fsApi)) return undefined;
    if (!template.useDefaultSource) {
      const sourcePath = pathApi.join(template.templatePath, 'project.aci');
      if (!fsApi.lstatSync(sourcePath)._isFile) return undefined;
      fsApi.readFileSync(sourcePath);
    }
    return template;
  } catch {
    return undefined;
  }
}

/**
 * Write the Arduino source at the template's entry, relative to the sketch directory.
 * Dedicated Coder templates supply the source in project.aci. The Blockly fallback
 * supplies the manifest and uses the default Arduino source.
 */
export function copyCoderArduinoTemplate(
  templatePath: string,
  projectPath: string,
  pathApi: CoderTemplatePathApi,
  fsApi: CoderTemplateFsApi,
  options: { useDefaultSource?: boolean } = {},
): string {
  const templatePackagePath = pathApi.join(templatePath, 'package.json');
  const templateSourcePath = pathApi.join(templatePath, 'project.aci');
  if (!pathApi.isExists(templatePackagePath)) {
    throw new Error(`Coder 板卡模板缺少 package.json: ${templatePackagePath}`);
  }
  if (!options.useDefaultSource && !pathApi.isExists(templateSourcePath)) {
    throw new Error(`Coder 板卡模板缺少 project.aci: ${templateSourcePath}`);
  }

  const { entry: declaredEntry = CODER_SOURCE_ENTRY } = JSON.parse(fsApi.readFileSync(templatePackagePath));
  const entry = typeof declaredEntry === 'string' ? declaredEntry.replace(/\\/g, '/') : '';
  const entryParts = entry.split('/');
  if (!/\.(ino|cpp)$/i.test(entry) || /[<>:"|?*\x00-\x1f]/.test(entry)
    || entryParts.some(part => !part || part.trim() !== part || part.endsWith('.'))) {
    throw new Error(`Coder 板卡模板的 entry 必须是 sketch 内的 .ino 或 .cpp 相对路径: ${templatePackagePath}`);
  }

  const sketchRoot = pathApi.join(projectPath, 'sketch');
  const sourcePath = pathApi.join(sketchRoot, ...entryParts);
  fsApi.mkdirSync(pathApi.join(sketchRoot, 'src'), { recursive: true });
  fsApi.mkdirSync(pathApi.join(sketchRoot, 'libraries'), { recursive: true });
  const sourceDirectory = entryParts.slice(0, -1);
  if (sourceDirectory.join('/') !== 'src') {
    fsApi.mkdirSync(pathApi.join(sketchRoot, ...sourceDirectory), { recursive: true });
  }
  fsApi.copySync(templatePackagePath, pathApi.join(projectPath, 'package.json'));
  if (options.useDefaultSource) {
    fsApi.writeFileSync(sourcePath, DEFAULT_CODER_ARDUINO_SOURCE);
  } else {
    fsApi.copySync(templateSourcePath, sourcePath);
  }
  return entry;
}
