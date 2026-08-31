import * as Blockly from 'blockly';

import type { HostToolResult } from './host-tool-result';

export interface CreateBlockInput {
  readonly type: string;
  readonly id?: string;
  readonly fields?: Record<string, unknown>;
  readonly extraState?: Record<string, unknown>;
  readonly position?: { x: number; y: number };
  readonly connect?: Omit<ConnectBlockInput, 'block'>;
}

export interface ConnectBlockInput {
  readonly block: string;
  readonly target: string;
  readonly action: 'chain_after' | 'put_into' | 'set_as_input';
  readonly input?: string;
  readonly moveWithChain?: boolean;
}

export function createBlock(
  workspace: Blockly.WorkspaceSvg,
  input: CreateBlockInput,
): HostToolResult {
  const type = String(input.type || '').trim();
  if (!type) return failure('缺少块类型');
  if (!Blockly.Blocks[type]) return failure(`当前工作区未注册块类型: ${type}`);
  if (input.id && workspace.getBlockById(input.id)) {
    return failure(`块 ID 已存在: ${input.id}`);
  }

  Blockly.Events.setGroup(true);
  let block: Blockly.BlockSvg | null = null;
  try {
    block = workspace.newBlock(type, input.id) as Blockly.BlockSvg;
    if (input.extraState && typeof block.loadExtraState === 'function') {
      block.loadExtraState(structuredClone(input.extraState));
    }
    applyFields(block, input.fields);
    block.initSvg();
    block.render();

    const position = input.position ?? { x: 30, y: 30 };
    const current = block.getRelativeToSurfaceXY();
    block.moveBy(position.x - current.x, position.y - current.y);

    if (input.connect) {
      const result = connectBlocks(workspace, {
        ...input.connect,
        block: block.id,
      });
      if (result.is_error) throw new Error(String(result.content));
    }

    return {
      is_error: false,
      content: `已创建块 ${type} (${block.id})`,
      metadata: { blockId: block.id, blockType: type },
    };
  } catch (error) {
    block?.dispose(true);
    return failure(errorMessage(error));
  } finally {
    Blockly.Events.setGroup(false);
  }
}

export function deleteBlock(
  workspace: Blockly.WorkspaceSvg,
  blockId: string,
): HostToolResult {
  const id = String(blockId || '').trim();
  const block = workspace.getBlockById(id);
  if (!block) return failure(`未找到块: ${id}`);

  Blockly.Events.setGroup(true);
  try {
    block.dispose(true);
    return {
      is_error: false,
      content: `已删除块 ${id}`,
      metadata: { blockId: id },
    };
  } catch (error) {
    return failure(errorMessage(error));
  } finally {
    Blockly.Events.setGroup(false);
  }
}

export function setBlockField(
  workspace: Blockly.WorkspaceSvg,
  blockId: string,
  fieldName: string,
  value: unknown,
): HostToolResult {
  const block = workspace.getBlockById(String(blockId || '').trim());
  if (!block) return failure(`未找到块: ${blockId}`);
  const normalizedFieldName = String(fieldName || '').trim();
  const field = block.getField(normalizedFieldName);
  if (!field) return failure(`块 ${block.id} 没有字段: ${normalizedFieldName}`);

  Blockly.Events.setGroup(true);
  try {
    field.setValue(normalizeFieldValue(value));
    (block as Blockly.BlockSvg).render();
    return {
      is_error: false,
      content: `已更新块 ${block.id} 的字段 ${normalizedFieldName}`,
      metadata: { blockId: block.id, fieldName: normalizedFieldName },
    };
  } catch (error) {
    return failure(errorMessage(error));
  } finally {
    Blockly.Events.setGroup(false);
  }
}

export function connectBlocks(
  workspace: Blockly.WorkspaceSvg,
  input: ConnectBlockInput,
): HostToolResult {
  const child = workspace.getBlockById(String(input.block || '').trim());
  const target = workspace.getBlockById(String(input.target || '').trim());
  if (!child) return failure(`未找到子块: ${input.block}`);
  if (!target) return failure(`未找到目标块: ${input.target}`);
  if (child === target) return failure('不能把块连接到自身');

  const pair = resolveConnectionPair(child, target, input);
  if ('error' in pair) return failure(pair.error);

  Blockly.Events.setGroup(true);
  try {
    pair.child.disconnect();
    pair.target.disconnect();
    pair.target.connect(pair.child);
    (child as Blockly.BlockSvg).render();
    (target as Blockly.BlockSvg).render();
    return {
      is_error: false,
      content: `已连接块 ${child.id} -> ${target.id}`,
      metadata: {
        blockId: child.id,
        targetId: target.id,
        action: input.action,
        ...(input.input ? { input: input.input } : {}),
      },
    };
  } catch (error) {
    return failure(errorMessage(error));
  } finally {
    Blockly.Events.setGroup(false);
  }
}

function resolveConnectionPair(
  child: Blockly.Block,
  target: Blockly.Block,
  input: ConnectBlockInput,
): { child: Blockly.Connection; target: Blockly.Connection } | { error: string } {
  if (input.action === 'chain_after') {
    if (!child.previousConnection || !target.nextConnection) {
      return { error: '块不支持 next/previous 语句连接' };
    }
    return { child: child.previousConnection, target: target.nextConnection };
  }

  const inputName = String(input.input || '').trim();
  const targetInput = inputName ? target.getInput(inputName) : null;
  if (!targetInput?.connection) {
    return { error: `目标块 ${target.id} 没有输入: ${inputName || '<empty>'}` };
  }
  if (input.action === 'put_into') {
    if (!child.previousConnection) return { error: '子块不支持语句输入连接' };
    return { child: child.previousConnection, target: targetInput.connection };
  }
  if (!child.outputConnection) return { error: '子块不支持值输入连接' };
  return { child: child.outputConnection, target: targetInput.connection };
}

function applyFields(block: Blockly.Block, fields?: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(fields ?? {})) {
    const field = block.getField(name);
    if (!field) throw new Error(`块 ${block.type} 没有字段: ${name}`);
    field.setValue(normalizeFieldValue(value));
  }
}

function normalizeFieldValue(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record['id'] === 'string') return record['id'];
    if (typeof record['name'] === 'string') return record['name'];
  }
  return value === null || value === undefined ? '' : String(value);
}

function failure(content: string): HostToolResult {
  return { is_error: true, content };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
