import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

export type ErrorDecision = 'continue' | 'abort';

export type ErrorDecisionRequest = {
  label: string;
  message: string;
  position: number;
  total: number;
};

type ErrorDecisionOptions = {
  interactive?: boolean;
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

const ANSI_RED = '\u001B[31m';
const ANSI_DEFAULT_FOREGROUND = '\u001B[39m';

export function parseErrorDecision(answer: string): ErrorDecision | null {
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'c' || normalized === 'continue' || normalized === '继续') {
    return 'continue';
  }
  if (!normalized || normalized === 'a' || normalized === 'abort' || normalized === '中止') {
    return 'abort';
  }
  return null;
}

export function canRequestErrorDecision(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AILY_E2E_INTERACTIVE_DECISIONS'] === '1' && !env['CI'];
}

export function shouldColorErrorOutput(env: NodeJS.ProcessEnv = process.env): boolean {
  return canRequestErrorDecision(env) && env['NO_COLOR'] === undefined;
}

export function formatTerminalError(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return shouldColorErrorOutput(env)
    ? `${ANSI_RED}${message}${ANSI_DEFAULT_FOREGROUND}`
    : message;
}

export async function requestErrorDecision(
  request: ErrorDecisionRequest,
  options: ErrorDecisionOptions = {},
): Promise<ErrorDecision> {
  const log = options.log ?? console.log;
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? canRequestErrorDecision(env);

  if (!interactive) {
    log('[e2e] 当前环境无法交互，默认中止并保留断点；如需自动继续，请设置 AILY_E2E_STOP_ON_ERROR=0。');
    return 'abort';
  }

  const question = options.question ?? askControlTerminal;
  let prompt = [
    '',
    `[e2e] [${request.position}/${request.total}] ${request.label} 执行失败。`,
    formatTerminalError(`错误：${request.message}`, env),
    '[c] 将当前项视为已处理并继续运行  [a] 中止并保留当前断点（默认）',
    '请选择：',
  ].join('\n');

  while (true) {
    try {
      const decision = parseErrorDecision(await question(prompt));
      if (decision) {
        return decision;
      }
      log('[e2e] 无效选择，请输入 c（继续）或 a（中止）。');
      prompt = '请选择 [c/a]：';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[e2e] 无法读取选择，默认中止并保留断点：${formatTerminalError(message, env)}`);
      return 'abort';
    }
  }
}

async function askControlTerminal(prompt: string): Promise<string> {
  const terminalPath = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';
  const handle = await open(terminalPath, 'r');
  try {
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    try {
      const readline = createInterface({ input, output: process.stdout, terminal: false });
      const controller = new AbortController();
      const abortQuestion = () => controller.abort();
      readline.once('SIGINT', abortQuestion);
      process.once('SIGINT', abortQuestion);

      try {
        return await readline.question(prompt, { signal: controller.signal });
      } finally {
        process.off('SIGINT', abortQuestion);
        readline.off('SIGINT', abortQuestion);
        readline.close();
      }
    } finally {
      input.destroy();
    }
  } finally {
    await handle.close().catch(() => {});
  }
}
