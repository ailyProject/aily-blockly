import { expect, test } from '@playwright/test';
import {
  readProjectPlazaSampleRate,
  readProjectPlazaSkipProjectIds,
  selectProjectPlazaSample,
} from '../project-plaza-selection';

test.describe('project plaza selection', () => {
  test('默认全量执行，并拒绝无效抽样比例', () => {
    expect(readProjectPlazaSampleRate(undefined)).toBe(1);
    expect(readProjectPlazaSampleRate('0.5')).toBe(0.5);
    expect(() => readProjectPlazaSampleRate('0')).toThrow('必须大于 0 且不超过 1');
    expect(() => readProjectPlazaSampleRate('1.1')).toThrow('必须大于 0 且不超过 1');
    expect(() => readProjectPlazaSampleRate('invalid')).toThrow('必须大于 0 且不超过 1');
  });

  test('50% 抽样向上取整，相同种子稳定复现', () => {
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      key: `project-${index + 1}`,
      value: index + 1,
    }));

    const first = selectProjectPlazaSample(candidates, 0.5, 'seed-a');
    const repeated = selectProjectPlazaSample(candidates, 0.5, 'seed-a');

    expect(first).toHaveLength(5);
    expect(repeated).toEqual(first);
    expect(new Set(first.map(({ key }) => key)).size).toBe(first.length);
  });

  test('不同种子选择不同项目，且抽样时种子必填', () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({ key: `project-${index + 1}` }));

    expect(selectProjectPlazaSample(candidates, 0.5, 'seed-a')).not.toEqual(
      selectProjectPlazaSample(candidates, 0.5, 'seed-b'),
    );
    expect(() => selectProjectPlazaSample(candidates, 0.5, '')).toThrow('必须设置');
  });

  test('全量模式不要求种子，并解析 AI 确认跳过的项目 ID', () => {
    const candidates = [{ key: 'a' }, { key: 'b' }];
    expect(selectProjectPlazaSample(candidates, 1, undefined)).toEqual(candidates);
    expect([...readProjectPlazaSkipProjectIds(' a, b, a ,, ')]).toEqual(['a', 'b']);
  });
});
