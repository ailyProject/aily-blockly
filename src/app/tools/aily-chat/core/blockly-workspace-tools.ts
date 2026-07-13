import type { IToolContribution } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';

import { AilyHost } from './host';
import { analyzeLibraryBlocksTool } from '../tools/editBlockTool';
import { syncAbsFileHandler } from '../tools/syncAbsFileTool';
import { isAilyCategoryDebugEnabled } from './chat-debug-flags';
import {
  createToolCallProgressEditorOperationSink,
  type EditorOperationEventSink,
} from '../tools/editorOperationEvents';
import { getSharedBlocklyEditorOperationQueue } from '../tools/blocklyEditorOperationQueue';
import type { EditingTimelineWriter } from '../services/editing-timeline-recording-bridge';
import { error, fromToolResult, text, type InvokeHandler } from './blockly-contributed-tool-runtime';

type DeferredFactory = (group: string, reason: string) => { group: string; reason: string };
type HostExecutionBoundary = {
  runOutsideAngular?<T>(operation: () => Promise<T> | T): Promise<T> | T;
};
type RuntimeScopedToolContribution = IToolContribution & {
  readonly toolSet?: string;
  readonly runtimeModes?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
  isConcurrencySafe?(input: unknown): boolean;
};

function createLintCodeFingerprint(code: string): string {
  let hash = 2166136261;
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getLintSketchFileDebugInfo(host: ReturnType<typeof AilyHost.get>, projectPath: string): {
  sketchFilePath?: string;
  exists: boolean;
  modifiedAt?: string;
} {
  if (!projectPath || !host.path || !host.fs) {
    return { exists: false };
  }

  try {
    const sketchFilePath = host.path.join(projectPath, '.temp', 'sketch', 'sketch.ino');
    if (!host.fs.existsSync(sketchFilePath)) {
      return { sketchFilePath, exists: false };
    }

    const stat = host.fs.statSync?.(sketchFilePath);
    return {
      sketchFilePath,
      exists: true,
      modifiedAt: stat?.mtime instanceof Date ? stat.mtime.toISOString() : undefined,
    };
  } catch {
    return { exists: false };
  }
}

function readHostAPIProjectPath(hostAPI: IExternalHostAPI): string {
  const project = hostAPI.project as (NonNullable<IExternalHostAPI['project']> & Record<string, unknown>) | undefined;
  const currentProjectPath = typeof project?.['currentProjectPath'] === 'string'
    ? project['currentProjectPath'].trim()
    : '';
  if (currentProjectPath) {
    return currentProjectPath;
  }

  const getProjectPath = project?.['getProjectPath'];
  if (typeof getProjectPath === 'function') {
    const projectPath = String(getProjectPath.call(project) ?? '').trim();
    if (projectPath) {
      return projectPath;
    }
  }

  return typeof project?.['projectRootPath'] === 'string'
    ? project['projectRootPath'].trim()
    : '';
}

function resolveLintSourceCode(host: ReturnType<typeof AilyHost.get>, projectPath: string): string {
  const inMemoryCode = host.editor?.getGeneratedCode?.() || '';
  if (inMemoryCode.trim()) {
    return inMemoryCode;
  }

  if (!projectPath || !host.fs || !host.path) {
    return '';
  }

  try {
    const sketchFilePath = host.path.join(projectPath, '.temp', 'sketch', 'sketch.ino');
    if (!host.fs.existsSync(sketchFilePath)) {
      return '';
    }

    const sketchCode = host.fs.readFileSync(sketchFilePath, 'utf-8');
    return typeof sketchCode === 'string' ? sketchCode : '';
  } catch {
    return '';
  }
}

function resolveLintSource(host: ReturnType<typeof AilyHost.get>, projectPath = ''): {
  generatedCode: string;
  inMemoryCode: string;
  source: 'editor-memory' | 'project-sketch-file' | 'none';
  sketchDebugInfo: ReturnType<typeof getLintSketchFileDebugInfo>;
} {
  const sketchDebugInfo = getLintSketchFileDebugInfo(host, projectPath);
  const inMemoryCode = host.editor?.getGeneratedCode?.() || '';
  if (inMemoryCode.trim()) {
    return {
      generatedCode: inMemoryCode,
      inMemoryCode,
      source: 'editor-memory',
      sketchDebugInfo,
    };
  }

  const generatedCode = resolveLintSourceCode({
    ...host,
    editor: undefined,
  } as ReturnType<typeof AilyHost.get>, projectPath);
  return {
    generatedCode,
    inMemoryCode,
    source: sketchDebugInfo.exists ? 'project-sketch-file' : 'none',
    sketchDebugInfo,
  };
}

function isBlocklyWorkspaceTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceBlocklyWorkspace', [
    '__AILY_CHAT_TRACE_BLOCKLY_WORKSPACE__',
    'AILY_CHAT_TRACE_BLOCKLY_WORKSPACE',
  ]);
}

function isAbortLikeError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return err instanceof Error && (err.name === 'AbortError' || /cancelled|canceled|aborted/i.test(err.message));
}

export interface BlocklyWorkspaceToolOverrides {
  syncAbsHandler?: typeof syncAbsFileHandler;
}

function makeSyncAbsContribution(): RuntimeScopedToolContribution {
  return {
    name: 'syncAbs',
    toolSet: 'blockly-workspace',
    description: 'Sync ABS (Aily Block Syntax) between text file and Blockly workspace',
    prompt: `Use this tool to sync ABS code with the Blockly workspace. ABS is the text-based DSL that replaces Blockly XML manipulation.

Actions:
- "export": Export the current Blockly workspace as ABS text. Use this to read the current program.
- "import": Import ABS text into the Blockly workspace. Use this after editing the .abs file with edit_file.
- "status": Check sync status between the ABS file and workspace.

Typical workflow:
1. syncAbs action="export" → saves workspace content to .abs file
2. read_file the .abs file
3. edit_file to modify the .abs content
4. syncAbs action="import" → applies changes back to workspace`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['export', 'import', 'status'], description: 'Action to perform' },
        content: { type: 'string', description: 'ABS content to import (required for import action)' },
      },
      required: ['action'],
    },
    annotations: { readOnly: false },
    runtimeModes: ['blockly'],
    requiredCapabilities: ['runtime:blockly'],
  };
}

function makeLintContribution(): RuntimeScopedToolContribution {
  return {
    name: 'lint',
    toolSet: 'blockly-workspace',
    description: 'Run syntax check (lint) on the generated Arduino C++ code',
    prompt: `Use this tool to check the generated Arduino C++ code for syntax errors and warnings.
Similar to a compile check, but faster — uses ast-grep based static analysis.
Returns errors, warnings, and notes found in the code.

Use this after editing ABS blocks to verify the generated code is syntactically correct before building.`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnly: true },
    runtimeModes: ['blockly'],
    requiredCapabilities: ['runtime:blockly'],
  };
}

function makeAnalyzeLibraryContribution(createDeferred: DeferredFactory): RuntimeScopedToolContribution {
  return {
    name: 'analyzeLibrary',
    toolSet: 'blockly-library',
    description: 'Analyze library block definitions and generate ABS format documentation',
    prompt: 'Use this tool to inspect an installed library. mode="auto" prefers readme_ai.md references when available and falls back to block analysis only for libraries without readme_ai.md. mode="readme_ref" returns only readme_ai.md references. mode="analysis" always returns block analysis. The metadata also reports whether the library has readme_ai.md and, when available, the readme path.',
    inputSchema: {
      type: 'object',
      properties: {
        libraryId: { type: 'string', description: 'Library package ID (e.g., "lib-servo")' },
        mode: {
          type: 'string',
          enum: ['auto', 'readme_ref', 'analysis'],
          default: 'auto',
          description: 'auto prefers readme references, readme_ref returns only readme paths, analysis forces block analysis',
        },
      },
      required: ['libraryId'],
    },
    annotations: { readOnly: true },
    isConcurrencySafe: () => false,
    runtimeModes: ['blockly'],
    requiredCapabilities: ['runtime:blockly'],
    agentScope: ['main'],
    deferred: createDeferred('blockly-library-discovery', '库定义分析属于低频查询能力'),
  };
}

export function appendBlocklyWorkspaceContributions(
  contributions: IToolContribution[],
  hostAPI: IExternalHostAPI,
  createDeferred: DeferredFactory,
): void {
  if (hostAPI.blockly?.exportAbs) {
    contributions.push(makeSyncAbsContribution());
    contributions.push(makeLintContribution());
  }

  if (hostAPI.blockly?.analyzeBlocks) {
    contributions.push(makeAnalyzeLibraryContribution(createDeferred));
  }
}

export function createBlocklyWorkspaceHandlers(
  overrides?: BlocklyWorkspaceToolOverrides,
): Record<string, InvokeHandler> {
  const syncAbsHandler = overrides?.syncAbsHandler ?? syncAbsFileHandler;

  return {
    syncAbs: async (input, hostAPI, invocationContext) => {
      const host = AilyHost.get();
      if (!host.absSync && !host.editor) return error('ABS editor is not available in this environment.');
      if (!hostAPI.project) return error('Project context is not available for ABS sync.');
      const editingTimeline = invocationContext?.host?.getExtension<EditingTimelineWriter>('editingTimeline');
      const forwardedEditorOperationEvents = invocationContext?.host?.getExtension<EditorOperationEventSink>('editorOperationEvents');
      const hostExecutionBoundary = invocationContext?.host?.getExtension<HostExecutionBoundary>('hostExecutionBoundary');
      const editorOperationProgress = createToolCallProgressEditorOperationSink({
        emitEvent: invocationContext?.emitEvent,
        trace: invocationContext?.trace,
        forwardTo: forwardedEditorOperationEvents,
      });
      const result = await syncAbsHandler(
        {
          operation: input['action'] as 'export' | 'import' | 'status',
          pendingAbsContent: typeof input['content'] === 'string' ? input['content'] : undefined,
        },
        hostAPI.project as any,
        host.electron as any,
        host.absSync as any,
        {
          sessionId: invocationContext?.sessionId,
          turnId: invocationContext?.trace?.turnId,
          toolCallId: invocationContext?.toolCallId,
          signal: invocationContext?.signal,
          timelineWriter: editingTimeline,
          progressSink: editorOperationProgress,
          runOutsideAngular: hostExecutionBoundary?.runOutsideAngular,
        },
      );
      return fromToolResult(result);
    },

    lint: async (_input, hostAPI, invocationContext) => {
      try {
        const lintGeneratedCode = (hostAPI.blockly as { lintGeneratedCode?: (code: string, options?: Record<string, unknown>) => Promise<any> } | undefined)
          ?.lintGeneratedCode;
        if (typeof lintGeneratedCode !== 'function') return error('Arduino lint service is not available.');

        const host = AilyHost.get();
        const hostExecutionBoundary = invocationContext?.host?.getExtension<HostExecutionBoundary>('hostExecutionBoundary');
        const forwardedEditorOperationEvents = invocationContext?.host?.getExtension<EditorOperationEventSink>('editorOperationEvents');
        const editorOperationProgress = createToolCallProgressEditorOperationSink({
          emitEvent: invocationContext?.emitEvent,
          trace: invocationContext?.trace,
          forwardTo: forwardedEditorOperationEvents,
        });

        return await getSharedBlocklyEditorOperationQueue().enqueue(
          'blockly.lint',
          'Run Blockly generated-code lint',
          async reportProgress => {
            await reportProgress({ summary: 'Resolving generated code', progress: 0.2 });
            const projectPath = readHostAPIProjectPath(hostAPI);
            const {
              generatedCode,
              inMemoryCode,
              source,
              sketchDebugInfo,
            } = resolveLintSource(host, projectPath);
            if (isBlocklyWorkspaceTraceEnabled()) {
              console.info('[BlocklyLintTool] lint source resolved', {
                source,
                length: generatedCode.length,
                fingerprint: createLintCodeFingerprint(generatedCode),
                inMemoryLength: inMemoryCode.length,
                inMemoryFingerprint: inMemoryCode ? createLintCodeFingerprint(inMemoryCode) : undefined,
                sketchFilePath: sketchDebugInfo.sketchFilePath,
                sketchFileExists: sketchDebugInfo.exists,
                sketchFileModifiedAt: sketchDebugInfo.modifiedAt,
              });
            }
            if (!generatedCode.trim()) return text('No generated code to lint (workspace is empty).');

            await reportProgress({ summary: 'Running lint', progress: 0.7 });
            const startTime = Date.now();
            const result = await lintGeneratedCode(generatedCode, {
              mode: 'ast-grep',
              format: 'json',
            });
            const duration = Date.now() - startTime;

            const lintResult: Record<string, unknown> = {
              isValid: result.success && (result.errors?.length ?? 0) === 0,
              errors: result.errors || [],
              warnings: result.warnings || [],
              notes: result.notes || [],
              duration,
              source,
              generatedCodeLength: generatedCode.length,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(lintResult, null, 2) }],
              metadata: {
                blocklyLint: {
                  source,
                  generatedCodeLength: generatedCode.length,
                  duration,
                },
              },
            };
          },
          {
            sessionId: invocationContext?.sessionId,
            turnId: invocationContext?.trace?.turnId,
            toolCallId: invocationContext?.toolCallId,
            signal: invocationContext?.signal,
            progressSink: editorOperationProgress,
            runOutsideAngular: hostExecutionBoundary?.runOutsideAngular,
          },
        );
      } catch (err) {
        if (isAbortLikeError(err, invocationContext?.signal)) {
          throw err;
        }
        return error(`Lint failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    analyzeLibrary: async (input, hostAPI) => {
      const project = hostAPI.project;
      if (!project) {
        return error('Project context is not available for library analysis.');
      }
      const result = await analyzeLibraryBlocksTool(
        project as any,
        {
          libraryNames: [input['libraryId'] as string],
          mode: (input['mode'] as 'auto' | 'readme_ref' | 'analysis' | undefined) ?? 'auto',
        },
      );
      return fromToolResult(result);
    },
  };
}
