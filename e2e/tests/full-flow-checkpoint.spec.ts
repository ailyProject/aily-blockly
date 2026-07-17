import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FullFlowCheckpoint,
  StaleFullFlowCheckpointError,
  shouldStopOnError,
  type FullFlowCheckpointState,
} from '../full-flow-checkpoint';

test.describe('full-flow checkpoint', () => {
  let directory: string;

  test.beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'aily-full-flow-checkpoint-'));
  });

  test.afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test('默认遇错停止，仅 0 开启继续模式', () => {
    expect(shouldStopOnError(undefined)).toBe(true);
    expect(shouldStopOnError('')).toBe(true);
    expect(shouldStopOnError('1')).toBe(true);
    expect(shouldStopOnError('false')).toBe(true);
    expect(shouldStopOnError('0')).toBe(false);
  });

  test('失败后按保存顺序和 stable key 恢复，允许当前候选重排并忽略新增项', async () => {
    const checkpoint = new FullFlowCheckpoint('specified-boards', directory);
    const initial = await checkpoint.begin([
      { key: 'a', label: 'Board A', payload: 'initial-a' },
      { key: 'b', label: 'Board B', payload: 'initial-b' },
      { key: 'c', label: 'Board C', payload: 'initial-c' },
    ]);

    expect(initial.resumed).toBe(false);
    expect(initial.remaining.map(({ key, position }) => ({ key, position }))).toEqual([
      { key: 'a', position: 1 },
      { key: 'b', position: 2 },
      { key: 'c', position: 3 },
    ]);
    await checkpoint.applyBatch({
      succeededKeys: ['a'],
      failures: [{ key: 'b', message: 'compile failed' }],
    });

    const saved = await readState(checkpoint.filePath);
    expect(saved.remaining.map(({ key }) => key)).toEqual(['b', 'c']);
    expect(saved.lastFailure).toMatchObject({
      key: 'b',
      label: 'Board B',
      position: 2,
      message: 'compile failed',
    });

    const resumed = await new FullFlowCheckpoint('specified-boards', directory).begin([
      { key: 'c', label: 'Current Board C', payload: 'current-c' },
      { key: 'd', label: 'New Board D', payload: 'current-d' },
      { key: 'b', label: 'Current Board B', payload: 'current-b' },
      { key: 'a', label: 'Current Board A', payload: 'current-a' },
    ]);

    expect(resumed.resumed).toBe(true);
    expect(resumed.total).toBe(3);
    expect(resumed.remaining.map(({ key, label, position, candidate }) => ({
      key,
      label,
      position,
      payload: candidate.payload,
    }))).toEqual([
      { key: 'b', label: 'Current Board B', position: 2, payload: 'current-b' },
      { key: 'c', label: 'Current Board C', position: 3, payload: 'current-c' },
    ]);
  });

  test('逐批删除成功项，并在全部完成后删除 checkpoint 文件', async () => {
    const checkpoint = new FullFlowCheckpoint('all-boards', directory);
    await checkpoint.begin([
      { key: 'a', label: 'Board A' },
      { key: 'b', label: 'Board B' },
    ]);

    await checkpoint.applyBatch({ succeededKeys: ['a'], failures: [] });
    expect((await readState(checkpoint.filePath)).remaining).toEqual([
      { key: 'b', label: 'Board B', position: 2 },
    ]);

    const completed = await checkpoint.applyBatch({ succeededKeys: ['b'], failures: [] });
    expect(completed).toBeNull();
    expect(await exists(checkpoint.filePath)).toBe(false);
  });

  test('继续模式下后续成功不会清掉仍待重试的失败位置', async () => {
    const checkpoint = new FullFlowCheckpoint('specified-boards', directory);
    await checkpoint.begin([
      { key: 'a', label: 'Board A' },
      { key: 'b', label: 'Board B' },
      { key: 'c', label: 'Board C' },
    ]);

    await checkpoint.applyBatch({ succeededKeys: [], failures: [{ key: 'a', message: 'failed A' }] });
    await checkpoint.applyBatch({ succeededKeys: ['b'], failures: [] });

    const saved = await readState(checkpoint.filePath);
    expect(saved.remaining.map(({ key }) => key)).toEqual(['a', 'c']);
    expect(saved.lastFailure).toMatchObject({ key: 'a', position: 1, message: 'failed A' });
  });

  test('保存队列中的 key 在当前候选中缺失时明确报告 stale', async () => {
    const checkpoint = new FullFlowCheckpoint('project-plaza', directory);
    await checkpoint.begin([
      { key: 'a', label: 'Project A' },
      { key: 'b', label: 'Project B' },
    ]);
    await checkpoint.applyBatch({ succeededKeys: ['a'], failures: [] });

    let caught: unknown;
    try {
      await new FullFlowCheckpoint('project-plaza', directory).begin([
        { key: 'a', label: 'Project A' },
        { key: 'c', label: 'Project C' },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StaleFullFlowCheckpointError);
    expect((caught as StaleFullFlowCheckpointError).missingKeys).toEqual(['b']);
    expect(String(caught)).toContain('stale');
    expect(await exists(checkpoint.filePath)).toBe(true);
  });

  test('不同模式使用不同 checkpoint 文件', async () => {
    const boards = new FullFlowCheckpoint('all-boards', directory);
    const projects = new FullFlowCheckpoint('project-plaza', directory);
    await boards.begin([{ key: 'board', label: 'Board' }]);
    await projects.begin([{ key: 'project', label: 'Project' }]);

    expect(boards.filePath).not.toBe(projects.filePath);
    expect(await exists(boards.filePath)).toBe(true);
    expect(await exists(projects.filePath)).toBe(true);
  });

  test('主文件缺失时从替换备份恢复旧断点', async () => {
    const checkpoint = new FullFlowCheckpoint('all-boards', directory);
    await checkpoint.begin([{ key: 'board', label: 'Board' }]);
    await rename(checkpoint.filePath, `${checkpoint.filePath}.bak`);

    const resumed = await new FullFlowCheckpoint('all-boards', directory).begin([
      { key: 'board', label: 'Current Board' },
    ]);

    expect(resumed.resumed).toBe(true);
    expect(resumed.remaining.map(({ key }) => key)).toEqual(['board']);
    expect(await exists(checkpoint.filePath)).toBe(true);
  });

  test('拒绝不可能的空队列断点，避免静默跳过批次', async () => {
    const checkpoint = new FullFlowCheckpoint('project-plaza', directory);
    await writeFile(
      checkpoint.filePath,
      JSON.stringify({
        version: 1,
        mode: 'project-plaza',
        remaining: [],
        total: 2,
        lastFailure: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    let caught: unknown;
    try {
      await checkpoint.begin([{ key: 'project', label: 'Project' }]);
    } catch (error) {
      caught = error;
    }

    expect(String(caught)).toContain('invalid empty full-flow checkpoint queue');
    expect(await exists(checkpoint.filePath)).toBe(true);
  });
});

async function readState(filePath: string): Promise<FullFlowCheckpointState> {
  return JSON.parse(await readFile(filePath, 'utf8')) as FullFlowCheckpointState;
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}
