import { Inject, Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subscription } from 'rxjs';
import {
  CmdOutput,
  CmdService,
  CrossPlatformCmdService,
  ElectronService,
  LogService,
  PlatformService,
} from '@core/platform/public-api';
import { ProjectService } from '@domain/project/public-api';
import { ConfigService } from '@core/preferences/public-api';
import { CompileValidationService } from './compile-validation.service';
import {
  BUILD_APPLICATION_PORT,
  type BuildActionState,
  type BuildApplicationPort,
} from './ports/build-application.port';
import {
  AilyBuilderOutputLine,
  AilyBuilderOutputLineBuffer,
  AilyBuilderProgressEvent,
  isAilyBuilderProgressLine,
  parseAilyBuilderProgressLine,
  parseLegacyAilyBuilderProgressLine,
} from '../../../utils/aily-builder-progress.utils';
import {
  appendProjectLog,
  ProjectLogLevel,
} from '../../../utils/project-log.utils';

interface DiskCompileOptions {
  projectPath?: string;
  code?: string;
}

interface DiskCompileProgressState {
  percent: number;
  text: string;
  hasStructuredProgress: boolean;
}

interface OneShotCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
  signal: string | null;
}

@Injectable({ providedIn: 'root' })
export class CompileService {
  private cancelled = false;
  private activeSub: Subscription | null = null;
  private activeStreamId: string | null = null;
  private activeCommandCancel: (() => void) | null = null;

  constructor(
    private projectService: ProjectService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private electronService: ElectronService,
    @Inject(BUILD_APPLICATION_PORT)
    private application: BuildApplicationPort,
    private platformService: PlatformService,
    private configService: ConfigService,
    private message: NzMessageService,
    private compileValidationService: CompileValidationService,
    private logService: LogService,
    private translate: TranslateService,
  ) { }

  cancel(): void {
    this.cancelled = true;
    const streamId = this.activeStreamId;
    if (streamId) {
      void this.cmdService.kill(streamId).catch((error) => {
        console.warn('Failed to stop the active build process:', error);
      });
      this.activeStreamId = null;
    }
    // Resolve the current command immediately as cancelled. Merely
    // unsubscribing leaves runCompileFromDisk awaiting a Promise forever.
    this.activeCommandCancel?.();
  }

  async runCompileFromDisk(options: DiskCompileOptions = {}): Promise<{ success: boolean; result: BuildActionState & { fullStdErr?: string } }> {
    const root = (options.projectPath || this.projectService.currentProjectPath || '').trim();
    const packagePath = this.electronService.pathJoin(root, 'package.json');
    const isAilyCodeProject = !!root && this.projectService.isAilyCodeProject(root);

    if (!root) {
      this.message.warning('No project is currently open.');
      return {
        success: false,
        result: { state: 'warn', text: 'No project is currently open; build cannot start.' },
      };
    }

    const source = this.readCompileSource(root, packagePath, isAilyCodeProject, options.code);
    if (source.success === false) {
      this.handleFailNotice(root, this.t('FAILED_TITLE'), source.error, source.error);
      return { success: false, result: { state: 'error', text: source.error } };
    }

    if (!this.application.startBuild()) {
      const state = this.application.currentProcessState;
      let msg = 'System is busy';
      if (state === 'BUILDING') {
        msg = 'Build is already running';
      } else if (state === 'UPLOADING') {
        msg = 'Upload is already running';
      } else if (state === 'INSTALLING') {
        msg = 'Dependency installation is already running';
      }
      this.message.warning(`${msg}; please try again later.`);
      return { success: false, result: { state: 'warn', text: msg } };
    }

    this.cancelled = false;
    const started = Date.now();

    try {
      const boardModule = await this.resolveBoardModule(root);
      if (!boardModule) {
        this.application.finishBuild(false, 'Missing board module');
        const text = 'Cannot resolve board module from the active project.';
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, text);
        return { success: false, result: { state: 'error', text } };
      }

      const boardName = boardModule.replace('@aily-project/board-', '').replace('@aily-project/coder-', '');
      const ailyBuilderPath = window['path'].getAilyBuilderPath();
      const appDataPath = window['path'].getAppDataPath();
      const ailyChildPath = window['path'].getAilyChildPath();
      const tempPath = isAilyCodeProject
        ? this.electronService.pathJoin(root, 'sketch')
        : this.electronService.pathJoin(root, '.temp');

      if (!ailyBuilderPath || !ailyChildPath) {
        this.application.finishBuild(false, 'Missing builder paths');
        const text = 'aily-builder path is unavailable.';
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, text);
        return { success: false, result: { state: 'error', text } };
      }

      const buildTitle = this.buildNoticeTitle(boardName);
      const preparingText = this.t('DEPENDENCY_ANALYSIS_RUNNING');
      this.application.updateNotice({
        title: this.t('PREPARING_TITLE'),
        text: preparingText,
        state: 'doing',
        progress: 0,
        setTimeout: 0,
        stop: () => this.cancel(),
      });
      this.publishBuildLog(root, preparingText, 'stdout', 'doing', buildTitle);

      const buildConfig = {
        currentProjectPath: root,
        boardModule,
        code: source.code,
        appDataPath,
        za7Path: this.platformService.za7,
        ailyBuilderPath,
        devmode: this.configService.data.devmode || false,
        partitionFilePath: isAilyCodeProject
          ? this.electronService.pathJoin(root, 'sketch', 'src', 'partitions.csv')
          : this.electronService.pathJoin(root, 'partitions.csv'),
      };
      const configFilePath = this.electronService.pathJoin(tempPath, 'build-config.json');
      if (!window['path'].isExists(tempPath)) {
        await this.crossPlatformCmdService.createDirectory(tempPath, true);
      }
      window['fs'].writeFileSync(configFilePath, JSON.stringify(buildConfig, null, 2));

      // 每次构建都进入预处理：该阶段会校验本地库内容指纹，内容未变时再安全复用库缓存。
      const preprocessScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'preprocess.js');
      const preprocessCmd = `node "${preprocessScriptPath}" "${configFilePath}"`;
      const pre = await this.runOneShotCommand(preprocessCmd, (line) => {
        this.publishBuildLog(root, line.line, line.type);
      });
      if (this.cancelled) {
        this.application.finishBuild(false, 'Cancelled');
        const sec = ((Date.now() - started) / 1000).toFixed(2);
        const text = this.t('CANCELLED_WITH_TIME', { seconds: sec });
        this.publishBuildLog(root, text, 'stdout', 'warn', this.t('CANCELLED_TITLE'));
        this.updateCancelledNotice(text);
        return { success: false, result: { state: 'warn', text } };
      }
      if (pre.exitCode !== 0) {
        const detail = pre.combined || pre.stderr + pre.stdout;
        this.application.finishBuild(false, 'Preprocess failed');
        this.handleFailNotice(
          root,
          this.t('PRECOMPILE_FAILED_TITLE'),
          this.t('PRECOMPILE_FAILED_DETAIL'),
          detail,
        );
        return {
          success: false,
          result: {
            state: 'error',
            text: this.t('MESSAGE_WITH_DURATION', {
              message: this.t('PRECOMPILE_FAILED_TITLE'),
              seconds: ((Date.now() - started) / 1000).toFixed(2),
            }),
            fullStdErr: detail,
          },
        };
      }

      const compileScriptPath = this.electronService.pathJoin(ailyChildPath, 'scripts', 'compile.js');
      const compileCmd = `node "${compileScriptPath}" "${configFilePath}"`;
      const progressState: DiskCompileProgressState = {
        percent: 0,
        text: this.t('FAST_BUILD_HINT'),
        hasStructuredProgress: false,
      };
      this.application.updateNotice({
        title: buildTitle,
        text: progressState.text,
        state: 'doing',
        progress: 0,
        setTimeout: 0,
        stop: () => this.cancel(),
      });
      const cmp = await this.runOneShotCommand(compileCmd, (line) => {
        if (this.consumeBuildProgressLine(line.line, boardName, progressState)) {
          return;
        }
        this.publishBuildLog(root, line.line, line.type);
      });
      const buildDuration = ((Date.now() - started) / 1000).toFixed(2);

      if (this.cancelled) {
        this.application.finishBuild(false, 'Cancelled');
        const text = this.t('CANCELLED_WITH_TIME', { seconds: buildDuration });
        this.publishBuildLog(root, text, 'stdout', 'warn', this.t('CANCELLED_TITLE'));
        this.updateCancelledNotice(text);
        return { success: false, result: { state: 'warn', text } };
      }

      if (cmp.exitCode !== 0) {
        const detail = cmp.combined || cmp.stderr + cmp.stdout;
        this.application.finishBuild(false, 'Compile failed');
        const text = this.t('FAILED_WITH_TIME', { seconds: buildDuration });
        this.handleFailNotice(root, this.t('FAILED_TITLE'), text, detail);
        return {
          success: false,
          result: { state: 'error', text, fullStdErr: detail },
        };
      }

      this.compileValidationService.triggerAfterSuccessfulCompile();
      this.application.finishBuild(true);
      const completeText = this.t('COMPLETE_WITH_TIME', { seconds: buildDuration });
      this.application.updateNotice({
        title: this.t('COMPLETE_TITLE'),
        text: completeText,
        state: 'done',
        setTimeout: 600000,
      });
      this.publishBuildLog(root, completeText, 'stdout', 'done', this.t('COMPLETE_TITLE'));

      return { success: true, result: { state: 'done', text: completeText } };
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.application.finishBuild(false, msg);
      this.message.error(msg);
      this.handleFailNotice(root, this.t('FAILED_TITLE'), msg, msg);
      return { success: false, result: { state: 'error', text: msg, fullStdErr: msg } };
    }
  }

  private readCompileSource(
    projectPath: string,
    packagePath: string,
    isAilyCodeProject: boolean,
    explicitCode?: string,
  ): { success: true; code: string } | { success: false; error: string } {
    if (explicitCode) {
      return { success: true, code: explicitCode };
    }

    try {
      if (isAilyCodeProject) {
        const manifest = JSON.parse(window['fs'].readFileSync(packagePath, 'utf8'));
        const entryRel = typeof manifest.entry === 'string' && manifest.entry.trim()
          ? manifest.entry.replace(/\\/g, '/')
          : 'src/main.cpp';
        const segments = entryRel.split('/').filter(Boolean);
        if (
          entryRel.startsWith('/')
          || /^[A-Za-z]:\//.test(entryRel)
          || segments.some(segment => segment === '..')
        ) {
          return { success: false, error: `Invalid Coder entry outside sketch workspace: ${entryRel}` };
        }
        const sourcePath = this.electronService.pathJoin(projectPath, 'sketch', ...segments);
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

  private async resolveBoardModule(projectPath: string): Promise<string | null> {
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

    return projectPath === this.projectService.currentProjectPath
      ? this.projectService.getBoardModule()
      : null;
  }

  private t(key: string, params?: Record<string, unknown>): string {
    return this.translate.instant(`BLOCKLY_EDITOR.BUILD.${key}`, params);
  }

  private buildNoticeTitle(boardName: string): string {
    return this.t('RUNNING_TITLE', { board: boardName });
  }

  private buildProgressText(progress: AilyBuilderProgressEvent): string {
    const translationKey = `BLOCKLY_EDITOR.BUILD.PROGRESS_${progress.stage.toUpperCase()}`;
    const translated = this.translate.instant(translationKey);
    return translated === translationKey ? progress.message : translated;
  }

  /**
   * Consume the same aily-builder progress contract used by Blockly builds.
   * Structured protocol lines are UI events and must not leak into the log.
   */
  private consumeBuildProgressLine(
    line: string,
    boardName: string,
    state: DiskCompileProgressState,
  ): boolean {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return true;
    }

    if (isAilyBuilderProgressLine(trimmedLine)) {
      const progress = parseAilyBuilderProgressLine(trimmedLine);
      if (!progress) {
        return false;
      }
      state.hasStructuredProgress = true;
      state.percent = Math.max(state.percent, progress.percent);
      state.text = this.buildProgressText(progress);
      this.updateBuildProgress(boardName, state);
      return true;
    }

    if (trimmedLine.startsWith('BuildText:')) {
      state.text = trimmedLine.slice('BuildText:'.length).trim() || state.text;
    }

    // Compatibility with aily-builder <= 1.2.10. Once a structured event is
    // observed, raw Ninja counters are stage-local and no longer drive global
    // progress.
    if (!state.hasStructuredProgress) {
      const legacyPercent = parseLegacyAilyBuilderProgressLine(trimmedLine);
      if (legacyPercent !== null && legacyPercent > state.percent) {
        state.percent = legacyPercent;
        this.updateBuildProgress(boardName, state);
      }
    }

    return false;
  }

  private updateBuildProgress(
    boardName: string,
    state: DiskCompileProgressState,
  ): void {
    if (this.cancelled) {
      return;
    }
    this.application.updateNotice({
      title: this.buildNoticeTitle(boardName),
      text: state.text,
      state: 'doing',
      progress: state.percent,
      setTimeout: 0,
      stop: () => this.cancel(),
    });
  }

  private publishBuildLog(
    projectPath: string,
    line: string,
    outputType: 'stdout' | 'stderr',
    state = 'doing',
    title?: string,
  ): void {
    const detail = String(line || '').trim();
    if (!detail) {
      return;
    }
    const isError = outputType === 'stderr' && /(?:\[ERROR\]|\berror:|\bfatal:)/i.test(detail);
    const logState = isError ? 'error' : state;
    this.logService.update({ title, detail, state: logState });
    const level: ProjectLogLevel = isError
      ? 'ERROR'
      : logState === 'done' || logState === 'warn'
        ? 'INFO'
        : 'DEBUG';
    appendProjectLog(projectPath, 'compile', level, detail);
  }

  private updateCancelledNotice(text: string): void {
    this.application.updateNotice({
      title: this.t('CANCELLED_TITLE'),
      text,
      state: 'warn',
      setTimeout: 55000,
      isCancellationNotice: true,
    });
  }

  private handleFailNotice(
    projectPath: string,
    title: string,
    text: string,
    detail: string,
  ): void {
    const clean = (detail || '').replace(/\[\d+(;\d+)*m/g, '').trim().slice(0, 8000);
    appendProjectLog(projectPath, 'compile', 'ERROR', text || clean || '(no logs)');
    this.application.updateNotice({
      title,
      text,
      state: 'error',
      detail: clean || '(no logs)',
      setTimeout: 600000,
      sendToLog: true,
    });
  }

  private runOneShotCommand(
    command: string,
    onLine?: (line: AilyBuilderOutputLine) => void,
  ): Promise<OneShotCommandResult> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let combined = '';
      let exitCode = 0;
      let signal: string | null = null;
      let settled = false;
      let sub: Subscription | null = null;
      const lineBuffer = new AilyBuilderOutputLineBuffer();

      const emitLines = (lines: AilyBuilderOutputLine[]) => {
        lines.forEach(line => onLine?.(line));
      };

      const cleanup = (cancelCommand: () => void) => {
        if (this.activeSub === sub) {
          this.activeSub = null;
        }
        if (this.activeCommandCancel === cancelCommand) {
          this.activeCommandCancel = null;
        }
        this.activeStreamId = null;
      };

      const settle = (cancelCommand: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        emitLines(lineBuffer.flush());
        sub?.unsubscribe();
        cleanup(cancelCommand);
        resolve({ exitCode, stdout, stderr, combined, signal });
      };

      const cancelCommand = () => {
        exitCode = 1;
        signal = 'cancelled';
        settle(cancelCommand);
      };

      this.activeCommandCancel = cancelCommand;
      sub = this.cmdService.run(command, null, false).subscribe({
        next: (o: CmdOutput) => {
          if (!this.activeStreamId && o.streamId) {
            this.activeStreamId = o.streamId;
          }
          if (o.type === 'close') {
            exitCode = o.code ?? (o.signal ? 1 : 0);
            signal = o.signal || null;
          }
          if (o.type === 'error') {
            const errorText = String(o.error || '');
            exitCode = 1;
            stderr += errorText;
            combined += errorText;
            if (errorText) {
              emitLines(lineBuffer.append('stderr', `${errorText}\n`));
            }
          }
          if (o.data) {
            if (o.type === 'stderr') {
              stderr += o.data;
              combined += o.data;
              emitLines(lineBuffer.append('stderr', o.data));
            } else {
              stdout += o.data;
              combined += o.data;
              emitLines(lineBuffer.append('stdout', o.data));
            }
          }
        },
        error: (err) => {
          if (settled) {
            return;
          }
          settled = true;
          emitLines(lineBuffer.flush());
          cleanup(cancelCommand);
          reject(err);
        },
        complete: () => {
          settle(cancelCommand);
        },
      });
      this.activeSub = sub;
    });
  }
}
