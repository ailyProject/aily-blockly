import { expect, test } from '@playwright/test';
import { readFullFlowMode } from '../full-flow-mode';

test.describe('e2e full flow mode', () => {
  test('显式模式只启用当前选择的场景，并隔离遗留开关', () => {
    expect(
      readFullFlowMode({
        AILY_E2E_MODE: 'specified-boards',
        AILY_E2E_PROJECT_PLAZA: '1',
      }),
    ).toBe('specified-boards');
  });

  test('兼容单个旧场景开关', () => {
    expect(readFullFlowMode({ AILY_E2E_FULLFLOW: '1' })).toBe('specified-boards');
    expect(readFullFlowMode({ AILY_E2E_ALL_BOARDS: '1' })).toBe('all-boards');
    expect(readFullFlowMode({ AILY_E2E_PROJECT_PLAZA: '1' })).toBe('project-plaza');
    expect(readFullFlowMode({})).toBeNull();
  });

  test('多个旧场景开关同时生效时立即报错', () => {
    expect(() =>
      readFullFlowMode({
        AILY_E2E_FULLFLOW: '1',
        AILY_E2E_PROJECT_PLAZA: '1',
      }),
    ).toThrow(/多个全流程场景开关/);
  });

  test('拒绝未知显式模式', () => {
    expect(() => readFullFlowMode({ AILY_E2E_MODE: 'unknown' })).toThrow(
      /AILY_E2E_MODE 必须是/,
    );
  });
});
