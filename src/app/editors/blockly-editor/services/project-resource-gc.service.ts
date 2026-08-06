const MANIFEST_DIRECTORY = '.aily';
const MANIFEST_FILE_NAME = 'project-resource-manifest.json';
const LEGACY_AUDIO_MANIFEST_PARTS = ['audio', '.field-audio-manifest.json'];
const LEGACY_AUDIO_PATH_PATTERN = /^audio\/[a-f0-9]{32}\.mp3$/i;
const PROTECTED_ROOTS = new Set(['.aily', '.git', 'node_modules']);
const RESOURCE_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

export interface ManagedProjectResource {
  kind: string;
  path: string;
}

interface ProjectResourceManifest {
  schemaVersion: 1;
  resources: ManagedProjectResource[];
}

interface LoadedManifest {
  corrupted: boolean;
  legacyManifestPaths: string[];
  resources: Map<string, ManagedProjectResource>;
}

export interface ProjectResourceCleanupResult {
  deleted: ManagedProjectResource[];
  retained: ManagedProjectResource[];
}

/**
 * Tracks generated project files and removes them only when a fully persisted
 * project document no longer contains their project-relative paths.
 */
export class ProjectResourceGcService {
  registerManagedFile(projectPath: string, resourcePath: string, kind: string): void {
    const normalizedPath = this.normalizeResourcePath(resourcePath);
    const normalizedKind = this.normalizeResourceKind(kind);
    if (!projectPath || !normalizedPath || !normalizedKind) return;

    try {
      const state = this.readManifest(projectPath);
      if (state.corrupted) {
        console.warn('[ProjectResourceGC] Registration skipped because the manifest is corrupted.');
        return;
      }
      state.resources.set(normalizedPath, { kind: normalizedKind, path: normalizedPath });
      if (this.writeManifest(projectPath, state.resources)) {
        this.removeLegacyManifests(state.legacyManifestPaths);
      }
    } catch (error) {
      console.warn('[ProjectResourceGC] Failed to register managed resource:', normalizedPath, error);
    }
  }

  /**
   * This should run only after a saved project has been fully loaded. Deferring
   * cleanup until the next open keeps Blockly undo safe in the editing session
   * where a resource reference was removed.
   */
  cleanupUnreferencedFiles(
    projectPath: string,
    persistedReferenceRoots: unknown,
  ): ProjectResourceCleanupResult {
    const result: ProjectResourceCleanupResult = { deleted: [], retained: [] };
    if (!projectPath) return result;

    const fsApi = (window as any)['fs'];
    if (
      !fsApi
      || typeof fsApi.existsSync !== 'function'
      || typeof fsApi.unlinkSync !== 'function'
    ) {
      return result;
    }

    const state = this.readManifest(projectPath);
    if (state.corrupted) {
      console.warn('[ProjectResourceGC] Cleanup skipped because the manifest is corrupted.');
      return result;
    }
    if (state.resources.size === 0 && state.legacyManifestPaths.length === 0) return result;

    const referencedPaths = this.collectReferencedPaths(persistedReferenceRoots);
    const nextManifest = new Map<string, ManagedProjectResource>();

    for (const resource of state.resources.values()) {
      if (referencedPaths.has(resource.path)) {
        nextManifest.set(resource.path, resource);
        result.retained.push(resource);
        continue;
      }

      const filePath = this.resolveResourceFilePath(projectPath, resource.path);
      if (!filePath) {
        nextManifest.set(resource.path, resource);
        result.retained.push(resource);
        continue;
      }

      try {
        if (fsApi.existsSync(filePath)) fsApi.unlinkSync(filePath);
        result.deleted.push(resource);
      } catch (error) {
        nextManifest.set(resource.path, resource);
        result.retained.push(resource);
        console.warn('[ProjectResourceGC] Failed to remove unreferenced resource:', resource.path, error);
      }
    }

    if (this.writeManifest(projectPath, nextManifest)) {
      this.removeLegacyManifests(state.legacyManifestPaths);
    }
    return result;
  }

  collectReferencedPaths(value: unknown): Set<string> {
    const references = new Set<string>();
    const visited = new WeakSet<object>();
    const pending: unknown[] = [value];

    while (pending.length > 0) {
      const current = pending.pop();
      if (typeof current === 'string') {
        const normalized = this.normalizeResourcePath(current);
        if (normalized) references.add(normalized);
        continue;
      }
      if (!current || typeof current !== 'object' || visited.has(current)) continue;
      visited.add(current);
      pending.push(...(Array.isArray(current)
        ? current
        : Object.values(current as Record<string, unknown>)));
    }

    return references;
  }

  private readManifest(projectPath: string): LoadedManifest {
    const state: LoadedManifest = {
      corrupted: false,
      legacyManifestPaths: [],
      resources: new Map(),
    };
    const fsApi = (window as any)['fs'];
    const pathApi = (window as any)['path'];
    if (!fsApi || !pathApi?.join || typeof fsApi.existsSync !== 'function') return state;

    const manifestPath = this.getManifestPath(projectPath);
    if (fsApi.existsSync(manifestPath) && typeof fsApi.readFileSync === 'function') {
      try {
        const parsed = JSON.parse(fsApi.readFileSync(manifestPath, 'utf8')) as Partial<ProjectResourceManifest>;
        if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.resources)) {
          state.corrupted = true;
        } else {
          for (const entry of parsed.resources) this.addManifestEntry(state.resources, entry);
        }
      } catch (error) {
        state.corrupted = true;
        console.warn('[ProjectResourceGC] Failed to read resource manifest:', error);
      }
    }

    this.readLegacyAudioManifest(projectPath, state);
    return state;
  }

  private readLegacyAudioManifest(projectPath: string, state: LoadedManifest): void {
    const fsApi = (window as any)['fs'];
    const pathApi = (window as any)['path'];
    if (!fsApi || !pathApi?.join || typeof fsApi.existsSync !== 'function') return;

    const legacyPath = pathApi.join(projectPath, ...LEGACY_AUDIO_MANIFEST_PARTS);
    if (!fsApi.existsSync(legacyPath) || typeof fsApi.readFileSync !== 'function') return;

    try {
      const parsed = JSON.parse(fsApi.readFileSync(legacyPath, 'utf8')) as {
        schemaVersion?: unknown;
        files?: unknown;
      };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) return;
      for (const value of parsed.files) {
        const normalized = this.normalizeResourcePath(value);
        if (!normalized || !LEGACY_AUDIO_PATH_PATTERN.test(normalized)) continue;
        state.resources.set(normalized, { kind: 'field-audio-output', path: normalized });
      }
      state.legacyManifestPaths.push(legacyPath);
    } catch (error) {
      console.warn('[ProjectResourceGC] Failed to read legacy audio manifest:', error);
    }
  }

  private addManifestEntry(
    resources: Map<string, ManagedProjectResource>,
    value: unknown,
  ): void {
    if (!value || typeof value !== 'object') return;
    const candidate = value as Record<string, unknown>;
    const path = this.normalizeResourcePath(candidate['path']);
    const kind = this.normalizeResourceKind(candidate['kind']);
    if (path && kind) resources.set(path, { kind, path });
  }

  private writeManifest(
    projectPath: string,
    resources: Map<string, ManagedProjectResource>,
  ): boolean {
    const fsApi = (window as any)['fs'];
    const pathApi = (window as any)['path'];
    if (
      !fsApi
      || !pathApi?.join
      || typeof fsApi.existsSync !== 'function'
      || typeof fsApi.mkdirSync !== 'function'
      || typeof fsApi.writeFileSync !== 'function'
    ) {
      return false;
    }

    const manifestPath = this.getManifestPath(projectPath);
    if (resources.size === 0) {
      if (fsApi.existsSync(manifestPath) && typeof fsApi.unlinkSync === 'function') {
        fsApi.unlinkSync(manifestPath);
      }
      return true;
    }

    fsApi.mkdirSync(pathApi.join(projectPath, MANIFEST_DIRECTORY));
    const manifest: ProjectResourceManifest = {
      schemaVersion: 1,
      resources: Array.from(resources.values()).sort((left, right) => (
        left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
      )),
    };
    fsApi.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return true;
  }

  private removeLegacyManifests(manifestPaths: string[]): void {
    const fsApi = (window as any)['fs'];
    if (!fsApi || typeof fsApi.existsSync !== 'function' || typeof fsApi.unlinkSync !== 'function') return;
    for (const manifestPath of manifestPaths) {
      try {
        if (fsApi.existsSync(manifestPath)) fsApi.unlinkSync(manifestPath);
      } catch (error) {
        console.warn('[ProjectResourceGC] Failed to remove legacy manifest:', manifestPath, error);
      }
    }
  }

  private resolveResourceFilePath(projectPath: string, resourcePath: string): string | null {
    const pathApi = (window as any)['path'];
    if (!pathApi?.join || !pathApi?.resolve || !pathApi?.relative) return null;
    const normalized = this.normalizeResourcePath(resourcePath);
    if (!normalized) return null;

    const projectRoot = pathApi.resolve(projectPath);
    const resolved = pathApi.resolve(pathApi.join(projectPath, ...normalized.split('/')));
    const relative = pathApi.relative(projectRoot, resolved);
    if (relative.startsWith('..') || (typeof pathApi.isAbsolute === 'function' && pathApi.isAbsolute(relative))) {
      return null;
    }
    return resolved;
  }

  private normalizeResourcePath(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      !normalized
      || normalized.length > 1024
      || normalized.startsWith('/')
      || /^[a-z][a-z0-9+.-]*:/i.test(normalized)
    ) {
      return null;
    }

    const segments = normalized.split('/');
    if (
      segments.length < 2
      || PROTECTED_ROOTS.has(segments[0].toLowerCase())
      || segments.some((segment) => !segment || segment === '.' || segment === '..')
    ) {
      return null;
    }
    return segments.join('/');
  }

  private normalizeResourceKind(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return RESOURCE_KIND_PATTERN.test(normalized) ? normalized : null;
  }

  private getManifestPath(projectPath: string): string {
    const pathApi = (window as any)['path'];
    return pathApi.join(projectPath, MANIFEST_DIRECTORY, MANIFEST_FILE_NAME);
  }
}

export const projectResourceGc = new ProjectResourceGcService();
