import { Injectable, Injector } from '@angular/core';
import { ProjectService, canonicalProjectJsonStringify } from '@domain/project/public-api';
import { ElectronService } from '@core/platform/public-api';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { getActiveProjectGeneratorRevision } from '../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { _ProjectService as BlocklyEditorProjectService } from '../../editors/blockly-editor/services/project.service';
import { AbsWorkspaceSyncService } from '../blockly/abs/abs-workspace-sync.service';
import { sha256Hex } from '../../utils/crypto.utils';
import type { SavedProjectBuildFileFact } from '../../utils/build-publication.utils';

interface BlocklyBuildSourceState {
  readonly projectPath: string;
  readonly activationId: string;
  readonly mode: 'blockly';
  readonly boardModule: string;
  readonly workspace: {
    readonly scope: 'serialized-blockly-document';
    readonly documentSha256: string;
    readonly revision: number;
    readonly runtimeRevision: number;
    readonly pageId: string;
  };
}

export interface SavedBlocklyBuildSourceBoundary extends BlocklyBuildSourceState {
  readonly workspace: BlocklyBuildSourceState['workspace'] & {
    readonly savedProjectFiles: readonly SavedProjectBuildFileFact[];
  };
}

const SAVED_PROJECT_MAX_BYTES = 128 * 1024 * 1024;

/** First-party, read-only editor query. It never generates/saves code or makes a
 * stale project current on behalf of the caller. The main process owns tickets.
 */
@Injectable({ providedIn: 'root' })
export class BuildSourceQueryService {
  private initialized = false;
  private activationId = crypto.randomUUID();

  constructor(
    private readonly project: ProjectService,
    private readonly electron: ElectronService,
    private readonly injector: Injector,
  ) {}

  initialize(): void {
    if (this.initialized || !window['ipcRenderer']?.on) return;
    this.initialized = true;
    this.project.currentProjectPath$.subscribe(() => { this.activationId = crypto.randomUUID(); });
    this.project.projectActivation$.subscribe(() => { this.activationId = crypto.randomUUID(); });
    window['ipcRenderer'].on('build-source-query', (_event: unknown, request: any) => {
      void this.respond(request);
    });
  }

  private async respond(request: any): Promise<void> {
    const envelope = { requestId: request?.requestId, rendererGeneration: request?.rendererGeneration };
    try {
      if (!request?.requestId || request.rendererGeneration !== this.electron.currentRendererGeneration) throw new Error('Renderer generation changed.');
      const source = await this.read(request.projectPath);
      if (request.rendererGeneration !== this.electron.currentRendererGeneration) throw new Error('Renderer reloaded during source query.');
      window['ipcRenderer'].send('build-source-query:response', { ...envelope, ok: true, source });
    } catch (error) {
      window['ipcRenderer'].send('build-source-query:response', { ...envelope, ok: false,
        message: error instanceof Error ? error.message : String(error) });
    }
  }

  async read(projectPath: string): Promise<unknown> {
    const activationId = this.activationId;
    const assertActive = () => {
      if (!projectPath || !this.project.currentProjectPath || window['path'].relative(projectPath, this.project.currentProjectPath) !== ''
          || activationId !== this.activationId || this.project.isProjectTransitionInProgress(projectPath)) {
        throw new Error('Project switched, reloaded, or is in transition.');
      }
    };
    assertActive();
    const mode = this.project.getProjectMode(projectPath);
    if (mode === 'coder') {
      const boardModule = await this.project.getBoardModule();
      const saved = await this.injector.get(CodeEditorProProjectService).hasSavedProject(projectPath);
      assertActive();
      return { projectPath, activationId, mode, boardModule, saved };
    }
    if (mode !== 'blockly') throw new Error('Unsupported editor mode.');
    // Do not instantiate both editor lifecycles when the root app starts.
    const blockly = this.injector.get(BlocklyService);
    if (!blockly.workspace || blockly.isWorkspaceEditInProgress()) throw new Error('Blockly editor is unavailable or busy.');
    const workspace = blockly.workspace;
    const before = blockly.captureProjectSnapshot();
    const runtimeRevision = getActiveProjectGeneratorRevision(), pageId = blockly.getActivePageId();
    const documentText = canonicalProjectJsonStringify(before.document);
    if (new TextEncoder().encode(documentText).length > 128 * 1024 * 1024) throw new Error('Workspace exceeds source query budget.');
    const documentSha256 = await sha256Hex(documentText);
    assertActive();
    if (workspace !== blockly.workspace || blockly.isWorkspaceEditInProgress() || before.revision !== blockly.captureProjectSnapshot().revision
        || runtimeRevision !== getActiveProjectGeneratorRevision() || pageId !== blockly.getActivePageId()) throw new Error('Workspace changed during source query.');
    return { projectPath, activationId, mode, boardModule: this.project.getRuntimeBoardModule(),
      workspace: { scope: 'serialized-blockly-document', documentSha256, revision: before.revision, runtimeRevision, pageId } };
  }

  /** Portable saved-file facts belong to the normal build producer, not to a
   * Simulator parser. Call before entering the editor's project operation queue:
   * ABS inspection already owns that queue and must not be nested inside it.
   */
  async readSavedProjectBoundary(projectPath: string): Promise<SavedBlocklyBuildSourceBoundary> {
    const before = await this.read(projectPath) as BlocklyBuildSourceState;
    if (before.mode !== 'blockly' || before.workspace?.scope !== 'serialized-blockly-document'
      || !before.boardModule) throw new Error('Saved Blockly build source is unavailable.');
    const project = this.injector.get(BlocklyEditorProjectService);
    if (!project.currentProjectPath || window['path'].relative(projectPath, project.currentProjectPath) !== '') {
      throw new Error('Saved project belongs to a different editor.');
    }
    const files = this.readSavedProjectFiles(projectPath);
    if (await project.hasUnsavedChanges()) throw new Error('Save the current Blockly project before compiling its portable source boundary.');
    const facts: SavedProjectBuildFileFact[] = [];
    for (const file of files) {
      const digest = await window.crypto.subtle.digest('SHA-256', file.bytes);
      facts.push({ path: file.path, sizeBytes: file.bytes.byteLength,
        sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') });
    }
    if (facts.length === 3) {
      const inspection = await this.injector.get(AbsWorkspaceSyncService).inspectGeneration();
      const diagnostics = inspection.diagnostics;
      if (inspection.pending || diagnostics.status !== 'ready'
        || diagnostics.workspace?.changedFromBaseline !== false || diagnostics.workspace.savedChangedFromBaseline !== false
        || !facts.every(file => diagnostics.hashes[file.path === 'project.abi' ? 'abi' : file.path === 'project.abs' ? 'abs' : 'map'] === `sha256:${file.sha256}`)) {
        throw new Error('Reconcile the ABS draft and saved Blockly project before compiling its portable source boundary.');
      }
    }
    const after = await this.read(projectPath) as BlocklyBuildSourceState;
    if (after.mode !== 'blockly' || after.projectPath !== before.projectPath || after.activationId !== before.activationId
      || after.boardModule !== before.boardModule || JSON.stringify(after.workspace) !== JSON.stringify(before.workspace)
      || window['path'].relative(projectPath, project.currentProjectPath) !== '') {
      throw new Error('Blockly project changed during saved source verification.');
    }
    const current = this.readSavedProjectFiles(projectPath);
    if (current.length !== files.length || current.some((file, index) => file.path !== files[index].path
      || file.bytes.byteLength !== files[index].bytes.byteLength || file.bytes.some((byte, offset) => byte !== files[index].bytes[offset]))) {
      throw new Error('Saved project files changed during source verification.');
    }
    return Object.freeze({ ...before, workspace: Object.freeze({ ...before.workspace,
      savedProjectFiles: Object.freeze(facts.map(file => Object.freeze(file))) }) });
  }

  private readSavedProjectFiles(projectPath: string) {
    interface FileState {
      size: number; mtime: string; birthtime: string;
      _isDirectory: boolean; _isFile: boolean; _isSymbolicLink: boolean;
    }
    const files = window['fs'] as {
      existsSync(path: string): boolean;
      lstatSync(path: string): FileState;
      readFileBuffer(path: string): ArrayBuffer;
    };
    if (!files?.existsSync || !files?.lstatSync || !files?.readFileBuffer) throw new Error('Saved project file access is unavailable.');
    const root = files.lstatSync(projectPath);
    if (!root._isDirectory || root._isSymbolicLink) throw new Error('Saved project root must be a non-linked directory.');
    const sameState = (before: FileState, after: FileState) => before.size === after.size
      && before.mtime === after.mtime && before.birthtime === after.birthtime
      && before._isDirectory === after._isDirectory && before._isFile === after._isFile
      && before._isSymbolicLink === after._isSymbolicLink;
    const filename = (relative: string) => window['path'].join(projectPath, relative);
    const hasAbs = files.existsSync(filename('project.abs'));
    if (hasAbs !== files.existsSync(filename('project.abs.map.json'))) throw new Error('Saved ABS source and map must be present together.');
    const names: SavedProjectBuildFileFact['path'][] = ['project.abi', ...(hasAbs ? ['project.abs', 'project.abs.map.json'] as const : [])];
    let total = 0;
    // Check the complete budget before asking the existing bridge to allocate
    // any buffers. readFileSync defaults to UTF-8 text in the preload API.
    const states = names.map(relative => {
      const state = files.lstatSync(filename(relative));
      if (!state._isFile || state._isSymbolicLink || !Number.isSafeInteger(state.size) || state.size < 0
        || (total += state.size) > SAVED_PROJECT_MAX_BYTES) {
        throw new Error('Saved project source exceeds its file/byte boundary.');
      }
      return state;
    });
    const result = names.map((relative, index) => {
      const buffer = files.readFileBuffer(filename(relative));
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== states[index].size
        || !sameState(states[index], files.lstatSync(filename(relative)))) {
        throw new Error('Saved project file changed while reading its source bytes.');
      }
      return { path: relative, bytes: new Uint8Array(buffer) };
    });
    if (!sameState(root, files.lstatSync(projectPath))) throw new Error('Saved project root changed while reading its source bytes.');
    if (names.some((relative, index) => !sameState(states[index], files.lstatSync(filename(relative))))) {
      throw new Error('Saved project file changed while reading its source bytes.');
    }
    return result;
  }
}
