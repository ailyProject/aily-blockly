const ANSI_ESCAPE_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g;

const NOISE_PATTERNS = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /^\[?pageerror/i,
  /\[PROC_TRACE]/,
  /buildCompleted\s*=/i,
  /isErrored\s*=/i,
  /lastBuildStatus\s*:/i,
  /编译命令完成/,
  /编译(?:失败|错误)，耗时/,
  /编译未成功完成/,
  /最后错误状态/,
  /失败断点已保存/,
];

const PRIMARY_DIAGNOSTIC_PATTERNS = [
  /:\d+(?::\d+)?:\s*(?:fatal\s+)?error\s*:/i,
  /\b(?:fatal\s+error|CMake Error)\s*:/i,
  /\bundefined reference to\b/i,
  /\bmultiple definition of\b/i,
  /\b(?:ModuleNotFoundError|ImportError|SyntaxError|ReferenceError|RuntimeError|TypeError):/,
];

const SECONDARY_DIAGNOSTIC_PATTERNS = [
  /(?:^|\s)error\s*:/i,
  /^\s*\[(?:ERROR|FATAL)]/i,
  /\bNo such file or directory\b/i,
  /\bwas not declared in this scope\b/i,
  /\bdoes not name a type\b/i,
  /\bno matching function for call\b/i,
  /\b(?:too few|too many) arguments\b/i,
];

const EXIT_DIAGNOSTIC_PATTERNS = [
  /\bexit status\s+\d+\b/i,
  /\b(?:process\s+)?exited with (?:exit )?code\s*:?\s*\d+\b/i,
  /编译进程异常退出，退出码\s*:?\s*\d+/i,
  /collect2(?:\.exe)?:\s*error:\s*ld returned\s+\d+/i,
  /\bninja:\s*build stopped\b/i,
];

export function extractCompileDiagnostic(messages: readonly string[]): string | null {
  let best: { line: string; priority: number } | null = null;
  const seen = new Set<string>();

  for (const message of messages) {
    for (const rawLine of message.split(/\r\n|\n|\r/)) {
      const line = normalizeDiagnosticLine(rawLine);
      if (!line || seen.has(line) || NOISE_PATTERNS.some((pattern) => pattern.test(line))) {
        continue;
      }
      seen.add(line);

      const priority = getDiagnosticPriority(line);
      if (priority === null || (best && best.priority <= priority)) {
        continue;
      }
      best = { line, priority };
    }
  }

  return best?.line ?? null;
}

function getDiagnosticPriority(line: string): number | null {
  if (EXIT_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(line))) {
    return 2;
  }
  if (PRIMARY_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(line))) {
    return 0;
  }
  if (SECONDARY_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(line))) {
    return 1;
  }
  return null;
}

function normalizeDiagnosticLine(rawLine: string): string {
  return applyBackspaces(rawLine)
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/^\s*\[\d{4}-\d{2}-\d{2}T[^\]]+]\s*/, '')
    .replace(/^\s*\d{4}-\d{2}-\d{2}T\S+\s*/, '')
    .replace(/^\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*>\s*/, '')
    .replace(/^\s*\[(?:page|compile)(?::[^\]]*)?]\s*/i, '')
    .replace(/^\s*检测到编译错误\s*:\s*/i, '')
    .trim();
}

function applyBackspaces(value: string): string {
  if (!value.includes('\b')) {
    return value;
  }

  const output: string[] = [];
  for (const char of value) {
    if (char === '\b') {
      if (output.length > 0) {
        output.pop();
      }
    } else {
      output.push(char);
    }
  }
  return output.join('');
}
