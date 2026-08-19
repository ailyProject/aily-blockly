import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import { CmdOutput, CmdService } from './cmd.service';
import { CrossPlatformCmdService } from './cross-platform-cmd.service';
import { ProjectService } from './project.service';
import { ElectronService } from './electron.service';
import { WorkflowService, ProcessState } from './workflow.service';
import { NoticeService } from './notice.service';
import { PlatformService } from './platform.service';
import { ConfigService } from './config.service';
import { ActionState } from './ui.service';
import { CompileValidationService } from './compile-validation.service';

interface DiskCompileOptions {
  projectPath?: string;
  code?: string;
}

@Injectable({ providedIn: 'root' })
export class CompileService {
  private cancelled = false;
  private activeSub: Subscription | null = null;
  private activeStreamId: string | null = null;

  constructor(
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    private workflowService: WorkflowService,
    private noticeService: NoticeService,
    private platformService: PlatformService,
    private configService: ConfigService,
    private message: NzMessageService,
    private compileValidationService: CompileValidationService,
  ) { }

  cancel(): void {
    this.cancelled = true;
    if (this.activeStreamId) {
      void this.cmdService.kill(this.activeStreamId);
      this.activeStreamId = null;
    }
    if (this.activeSub) {
      this.activeSub.unsubscribe();
      this.activeSub = null;
    }
  }

  async runCompileFromDisk(options: DiskCompileOptions = {}): Promise<{ success: boolean; result: ActionState & { fullStdErr?: string } }> {
    const root = (options.projectPath || this.projectService.currentProjectPath || '').trim();
    const aciPath = this.electronService.pathJoin(root, 'project.aci');
    const isAilyCodeProject = !!root && window['path'].isExists(aciPath);

    if (!root) {
      this.message.warning('No project is currently open.');
      return {
        success: false,
        result: { state: 'warn', text: 'No project is currently open; build cannot start.' },
      };
    }

    const source = this.readCompileSource(root, aciPath, isAilyCodeProject, options.code);
    if (source.success === false) {
      return { success: false, result: { state: 'error', text: source.error } };
    }

    if (!this.workflowService.startBuild()) {
      const state = this.workflowService.currentState;
      let msg = 'System is busy';
      if (state === ProcessState.BUILDING) {
        msg = 'Build is already running';
      } else if (state === ProcessState.UPLOADING) {
        msg = 'Upload is already running';
      } else if (state === ProcessState.INSTALLING) {
        msg = 'Dependency installation is already running';
      }
      this.message.warning(`${msg}; please try again later.`);
      return { success: false, result: { state: 'warn', text: msg } };
    }

    this.cancelled = false;
    const started = Date.now();

    try {
      const boardModule = await this.resolveBoardModule(root, isAilyCodeProject ? aciPath : undefined);
      if (!boardModule) {
        this.workflowService.finishBuild(false, 'Missing board module');
        return { success: false, result: { state: 'error', text: 'Cannot resolve board module from the active project.' } };
      }

      const boardName = boardModule.replace('@aily-project/board-', '').replace('@aily-project/coder-', '');
      const ailyBuilderPath = window['path'].getAilyBuilderPath();
      const appDataPath = window['path'].getAppDataPath();
      const ailyChildPath = window['path'].getAilyChildPath();
      const tempPath = this.electronService.pathJoin(root, '.temp');

      if (!ailyBuilderPath || !ailyChildPath) {
        this.workflowService.finishBuild(false, 'Missing builder paths');
        return { success: false, result: { state: 'error', text: 'aily-builder path is unavailable.' } };
      }

      this.noticeService.update({
        title: `Building ${boardName}`,
        text: isAilyCodeProject ? 'Aily Code build' : 'Blockly build',
        state: 'doing',
        progress: 0,
        setTimeout: 0,
        stop: () => this.cancel(),
      });

      const buildConfig = {
        currentProjectPath: root,
        boardModule,
        code: source.code,
        appDataPath,
        za7Path: this.platformService.za7,
        ailyBuilderPath,
        devmode: this.configService.data.devmode || false,
        partitionFilePath: this.electronService.pathJoin(root, 'partitions.csv'),
      };
      const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
      if (!window['path'].isExists(tempPath)) {
        await this.crossPlatformCmdService.createDirectory(tempPath, true);
      }
      window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

      // 每次构建都进入预处理：该阶段会校验本地库内容指纹，内容未变时再安全复用库缓存。
      const preprocessScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'preprocess.js');
      const preprocessCmd = `node "${preprocessScriptPath}" "${configFilePath}"`;
      const pre = await this.runOneShotCommand(preprocessCmd);
      if (this.cancelled) {
        this.workflowService.finishBuild(false, 'Cancelled');
        const sec = ((Date.now() - started) / 1000).toFixed(2);
        return { success: false, result: { state: 'warn', text: `Build cancelled (${sec}s)` } };
      }
      if (pre.exitCode !== 0) {
        const detail = pre.stderr + pre.stdout;
        this.workflowService.finishBuild(false, 'Preprocess failed');
        this.handleFailNotice(detail);
        return {
          success: false,
          result: { state: 'error', text: `Preprocess failed (${((Date.now() - started) / 1000).toFixed(2)}s)`, fullStdErr: detail },
        };
      }

      const compileScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'compile.js');
      const compileCmd = `node "${compileScriptPath}" "${configFilePath}"`;
      const cmp = await this.runOneShotCommand(compileCmd);
      const buildDuration = ((Date.now() - started) / 1000).toFixed(2);

      if (this.cancelled) {
        this.workflowService.finishBuild(false, 'Cancelled');
        return { success: false, result: { state: 'warn', text: `Build cancelled (${buildDuration}s)` } };
      }

      if (cmp.exitCode !== 0) {
        const detail = cmp.stderr + cmp.stdout;
        this.workflowService.finishBuild(false, 'Compile failed');
        this.handleFailNotice(detail);
        return {
          success: false,
          result: { state: 'error', text: `Build failed (${buildDuration}s)`, fullStdErr: detail },
        };
      }

      this.compileValidationService.triggerAfterSuccessfulCompile();
      this.workflowService.finishBuild(true);
      this.noticeService.update({
        title: 'Build completed',
        text: `Build completed (${buildDuration}s)`,
        state: 'done',
        setTimeout: 600000,
      });

      return { success: true, result: { state: 'done', text: `Build completed (${buildDuration}s)` } };
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.workflowService.finishBuild(false, msg);
      this.message.error(msg);
      return { success: false, result: { state: 'error', text: msg, fullStdErr: msg } };
    }
  }

  private readCompileSource(
    projectPath: string,
    aciPath: string,
    isAilyCodeProject: boolean,
    explicitCode?: string,
  ): { success: true; code: string } | { success: false; error: string } {
    if (explicitCode) {
      return { success: true, code: explicitCode };
    }

    try {
      if (isAilyCodeProject) {
        const aci = JSON.parse(window['fs'].readFileSync(aciPath, 'utf8'));
        const entryRel = typeof aci.entry === 'string' && aci.entry.trim()
          ? aci.entry.replace(/\\/g, '/')
          : 'src/main.cpp';
        const segments = entryRel.split('/').filter(Boolean);
        const sourcePath = this.electronService.pathJoin(projectPath, ...segments);
        if (!window['path'].isExists(sourcePath)) {
          return { success: false, error: `Entry file does not exist: ${entryRel}` };
        }
        return { success: true, code: window['fs'].readFileSync(sourcePath, 'utf8') };
      }

      const sketchPath = this.electronService.pathJoin(projectPath, '.temp', 'sketch', 'sketch.ino');
      if (!window['path'].isExists(sketchPath)) {
        return {
          success: false,
          error: 'Missing Blockly generated file .temp/sketch/sketch.ino; sync or generate Blockly code before building.',
        };
      }
      return { success: true, code: window['fs'].readFileSync(sketchPath, 'utf8') };
    } catch (error: any) {
      return { success: false, error: error?.message || 'Failed to read project compile source.' };
    }
  }

  private async resolveBoardModule(projectPath: string, aciPath?: string): Promise<string | null> {
    if (!projectPath) {
      return null;
    }

    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      if (window['path'].isExists(packageJsonPath)) {
        const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
        const dependencyNames = [
          ...Object.keys(packageJson.dependencies || {}),
          ...Object.keys(packageJson.devDependencies || {}),
          ...Object.keys(packageJson.boardDependencies || {}),
        ];
        const boardModule = dependencyNames.find(dep => dep.startsWith('@aily-project/board-'))
          ?? dependencyNames.find(dep => dep.startsWith('@aily-project/coder-'));
        if (boardModule) {
          return boardModule;
        }
      }
    } catch {
      /* fall through to Aily Code project metadata/current project service */
    }

    if (aciPath && window['path'].isExists(aciPath)) {
      try {
        const aci = JSON.parse(window['fs'].readFileSync(aciPath, 'utf8'));
        const boardPackage = String(aci?.target?.boardPackage ?? '').trim();
        if (boardPackage) {
          return boardPackage;
        }
        const board = String(aci?.target?.board ?? '').trim();
        if (board.startsWith('@aily-project/')) {
          return board;
        }
      } catch {
        /* ignore */
      }
    }

    return projectPath === this.projectService.currentProjectPath
      ? this.projectService.getBoardModule()
      : null;
  }

  private handleFailNotice(detail: string): void {
    const clean = (detail || '').replace(/\[\d+(;\d+)*m/g, '').trim().slice(0, 8000);
    this.noticeService.update({
      title: 'Build failed',
      text: 'See logs for details.',
      state: 'error',
      detail: clean || '(no logs)',
      setTimeout: 600000,
      sendToLog: true,
    });
  }

  private runOneShotCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string; signal: string | null }> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let signal: string | null = null;

      const sub = this.cmdService.run(command, null, false).subscribe({
        next: (o: CmdOutput) => {
          if (!this.activeStreamId && o.streamId) {
            this.activeStreamId = o.streamId;
          }
          if (o.type === 'close') {
            exitCode = o.code ?? (o.signal ? 1 : 0);
            signal = o.signal || null;
          }
          if (o.type === 'error') {
            stderr += String(o.error || '');
          }
          if (o.data) {
            if (o.type === 'stderr') {
              stderr += o.data;
            } else {
              stdout += o.data;
            }
          }
        },
        error: (err) => reject(err),
        complete: () => {
          this.activeStreamId = null;
          sub.unsubscribe();
          this.activeSub = null;
          resolve({ exitCode, stdout, stderr, signal });
        },
      });
      this.activeSub = sub;
    });
  }
}
