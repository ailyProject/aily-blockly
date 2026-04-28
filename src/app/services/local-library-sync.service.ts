import { Injectable } from '@angular/core';
import { CrossPlatformCmdService } from './cross-platform-cmd.service';
import { ElectronService } from './electron.service';

/** 项目 package.json 中记录「包名 → 本机原库目录」的字段名 */
export const AILY_LOCAL_LIBRARY_SOURCES_KEY = 'ailyLocalLibrarySources';

const POLL_MS = 2500;
const SYNC_DEBOUNCE_MS = 400;

@Injectable({
  providedIn: 'root',
})
export class LocalLibrarySyncService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private projectPath: string | null = null;
  private fingerprints = new Map<string, string>();
  private syncing = new Set<string>();
  private pendingSync = new Set<string>();

  constructor(
    private electronService: ElectronService,
    private crossPlatformCmdService: CrossPlatformCmdService,
  ) {}

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.projectPath = null;
    this.fingerprints.clear();
    this.syncing.clear();
    this.pendingSync.clear();
  }

  /**
   * 在项目加载后调用：先比对原库与副本指纹，不一致则覆盖副本；再轮询原库变化。不自动刷新 Blockly。
   */
  start(projectPath: string): void {
    this.stop();
    if (!projectPath || !this.electronService.exists(projectPath)) {
      return;
    }

    const pkgPath = this.electronService.pathJoin(projectPath, 'package.json');
    if (!this.electronService.exists(pkgPath)) {
      return;
    }

    let mapping: Record<string, string>;
    try {
      const pkg = JSON.parse(this.electronService.readFile(pkgPath));
      mapping = pkg[AILY_LOCAL_LIBRARY_SOURCES_KEY];
    } catch {
      return;
    }

    if (!mapping || typeof mapping !== 'object') {
      return;
    }

    const entries = Object.entries(mapping).filter(
      ([name, src]) =>
        typeof name === 'string' &&
        name.startsWith('@aily-project/lib-') &&
        typeof src === 'string' &&
        src.length > 0,
    );

    if (entries.length === 0) {
      return;
    }

    this.projectPath = projectPath;

    // 异步：先比对原库与 local-libraries 副本，不一致则覆盖（解决关项目期间原库已改、重开未同步的问题）
    void this.runInitialSyncThenPoll(entries, projectPath);
  }

  /**
   * 打开项目时：无副本则从原库复制；有副本则指纹不一致时覆盖。完成后启动轮询。
   */
  private async runInitialSyncThenPoll(entries: [string, string][], projectPath: string): Promise<void> {
    for (const [packageName, sourcePath] of entries) {
      if (this.projectPath !== projectPath) {
        return;
      }
      if (!this.electronService.exists(sourcePath)) {
        continue;
      }
      const destPath = this.resolveImportedLibraryPath(projectPath, packageName);
      if (!this.electronService.exists(destPath)) {
        await this.syncOne(packageName, sourcePath);
        continue;
      }
      const fpSrc = this.dirFingerprint(sourcePath);
      const fpDest = this.dirFingerprint(destPath);
      if (fpSrc !== fpDest) {
        await this.syncOne(packageName, sourcePath);
      } else {
        this.fingerprints.set(packageName, fpSrc);
      }
    }

    if (this.projectPath !== projectPath) {
      return;
    }
    this.pollTimer = setInterval(() => this.poll(entries), POLL_MS);
  }

  private resolveImportedLibraryPath(projectPath: string, packageName: string): string {
    return this.electronService.pathJoin(projectPath, 'local-libraries', ...packageName.split('/'));
  }

  private poll(entries: [string, string][]): void {
    if (!this.projectPath) {
      return;
    }

    for (const [packageName, sourcePath] of entries) {
      if (this.syncing.has(packageName)) {
        continue;
      }
      if (!this.electronService.exists(sourcePath)) {
        continue;
      }
      const next = this.dirFingerprint(sourcePath);
      const prev = this.fingerprints.get(packageName);
      if (prev === undefined) {
        this.fingerprints.set(packageName, next);
        continue;
      }
      if (next !== prev) {
        this.fingerprints.set(packageName, next);
        this.pendingSync.add(packageName);
      }
    }

    if (this.pendingSync.size === 0) {
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      const toRun = Array.from(this.pendingSync);
      this.pendingSync.clear();
      this.debounceTimer = null;
      for (const packageName of toRun) {
        const entry = entries.find(([n]) => n === packageName);
        if (entry) {
          void this.syncOne(entry[0], entry[1]);
        }
      }
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncOne(packageName: string, sourcePath: string): Promise<void> {
    const projectPath = this.projectPath;
    if (!projectPath || this.syncing.has(packageName)) {
      return;
    }
    if (!this.electronService.exists(sourcePath)) {
      return;
    }

    this.syncing.add(packageName);
    try {
      const destPath = this.resolveImportedLibraryPath(projectPath, packageName);
      if (this.electronService.exists(destPath)) {
        await this.crossPlatformCmdService.removeItem(destPath, true, true);
      }
      const parent = this.electronService.pathJoin(destPath, '..');
      await this.crossPlatformCmdService.createDirectory(parent, true);
      await this.crossPlatformCmdService.copyItem(sourcePath, destPath, true, true);
      if (this.electronService.exists(sourcePath)) {
        this.fingerprints.set(packageName, this.dirFingerprint(sourcePath));
      }
    } catch (e) {
      console.error('[LocalLibrarySync] sync failed', packageName, e);
    } finally {
      this.syncing.delete(packageName);
    }
  }

  /** 目录内容指纹：相对路径 + 大小 + mtime，跳过 node_modules / .git */
  private dirFingerprint(root: string): string {
    const fs = window['fs'];
    const path = window['path'];
    const parts: string[] = [];
    const skip = new Set(['node_modules', '.git']);

    const walk = (dir: string, rel: string) => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      names.sort();
      for (const name of names) {
        if (skip.has(name)) {
          continue;
        }
        const full = path.join(dir, name);
        const r = rel ? path.join(rel, name) : name;
        let st: { size: number; mtime: string; _isDirectory?: boolean };
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st._isDirectory) {
          walk(full, r);
        } else {
          parts.push(`${r}:${st.size}:${st.mtime}`);
        }
      }
    };

    walk(root, '');
    return parts.join('\n');
  }
}
