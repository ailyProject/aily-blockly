import { projectDataRuntime } from '../../../../services/project-data/project-data-runtime';
import { extractStructuredAbsValues } from '../../../../services/project-data/project-data-abs';
import { AilyDataRef, AilyDataStorageEncoding, isAilyDataRef } from '../../../../services/project-data/project-data.types';
import { IAilyTool, ToolContext, ToolSchema, ToolUseResult } from '../../core/tool-types';
import { ToolRegistry } from '../../core/tool-registry';
import * as Blockly from 'blockly';

const REF_SCHEMA = { type: 'object', description: '完整的 $ailyData 引用对象' };

abstract class ProjectDataTool implements IAilyTool {
  abstract readonly name: string;
  abstract readonly schema: ToolSchema;
  readonly environment = 'gui' as const;

  abstract invoke(args: any, ctx: ToolContext): Promise<ToolUseResult>;

  getStartText(): string { return '处理项目大数据资源...'; }
  getResultText(_args: any, result?: ToolUseResult): string {
    return result?.is_error ? '项目大数据资源操作失败' : '项目大数据资源操作完成';
  }

  protected success(value: unknown): ToolUseResult {
    return { is_error: false, content: JSON.stringify(value, null, 2) };
  }

  protected failure(error: unknown): ToolUseResult {
    return { is_error: true, content: error instanceof Error ? error.message : String(error) };
  }
}

class InspectProjectDataTool extends ProjectDataTool {
  readonly name = 'inspect_project_data';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '校验项目大数据引用并返回元数据和简短摘要。二进制内容不会进入上下文。',
    input_schema: {
      type: 'object',
      properties: { ref: REF_SCHEMA },
      required: ['ref'],
    },
    agents: ['mainAgent'],
  };

  async invoke(args: any): Promise<ToolUseResult> {
    try {
      const ref = requireRef(args?.ref);
      const inspection = await projectDataRuntime.getStore().inspect(ref);
      const summary: Record<string, unknown> = { ...inspection, ref };
      if (inspection.valid && ref.$ailyData.logicalType === 'text') {
        const text = await projectDataRuntime.resolve<string>(ref);
        summary['textPreview'] = text.slice(0, 512);
        summary['truncated'] = text.length > 512;
      } else if (inspection.valid && ref.$ailyData.logicalType === 'json') {
        const value = await projectDataRuntime.resolve<unknown>(ref);
        summary['jsonSummary'] = summarizeJson(value);
      }
      return this.success(summary);
    } catch (error) {
      return this.failure(error);
    }
  }
}

class ReadProjectTextTool extends ProjectDataTool {
  readonly name = 'read_project_text';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '按字符范围读取 utf8-v1 项目文本资源，单次最多 65536 字符。',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        offset: { type: 'integer', minimum: 0, default: 0 },
        length: { type: 'integer', minimum: 1, maximum: 65536, default: 8192 },
      },
      required: ['ref'],
    },
    agents: ['mainAgent'],
  };

  async invoke(args: any): Promise<ToolUseResult> {
    try {
      const ref = requireRef(args?.ref);
      if (ref.$ailyData.logicalType !== 'text') throw new Error('The reference is not a text resource.');
      const text = await projectDataRuntime.resolve<string>(ref);
      const offset = clampInteger(args?.offset, 0, 0, text.length);
      const length = clampInteger(args?.length, 8192, 1, 65536);
      const end = Math.min(text.length, offset + length);
      return this.success({ offset, end, totalLength: text.length, text: text.slice(offset, end) });
    } catch (error) {
      return this.failure(error);
    }
  }
}

class ReadProjectJsonTool extends ProjectDataTool {
  readonly name = 'read_project_json';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '读取 canonical-json-v1 资源的指定 JSON Pointer，并对数组或对象分页。',
    input_schema: {
      type: 'object',
      properties: {
        ref: REF_SCHEMA,
        pointer: { type: 'string', default: '' },
        offset: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      required: ['ref'],
    },
    agents: ['mainAgent'],
  };

  async invoke(args: any): Promise<ToolUseResult> {
    try {
      const ref = requireRef(args?.ref);
      if (ref.$ailyData.logicalType !== 'json') throw new Error('The reference is not a JSON resource.');
      const root = await projectDataRuntime.resolve<unknown>(ref);
      const pointer = typeof args?.pointer === 'string' ? args.pointer : '';
      const value = getJsonPointer(root, pointer);
      const offset = clampInteger(args?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampInteger(args?.limit, 50, 1, 200);
      if (Array.isArray(value)) {
        return this.success({ pointer, offset, limit, total: value.length, items: value.slice(offset, offset + limit) });
      }
      if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>);
        return this.success({ pointer, offset, limit, total: entries.length, entries: entries.slice(offset, offset + limit) });
      }
      return this.success({ pointer, value });
    } catch (error) {
      return this.failure(error);
    }
  }
}

class ReplaceProjectDataTool extends ProjectDataTool {
  readonly name = 'replace_project_data';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '以 compare-and-swap 方式替换指定 Blockly 字段中的项目大数据引用。先写新资源，再更新字段。',
    input_schema: {
      type: 'object',
      properties: {
        blockId: { type: 'string' },
        fieldName: { type: 'string' },
        payloadPointer: { type: 'string', description: '字段状态内的 JSON Pointer；字段本身就是引用时传空字符串', default: '' },
        expectedRef: REF_SCHEMA,
        codec: { type: 'string', description: '默认沿用 expectedRef.codec' },
        storage: { type: 'string', enum: ['raw-v1', 'deflate-raw-v1'], default: 'raw-v1' },
        inputType: { type: 'string', enum: ['text', 'json', 'base64'] },
        value: { description: 'text 为字符串，json 为 JSON 值，base64 为纯 Base64 字符串' },
      },
      required: ['blockId', 'fieldName', 'expectedRef', 'inputType', 'value'],
    },
    agents: ['mainAgent'],
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    try {
      const expectedRef = requireRef(args?.expectedRef);
      const workspace = (ctx.host?.blockly as any)?.workspace;
      const block = workspace?.getBlockById?.(String(args?.blockId || ''));
      if (!block) throw new Error(`Block not found in the active workspace: ${args?.blockId}`);
      const field = block.getField?.(String(args?.fieldName || ''));
      if (!field) throw new Error(`Field not found: ${args?.fieldName}`);

      const originalValue = field.getValue?.();
      const wasString = typeof originalValue === 'string';
      const state = parseFieldState(originalValue);
      const pointer = typeof args?.payloadPointer === 'string' ? args.payloadPointer : '';
      const currentRef = getJsonPointer(state, pointer);
      if (!isAilyDataRef(currentRef) || currentRef.$ailyData.id !== expectedRef.$ailyData.id) {
        throw new Error('Project data compare-and-swap failed: the field no longer contains expectedRef.');
      }

      const codec = typeof args?.codec === 'string' && args.codec ? args.codec : expectedRef.$ailyData.codec;
      const storage = (args?.storage || 'raw-v1') as AilyDataStorageEncoding;
      const input = decodeToolInput(args?.inputType, args?.value);
      const nextRef = await projectDataRuntime.put({ codec, storage, value: input });
      const nextState = replaceJsonPointer(state, pointer, nextRef);
      field.setValue?.(wasString ? JSON.stringify(nextState) : nextState);
      block.render?.();
      return this.success({ blockId: block.id, fieldName: args.fieldName, payloadPointer: pointer, previousRef: expectedRef, ref: nextRef });
    } catch (error) {
      return this.failure(error);
    }
  }
}

class ProjectDataStatusTool extends ProjectDataTool {
  readonly name = 'project_data_status';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '统计当前项目数据资源占用、引用/未引用数量，并校验当前 ABI 与工作区引用。',
    input_schema: { type: 'object', properties: {} },
    agents: ['mainAgent'],
  };

  async invoke(_args: any, ctx: ToolContext): Promise<ToolUseResult> {
    try {
      const roots = collectProjectDataRoots(ctx);
      const refs = roots.flatMap((value) => projectDataRuntime.getStore().collectReferences(value));
      const [statistics, validation] = await Promise.all([
        projectDataRuntime.getStatistics(roots),
        projectDataRuntime.getStore().validateReferences(refs),
      ]);
      return this.success({ ...statistics, validation });
    } catch (error) {
      return this.failure(error);
    }
  }
}

class GarbageCollectProjectDataTool extends ProjectDataTool {
  readonly name = 'garbage_collect_project_data';
  readonly schema: ToolSchema = {
    name: this.name,
    description: '按 ABI、ABS 和当前 Blockly 工作区引用执行项目数据 GC。默认仅预览；正式清理默认保留 7 天宽限期。',
    input_schema: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', default: true },
        graceDays: { type: 'number', minimum: 0, maximum: 365, default: 7 },
      },
    },
    agents: ['mainAgent'],
  };

  async invoke(args: any, ctx: ToolContext): Promise<ToolUseResult> {
    try {
      const graceDays = Number.isFinite(Number(args?.graceDays))
        ? Math.min(365, Math.max(0, Number(args.graceDays)))
        : 7;
      const result = await projectDataRuntime.garbageCollect(collectProjectDataRoots(ctx), {
        dryRun: args?.dryRun !== false,
        gracePeriodMs: graceDays * 24 * 60 * 60 * 1000,
      });
      return this.success(result);
    } catch (error) {
      return this.failure(error);
    }
  }
}

function requireRef(value: unknown): AilyDataRef {
  if (!isAilyDataRef(value)) throw new Error('Invalid $ailyData reference.');
  return value;
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function summarizeJson(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { kind: 'array', length: value.length, preview: value.slice(0, 10) };
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return { kind: 'object', keyCount: keys.length, keys: keys.slice(0, 50) };
  }
  return { kind: typeof value, value };
}

function parseFieldState(value: unknown): unknown {
  if (typeof value !== 'string') return structuredClone(value);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('The target field does not contain JSON state.');
  }
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('JSON Pointer must be empty or start with /.');
  return pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getJsonPointer(root: unknown, pointer: string): unknown {
  let current = root;
  for (const segment of parsePointer(pointer)) {
    if (!current || typeof current !== 'object' || !(segment in (current as Record<string, unknown>))) {
      throw new Error(`JSON Pointer does not exist: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function replaceJsonPointer(root: unknown, pointer: string, value: unknown): unknown {
  if (pointer === '') return value;
  const clone = structuredClone(root);
  const segments = parsePointer(pointer);
  const property = segments.pop()!;
  let parent = clone as Record<string, unknown>;
  for (const segment of segments) {
    const next = parent?.[segment];
    if (!next || typeof next !== 'object') throw new Error(`JSON Pointer does not exist: ${pointer}`);
    parent = next as Record<string, unknown>;
  }
  if (!(property in parent)) throw new Error(`JSON Pointer does not exist: ${pointer}`);
  parent[property] = value;
  return clone;
}

function decodeToolInput(inputType: unknown, value: unknown): unknown {
  if (inputType === 'text') {
    if (typeof value !== 'string') throw new Error('Text input must be a string.');
    return value;
  }
  if (inputType === 'json') return value;
  if (inputType === 'base64') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
      throw new Error('Binary input must be canonical Base64.');
    }
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  throw new Error(`Unsupported inputType: ${String(inputType)}`);
}

function collectProjectDataRoots(ctx: ToolContext): unknown[] {
  const roots: unknown[] = [];
  const projectPath = projectDataRuntime.getStore().getProjectPath();
  const fsApi = window['fs'];
  const pathApi = window['path'];
  const abiPath = pathApi.join(projectPath, 'project.abi');
  if (fsApi.existsSync(abiPath)) {
    roots.push(JSON.parse(fsApi.readFileSync(abiPath, 'utf8')));
  }
  const absPath = pathApi.join(projectPath, 'project.abs');
  if (fsApi.existsSync(absPath)) {
    roots.push(...extractStructuredAbsValues(fsApi.readFileSync(absPath, 'utf8'), { strict: true }));
  }
  const workspace = (ctx.host?.blockly as any)?.workspace;
  if (workspace) {
    roots.push(Blockly.serialization.workspaces.save(workspace));
    roots.push((workspace as any).undoStack_ || []);
    roots.push((workspace as any).redoStack_ || []);
  }
  collectCheckpointRoots(fsApi, pathApi, pathApi.join(projectPath, '.aily_checkpoints'), roots);
  return roots;
}

function collectCheckpointRoots(
  fsApi: any,
  pathApi: any,
  directory: string,
  roots: unknown[],
  depth = 0,
): void {
  if (depth > 8) throw new Error(`Checkpoint directory exceeds the GC scan depth limit: ${directory}`);
  if (!fsApi.existsSync(directory) || typeof fsApi.readdirSync !== 'function') return;
  for (const name of fsApi.readdirSync(directory)) {
    const candidate = pathApi.join(directory, String(name));
    try {
      const stat = fsApi.statSync(candidate);
      const isDirectory = typeof stat?.isDirectory === 'function'
        ? stat.isDirectory()
        : Boolean(stat?._isDirectory);
      if (isDirectory) {
        collectCheckpointRoots(fsApi, pathApi, candidate, roots, depth + 1);
        continue;
      }
      const isFile = typeof stat?.isFile === 'function' ? stat.isFile() : Boolean(stat?._isFile);
      if (!isFile) continue;
      if (Number(stat?.size || 0) > 64 * 1024 * 1024) {
        throw new Error(`Checkpoint file exceeds the GC scan size limit: ${candidate}`);
      }
      const content = fsApi.readFileSync(candidate, 'utf8');
      if (typeof content !== 'string' || !content.includes('$ailyData')) continue;
      if (content.trim().startsWith('{')) roots.push(content);
      else roots.push(...extractStructuredAbsValues(content, { strict: true }));
    } catch (error) {
      // Checkpoints can be concurrently rotated. Only ignore entries that
      // actually disappeared; any unreadable live root must abort safe GC.
      if (fsApi.existsSync(candidate)) throw error;
    }
  }
}

ToolRegistry.register(new InspectProjectDataTool());
ToolRegistry.register(new ReadProjectTextTool());
ToolRegistry.register(new ReadProjectJsonTool());
ToolRegistry.register(new ReplaceProjectDataTool());
ToolRegistry.register(new ProjectDataStatusTool());
ToolRegistry.register(new GarbageCollectProjectDataTool());
