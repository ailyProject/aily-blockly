import { Injectable, Injector } from '@angular/core';
import { ProjectService } from '@domain/project/public-api';
import { ElectronService } from '@core/platform/public-api';
import { BlocklyService } from '../../editors/blockly-editor/services/blockly.service';
import { getActiveProjectGeneratorRevision } from '../../editors/blockly-editor/services/blockly-generator-runtime.service';
import { CodeEditorProProjectService } from '../../editors/code-editor-pro/services/code-editor-pro-project.service';
import { sha256Hex } from '../../utils/crypto.utils';
import { buildSourceStale } from '../../utils/build-request.utils';

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
        message: error instanceof Error ? error.message : String(error),
        ...(error?.code === 'BUILD_SOURCE_STALE' ? { sourceReason: error.sourceReason } : {}) });
    }
  }

  async read(projectPath: string): Promise<unknown> {
    const activationId = this.activationId;
    const assertActive = () => {
      if (!projectPath || !this.project.currentProjectPath || window['path'].relative(projectPath, this.project.currentProjectPath) !== ''
          || activationId !== this.activationId || this.project.isProjectTransitionInProgress(projectPath)) {
        throw buildSourceStale('project', 'Project switched, reloaded, or is in transition.');
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
    const workspace = blockly.workspace;
    const assertWorkspace = () => {
      if (!workspace || workspace !== blockly.workspace) throw buildSourceStale('workspace', 'Blockly workspace is unavailable or replaced.');
      if (blockly.isWorkspaceEditBlocked()) throw buildSourceStale('busy', 'Blockly workspace is unavailable for source verification.');
    };
    const { documentText, revision, runtimeRevision, pageId } = await blockly.readAfterWorkspaceEdit(() => {
      assertActive();
      assertWorkspace();
      return { ...blockly.captureBuildSnapshot(), runtimeRevision: getActiveProjectGeneratorRevision(), pageId: blockly.getActivePageId() };
    });
    if (new TextEncoder().encode(documentText).length > 128 * 1024 * 1024) throw new Error('Workspace exceeds source query budget.');
    const documentSha256 = await sha256Hex(documentText);
    return blockly.readAfterWorkspaceEdit(() => {
      assertActive();
      assertWorkspace();
      if (pageId !== blockly.getActivePageId()) throw buildSourceStale('page', 'Active page changed during source verification.');
      if (runtimeRevision !== getActiveProjectGeneratorRevision()) throw buildSourceStale('generator', 'Generator changed during source verification.');
      if (revision !== blockly.captureBuildSnapshot().revision) throw buildSourceStale('blocks', 'Blockly source changed during source verification.');
      return { projectPath, activationId, mode, boardModule: this.project.getRuntimeBoardModule(),
        workspace: { scope: 'serialized-blockly-document', documentSha256, revision, runtimeRevision, pageId } };
    });
  }
}
