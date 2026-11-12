import { valid } from 'semver';
import { findCompilerIntegrityProblem } from './compiler-integrity.utils';
import { findToolPayload, platformResourcePaths } from '../../../child/scripts/platform-resource-layout.cjs';

export interface PlatformResourceBases {
  sdkBase: string;
  compilersBase: string;
  toolsBase: string;
}

interface VersionedResource {
  kind: 'sdk' | 'compiler' | 'tool';
  name: string;
  directories: string[];
}

export function versionedPlatformResource(
  packageName: string, version: string, bases: PlatformResourceBases,
): VersionedResource | undefined {
  const match = /^@aily-project\/(sdk|compiler|tool)-([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/.exec(packageName);
  if (!match || !valid(version) || valid(version) !== version) return;
  const [, kind, name] = match;
  // IDF packages share a version directory with other chip payloads. Keep
  // their existing installer until readiness can identify the chip subdirectory.
  if (kind === 'tool' && name.startsWith('idf_')) return;
  const join = (...parts: string[]) => window['path'].join(...parts);
  const base = kind === 'sdk' ? bases.sdkBase : kind === 'compiler' ? bases.compilersBase : bases.toolsBase;
  if (!base) return;
  const entries = kind === 'tool' && window['path'].isExists(base)
    ? window['fs'].readDirSync(base).map(entry => typeof entry === 'string' ? entry : entry.name)
    : [];
  const directories = platformResourcePaths(kind, name, version, entries).map(directory => join(base, ...directory.split('/')));
  return { kind: kind as VersionedResource['kind'], name, directories };
}

export function readyVersionedPlatformResource(
  packageName: string, version: string, resource: VersionedResource,
): string | undefined {
  const fs = window['fs'];
  const paths = window['path'];
  const windows = window['platform']?.isWindows === true;
  const isFile = (filename: string, executable = false): boolean => {
    if (!paths.isExists(filename)) return false;
    try {
      const stat = fs.statSync(filename);
      return stat._isFile && stat.size > 0 && (!executable || windows || (stat.mode & 0o111) !== 0);
    } catch (error: any) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code) || /^(?:ENOENT|ENOTDIR):/.test(String(error?.message || ''))) return false;
      throw error;
    }
  };
  return resource.directories.find(directory => {
    if (!paths.isExists(directory)) return false;
    const join = (...parts: string[]) => paths.join(...parts);
    const list = (relative: string): string[] => {
      const target = join(directory, relative);
      if (!paths.isExists(target)) return [];
      try {
        return fs.readDirSync(target).map(entry => typeof entry === 'string' ? entry : entry.name).filter(Boolean);
      } catch (error: any) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code) || /^(?:ENOENT|ENOTDIR):/.test(String(error?.message || ''))) return [];
        throw error;
      }
    };
    if (resource.kind === 'sdk') {
      return ['boards.txt', 'platform.txt'].every(file => isFile(join(directory, file)));
    }
    if (resource.kind === 'compiler') {
      if (findCompilerIntegrityProblem(packageName, directory, fs, join, windows)) return false;
      // Compilers with an unknown layout must not be accepted as empty folders.
      return list('bin').some(name => isFile(join(directory, 'bin', name), true));
    }
    return findToolPayload(resource.name, windows, file => isFile(join(directory, ...file.split('/'))), list).length > 0;
  });
}
