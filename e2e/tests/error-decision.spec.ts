import { expect, test } from '@playwright/test';
import {
  canRequestErrorDecision,
  formatTerminalError,
  parseErrorDecision,
  requestErrorDecision,
  shouldColorErrorOutput,
} from '../error-decision';

const request = {
  label: 'Project A (ID: 123)',
  message: 'compile failed',
  position: 2,
  total: 10,
};

test.describe('e2e error decision', () => {
  test('解析继续、中止和无效输入', () => {
    expect(parseErrorDecision('c')).toBe('continue');
    expect(parseErrorDecision(' continue ')).toBe('continue');
    expect(parseErrorDecision('继续')).toBe('continue');
    expect(parseErrorDecision('')).toBe('abort');
    expect(parseErrorDecision('a')).toBe('abort');
    expect(parseErrorDecision('中止')).toBe('abort');
    expect(parseErrorDecision('unknown')).toBeNull();
  });

  test('仅允许包装脚本标记的非 CI 环境交互', () => {
    expect(canRequestErrorDecision({ AILY_E2E_INTERACTIVE_DECISIONS: '1' })).toBe(true);
    expect(canRequestErrorDecision({ AILY_E2E_INTERACTIVE_DECISIONS: '0' })).toBe(false);
    expect(canRequestErrorDecision({ AILY_E2E_INTERACTIVE_DECISIONS: '1', CI: '1' })).toBe(false);
  });

  test('仅在交互终端中将错误正文标红，并遵守 NO_COLOR', () => {
    const interactiveEnv = { AILY_E2E_INTERACTIVE_DECISIONS: '1' };

    expect(shouldColorErrorOutput(interactiveEnv)).toBe(true);
    expect(formatTerminalError('compile failed', interactiveEnv)).toBe(
      '\u001B[31mcompile failed\u001B[39m',
    );
    expect(formatTerminalError('compile failed', { AILY_E2E_INTERACTIVE_DECISIONS: '0' })).toBe(
      'compile failed',
    );
    expect(
      formatTerminalError('compile failed', {
        AILY_E2E_INTERACTIVE_DECISIONS: '1',
        CI: '1',
      }),
    ).toBe('compile failed');
    expect(
      formatTerminalError('compile failed', {
        AILY_E2E_INTERACTIVE_DECISIONS: '1',
        NO_COLOR: '',
      }),
    ).toBe('compile failed');
  });

  test('非交互环境默认中止且不读取输入', async () => {
    let asked = false;
    const decision = await requestErrorDecision(request, {
      interactive: false,
      question: async () => {
        asked = true;
        return 'c';
      },
      log: () => {},
    });

    expect(decision).toBe('abort');
    expect(asked).toBe(false);
  });

  test('交互选择继续，无效输入后重新询问但不重复错误正文', async () => {
    const answers = ['?', 'c'];
    const prompts: string[] = [];
    let asked = 0;
    const decision = await requestErrorDecision(request, {
      interactive: true,
      env: { AILY_E2E_INTERACTIVE_DECISIONS: '1' },
      question: async (prompt) => {
        prompts.push(prompt);
        asked++;
        return answers.shift() ?? 'a';
      },
      log: () => {},
    });

    expect(decision).toBe('continue');
    expect(asked).toBe(2);
    expect(prompts[0]).toContain('[2/10] Project A (ID: 123) 执行失败');
    expect(prompts[0]).toContain('错误：compile failed');
    expect(prompts[0]).toContain('\u001B[31m错误：compile failed\u001B[39m');
    expect(prompts[0]).toContain('[c] 将当前项视为已处理并继续运行');
    expect(prompts[1]).toBe('请选择 [c/a]：');
    expect(prompts[1]).not.toContain('compile failed');
  });

  test('读取输入失败时安全中止', async () => {
    const decision = await requestErrorDecision(request, {
      interactive: true,
      question: async () => {
        throw new Error('terminal closed');
      },
      log: () => {},
    });

    expect(decision).toBe('abort');
  });
});
