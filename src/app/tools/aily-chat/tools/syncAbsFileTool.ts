/**
 * ABS 文件同步工具
 * 
 * 提供 Blockly 工作区与 project.abs 文件之间的同步操作
 */

import { convertAbiToAbs, convertAbsToAbi, inferFieldVariableType } from './abiAbsConverter';
import { getActiveWorkspace, createBlockFromConfig } from './editBlockTool';
import { AbsAutoSyncService } from '../services/abs-auto-sync.service';
import type { EditingTimelineWriter } from '../services/editing-timeline-recording-bridge';
import { loadProjectBlockDefinitions, parseAbs, BlocklyAbsParser } from './absParser';
import { arduinoGenerator } from '../../../editors/blockly-editor/components/blockly/generators/arduino/arduino';
import {
  yieldToBrowserIdle,
  type BrowserFrameBudgetController,
} from './browserTaskScheduler';
import { ChatPerformanceTracer } from '../services/chat-perf-tracer';
import {
  getSharedBlocklyEditorOperationQueue,
  type BlocklyEditorOperationQueue,
  type BlocklyEditorOperationProgressReporter,
} from './blocklyEditorOperationQueue';
import type { EditorOperationEventSink } from './editorOperationEvents';
import type {
  ChatRuntimeHostResourceRequestKind,
} from '../core/chat-runtime-host-contract';
import { createElectronChatRuntimeHostTransport } from '../core/electron-chat-runtime-host-transport';

declare const Blockly: any;

function shouldLogSyncAbsImportDebug(): boolean {
  try {
    const globalScope = typeof window !== 'undefined'
      ? (window as any)
      : (globalThis as Record<string, unknown>);
    return globalScope.__AILY_DEBUG_BLOCKLY_IMPORT__ === true
      || globalScope.localStorage?.getItem?.('aily.debug.blocklyImport') === '1';
  } catch {
    return false;
  }
}

function describeSyncAbsImportError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debugSyncAbsImportIssue(message: string, error?: unknown): void {
  if (!shouldLogSyncAbsImportDebug()) {
    return;
  }
  if (error === undefined) {
    console.warn(message);
    return;
  }
  console.warn(`${message}: ${describeSyncAbsImportError(error)}`);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

export function runWithBlocklyEventsDisabled<T>(operation: () => T): T {
  Blockly.Events.disable();
  try {
    const result = operation();
    if (isPromiseLike(result)) {
      throw new Error('Blockly.Events.disable() scope must stay synchronous');
    }
    return result;
  } finally {
    Blockly.Events.enable();
  }
}

async function writeGeneratedSketchIno(
  projectPath: string,
  electronService: any,
  workspace: any,
  invocationContext?: SyncAbsInvocationContext,
): Promise<{ filePath: string; generated: boolean }> {
  throwIfSyncAbsCancelled(invocationContext);
  const tempPath = electronService.pathJoin(projectPath, '.temp');
  const sketchPath = electronService.pathJoin(tempPath, 'sketch');
  const sketchFilePath = electronService.pathJoin(sketchPath, 'sketch.ino');

  if (!electronService.exists(tempPath)) {
    window['fs'].mkdirSync(tempPath, { recursive: true });
  }
  if (!electronService.exists(sketchPath)) {
    window['fs'].mkdirSync(sketchPath, { recursive: true });
  }

  await yieldToBrowserIdle(300);
  throwIfSyncAbsCancelled(invocationContext);
  const codegenStartedAt = performance.now();
  const generatedCode = await ChatPerformanceTracer.runWithSurface(
    'builder_preprocess',
    () => arduinoGenerator.workspaceToCode(workspace) || '',
    'syncAbs.import:sketch.ino',
  );
  ChatPerformanceTracer.recordDuration(
    'syncAbs_sketch_codegen',
    performance.now() - codegenStartedAt,
    sketchFilePath,
    { slowThresholdMs: 16 },
  );
  throwIfSyncAbsCancelled(invocationContext);
  await writeTimelineAwareTextFile(sketchFilePath, generatedCode, electronService, invocationContext);

  return {
    filePath: sketchFilePath,
    generated: generatedCode.length > 0
  };
}

// =============================================================================
// 类型定义
// =============================================================================

export interface SyncAbsArgs {
  operation: 'export' | 'import' | 'status';
  includeHeader?: boolean;
  pendingAbsContent?: string;
}

export interface SyncAbsResult {
  is_error: boolean;
  content: string;
  metadata?: {
    operation: string;
    filePath?: string;
    absPreview?: string;
    blockCount?: number;
    variableCount?: number;
    versionSaved?: boolean;
    readBackVerified?: boolean;
    previewSource?: 'disk-readback';
  };
}

export interface SyncAbsInvocationContext {
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  signal?: AbortSignal;
  isStale?: () => boolean;
  timelineWriter?: EditingTimelineWriter;
  editorOperationQueue?: BlocklyEditorOperationQueue;
  progressSink?: EditorOperationEventSink;
  reportOperationProgress?: BlocklyEditorOperationProgressReporter;
  runOutsideAngular?: <T>(operation: () => Promise<T> | T) => Promise<T> | T;
  editorFrameBudget?: BrowserFrameBudgetController;
}

async function checkpointSyncAbsFrameBudget(
  invocationContext: SyncAbsInvocationContext | undefined,
  label: string,
): Promise<void> {
  throwIfSyncAbsCancelled(invocationContext);
  await invocationContext?.editorFrameBudget?.checkpoint(label);
  throwIfSyncAbsCancelled(invocationContext);
}

async function disposeBlocklyBlocksInBatches(
  blocks: readonly any[],
  invocationContext: SyncAbsInvocationContext | undefined,
  label: string,
  batchSize = 3,
): Promise<number> {
  let disposedCount = 0;
  for (const block of blocks) {
    throwIfSyncAbsCancelled(invocationContext);
    runWithBlocklyEventsDisabled(() => {
      block?.dispose?.(true);
      disposedCount++;
    });
    if (disposedCount % batchSize === 0) {
      await checkpointSyncAbsFrameBudget(invocationContext, `${label}.${disposedCount}`);
    }
  }
  if (disposedCount > 0) {
    await checkpointSyncAbsFrameBudget(invocationContext, `${label}.done`);
  }
  return disposedCount;
}

function getWorkspaceRenderRoots(workspace: any): readonly any[] {
  if (workspace && typeof workspace.getTopBlocks === 'function') {
    const topBlocks = workspace.getTopBlocks(false);
    if (Array.isArray(topBlocks)) {
      return topBlocks;
    }
  }

  if (!workspace || typeof workspace.getAllBlocks !== 'function') {
    return [];
  }
  const allBlocks = workspace.getAllBlocks(false);
  if (!Array.isArray(allBlocks)) {
    return [];
  }
  return allBlocks.filter(block => {
    if (!block) {
      return false;
    }
    if (typeof block.getParent === 'function') {
      return !block.getParent();
    }
    if (typeof block.getSurroundParent === 'function') {
      return !block.getSurroundParent();
    }
    return true;
  });
}

async function renderBlocklyRootBlocksInBatches(
  blocks: readonly any[],
  invocationContext: SyncAbsInvocationContext | undefined,
  label: string,
  batchSize = 3,
): Promise<void> {
  let renderedCount = 0;
  for (const block of blocks) {
    throwIfSyncAbsCancelled(invocationContext);
    if (typeof block?.render === 'function') {
      block.render();
      renderedCount++;
    }
    if (renderedCount > 0 && renderedCount % batchSize === 0) {
      await checkpointSyncAbsFrameBudget(invocationContext, `${label}.${renderedCount}`);
    }
  }
  if (renderedCount > 0) {
    await checkpointSyncAbsFrameBudget(invocationContext, `${label}.done`);
  }
}

export async function refreshBlocklyWorkspaceRenderInBatches(
  workspace: any,
  invocationContext: SyncAbsInvocationContext | undefined,
  label: string,
): Promise<void> {
  throwIfSyncAbsCancelled(invocationContext);
  const renderRoots = getWorkspaceRenderRoots(workspace);
  await renderBlocklyRootBlocksInBatches(renderRoots, invocationContext, `${label}.roots`);
  throwIfSyncAbsCancelled(invocationContext);
  if (typeof Blockly !== 'undefined' && Blockly && typeof Blockly.svgResize === 'function') {
    await checkpointSyncAbsFrameBudget(invocationContext, `${label}.before-resize`);
    Blockly.svgResize(workspace);
    await checkpointSyncAbsFrameBudget(invocationContext, `${label}.resize`);
  } else {
    await checkpointSyncAbsFrameBudget(invocationContext, `${label}.no-resize`);
  }
}

export async function writeTimelineAwareTextFile(
  filePath: string,
  content: string,
  electronService: {
    exists(path: string): Promise<boolean> | boolean;
    readFile(path: string): Promise<string> | string;
    writeFile(path: string, data: string): Promise<void> | void;
  },
  invocationContext?: SyncAbsInvocationContext,
): Promise<void> {
  const timelineWriter = invocationContext?.timelineWriter;
  const turnId = invocationContext?.turnId;
  let existedBefore = false;
  let beforeContent: string | null = null;

  if (timelineWriter?.recordFileWrite && turnId) {
    existedBefore = await Promise.resolve(electronService.exists(filePath));
    beforeContent = existedBefore ? await Promise.resolve(electronService.readFile(filePath)) : null;
  }

  await Promise.resolve(electronService.writeFile(filePath, content));

  if (!timelineWriter?.recordFileWrite || !turnId) {
    return;
  }

  try {
    await timelineWriter.recordFileWrite({
      turnId,
      toolCallId: invocationContext?.toolCallId,
      filePath,
      existedBefore,
      beforeContent,
      afterContent: content,
    });
  } catch (error) {
    console.warn('[syncAbsFile] editing timeline recording failed:', error);
  }
}

export async function backupAbiFileIfPresent(
  abiFilePath: string,
  electronService: {
    exists(path: string): Promise<boolean> | boolean;
    readFile(path: string): Promise<string> | string;
    writeFile(path: string, data: string): Promise<void> | void;
  },
  projectService?: {
    currentProjectPath?: string;
    copyPackageJsonToTemp?(projectPath?: string): void;
  },
  invocationContext?: SyncAbsInvocationContext,
): Promise<string | null> {
  if (!await Promise.resolve(electronService.exists(abiFilePath))) {
    return null;
  }

  const backupPath = `${abiFilePath}.backup`;
  const currentAbi = await Promise.resolve(electronService.readFile(abiFilePath));
  await writeTimelineAwareTextFile(backupPath, currentAbi, electronService, invocationContext);
  projectService?.copyPackageJsonToTemp?.(projectService?.currentProjectPath);
  return backupPath;
}

async function reportSyncAbsImportProgress(
  invocationContext: SyncAbsInvocationContext | undefined,
  summary: string,
  progress: number,
  detail?: string,
): Promise<void> {
  try {
    await invocationContext?.reportOperationProgress?.({
      summary,
      progress,
      detail,
    });
  } catch (error) {
    console.warn('[syncAbsFile] operation progress reporting failed:', error);
  }
}

function createSyncAbsCancellationError(): Error {
  const error = new Error('ABS import cancelled');
  error.name = 'AbortError';
  return error;
}

function isSyncAbsStale(invocationContext?: SyncAbsInvocationContext): boolean {
  try {
    return invocationContext?.isStale?.() === true;
  } catch {
    return true;
  }
}

function throwIfSyncAbsCancelled(invocationContext?: SyncAbsInvocationContext): void {
  if (invocationContext?.signal?.aborted || isSyncAbsStale(invocationContext)) {
    throw createSyncAbsCancellationError();
  }
}

function isSyncAbsCancellationError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || /cancelled|canceled|aborted/i.test(error.message));
}

function normalizeSyncAbsSessionId(invocationContext?: SyncAbsInvocationContext): string {
  return typeof invocationContext?.sessionId === 'string'
    ? invocationContext.sessionId.trim()
    : '';
}

function toSyncAbsResourceError(error: unknown): { readonly message: string; readonly code?: string; readonly retryable?: boolean } {
  if (error instanceof Error) {
    return {
      message: error.message || 'syncAbs resource operation failed.',
      retryable: isSyncAbsCancellationError(error) ? false : undefined,
    };
  }
  return {
    message: typeof error === 'string' && error.trim().length > 0
      ? error.trim()
      : 'syncAbs resource operation failed.',
  };
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 对 rootBlocks 进行排序，确保加载顺序正确
 * 
 * 加载顺序：
 * 1. 先加载函数定义块（custom_function_def 等），让 mutator 注册函数到 registry
 * 2. 最后加载 arduino_setup 和 arduino_loop，这时函数调用块能正确获取参数信息
 * 
 * @param rootBlocks 原始 rootBlocks 数组
 * @returns 排序后的 rootBlocks 数组
 */
function sortBlocksForLoading(rootBlocks: any[]): any[] {
  // 需要放到最后加载的块类型
  const loadLastTypes = new Set(['arduino_setup', 'arduino_loop']);
  
  const normalBlocks: any[] = [];
  const lastBlocks: any[] = [];
  
  for (const block of rootBlocks) {
    if (loadLastTypes.has(block.type)) {
      lastBlocks.push(block);
    } else {
      normalBlocks.push(block);
    }
  }
  
  // 返回：先加载普通块（包括函数定义），后加载 setup/loop
  return [...normalBlocks, ...lastBlocks];
}

// =============================================================================
// 工具处理函数
// =============================================================================

/**
 * ABS 文件同步处理
 */
export async function syncAbsFileHandler(
  args: SyncAbsArgs,
  projectService: any,
  electronService: any,
  absAutoSyncService?: AbsAutoSyncService,
  invocationContext?: SyncAbsInvocationContext,
): Promise<SyncAbsResult> {
  const sessionId = normalizeSyncAbsSessionId(invocationContext);
  if (!sessionId) {
    return {
      is_error: true,
      content: 'syncAbs requires a host session id.',
    };
  }

  const runtimeHost = createElectronChatRuntimeHostTransport();
  if (!runtimeHost) {
    return {
      is_error: true,
      content: 'syncAbs requires the Electron runtime host resource operation boundary.',
    };
  }

  const hostOperation = buildSyncAbsHostResourceOperation(args, projectService, sessionId);
  try {
    const result = await runtimeHost.requestResourceOperation(hostOperation);
    return normalizeSyncAbsHostOperationResult(result.result);
  } catch (error: unknown) {
    return {
      is_error: true,
      content: error instanceof Error
        ? error.message
        : String(error),
    };
  }
}

export async function runSyncAbsFileConcreteHandler(
  args: SyncAbsArgs,
  projectService: any,
  electronService: any,
  absAutoSyncService?: AbsAutoSyncService,
  invocationContext?: SyncAbsInvocationContext,
): Promise<SyncAbsResult> {
  const { operation, includeHeader = true } = args;
  
  // 获取项目路径（优先使用当前项目路径，否则使用根路径）
  const projectPath = projectService?.currentProjectPath || projectService?.projectRootPath;
  if (!projectPath) {
    return {
      is_error: true,
      content: '无法获取当前项目路径，请先打开一个项目'
    };
  }
  
  // 加载项目的块定义
  loadProjectBlockDefinitions(projectPath);
  
  const absFilePath = `${projectPath}/project.abs`;
  const abiFilePath = `${projectPath}/project.abi`;
  const resourceBase = {
    projectPath,
    absFilePath,
    abiFilePath,
    toolName: 'syncAbs',
  };
  
  switch (operation) {
    case 'export': {
      const editorOperationQueue = invocationContext?.editorOperationQueue ?? getSharedBlocklyEditorOperationQueue();
      return await editorOperationQueue.enqueue(
        'blockly.syncAbs.export',
        'Export Blockly workspace to ABS',
        () => exportToAbs(abiFilePath, absFilePath, includeHeader, electronService, invocationContext),
        {
          sessionId: invocationContext?.sessionId,
          turnId: invocationContext?.turnId,
          toolCallId: invocationContext?.toolCallId,
          signal: invocationContext?.signal,
          isStale: invocationContext?.isStale,
          progressSink: invocationContext?.progressSink,
          runOutsideAngular: invocationContext?.runOutsideAngular,
        },
      );
    }
    
    case 'import': {
      const editorOperationQueue = invocationContext?.editorOperationQueue ?? getSharedBlocklyEditorOperationQueue();
      return await editorOperationQueue.enqueue(
        'blockly.syncAbs.import',
        'Apply ABS to Blockly workspace',
        (reportOperationProgress, operationContext) => importFromAbs(absFilePath, abiFilePath, electronService, absAutoSyncService, projectService, {
          ...invocationContext,
          reportOperationProgress,
          editorFrameBudget: operationContext.frameBudget,
        },
        args.pendingAbsContent),
        {
          sessionId: invocationContext?.sessionId,
          turnId: invocationContext?.turnId,
          toolCallId: invocationContext?.toolCallId,
          signal: invocationContext?.signal,
          isStale: invocationContext?.isStale,
          progressSink: invocationContext?.progressSink,
          runOutsideAngular: invocationContext?.runOutsideAngular,
          editorFrameBudget: invocationContext?.editorFrameBudget,
        },
      );
    }
    
    case 'status':
      return await getAbsStatus(absFilePath, abiFilePath, electronService);
    
    default:
      return {
        is_error: true,
        content: `未知操作: ${operation}`
      };
  }
}

function buildSyncAbsHostResourceOperation(
  args: SyncAbsArgs,
  projectService: any,
  sessionId: string,
) {
  const projectPath = projectService?.currentProjectPath || projectService?.projectRootPath || '';
  const absFilePath = projectPath ? `${projectPath}/project.abs` : '';
  const abiFilePath = projectPath ? `${projectPath}/project.abi` : '';
  const operation = args.operation;
  const kind: ChatRuntimeHostResourceRequestKind = operation === 'import'
    ? 'workspace-mutation'
    : operation === 'export'
      ? 'file-write'
      : 'file-read';
  const operationKind = `blockly.syncAbs.${operation}`;
  const labels = readSyncAbsResourceLabels(operation);

  return {
    sessionId,
    kind,
    label: labels.startedLabel,
    detail: labels.detail,
    resource: {
      projectPath,
      absFilePath,
      abiFilePath,
      toolName: 'syncAbs',
      operation,
      operationKind,
      ...(operation === 'import'
        ? { hasPendingAbsContent: typeof args.pendingAbsContent === 'string' && args.pendingAbsContent.trim().length > 0 }
        : {}),
    },
    payload: {
      adapter: 'syncAbs',
      args: {
        operation,
        includeHeader: args.includeHeader,
        pendingAbsContent: args.pendingAbsContent,
      },
    },
  } as const;
}

function readSyncAbsResourceLabels(operation: SyncAbsArgs['operation']): {
  readonly startedLabel: string;
  readonly detail: string;
} {
  switch (operation) {
    case 'export':
      return {
        startedLabel: 'Exporting Blockly workspace to ABS',
        detail: 'syncAbs export serializes the Blockly workspace and writes project.abs.',
      };
    case 'import':
      return {
        startedLabel: 'Applying ABS to Blockly workspace',
        detail: 'syncAbs import parses project.abs and mutates the Blockly workspace in frame-budgeted batches.',
      };
    case 'status':
      return {
        startedLabel: 'Reading ABS sync status',
        detail: 'syncAbs status reads project.abs/project.abi availability and metadata.',
      };
  }
}

function normalizeSyncAbsHostOperationResult(result: unknown): SyncAbsResult {
  if (!result || typeof result !== 'object') {
    return {
      is_error: true,
      content: 'syncAbs host resource operation returned an invalid result.',
    };
  }
  const candidate = result as Partial<SyncAbsResult>;
  return {
    is_error: candidate.is_error === true,
    content: typeof candidate.content === 'string' ? candidate.content : '',
    ...(candidate.metadata ? { metadata: candidate.metadata } : {}),
  };
}

/**
 * 导出 Blockly 工作区到 ABS 文件
 */
async function exportToAbs(
  abiFilePath: string,
  absFilePath: string,
  includeHeader: boolean,
  electronService: any,
  invocationContext?: SyncAbsInvocationContext,
): Promise<SyncAbsResult> {
  try {
    throwIfSyncAbsCancelled(invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Reading Blockly workspace', 0.2, abiFilePath);
    // 方法1：从工作区获取
    const workspace = getActiveWorkspace();
    let abiJson: any;
    
    if (workspace) {
      // 直接从工作区序列化
      abiJson = Blockly.serialization.workspaces.save(workspace);
    } else if (await electronService.exists(abiFilePath)) {
      // 方法2：从 ABI 文件读取
      const abiContent = await electronService.readFile(abiFilePath);
      abiJson = JSON.parse(abiContent);
    } else {
      return {
        is_error: true,
        content: '无法获取 Blockly 工作区或 ABI 文件'
      };
    }
    throwIfSyncAbsCancelled(invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Converting Blockly workspace to ABS', 0.5);
    
    // 转换为 ABS 格式
    const absContent = convertAbiToAbs(abiJson, { includeHeader });
    throwIfSyncAbsCancelled(invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Writing ABS file', 0.75, absFilePath);
    
    // 写入 ABS 文件
    await writeTimelineAwareTextFile(absFilePath, absContent, electronService, invocationContext);

    // 写盘后立即回读，确保返回给模型的是磁盘上可观察到的实际内容
    const readBackContent = await electronService.readFile(absFilePath);
    if (readBackContent !== absContent) {
      return {
        is_error: true,
        content: `导出失败: ABS 文件写盘后回读结果与导出内容不一致\n\n文件路径: ${absFilePath}\n这说明导出阶段生成的内存内容与磁盘实际可读取内容未对齐，当前不返回未确认的预览。`
      };
    }
    throwIfSyncAbsCancelled(invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'ABS export finished', 0.95, absFilePath);
    
    // 统计信息
    const blockCount = countBlocks(abiJson);
    const variableCount = abiJson.variables?.length || 0;
    
    // 生成预览（前 30 行）
    const absLines = readBackContent.split('\n');
    const preview = absLines.slice(0, 30).join('\n') + 
      (absLines.length > 30 ? '\n... (more lines)' : '');
    
    return {
      is_error: false,
      content: `✅ 已导出 ABS 文件

**文件路径:** \`${absFilePath}\`
**统计:** ${blockCount} 个块, ${variableCount} 个变量
**写盘确认:** 已通过磁盘回读确认

**ABS 预览:**
\`\`\`
${preview}
\`\`\`

**下一步操作建议:**
1. 使用 \`read_file\` 读取完整的 ABS 文件
2. 使用 \`edit_file\` 修改 ABS 内容
3. 修改完成后使用 \`syncAbs action="import"\` 应用更改`,
      metadata: {
        operation: 'export',
        filePath: absFilePath,
        absPreview: preview,
        blockCount,
        variableCount,
        readBackVerified: true,
        previewSource: 'disk-readback'
      }
    };
  } catch (error) {
    if (isSyncAbsCancellationError(error)) {
      throw error;
    }
    return {
      is_error: true,
      content: `导出失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 从 ABS 文件导入到 Blockly 工作区
 * 使用 createBlockFromConfig 直接创建块，支持动态扩展
 */
async function importFromAbs(
  absFilePath: string,
  abiFilePath: string,
  electronService: any,
  absAutoSyncService?: AbsAutoSyncService,
  projectService?: any,
  invocationContext?: SyncAbsInvocationContext,
  pendingAbsContent?: string,
): Promise<SyncAbsResult> {
  try {
    throwIfSyncAbsCancelled(invocationContext);
    if (typeof pendingAbsContent === 'string' && pendingAbsContent.trim().length > 0) {
      await reportSyncAbsImportProgress(invocationContext, 'Writing pending ABS content', 0.05, absFilePath);
      throwIfSyncAbsCancelled(invocationContext);
      await writeTimelineAwareTextFile(absFilePath, pendingAbsContent, electronService, invocationContext);
      throwIfSyncAbsCancelled(invocationContext);
    }

    // 检查 ABS 文件是否存在
    if (!await electronService.exists(absFilePath)) {
      return {
        is_error: true,
        content: `ABS 文件不存在: ${absFilePath}\n\n请先使用 \`syncAbs action="export"\` 生成 ABS 文件`
      };
    }
    await reportSyncAbsImportProgress(invocationContext, 'Preparing pre-import backup', 0.1, absFilePath);
    throwIfSyncAbsCancelled(invocationContext);

    // 在修改前保存当前版本（AI 修改时的版本控制）
    // 注意：使用 getWorkspaceAbsContent 而不是 exportToAbs，避免覆盖用户编辑的 ABS 文件
    let versionSaved = false;
    if (absAutoSyncService) {
      try {
        // 获取当前工作区内容并保存版本（不写入文件）
        const currentAbs = absAutoSyncService.getWorkspaceAbsContent();
        if (currentAbs) {
          const version = await absAutoSyncService.saveVersion(currentAbs, 'AI 修改前备份');
          versionSaved = !!version;
        }
      } catch (e) {
        console.warn('[syncAbsFile] 保存版本失败:', e);
      }
    }
    await reportSyncAbsImportProgress(invocationContext, 'Reading ABS file', 0.15, absFilePath);
    throwIfSyncAbsCancelled(invocationContext);

    // 读取 ABS 文件
    const absContent = await electronService.readFile(absFilePath);
    await reportSyncAbsImportProgress(invocationContext, 'Parsing ABS blocks', 0.2);
    throwIfSyncAbsCancelled(invocationContext);

    // 解析 ABS（不转换为 ABI JSON，而是获取 BlockConfig）
    const parser = new BlocklyAbsParser();
    const parseResult = parser.parse(absContent);
    
    // 🆕 重新排序 rootBlocks：先加载函数定义等块，最后加载 setup/loop
    // 这确保 custom_function_def 先注册到 registry，custom_function_call 才能正确获取参数信息
    const sortedRootBlocks = sortBlocksForLoading(parseResult.rootBlocks);
    parseResult.rootBlocks = sortedRootBlocks;
    // console.log(`📑 块加载顺序: ${sortedRootBlocks.map(b => b.type).join(' → ')}`);
    
    if (!parseResult.success) {
      const errorMessages = parseResult.errors
        ?.map(e => `第 ${e.line} 行: ${e.message}`)
        .join('\n') || '未知错误';
      
      return {
        is_error: true,
        content: `ABS 解析失败:\n${errorMessages}\n\n请检查 ABS 文件语法，读取对应库 reademe_ai.md 或使用 \`get_block_info_tool\` 查询正确的块定义和参数格式。`
      };
    }
    await reportSyncAbsImportProgress(
      invocationContext,
      'Preparing Blockly workspace update',
      0.35,
      `${parseResult.rootBlocks.length} root blocks`,
    );
    throwIfSyncAbsCancelled(invocationContext);

    // 获取工作区
    const workspace = getActiveWorkspace();
    if (!workspace) {
      return {
        is_error: true,
        content: '无法获取 Blockly 工作区'
      };
    }
    
    // 备份当前 ABI 文件
    await backupAbiFileIfPresent(abiFilePath, electronService, projectService, invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Backed up current Blockly artifacts', 0.45);
    throwIfSyncAbsCancelled(invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Applying Blockly workspace changes', 0.5);
    
    // 收集所有变量：从 @var 声明 + 从 $varName 引用自动推断
    const allVariables = new Map<string, string>(); // name → type
    
    // 🆕 收集会被初始化块自动创建的变量（如 dht_init 的第一个参数）
    // 这些变量不需要预先创建，让 Blockly 扩展自动创建带正确类型的变量
    const autoCreatedVars = collectAutoCreatedVariables(parseResult.rootBlocks);
    if (autoCreatedVars.size > 0) {
      // console.log(`📋 检测到初始化块自动创建的变量: ${Array.from(autoCreatedVars).join(', ')}`);
    }
    
    // 1. 从显式 @var 声明中收集（如果有）
    for (const varDef of parseResult.variables) {
      allVariables.set(varDef.name, varDef.type);
    }
    
    // 2. 从 $varName 引用中自动收集（扫描所有块，带类型推断）
    // 🆕 排除会被初始化块自动创建的变量
    const inferredVars = collectVariableReferences(parseResult.rootBlocks);
    for (const [varName, varType] of inferredVars) {
      if (!allVariables.has(varName) && !autoCreatedVars.has(varName)) {
        allVariables.set(varName, varType); // 使用推断的类型（可能来自 FieldVariable 的类型约束）
        // console.log(`🔍 自动推断变量: "${varName}" (类型: ${varType || '默认'}, 从 $${varName} 引用)`);
      } else if (autoCreatedVars.has(varName)) {
        // console.log(`⏭️ 跳过变量: "${varName}" (将由初始化块自动创建)`);
      }
    }
    
    // 清理不再需要的旧变量，保留 ABS 中会用到的变量
    // 变量库及部分库的块在加载时会自动注册变量（如 registerVariableToBlockly / addVariableToToolbox）
    // 所以只删除既不在 ABS 声明/引用中、也不会被初始化块自动创建的变量
    // 使用 VariableMap 直接操作，避免 workspace.deleteVariableById 弹出确认对话框
    const variableMap = workspace.getVariableMap();
    const existingVars = workspace.getAllVariables();
    if (variableMap && existingVars.length > 0) {
      let deletedVariableCount = 0;
      for (const oldVar of existingVars) {
        throwIfSyncAbsCancelled(invocationContext);
        if (!allVariables.has(oldVar.name) && !autoCreatedVars.has(oldVar.name)) {
          runWithBlocklyEventsDisabled(() => {
            variableMap.deleteVariable(oldVar);
            deletedVariableCount++;
          });
          if (deletedVariableCount % 8 === 0) {
            await checkpointSyncAbsFrameBudget(invocationContext, 'variables.delete-batch');
          }
        }
      }
    }
    await checkpointSyncAbsFrameBudget(invocationContext, 'variables.deleted');
    
    // 同步 ABS 中声明的变量到工作区（只创建不存在的，保留已有的）
    // 注意：当推断出变量类型时，必须精确匹配（名称+类型），
    // 否则已存在的空类型变量会导致 FieldVariable "type doesn't match" 错误
    // 禁用事件，避免删除/重建变量时触发代码生成导致 getVariableById 返回 null
    const variableNameToId = new Map<string, string>();
    
    let syncedVariableCount = 0;
    for (const [name, type] of allVariables) {
      throwIfSyncAbsCancelled(invocationContext);
      let variable: any;
      runWithBlocklyEventsDisabled(() => {
        if (type) {
          // 类型已知时，按名称+类型精确查找
          variable = workspace.getVariable(name, type);
          if (!variable) {
            // 检查是否存在同名但类型不匹配的旧变量
            const wrongTypeVar = workspace.getVariable(name);
            if (wrongTypeVar && wrongTypeVar.type !== type) {
              // 删除旧的错误类型变量，用正确类型重建
              variableMap?.deleteVariable(wrongTypeVar);
            }
            variable = workspace.createVariable(name, type);
          }
        } else {
          variable = workspace.getVariable(name);
          if (!variable) {
            variable = workspace.createVariable(name);
          }
        }
        variableNameToId.set(name, variable.getId());
        syncedVariableCount++;
      });
      if (syncedVariableCount % 8 === 0) {
        await checkpointSyncAbsFrameBudget(invocationContext, 'variables.sync-batch');
      }
    }
    await checkpointSyncAbsFrameBudget(invocationContext, 'variables.synced');
    // console.log(`📋 同步 ${allVariables.size} 个变量`);
    
    // 🆕 尝试增量更新
    const hasExistingBlocks = workspace.getTopBlocks(false).length > 0;
    let updateResult: { added: number; removed: number; unchanged: number; failedBlocks: any[] } | null = null;
    let useIncrementalUpdate = hasExistingBlocks;
    
    if (useIncrementalUpdate) {
      // console.log('🔄 尝试增量更新...');
      try {
        updateResult = await incrementalUpdate(
          workspace,
          parseResult.rootBlocks,
          variableNameToId,
          preprocessVariableReferences,
          invocationContext,
        );
        await reportSyncAbsImportProgress(
          invocationContext,
          'Applied incremental Blockly update',
          0.75,
          `added ${updateResult.added}, removed ${updateResult.removed}, unchanged ${updateResult.unchanged}`,
        );
        throwIfSyncAbsCancelled(invocationContext);
        // console.log(`📊 增量更新完成: +${updateResult.added}, -${updateResult.removed}, =${updateResult.unchanged}`);
      } catch (e) {
        debugSyncAbsImportIssue('Incremental Blockly update failed, falling back to full rebuild', e);
        useIncrementalUpdate = false;
      }
    }
    
    // 如果增量更新失败或没有现有块，使用全量更新
    let totalBlocks = 0;
    const failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }> = [];
    
    if (!useIncrementalUpdate) {
      // console.log('🔄 执行全量更新（保留受保护块）...');
      
      // 🆕 收集受保护的块，稍后恢复
      const protectedBlocksMap = new Map<string, any>();
      const existingTopBlocks = workspace.getTopBlocks(false);
      for (const block of existingTopBlocks) {
        if (PROTECTED_ROOT_BLOCKS.has(block.type) && !protectedBlocksMap.has(block.type)) {
          // 记录受保护块的位置信息
          protectedBlocksMap.set(block.type, {
            block: block,
            x: block.getRelativeToSurfaceXY().x,
            y: block.getRelativeToSurfaceXY().y
          });
        }
      }
      
      // 清空非受保护块，删除重复的受保护块。使用短事件事务，避免
      // Blockly workspace mutation 长时间占用主线程。
      let disposeCount = 0;
      for (const block of existingTopBlocks) {
        throwIfSyncAbsCancelled(invocationContext);
        if (!PROTECTED_ROOT_BLOCKS.has(block.type)) {
          runWithBlocklyEventsDisabled(() => {
            block.dispose(true);
            disposeCount++;
          });
          // 每销毁 3 个块后让出事件循环，允许 UI 刷新
          if (disposeCount % 3 === 0) {
            await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.dispose-batch');
          }
        } else {
          // 受保护块：只保留 protectedBlocksMap 中记录的那个（第一个），删除重复的
          const protectedInfo = protectedBlocksMap.get(block.type);
          if (protectedInfo && protectedInfo.block === block) {
            // 这是要保留的块，清空其子块
            let clearedProtectedChildCount = 0;
            for (const input of block.inputList || []) {
              if (input.connection?.isConnected()) {
                const child = input.connection.targetBlock();
                if (child && !child.isShadow()) {
                  throwIfSyncAbsCancelled(invocationContext);
                  runWithBlocklyEventsDisabled(() => {
                    input.connection.disconnect();
                    child.dispose(true);
                    clearedProtectedChildCount++;
                  });
                  if (clearedProtectedChildCount % 4 === 0) {
                    await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.protected-children-batch');
                  }
                }
              }
            }
          } else {
            // 这是重复的受保护块，删除
            runWithBlocklyEventsDisabled(() => {
              block.dispose(true);
              disposeCount++;
            });
            if (disposeCount % 3 === 0) {
              await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.dispose-batch');
            }
          }
        }
      }
      
      // 重新创建变量
      await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.cleaned');
      variableNameToId.clear();
      let recreatedVariableCount = 0;
      for (const [name, type] of allVariables) {
        throwIfSyncAbsCancelled(invocationContext);
        let variable = workspace.getVariable(name);
        if (!variable) {
          variable = workspace.createVariable(name, type || undefined);
        }
        variableNameToId.set(name, variable.getId());
        recreatedVariableCount++;
        if (recreatedVariableCount % 8 === 0) {
          await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.variables-batch');
        }
      }
      
      let yPosition = 30;
      const processedTypes = new Set<string>();
      let blockCreateCount = 0;
      
      for (const blockConfig of parseResult.rootBlocks) {
        throwIfSyncAbsCancelled(invocationContext);
        // 检查是否有受保护块需要重建子块
        if (PROTECTED_ROOT_BLOCKS.has(blockConfig.type) && protectedBlocksMap.has(blockConfig.type)) {
          const protectedInfo = protectedBlocksMap.get(blockConfig.type);
          processedTypes.add(blockConfig.type);
          
          // 使用 rebuildBlockChildren 重建子块
          preprocessVariableReferences(blockConfig, variableNameToId);
          try {
            const rebuildResult = await rebuildBlockChildren(
              workspace, protectedInfo.block, blockConfig,
              variableNameToId, preprocessVariableReferences,
              invocationContext,
            );
            totalBlocks++;
            blockCreateCount++;
            if (rebuildResult.failedBlocks?.length) {
              failedBlocks.push(...rebuildResult.failedBlocks);
            }
          } catch (error) {
            debugSyncAbsImportIssue(`Protected block child rebuild failed: ${blockConfig.type}`, error);
            failedBlocks.push({
              blockType: blockConfig.type,
              error: error instanceof Error ? error.message : String(error)
            });
          }
          // 每创建 2 个根块后让出事件循环，允许 UI 刷新
            if (blockCreateCount % 2 === 0) { await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.protected-blocks'); }
          throwIfSyncAbsCancelled(invocationContext);
          continue;
        }
        
        // 设置位置
        const configWithPosition = {
          ...blockConfig,
          position: { x: 30, y: yPosition }
        };
        
        // 预处理：将变量名转换为变量 ID
        preprocessVariableReferences(configWithPosition, variableNameToId);
        
        try {
          const result = await createBlockFromConfig(workspace, configWithPosition, undefined, invocationContext);
          if (result.block) {
            totalBlocks += result.totalBlocks;
            yPosition += calculateBlockHeight(result.block) + 50;
          }
          if (result.failedBlocks && result.failedBlocks.length > 0) {
            failedBlocks.push(...result.failedBlocks);
          }
        } catch (error) {
          debugSyncAbsImportIssue(`Block creation failed: ${blockConfig.type}`, error);
          failedBlocks.push({
            blockType: blockConfig.type,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        blockCreateCount++;
        // 每创建 2 个根块后让出事件循环，允许 UI 刷新
        if (blockCreateCount % 2 === 0) { await checkpointSyncAbsFrameBudget(invocationContext, 'full-recreate.root-blocks'); }
        throwIfSyncAbsCancelled(invocationContext);
        if (blockCreateCount % 10 === 0) {
          await reportSyncAbsImportProgress(
            invocationContext,
            'Rebuilding Blockly blocks',
            Math.min(0.74, 0.5 + (blockCreateCount / Math.max(1, parseResult.rootBlocks.length)) * 0.24),
            `${blockCreateCount}/${parseResult.rootBlocks.length} root blocks`,
          );
        }
      }
    } else {
      // 使用增量更新结果
      totalBlocks = (updateResult?.added || 0) + (updateResult?.unchanged || 0);
      if (updateResult?.failedBlocks) {
        failedBlocks.push(...updateResult.failedBlocks);
      }
    }
    
    // ============ 最终清理：移除任何不应存在的孤立根块 ============
    // 无论增量还是全量更新，都可能产生孤立块（createBlockFromConfig 创建了块但连接失败）
    // 基于 ABS 中定义的根块类型和数量，对工作区进行最终扫描
    {
      // 统计 ABS 中每种根块类型的期望数量
      const expectedRootCounts = new Map<string, number>();
      for (const block of parseResult.rootBlocks) {
        expectedRootCounts.set(block.type, (expectedRootCounts.get(block.type) || 0) + 1);
      }
      
      // 按类型分组当前工作区的根块
      const topBlocks = workspace.getTopBlocks(false);
      const topBlocksByType = new Map<string, any[]>();
      for (const block of topBlocks) {
        if (!topBlocksByType.has(block.type)) {
          topBlocksByType.set(block.type, []);
        }
        topBlocksByType.get(block.type)!.push(block);
      }
      
      let orphanCleanupCount = 0;
      for (const [type, blocks] of topBlocksByType) {
        const expected = expectedRootCounts.get(type) || 0;
        // 受保护块至少保留 1 个（即使 ABS 未定义），但不保留多余的
        const minKeep = PROTECTED_ROOT_BLOCKS.has(type) ? Math.max(1, expected) : expected;
        if (blocks.length > minKeep) {
          // 有多余的块，删除多余的（保留前 minKeep 个）
          const toDelete = blocks.slice(minKeep);
          orphanCleanupCount += await disposeBlocklyBlocksInBatches(
            toDelete,
            invocationContext,
            `full-recreate.final-orphan-cleanup.${type}`,
          );
        }
      }
      
      if (orphanCleanupCount > 0) {
        console.log(`[syncAbsFile] 最终清理: 移除了 ${orphanCleanupCount} 个孤立块`);
      }
    }
    
    // 触发 FINISHED_LOADING 事件，让各库的初始化逻辑执行
    // （如 _initFunctionLibOnLoad 绑定 FUNC 变量到 custom_function_def）
    // createBlockFromConfig 路径不像 Blockly.serialization.workspaces.load 那样自动触发此事件
    await checkpointSyncAbsFrameBudget(invocationContext, 'finished-loading.before');
    try {
      const finishedLoadingEvent = new Blockly.Events.FinishedLoading(workspace);
      Blockly.Events.fire(finishedLoadingEvent);
    } catch (e) {
      console.warn('[syncAbsFile] 触发 FINISHED_LOADING 事件失败:', e);
    }
    await checkpointSyncAbsFrameBudget(invocationContext, 'finished-loading.after');
    
    // 保存工作区到 ABI 文件
    await reportSyncAbsImportProgress(invocationContext, 'Saving Blockly workspace snapshot', 0.8, abiFilePath);
    throwIfSyncAbsCancelled(invocationContext);
    await checkpointSyncAbsFrameBudget(invocationContext, 'workspace-save.before');
    const workspaceSaveStartedAt = performance.now();
    const abiJson = await ChatPerformanceTracer.runWithSurface(
      'editor_operation',
      () => Blockly.serialization.workspaces.save(workspace),
      'syncAbs.import:workspace.save',
    );
    ChatPerformanceTracer.recordDuration(
      'syncAbs_workspace_save',
      performance.now() - workspaceSaveStartedAt,
      abiFilePath,
      { slowThresholdMs: 16 },
    );
    await checkpointSyncAbsFrameBudget(invocationContext, 'workspace-save.after');
    await writeTimelineAwareTextFile(abiFilePath, JSON.stringify(abiJson), electronService, invocationContext);
    await reportSyncAbsImportProgress(invocationContext, 'Saving generated project files', 0.85);
    throwIfSyncAbsCancelled(invocationContext);

    // 在 AI 回合中 builder 的自动预处理会因 aiWaiting 被延后。
    // 这里直接同步刷新 sketch.ino，避免同一 turn 立即读取时仍看到旧代码。
    let sketchSyncInfo: { filePath: string; generated: boolean } | null = null;
    let sketchSyncWarning = '';
    try {
      await reportSyncAbsImportProgress(invocationContext, 'Refreshing generated sketch', 0.9);
      throwIfSyncAbsCancelled(invocationContext);
      sketchSyncInfo = await writeGeneratedSketchIno(projectService?.currentProjectPath || projectService?.projectRootPath, electronService, workspace, invocationContext);
    } catch (error) {
      if (isSyncAbsCancellationError(error)) {
        throw error;
      }
      sketchSyncWarning = `\n\n**⚠️ 代码生成告警:** 未能立即刷新 sketch.ino: ${error instanceof Error ? error.message : String(error)}`;
    }
    throwIfSyncAbsCancelled(invocationContext);
    
    const variableCount = allVariables.size;  // 使用收集到的所有变量数量
    await reportSyncAbsImportProgress(invocationContext, 'Blockly workspace import finished', 0.95);

    // 警告信息
    let warnings = '';
    if (parseResult.warnings && parseResult.warnings.length > 0) {
      warnings = '\n\n**⚠️ 警告:**\n' + 
        parseResult.warnings.map(w => `- 第 ${w.line} 行: ${w.message}`).join('\n');
    }
    
    // 更新模式信息
    let updateModeInfo = '';
    if (useIncrementalUpdate && updateResult) {
      updateModeInfo = `\n**更新模式:** 增量更新 (新增 ${updateResult.added}, 删除 ${updateResult.removed}, 保持 ${updateResult.unchanged})`;
    } else {
      updateModeInfo = '\n**更新模式:** 全量重建';
    }
    
    // 失败的块
    let failedInfo = '';
    if (failedBlocks.length > 0) {
      failedInfo = '\n\n**❌ 创建失败的块 (' + failedBlocks.length + ' 个):**\n';
      
      for (const f of failedBlocks) {
        failedInfo += `- \`${f.blockType}\`: ${f.error}\n`;
        if (f.suggestion) {
          failedInfo += `  💡 ${f.suggestion}\n`;
        }
      }
      
      failedInfo += '\n**🔧 修复建议:**\n';
      failedInfo += '1. 检查块类型是否拼写正确\n';
      failedInfo += '2. ABS 位置参数必须严格按照 block.json 中 args0 的定义顺序传递（字段和值输入可能交错排列，不是"先所有字段后所有输入"）\n';
      failedInfo += '3. 直接读取库的 generator/block 等文件了解块的使用方法\n';
      failedInfo += '4. 阅读对应库的 README 了解块的使用方法\n';
      failedInfo += '5. 如果多次尝试仍失败，考虑使用 `lib-core-custom` 的自定义代码块\n';
    }
    
    // 版本信息
    const versionInfo = versionSaved ? '\n**版本:** 修改前状态已自动保存到版本历史' : '';
    
    return {
      is_error: false,
      content: `✅ 已从 ABS 文件导入

**统计:** ${totalBlocks} 个块, ${variableCount} 个变量${updateModeInfo}
**备份:** 原 ABI 文件已备份为 \`project.abi.backup\`${versionInfo}${warnings}${failedInfo}${sketchSyncWarning}

${sketchSyncInfo ? `**代码同步:** 已刷新 \`${sketchSyncInfo.filePath}\`${sketchSyncInfo.generated ? '' : '（当前生成结果为空）'}

` : ''}工作区已更新。请使用 \`lint\` 验证生成代码；如需检查结构，请读取 \`project.abs\` 或导出的 sketch 文件，不要调用旧的直接 Blockly mutation/overview 工具。`,
      metadata: {
        operation: 'import',
        filePath: absFilePath,
        blockCount: totalBlocks,
        variableCount,
        versionSaved
      }
    };
  } catch (error) {
    if (isSyncAbsCancellationError(error)) {
      throw error;
    }
    return {
      is_error: true,
      content: `导入失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 从块配置中收集所有变量引用（$varName 格式）
 * 用于自动创建 Blockly 工作区变量
 */
function collectVariableReferences(blocks: any[]): Map<string, string> {
  const varMap = new Map<string, string>(); // name → type
  
  function collectFromConfig(config: any): void {
    if (!config) return;
    
    // 从字段中收集变量引用（带类型推断）
    if (config.fields) {
      for (const [key, value] of Object.entries(config.fields)) {
        if (typeof value === 'object' && value !== null && (value as any).name) {
          const varName = (value as any).name;
          if (!varMap.has(varName)) {
            // 优先使用解析值中的 type，再从 Blockly 运行时推断
            const varType = (value as any).type || inferFieldVariableType(config.type, key);
            varMap.set(varName, varType);
          }
        }
      }
    }
    
    // 递归处理输入
    if (config.inputs) {
      for (const input of Object.values(config.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) {
          collectFromConfig(inputConfig.block);
        }
        if (inputConfig.shadow) {
          collectFromConfig(inputConfig.shadow);
        }
      }
    }
    
    // 处理 next
    if (config.next?.block) {
      collectFromConfig(config.next.block);
    }
  }
  
  for (const block of blocks) {
    collectFromConfig(block);
  }
  
  return varMap;
}

/**
 * 🆕 收集会被初始化块自动创建的变量
 * 这些块（如 dht_init, servo_init 等）的第一个字符串参数是变量名，
 * Blockly 扩展会自动创建带正确类型的变量
 */
function collectAutoCreatedVariables(blocks: any[]): Set<string> {
  const autoCreatedVars = new Set<string>();
  
  // 已知会自动创建变量的初始化块模式
  // 块类型 → 包含变量名的字段名
  const initBlockPatterns: Record<string, string> = {
    'dht_init': 'VAR',
    'servo_init': 'VAR',
    'stepper_init': 'VAR',
    'lcd_init': 'VAR',
    'oled_init': 'VAR',
    'neopixel_init': 'VAR',
    'motor_init': 'VAR',
    'ultrasonic_init': 'VAR',
    'ir_init': 'VAR',
    'mqtt_init': 'VAR',
    'ntpclient_create': 'VAR',
    // 可以根据需要添加更多
  };
  
  function collectFromConfig(config: any): void {
    if (!config) return;
    
    // 检查是否是初始化块
    const varFieldName = initBlockPatterns[config.type];
    if (varFieldName && config.fields) {
      const varValue = config.fields[varFieldName];
      if (varValue) {
        // 变量名可能是字符串或 { name: "xxx" } 对象
        const varName = typeof varValue === 'string' ? varValue : varValue.name;
        if (varName) {
          autoCreatedVars.add(varName);
        }
      }
    }
    
    // 递归处理输入
    if (config.inputs) {
      for (const input of Object.values(config.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) {
          collectFromConfig(inputConfig.block);
        }
      }
    }
    
    // 处理 next
    if (config.next?.block) {
      collectFromConfig(config.next.block);
    }
  }
  
  for (const block of blocks) {
    collectFromConfig(block);
  }
  
  return autoCreatedVars;
}

/**
 * 预处理变量引用：将 { name: "varName" } 转换为 Blockly 可识别的格式
 */
function preprocessVariableReferences(
  config: any, 
  variableNameToId: Map<string, string>
): void {
  // 处理字段中的变量引用
  if (config.fields) {
    for (const [key, value] of Object.entries(config.fields)) {
      if (typeof value === 'object' && value !== null && (value as any).name) {
        const varName = (value as any).name;
        const varId = variableNameToId.get(varName);
        if (varId) {
          // Blockly 需要 id 字段，同时保留/推断变量类型
          // 类型信息对 FieldVariable 验证至关重要（如 FUNC_NAME 期望 'FUNC' 类型）
          const varType = (value as any).type || inferFieldVariableType(config.type, key);
          config.fields[key] = { id: varId, name: varName, type: varType };
        }
      }
    }
  }
  
  // 递归处理输入
  if (config.inputs) {
    for (const input of Object.values(config.inputs)) {
      const inputConfig = input as any;
      if (inputConfig.block) {
        preprocessVariableReferences(inputConfig.block, variableNameToId);
      }
      if (inputConfig.shadow) {
        preprocessVariableReferences(inputConfig.shadow, variableNameToId);
      }
    }
  }
  
  // 处理 next
  if (config.next?.block) {
    preprocessVariableReferences(config.next.block, variableNameToId);
  }
}

/**
 * 计算块的实际高度
 */
function calculateBlockHeight(block: any): number {
  if (!block) return 50;
  
  try {
    // 尝试获取块的实际高度
    if (block.height) {
      return block.height;
    }
    
    // 回退到估算
    let height = 50;
    
    // 计算子块高度
    const inputs = block.inputList || [];
    for (const input of inputs) {
      if (input.connection && input.connection.targetBlock()) {
        height += calculateBlockHeight(input.connection.targetBlock());
      }
    }
    
    // 计算 next 链
    if (block.nextConnection && block.nextConnection.targetBlock()) {
      height += calculateBlockHeight(block.nextConnection.targetBlock());
    }
    
    return height;
  } catch {
    return 50;
  }
}

/**
 * 获取 ABS 文件状态
 */
async function getAbsStatus(
  absFilePath: string,
  abiFilePath: string,
  electronService: any
): Promise<SyncAbsResult> {
  try {
    const absExists = await electronService.exists(absFilePath);
    const abiExists = await electronService.exists(abiFilePath);
    
    let content = `## ABS 文件状态\n\n`;
    content += `**ABS 文件:** ${absFilePath}\n`;
    content += `**状态:** ${absExists ? '✅ 存在' : '❌ 不存在'}\n\n`;
    content += `**ABI 文件:** ${abiFilePath}\n`;
    content += `**状态:** ${abiExists ? '✅ 存在' : '❌ 不存在'}\n\n`;
    
    let blockCount = 0;
    let variableCount = 0;
    let absPreview = '';
    
    if (absExists) {
      const absContent = await electronService.readFile(absFilePath);
      const lines = absContent.split('\n');
      absPreview = lines.slice(0, 20).join('\n') + 
        (lines.length > 20 ? '\n... (more lines)' : '');
      
      content += `**ABS 内容预览:**\n\`\`\`\n${absPreview}\n\`\`\`\n\n`;
      
      // 统计
      const nonEmptyLines = lines.filter(l => l.trim() && !l.trim().startsWith('#'));
      content += `**ABS 行数:** ${lines.length} (非空非注释: ${nonEmptyLines.length})\n`;
    }
    
    if (abiExists) {
      const abiContent = await electronService.readFile(abiFilePath);
      const abiJson = JSON.parse(abiContent);
      blockCount = countBlocks(abiJson);
      variableCount = abiJson.variables?.length || 0;
      
      content += `**ABI 块数:** ${blockCount}\n`;
      content += `**ABI 变量数:** ${variableCount}\n`;
    }
    
    content += `\n**建议操作:**\n`;
    if (!absExists && abiExists) {
      content += `- 使用 \`syncAbs action="export"\` 生成 ABS 文件\n`;
    } else if (absExists) {
      content += `- 使用 \`read_file\` 读取完整 ABS 内容\n`;
      content += `- 使用 \`edit_file\` 修改后 \`syncAbs action="import"\` 应用\n`;
    }
    
    return {
      is_error: false,
      content,
      metadata: {
        operation: 'status',
        filePath: absFilePath,
        absPreview,
        blockCount,
        variableCount
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `获取状态失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 统计块数量
 */
function countBlocks(abiJson: any): number {
  let count = 0;
  
  function countRecursive(block: any): void {
    if (!block) return;
    count++;
    
    // 统计输入中的块
    if (block.inputs) {
      for (const input of Object.values(block.inputs)) {
        const inputConfig = input as any;
        if (inputConfig.block) countRecursive(inputConfig.block);
        if (inputConfig.shadow) countRecursive(inputConfig.shadow);
      }
    }
    
    // 统计 next 块
    if (block.next?.block) {
      countRecursive(block.next.block);
    }
  }
  
  if (abiJson.blocks?.blocks) {
    for (const block of abiJson.blocks.blocks) {
      countRecursive(block);
    }
  }
  
  return count;
}

// =============================================================================
// 增量更新辅助函数
// =============================================================================

/**
 * 规范化字段值用于签名比较
 * 统一处理变量字段、普通字段的格式差异
 */
function normalizeFieldValue(value: any): string {
  if (value === null || value === undefined) return '';
  
  if (typeof value === 'object') {
    // 变量字段：优先使用 name，因为 ABS 和工作区都有 name
    if ('name' in value) {
      return `var:${value.name}`;
    }
    if ('id' in value) {
      return `id:${value.id}`;
    }
    return JSON.stringify(value);
  }
  
  return String(value);
}

/**
 * 找到块配置中的第一个子块（用于调试对比）
 */
function findFirstChildBlock(blockConfig: any): any {
  if (!blockConfig) return null;
  
  // 优先从 inputs 中找
  if (blockConfig.inputs) {
    for (const [inputName, inputValue] of Object.entries(blockConfig.inputs) as [string, any][]) {
      if (inputValue.block) return inputValue.block;
      if (inputValue.shadow) return inputValue.shadow;
    }
  }
  
  // 然后从 next 中找
  if (blockConfig.next?.block) {
    return blockConfig.next.block;
  }
  
  return null;
}

/**
 * 计算块链的签名（用于比较是否相同）
 * 签名包含：块类型、字段值、输入连接、next 连接
 * 注意：不包含位置信息和块 ID
 */
function computeBlockChainSignature(block: any): string {
  if (!block) return '';
  
  const parts: string[] = [];
  
  // 块类型
  parts.push(`T:${block.type}`);
  
  // 需要跳过的字段（UI 相关，不影响语义）
  const isUIField = (name: string): boolean => {
    // PLUS, MINUS, PLUS1, MINUS1, MINUS2 等都是 UI 按钮图标
    if (/^(PLUS|MINUS)\d*$/i.test(name)) return true;
    return false;
  };
  
  // 标准字段名列表（这些字段名在签名中保留原名）
  const standardFieldNames = new Set(['VAR', 'TYPE', 'NAME', 'TEXT', 'NUM', 'VALUE', 'OP', 'MODE', 'BOOL', 'ITEM']);
  
  // 字段值（排序后连接，跳过空值和 UI 字段）
  // EXTRA_N 字段和非标准字段只按值参与签名，使用 _DYN_VAL:value 格式
  if (block.fields) {
    const normalFields: string[] = [];
    const dynamicValues: string[] = [];
    
    const sortedEntries = Object.entries(block.fields)
      .filter(([k, v]) => !isUIField(k) && v !== null && v !== undefined && v !== '')
      .sort(([a], [b]) => a.localeCompare(b));
    
    for (const [k, v] of sortedEntries) {
      // EXTRA_N 字段：只保留值，按索引顺序
      if (/^EXTRA_\d+$/.test(k)) {
        dynamicValues.push(normalizeFieldValue(v));
      }
      // 标准字段：保留字段名
      else if (standardFieldNames.has(k)) {
        normalFields.push(`${k}=${normalizeFieldValue(v)}`);
      }
      // 其他字段（可能是动态创建的如 PIN）：也只保留值
      else {
        dynamicValues.push(normalizeFieldValue(v));
      }
    }
    
    // 标准字段部分
    if (normalFields.length > 0) {
      parts.push(`F:{${normalFields.join(',')}}`);
    }
    // 动态字段值部分（只值不含名，排序后）
    if (dynamicValues.length > 0) {
      parts.push(`D:[${dynamicValues.sort().join(',')}]`);
    }
  }
  
  // extraState（如果有且非空）
  if (block.extraState && Object.keys(block.extraState).length > 0) {
    parts.push(`E:${JSON.stringify(block.extraState)}`);
  }
  
  // 输入连接（递归计算子块签名）
  if (block.inputs) {
    const inputSigs = Object.entries(block.inputs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, input]: [string, any]) => {
        const blockSig = input.block ? computeBlockChainSignature(input.block) : '';
        const shadowSig = input.shadow ? computeBlockChainSignature(input.shadow) : '';
        // 只有当有内容时才包含
        if (blockSig || shadowSig) {
          return `${name}:[${blockSig}|${shadowSig}]`;
        }
        return null;
      })
      .filter(Boolean);
    if (inputSigs.length > 0) {
      parts.push(`I:{${inputSigs.join(',')}}`);
    }
  }
  
  // next 连接
  if (block.next?.block) {
    parts.push(`N:${computeBlockChainSignature(block.next.block)}`);
  }
  
  return parts.join('|');
}

/**
 * 将 Blockly 工作区中的块序列化为与 ABS 解析结果相同的格式
 * 重要：输出格式必须与 ABS 解析器的 BlockConfig 格式一致
 */
function serializeWorkspaceBlock(block: any): any {
  if (!block) return null;
  
  const result: any = {
    type: block.type
  };
  
  // 序列化字段
  const fields: any = {};
  for (const input of block.inputList || []) {
    for (const field of input.fieldRow || []) {
      if (field.name && field.getValue) {
        const value = field.getValue();
        // 变量字段特殊处理：使用 { name: varName } 格式，与 ABS 解析结果一致
        if (field.getVariable) {
          const variable = field.getVariable();
          if (variable) {
            // 只保留 name，与 ABS 解析结果格式一致
            fields[field.name] = { name: variable.name };
          }
        } else if (value !== undefined && value !== null && value !== '') {
          fields[field.name] = value;
        }
      }
    }
  }
  if (Object.keys(fields).length > 0) {
    result.fields = fields;
  }
  
  // 序列化 extraState（只有非空时才添加）
  if (block.saveExtraState) {
    try {
      const extraState = block.saveExtraState();
      if (extraState && Object.keys(extraState).length > 0) {
        result.extraState = extraState;
      }
    } catch (e) {
      // 忽略
    }
  }
  
  // 序列化输入
  const inputs: any = {};
  for (const input of block.inputList || []) {
    if (input.connection && input.name) {
      const connectedBlock = input.connection.targetBlock();
      if (connectedBlock) {
        const isShadow = connectedBlock.isShadow();
        const serialized = serializeWorkspaceBlock(connectedBlock);
        if (serialized) {
          if (isShadow) {
            inputs[input.name] = { shadow: serialized };
          } else {
            inputs[input.name] = { block: serialized };
          }
        }
      }
    }
  }
  if (Object.keys(inputs).length > 0) {
    result.inputs = inputs;
  }
  
  // 序列化 next
  if (block.nextConnection) {
    const nextBlock = block.nextConnection.targetBlock();
    if (nextBlock) {
      const serialized = serializeWorkspaceBlock(nextBlock);
      if (serialized) {
        result.next = { block: serialized };
      }
    }
  }
  
  return result;
}

/**
 * 获取工作区中所有根块（顶层块）
 */
function getWorkspaceRootBlocks(workspace: any): any[] {
  const topBlocks = workspace.getTopBlocks(false);
  return topBlocks.map((block: any) => ({
    block,
    serialized: serializeWorkspaceBlock(block),
    signature: computeBlockChainSignature(serializeWorkspaceBlock(block))
  }));
}

/**
 * 就地更新块的字段值
 * 返回是否有任何字段被更新
 */
function updateBlockFields(block: any, newFields: any, variableNameToId: Map<string, string>): boolean {
  if (!newFields) return false;
  
  let updated = false;
  for (const [fieldName, newValue] of Object.entries(newFields)) {
    const field = block.getField(fieldName);
    if (!field) continue;
    
    // 变量字段特殊处理
    if (field.getVariable && typeof newValue === 'object' && newValue && 'name' in newValue) {
      const varName = (newValue as any).name;
      const varId = variableNameToId.get(varName);
      if (varId) {
        const currentVar = field.getVariable();
        if (!currentVar || currentVar.name !== varName) {
          field.setValue(varId);
          updated = true;
        }
      }
    } else if (field.getValue && field.setValue) {
      const currentValue = field.getValue();
      if (currentValue !== newValue) {
        field.setValue(newValue);
        updated = true;
      }
    }
  }
  
  return updated;
}

/**
 * 将 EXTRA_N 输入映射到块上实际存在的输入，并在需要时动态扩展块的输入数量。
 * 
 * ABS 解析时，超出块元数据已知输入的参数被标记为 EXTRA_0、EXTRA_1 等。
 * 此函数将它们映射到块上实际的未占用值输入（如 INPUT1、INPUT2）。
 * 如果块的输入不够，会通过 plus()、updateShape_() 等方式动态扩展。
 */
function remapAndExpandInputs(block: any, inputs: Record<string, any>): Record<string, any> {
  const extraInputs: Array<{ key: string; value: any; index: number }> = [];
  const normalInputs: Record<string, any> = {};

  for (const [key, value] of Object.entries(inputs)) {
    const extraMatch = key.match(/^EXTRA_(\d+)$/);
    if (extraMatch) {
      extraInputs.push({ key, value, index: parseInt(extraMatch[1], 10) });
    } else {
      const inputMatch = key.match(/^INPUT(\d+)$/);
      if (inputMatch && !block.getInput(key)) {
        extraInputs.push({ key, value, index: parseInt(inputMatch[1], 10) });
      } else {
        normalInputs[key] = value;
      }
    }
  }

  if (extraInputs.length === 0) return inputs;

  extraInputs.sort((a, b) => a.index - b.index);

  const configuredInputs = new Set(Object.keys(normalInputs));

  const getAvailable = () => {
    const list: string[] = [];
    for (const inp of block.inputList || []) {
      if (inp.name && inp.type === 1 && !configuredInputs.has(inp.name)) {
        list.push(inp.name);
      }
    }
    return list;
  };

  let availableInputs = getAvailable();

  // 动态扩展输入数量
  if (extraInputs.length > availableInputs.length) {
    const deficit = extraInputs.length - availableInputs.length;
    let expanded = false;

    if (block.plus && typeof block.plus === 'function') {
      for (let i = 0; i < deficit; i++) {
        try { block.plus(); } catch (e) { break; }
      }
      expanded = true;
    } else if (block.updateShape_ && typeof block.updateShape_ === 'function' && block.extraCount_ !== undefined) {
      const target = (block.extraCount_ || 0) + deficit;
      try { block.extraCount_ = target; block.updateShape_(target); expanded = true; } catch (e) { /* ignore */ }
    } else if (block.loadExtraState && typeof block.loadExtraState === 'function') {
      const totalNeeded = (block.extraCount_ || block.itemCount_ || 0) + deficit;
      const state = block.itemCount_ !== undefined ? { itemCount: totalNeeded } : { extraCount: totalNeeded };
      try { block.loadExtraState(state); expanded = true; } catch (e) { /* ignore */ }
    }

    if (expanded) {
      availableInputs = getAvailable();
      // console.log(`    🔧 动态扩展后可用输入: [${availableInputs.join(', ')}]`);
    }
  }

  const result = { ...normalInputs };
  for (let i = 0; i < extraInputs.length && i < availableInputs.length; i++) {
    result[availableInputs[i]] = extraInputs[i].value;
    // console.log(`    🔄 输入映射: ${extraInputs[i].key} → ${availableInputs[i]}`);
  }
  for (let i = availableInputs.length; i < extraInputs.length; i++) {
    result[extraInputs[i].key] = extraInputs[i].value;
    debugSyncAbsImportIssue(`Unable to map extra input, no available value input remains: ${extraInputs[i].key}`);
  }

  return result;
}

/**
 * 简化方案：保留根块，清空并重建所有子树
 * 
 * 策略：
 * 1. 保留根块本身（arduino_setup/loop/global）
 * 2. 更新根块的字段值
 * 3. 清空所有输入中的子块
 * 4. 根据新配置重建所有子块
 * 
 * 优点：简单稳定，避免 connectionDB 问题
 * 
 * @returns 包含失败块信息的对象
 */
async function rebuildBlockChildren(
  workspace: any,
  existingBlock: any,
  newConfig: any,
  variableNameToId: Map<string, string>,
  preprocessVariableReferences: (config: any, mapping: Map<string, string>) => void,
  invocationContext?: SyncAbsInvocationContext,
): Promise<{ failedBlocks: Array<{ blockType: string; error: string }> }> {
  const failedBlocks: Array<{ blockType: string; error: string }> = [];
  // console.log(`    🔧 开始重建子树: ${existingBlock.type}`);
  
  // 1. 更新 extraState（如 custom_function_def 的 params/returnType）
  // 必须在更新字段和清空子块之前执行，以确保动态输入（如 RETURN、PARAM_TYPEn）已创建
  if (newConfig.extraState) {
    // console.log(`    🎛️ 更新 extraState: ${JSON.stringify(newConfig.extraState)}`);
    try {
      if (existingBlock.loadExtraState && typeof existingBlock.loadExtraState === 'function') {
        existingBlock.loadExtraState(newConfig.extraState);
        // console.log(`    ✅ loadExtraState 调用完成`);
      }
    } catch (e) {
        debugSyncAbsImportIssue('Updating block extraState failed', e);
    }
  }
  
  // 2. 更新根块的字段值（在 extraState 之后，确保动态字段已创建）
  if (newConfig.fields) {
    updateBlockFields(existingBlock, newConfig.fields, variableNameToId);
  }
  
  // 3. 收集所有需要删除的子块（先收集，后删除）
  const blocksToDelete: any[] = [];
  
  for (const input of existingBlock.inputList || []) {
    if (!input.connection) continue;
    const child = input.connection.targetBlock();
    if (child && !child.isShadow()) {
      // 收集整个子链
      let block = child;
      while (block) {
        blocksToDelete.push({ block, inputName: input.name });
        // 也收集子块的 next 链
        block = block.nextConnection?.targetBlock();
      }
    }
  }
  
  // 4. 禁用事件，清空所有子块
  if (blocksToDelete.length > 0) {
    // console.log(`    🗑️ 清空 ${blocksToDelete.length} 个子块`);
    // 先断开所有输入连接。每个 Blockly mutation 使用短事件事务，避免一整段
    // Events.disable() 阻塞聊天 UI 的 hover/loading/scrollbar 动画。
    let disconnectedChildCount = 0;
    for (const input of existingBlock.inputList || []) {
      if (input.connection?.isConnected()) {
        const child = input.connection.targetBlock();
        if (child && !child.isShadow()) {
          throwIfSyncAbsCancelled(invocationContext);
          runWithBlocklyEventsDisabled(() => {
            input.connection.disconnect();
            disconnectedChildCount++;
          });
          if (disconnectedChildCount % 8 === 0) {
            await checkpointSyncAbsFrameBudget(invocationContext, `rebuild.${existingBlock.type}.children-disconnected`);
          }
        }
      }
    }

    // 删除所有收集的块（去重）
    const deletedIds = new Set<string>();
    let deletedChildCount = 0;
    for (const { block } of blocksToDelete) {
      if (!deletedIds.has(block.id) && !block.disposed) {
        throwIfSyncAbsCancelled(invocationContext);
        runWithBlocklyEventsDisabled(() => {
          block.dispose(false);
          deletedIds.add(block.id);
          deletedChildCount++;
        });
        if (deletedChildCount % 8 === 0) {
          await checkpointSyncAbsFrameBudget(invocationContext, `rebuild.${existingBlock.type}.children-delete-batch`);
        }
      }
    }
    await checkpointSyncAbsFrameBudget(invocationContext, `rebuild.${existingBlock.type}.children-deleted`);
  }
  
  // 5. 根据新配置重建子块
  if (newConfig.inputs) {
    // 🆕 映射 EXTRA_N 输入到块上实际输入，并在需要时动态扩展
    const remappedInputs = remapAndExpandInputs(existingBlock, newConfig.inputs);
    
    for (const [inputName, inputValue] of Object.entries(remappedInputs) as [string, any][]) {
      const input = existingBlock.getInput(inputName);
      if (!input || !input.connection) {
        // console.log(`    ⚠️ 输入 ${inputName} 不存在`);
        continue;
      }
      
      const childConfig = inputValue.block || inputValue.shadow;
      if (!childConfig) continue;
      
      // console.log(`    ➕ 重建输入 ${inputName}: ${childConfig.type}`);
      
      // 预处理变量引用
      preprocessVariableReferences(childConfig, variableNameToId);
      
      try {
        const result = await createBlockFromConfig(workspace, childConfig, undefined, invocationContext);
        if (result.block) {
          const targetConnection = result.block.outputConnection || result.block.previousConnection;
          if (targetConnection) {
            try {
              input.connection.connect(targetConnection);
            } catch (connectError) {
              // 连接失败，销毁孤立块避免残留
              debugSyncAbsImportIssue(`Child connection failed, cleaning orphan block: ${childConfig.type}`, connectError);
              try { result.block.dispose(true); } catch (_) { /* ignore */ }
              failedBlocks.push({
                blockType: childConfig.type,
                error: `连接到输入 ${inputName} 失败: ${connectError instanceof Error ? connectError.message : String(connectError)}`
              });
            }
          } else {
            // 无可用连接点，销毁孤立块
            debugSyncAbsImportIssue(`Child block has no output/previous connection, cleaning: ${childConfig.type}`);
            try { result.block.dispose(true); } catch (_) { /* ignore */ }
            failedBlocks.push({
              blockType: childConfig.type,
              error: `块 ${childConfig.type} 无可用的连接点，无法连接到输入 ${inputName}`
            });
          }
        }
        // 收集嵌套块创建失败信息
        if (result.failedBlocks && result.failedBlocks.length > 0) {
          failedBlocks.push(...result.failedBlocks);
        }
      } catch (e) {
        debugSyncAbsImportIssue(`Child rebuild failed: ${childConfig.type}`, e);
        failedBlocks.push({
          blockType: childConfig.type,
          error: e instanceof Error ? e.message : String(e)
        });
      }
      await checkpointSyncAbsFrameBudget(invocationContext, `rebuild.${existingBlock.type}.child`);
    }
  }
  
  // console.log(`    ✅ 子树重建完成: ${existingBlock.type}`);
  return { failedBlocks };
}

// =============================================================================
// 保护块类型定义
// =============================================================================

/**
 * 受保护的根块类型集合
 * 
 * 这些块在增量更新时不会被删除，只会清空/重建其内部子块：
 * - arduino_global: 全局代码块
 * - arduino_setup: setup() 函数块
 * - arduino_loop: loop() 函数块
 * 
 * 保护原因：
 * 1. 这些是 Arduino 项目的核心结构块，用户无法从工具箱手动添加
 * 2. 如果用户在 AI 加载过程中暂停，这些块消失后用户无法继续编程
 * 3. 保留这些块可以提供更好的用户体验和容错性
 */
const PROTECTED_ROOT_BLOCKS = new Set(['arduino_global', 'arduino_setup', 'arduino_loop']);

/**
 * 增量更新工作区（细粒度版本）
 * 
 * 策略（三阶段匹配）：
 * 1. 精确匹配：签名完全相同的块直接保留
 * 2. 类型匹配：同类型的块进行递归更新
 * 3. 清理/添加：删除无匹配的旧块，添加无匹配的新块
 * 
 * 🆕 保护机制：arduino_global、arduino_setup、arduino_loop 块不会被删除
 * 
 * 返回操作统计
 */
async function incrementalUpdate(
  workspace: any,
  newBlocks: any[],
  variableNameToId: Map<string, string>,
  preprocessVariableReferences: (config: any, mapping: Map<string, string>) => void,
  invocationContext?: SyncAbsInvocationContext,
): Promise<{
  added: number;
  removed: number;
  unchanged: number;
  failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }>;
}> {
  const failedBlocks: Array<{ blockType: string; error: string; suggestion?: string }> = [];
  
  // 获取当前工作区的根块
  const currentRootBlocks = getWorkspaceRootBlocks(workspace);
  // console.log(`\n${'='.repeat(60)}`);
  // console.log(`📊 增量更新开始`);
  // console.log(`${'='.repeat(60)}`);
  // console.log(`📋 当前工作区有 ${currentRootBlocks.length} 个根块:`);
  for (const item of currentRootBlocks) {
    // console.log(`   📦 ${item.serialized.type} (ID: ${item.block.id})`);
  }
  
  // 为新块计算签名并创建索引映射
  const newBlocksWithInfo = newBlocks.map((config, index) => ({
    config,
    index,
    signature: computeBlockChainSignature(config),
    type: config.type
  }));
  // console.log(`� 新 ABS 有 ${newBlocksWithInfo.length} 个根块:`);
  for (const item of newBlocksWithInfo) {
    // console.log(`   📄 ${item.type} (索引: ${item.index})`);
  }
  // console.log(`${'─'.repeat(60)}`);
  
  // 跟踪统计
  let addedCount = 0;
  let removedCount = 0;
  let unchangedCount = 0;
  let updatedCount = 0;
  
  // 已处理的块（避免重复处理）
  const processedExistingBlocks = new Set<string>();
  const processedNewBlocks = new Set<number>();
  
  // 🆕 追踪所有应保留在工作区的块 ID
  // 用于最终清理阶段，移除上次导入失败残留的孤立块
  const validBlockIds = new Set<string>();
  
  // 🔧 受保护块不再盲目全部加入 validBlockIds
  // 每种类型只保留一个，多余的实例交由 Phase 6 清理
  // 实际有效的受保护块会在 Phase 1/2a/3/4 中按需加入
  
  // ============ 阶段 1：精确签名匹配 ============
  // 签名完全相同的块直接保留，无需任何操作
  // console.log(`🔍 阶段 1: 精确签名匹配`);
  
  // 输出签名对比信息
  // console.log(`  📝 签名对比:`);
  for (const currentItem of currentRootBlocks) {
    const matchingByType = newBlocksWithInfo.find(n => n.type === currentItem.serialized.type);
    if (matchingByType) {
      const sigMatch = currentItem.signature === matchingByType.signature;
      // console.log(`  ${sigMatch ? '✅' : '❌'} ${currentItem.serialized.type}:`);
      if (!sigMatch) {
        // 找出签名差异位置
        const currentSig = currentItem.signature;
        const newSig = matchingByType.signature;
        let diffPos = 0;
        for (let i = 0; i < Math.min(currentSig.length, newSig.length); i++) {
          if (currentSig[i] !== newSig[i]) {
            diffPos = i;
            break;
          }
        }
        // console.log(`     差异位置: ${diffPos}`);
        // console.log(`     当前 [${diffPos}-${diffPos+100}]: ...${currentSig.substring(diffPos, diffPos + 100)}...`);
        // console.log(`     新块 [${diffPos}-${diffPos+100}]: ...${newSig.substring(diffPos, diffPos + 100)}...`);
        
        // 🆕 详细输出第一个子块的字段对比，帮助调试
        const currentFirstChild = findFirstChildBlock(currentItem.serialized);
        const newFirstChild = findFirstChildBlock(matchingByType.config);
        if (currentFirstChild || newFirstChild) {
          // console.log(`     🔍 第一个子块字段对比:`);
          // console.log(`        工作区: type=${currentFirstChild?.type}, fields=${JSON.stringify(currentFirstChild?.fields)}`);
          // console.log(`        ABS文件: type=${newFirstChild?.type}, fields=${JSON.stringify(newFirstChild?.fields)}`);
        }
      }
    }
  }
  
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    
    // 查找签名完全匹配的新块
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.signature === currentItem.signature
    );
    
    if (matchingNewBlock) {
      // console.log(`  ✅ 精确匹配: ${currentItem.serialized.type} (${currentItem.block.id})`);
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      validBlockIds.add(currentItem.block.id);
      unchangedCount++;
    }
  }
  
  // 定义需要最后处理的块类型
  const loadLastTypes = new Set(['arduino_setup', 'arduino_loop']);
  
  // ============ 阶段 2：处理所有非 setup/loop 块 ============
  // 先重建/添加独立块（如 custom_function_def），确保其 mutator 先注册
  // console.log(`🔍 阶段 2: 处理非 setup/loop 块`);
  
  // 2a: 非 setup/loop 的类型匹配重建
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    const currentType = currentItem.serialized.type;
    if (loadLastTypes.has(currentType)) continue; // setup/loop 跳过，等阶段 3
    
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.type === currentType
    );
    
    if (matchingNewBlock) {
      // console.log(`  🔄 类型匹配，重建子树: ${currentType}`);
      try {
          const rebuildResult = await rebuildBlockChildren(
            workspace, currentItem.block, matchingNewBlock.config,
            variableNameToId, preprocessVariableReferences,
            invocationContext,
          );
        if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
        // console.log(`    ✅ 子树重建成功: ${currentType}`);
      } catch (error) {
        debugSyncAbsImportIssue(`Subtree rebuild failed: ${currentType}`, error);
        failedBlocks.push({ blockType: currentType, error: error instanceof Error ? error.message : String(error) });
      }
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      validBlockIds.add(currentItem.block.id);
      updatedCount++;
    }
    await checkpointSyncAbsFrameBudget(invocationContext, `incremental.rebuild-root.${currentType}`);
  }
  
  // 2b: 添加所有未匹配的非 setup/loop 新块
  await checkpointSyncAbsFrameBudget(invocationContext, 'incremental.phase-2b');
  let yPosition = 30;
  const calcYPosition = () => {
    let y = 30;
    for (const block of workspace.getTopBlocks(false)) {
      const bounds = block.getBoundingRectangle();
      if (bounds) y = Math.max(y, bounds.bottom + 50);
    }
    return y;
  };
  yPosition = calcYPosition();
  
  const newNonSetupBlocks = newBlocksWithInfo.filter(
    item => !processedNewBlocks.has(item.index) && !loadLastTypes.has(item.type)
  );
  for (const newItem of newNonSetupBlocks) {
    const config = newItem.config;
    // console.log(`  ➕ 添加新块: ${config.type}`);
    const configWithPosition = { ...config, position: { x: 30, y: yPosition } };
    preprocessVariableReferences(configWithPosition, variableNameToId);
    try {
      const result = await createBlockFromConfig(workspace, configWithPosition, undefined, invocationContext);
      if (result.block) {
        addedCount++;
        validBlockIds.add(result.block.id);
        const bounds = result.block.getBoundingRectangle();
        yPosition = bounds ? bounds.bottom + 50 : yPosition + 100;
      }
      if (result.failedBlocks?.length) failedBlocks.push(...result.failedBlocks);
      processedNewBlocks.add(newItem.index);
    } catch (error) {
      debugSyncAbsImportIssue(`Adding block failed: ${config.type}`, error);
      failedBlocks.push({ blockType: config.type, error: error instanceof Error ? error.message : String(error) });
    }
    await checkpointSyncAbsFrameBudget(invocationContext, `incremental.add.${config.type}`);
  }
  
  // ============ 阶段 3：处理 setup/loop 块 ============
  // 所有独立块已就绪，现在重建 setup/loop 子树
  await checkpointSyncAbsFrameBudget(invocationContext, 'incremental.phase-3');
  // console.log(`🔍 阶段 3: 处理 setup/loop 块`);
  
  for (const currentItem of currentRootBlocks) {
    if (processedExistingBlocks.has(currentItem.block.id)) continue;
    const currentType = currentItem.serialized.type;
    if (!loadLastTypes.has(currentType)) continue;
    
    const matchingNewBlock = newBlocksWithInfo.find(
      newItem => !processedNewBlocks.has(newItem.index) && newItem.type === currentType
    );
    
    if (matchingNewBlock) {
      // console.log(`  🔄 重建 ${currentType} 子树`);
      try {
          const rebuildResult = await rebuildBlockChildren(
            workspace, currentItem.block, matchingNewBlock.config,
            variableNameToId, preprocessVariableReferences,
            invocationContext,
          );
        if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
        // console.log(`    ✅ ${currentType} 子树重建成功`);
      } catch (error) {
        debugSyncAbsImportIssue(`Subtree rebuild failed: ${currentType}`, error);
        failedBlocks.push({ blockType: currentType, error: error instanceof Error ? error.message : String(error) });
      }
      processedExistingBlocks.add(currentItem.block.id);
      processedNewBlocks.add(matchingNewBlock.index);
      validBlockIds.add(currentItem.block.id);
      updatedCount++;
    }
    await checkpointSyncAbsFrameBudget(invocationContext, `incremental.rebuild-setup.${currentType}`);
  }
  
  // 输出匹配后的状态
  // console.log(`${'─'.repeat(60)}`);
  // console.log(`📊 匹配结果:`);
  // console.log(`   已匹配的工作区块: ${[...processedExistingBlocks].join(', ') || '无'}`);
  // console.log(`   已匹配的新块索引: ${[...processedNewBlocks].join(', ') || '无'}`);
  // console.log(`   未匹配的工作区块:`);
  for (const item of currentRootBlocks) {
    if (!processedExistingBlocks.has(item.block.id)) {
      // console.log(`      ⚠️ ${item.serialized.type} (ID: ${item.block.id})`);
    }
  }
  // console.log(`   未匹配的新块:`);
  for (const item of newBlocksWithInfo) {
    if (!processedNewBlocks.has(item.index)) {
      // console.log(`      ⚠️ ${item.type} (索引: ${item.index})`);
    }
  }
  // console.log(`${'─'.repeat(60)}`);
  
  // ============ 阶段 4：删除无匹配的旧块（保护关键块）============
  await checkpointSyncAbsFrameBudget(invocationContext, 'incremental.phase-4');
  // console.log(`🔍 阶段 4: 清理无匹配的旧块（保留受保护块）`);
  
  for (const item of currentRootBlocks) {
    if (!processedExistingBlocks.has(item.block.id)) {
      const blockType = item.serialized.type;
      
      // 🆕 保护机制：对于受保护的根块，不删除块本身
      if (PROTECTED_ROOT_BLOCKS.has(blockType)) {
        // 查找 ABS 中是否有这个块类型的未处理配置
        const matchingNewConfig = newBlocksWithInfo.find(
          newItem => !processedNewBlocks.has(newItem.index) && newItem.type === blockType
        );
        
        if (matchingNewConfig) {
          // ABS 中有该块的配置，重建子块
          // console.log(`  🛡️ 保留受保护块: ${blockType} (ID: ${item.block.id})，使用 ABS 配置重建子块`);
          try {
            const rebuildResult = await rebuildBlockChildren(
              workspace, item.block, matchingNewConfig.config,
              variableNameToId, preprocessVariableReferences,
              invocationContext,
            );
            if (rebuildResult.failedBlocks?.length) failedBlocks.push(...rebuildResult.failedBlocks);
          } catch (error) {
            debugSyncAbsImportIssue(`Protected block child rebuild failed: ${blockType}`, error);
            failedBlocks.push({ blockType: blockType, error: error instanceof Error ? error.message : String(error) });
          }
          processedNewBlocks.add(matchingNewConfig.index);
          validBlockIds.add(item.block.id);
        } else {
          // ABS 中没有该块的配置
          // 检查是否已有同类型的有效块（Phase 1/2a/3 已匹配的）
          const alreadyHasValid = currentRootBlocks.some(
            i => i.serialized.type === blockType && validBlockIds.has(i.block.id)
          );
          if (alreadyHasValid) {
            // 已有同类型有效块，这是重复块，直接删除
            // console.log(`  🗑️ 删除重复受保护块: ${blockType} (ID: ${item.block.id})`);
            try {
              runWithBlocklyEventsDisabled(() => {
                item.block.dispose(true);
                removedCount++;
              });
            } catch (e) {
              debugSyncAbsImportIssue(`Deleting duplicate protected block failed: ${blockType}`, e);
            }
            processedExistingBlocks.add(item.block.id);
            await checkpointSyncAbsFrameBudget(invocationContext, `incremental.cleanup-duplicate-protected.${blockType}`);
            continue;
          }
          // 没有同类型有效块，保留此块（清空子块）
          // console.log(`  🛡️ 保留受保护块: ${blockType} (ID: ${item.block.id})，清空其子块`);
          try {
            // 清空受保护块的所有子块。短事务 + 批次 checkpoint，避免大块
            // workspace mutation 抢占聊天流式渲染。
            let clearedChildCount = 0;
            for (const input of item.block.inputList || []) {
              if (input.connection?.isConnected()) {
                const child = input.connection.targetBlock();
                if (child && !child.isShadow()) {
                  throwIfSyncAbsCancelled(invocationContext);
                  runWithBlocklyEventsDisabled(() => {
                    input.connection.disconnect();
                    child.dispose(true);
                    clearedChildCount++;
                  });
                  if (clearedChildCount % 4 === 0) {
                    await checkpointSyncAbsFrameBudget(invocationContext, `incremental.cleanup-protected-children.${blockType}`);
                  }
                }
              }
            }
          } catch (e) {
            debugSyncAbsImportIssue(`Clearing protected block children failed: ${blockType}`, e);
          }
          validBlockIds.add(item.block.id);
        }
        // 标记为已处理，避免后续再次删除
        processedExistingBlocks.add(item.block.id);
        await checkpointSyncAbsFrameBudget(invocationContext, `incremental.cleanup-protected.${blockType}`);
        continue;
      }
      
      // console.log(`  🗑️ 删除无匹配块: ${blockType} (ID: ${item.block.id})`);
      try {
        runWithBlocklyEventsDisabled(() => {
          item.block.dispose(true);
          removedCount++;
        });
      } catch (e) {
        debugSyncAbsImportIssue(`Deleting unmatched block failed: ${blockType}`, e);
      }
      await checkpointSyncAbsFrameBudget(invocationContext, `incremental.cleanup.${blockType}`);
    }
  }
  
  // ============ 阶段 5：添加剩余未匹配的新块 ============
  const remainingNewItems = newBlocksWithInfo.filter(item => !processedNewBlocks.has(item.index));
  if (remainingNewItems.length > 0) {
    // console.log(`🔍 阶段 5: 添加剩余新块 (${remainingNewItems.length} 个)`);
    yPosition = calcYPosition();
    
    for (const newItem of remainingNewItems) {
      const config = newItem.config;
      // console.log(`  ➕ 添加新块: ${config.type}`);
      const configWithPosition = { ...config, position: { x: 30, y: yPosition } };
      preprocessVariableReferences(configWithPosition, variableNameToId);
      try {
        const result = await createBlockFromConfig(workspace, configWithPosition, undefined, invocationContext);
        if (result.block) {
          addedCount++;
          validBlockIds.add(result.block.id);
          const bounds = result.block.getBoundingRectangle();
          yPosition = bounds ? bounds.bottom + 50 : yPosition + 100;
        }
        if (result.failedBlocks?.length) failedBlocks.push(...result.failedBlocks);
      } catch (error) {
        debugSyncAbsImportIssue(`Adding block failed: ${config.type}`, error);
        failedBlocks.push({ blockType: config.type, error: error instanceof Error ? error.message : String(error) });
      }
      await checkpointSyncAbsFrameBudget(invocationContext, `incremental.add-remaining.${config.type}`);
    }
  }
  
  // console.log(`📊 增量更新完成: 精确匹配 ${unchangedCount}, 递归更新 ${updatedCount}, 删除 ${removedCount}, 添加 ${addedCount}`);
  
  // ============ 阶段 6：最终清理 - 移除所有未被本次导入处理的残留根块 ============
  // 基于 validBlockIds 集合进行清理，而不是类型计数
  // 这样可以可靠地移除上次导入失败残留的孤立块
  // console.log(`🔍 阶段 6: 最终清理残留块 (基于 ID 追踪)`);
  
  const currentTopBlocks = workspace.getTopBlocks(false);
  const residualBlocks: any[] = [];
  
  for (const block of currentTopBlocks) {
    if (!validBlockIds.has(block.id)) {
      residualBlocks.push(block);
    }
  }
  const cleanupCount = await disposeBlocklyBlocksInBatches(
    residualBlocks,
    invocationContext,
    'incremental.cleanup-residual',
  );
  if (cleanupCount > 0) {
    // console.log(`  ✅ 清理了 ${cleanupCount} 个残留块`);
    removedCount += cleanupCount;
  }
  
  // 终端刷新工作区，确保视觉状态正确；只渲染顶层块树，避免对子块重复 render。
  try {
    await refreshBlocklyWorkspaceRenderInBatches(workspace, invocationContext, 'incremental.workspace-render');
    // console.log(`🎨 工作区渲染刷新完成`);
  } catch (e) {
    debugSyncAbsImportIssue('Workspace render refresh failed', e);
  }
  
  return {
    added: addedCount,
    removed: removedCount,
    unchanged: unchangedCount + updatedCount, // 更新也算作"保留"
    failedBlocks
  };
}
