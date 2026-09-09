import { Injectable } from '@angular/core';
import { ElectronService } from '@core/platform/public-api';

const BUILD_MANIFEST_FIELDS = [
  'type', 'entry', 'framework', 'devmode', 'platform', 'platformVersion',
  'dependencies', 'devDependencies', 'boardDependencies', 'projectConfig', 'macros', 'MACROS',
];
const GENERATED_SKETCH_FILES = new Set([
  'build-config.json', 'upload-config.json', 'preprocess.json', 'library-cache.json',
]);
const CACHE_DIRECTORIES = new Set(['.git', '.aily', '.build', '.temp', 'node_modules']);

@Injectable({ providedIn: 'root' })
export class CoderBuildInfoService {
  constructor(private electronService: ElectronService) {}

  async updateCodeHash(projectPath: string): Promise<string> {
    const codeHash = await this.calculateCodeHash(projectPath);
    const packagePath = this.electronService.pathJoin(projectPath, 'package.json');
    // Read again after hashing so a simultaneous metadata update is preserved.
    const manifest = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
    manifest.codeHash = codeHash;
    window['fs'].writeFileSync(packagePath, JSON.stringify(manifest, null, 2));
    return codeHash;
  }

  async saveBuildInfo(
    projectPath: string,
    compiledHash: string,
    status: 'success' | 'failed' | 'cancelled',
    duration: number,
  ): Promise<void> {
    // The current inputs may have changed while the compiler was running.
    const codeHash = await this.calculateCodeHash(projectPath);
    const packagePath = this.electronService.pathJoin(projectPath, 'package.json');
    const manifest = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
    manifest.codeHash = codeHash;
    manifest.buildInfo = {
      lastBuildTime: new Date().toISOString(),
      lastBuildCode: compiledHash,
      lastBuildStatus: status,
      lastBuildDuration: duration,
    };
    window['fs'].writeFileSync(packagePath, JSON.stringify(manifest, null, 2));
  }

  private async calculateCodeHash(projectPath: string): Promise<string> {
    const packagePath = this.electronService.pathJoin(projectPath, 'package.json');
    const manifest = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
    const buildManifest = Object.fromEntries(
      BUILD_MANIFEST_FIELDS.filter(key => manifest[key] !== undefined)
        .map(key => [key, manifest[key]]),
    );
    const files: [string, string][] = [];
    const collect = (relativePath: string) => {
      const absolutePath = this.electronService.pathJoin(projectPath, 'sketch', relativePath);
      for (const entry of window['fs'].readDirSync(absolutePath)) {
        const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry._isDirectory) {
          if (!CACHE_DIRECTORIES.has(entry.name)) collect(childPath);
        } else if (entry._isFile && (relativePath || !GENERATED_SKETCH_FILES.has(entry.name))) {
          // Base64 preserves binary library inputs as well as text sources.
          files.push([childPath, window['fs'].readFileAsBase64(
            this.electronService.pathJoin(projectPath, 'sketch', childPath),
          )]);
        }
      }
    };
    // Coder's persistent sources and libraries live in sketch/. Legacy .aci
    // projects are migrated into this layout when opened by ProjectService.
    collect('');
    if (manifest.projectConfig?.PartitionScheme === 'custom') {
      const entry = typeof manifest.entry === 'string' && manifest.entry.trim()
        ? manifest.entry.replace(/\\/g, '/') : 'src/main.cpp';
      const partitionPath = [...entry.split('/').filter(segment => segment && segment !== '.').slice(0, -1),
        'partitions.csv'].join('/');
      if (!files.some(([path]) => path === partitionPath)) {
        // preprocess materializes these fallback inputs beside the entry.
        // Hash them at that destination so the first build keeps the same hash.
        const legacyPartitionPath = this.electronService.pathJoin(projectPath, 'partitions.csv');
        const partition = window['fs'].existsSync(legacyPartitionPath)
          ? window['fs'].readFileAsBase64(legacyPartitionPath)
          : files.find(([path]) => path === 'src/partitions.csv')?.[1];
        if (partition !== undefined) files.push([partitionPath, partition]);
      }
    }
    files.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return this.electronService.calculateHash(JSON.stringify({
      manifest: this.sortKeys(buildManifest),
      files,
    }));
  }

  private sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => this.sortKeys(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort()
        .map(key => [key, this.sortKeys(value[key])]));
    }
    return value;
  }
}
