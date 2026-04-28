/**
 * 终端会话管理工具 — 后台命令执行 & 输出获取
 *
 * 参考 Copilot 的 run_in_terminal / get_terminal_output 设计：
 * - 支持后台执行长时间命令（如编译、监控）
 * - 可随时获取后台命令的当前输出
 * - 维护终端会话映射，支持命令中断
 *
 * 与现有 executeCommandTool 的关系：
 * executeCommandTool 仍是主要的同步命令执行工具。
 * 本模块提供：
 *   1. startBackgroundCommand() — 后台启动命令
 *   2. getTerminalOutputTool() — 获取后台命令输出
 *   3. listTerminalSessions() — 列出活跃终端
 */

import { ToolUseResult } from './tools';
import { AilyHost } from '../core/host';

// ============================
// 类型定义
// ============================

interface TerminalSession {
  id: string;
  command: string;
  cwd: string;
  startTime: number;
  stdout: string;
  stderr: string;
  /** 已读取到的 stdout 偏移（用于增量读取） */
  readOffset: number;
  status: 'running' | 'completed' | 'error';
  exitCode?: number;
  subscription?: any; // Observable subscription
}

export interface StartBackgroundCommandArgs {
  command: string;
  cwd?: string;
  /** 可选的会话标签（如 "build", "server"），用于后续识别 */
  label?: string;
}

export interface GetTerminalOutputArgs {
  /** 终端会话 ID */
  session_id: string;
  /** 是否仅获取自上次读取以来的新输出（增量模式） */
  incremental?: boolean;
  /** 最大返回字符数 */
  max_chars?: number;
}

export interface KillTerminalArgs {
  session_id: string;
}

// ============================
// 终端会话管理器（模块级单例）
// ============================

const MAX_OUTPUT_SIZE = 100000; // 每个终端最大保留 100KB 输出
const MAX_SESSIONS = 10;       // 最多保留 10 个终端会话
const _sessions = new Map<string, TerminalSession>();

function generateSessionId(label?: string): string {
  const base = label ? label.replace(/[^a-zA-Z0-9_-]/g, '_') : 'term';
  return `${base}_${Date.now().toString(36)}`;
}

function cleanupOldSessions(): void {
  if (_sessions.size <= MAX_SESSIONS) return;
  // 按时间排序，清除最早的已完成会话
  const completed = [..._sessions.entries()]
    .filter(([, s]) => s.status !== 'running')
    .sort((a, b) => a[1].startTime - b[1].startTime);
  while (_sessions.size > MAX_SESSIONS && completed.length > 0) {
    const [id] = completed.shift()!;
    _sessions.delete(id);
  }
}

// ============================
// 工具 1: 后台启动命令
// ============================

export async function startBackgroundCommandTool(args: StartBackgroundCommandArgs): Promise<ToolUseResult> {
  const { command, cwd, label } = args;

  if (!command) {
    return { is_error: true, content: '缺少必要参数: command' };
  }

  const host = AilyHost.get();
  const cmdService = host.cmd;

  if (!cmdService) {
    return { is_error: true, content: '命令执行服务不可用' };
  }

  const projectPath = cwd || host.project?.currentProjectPath || host.project?.projectRootPath;
  if (!projectPath) {
    return { is_error: true, content: '无法确定工作目录，请指定 cwd 或先打开项目' };
  }

  cleanupOldSessions();

  const sessionId = generateSessionId(label);
  const session: TerminalSession = {
    id: sessionId,
    command,
    cwd: projectPath,
    startTime: Date.now(),
    stdout: '',
    stderr: '',
    readOffset: 0,
    status: 'running',
  };

  _sessions.set(sessionId, session);

  // 异步启动命令，不等待完成
  try {
    const observable = cmdService.run(command, projectPath, false, true);
    session.subscription = observable.subscribe({
      next: (data: any) => {
        if (data?.data) {
          if (data.type === 'stderr') {
            session.stderr += data.data;
            if (session.stderr.length > MAX_OUTPUT_SIZE) {
              session.stderr = '...[早期输出已截断]...\n' + session.stderr.slice(-MAX_OUTPUT_SIZE);
            }
          } else {
            session.stdout += data.data;
            if (session.stdout.length > MAX_OUTPUT_SIZE) {
              session.stdout = '...[早期输出已截断]...\n' + session.stdout.slice(-MAX_OUTPUT_SIZE);
            }
          }
        }
        if (data?.error) {
          session.stderr += data.error;
        }
      },
      error: (err: any) => {
        session.status = 'error';
        session.stderr += `\n[命令执行出错: ${err?.message || err}]`;
      },
      complete: () => {
        session.status = 'completed';
      },
    });
  } catch (err: any) {
    session.status = 'error';
    return {
      is_error: true,
      content: `后台命令启动失败: ${err?.message || err}`,
    };
  }

  return {
    is_error: false,
    content: JSON.stringify({
      session_id: sessionId,
      command,
      cwd: projectPath,
      message: `后台命令已启动。使用 get_terminal_output({ session_id: "${sessionId}" }) 查看输出。`,
    }),
    metadata: { sessionId },
  };
}

// ============================
// 工具 2: 获取终端输出
// ============================

export async function getTerminalOutputTool(args: GetTerminalOutputArgs): Promise<ToolUseResult> {
  const { session_id, incremental = true, max_chars = 50000 } = args;

  if (!session_id) {
    return { is_error: true, content: '缺少必要参数: session_id' };
  }

  const session = _sessions.get(session_id);
  if (!session) {
    // 列出可用会话以帮助 LLM
    const available = [..._sessions.keys()];
    return {
      is_error: true,
      content: available.length > 0
        ? `未找到终端会话 "${session_id}"。可用会话: ${available.join(', ')}`
        : '未找到终端会话，当前没有活跃的后台命令',
    };
  }

  let output: string;
  if (incremental) {
    // 增量模式：只返回自上次读取以来的新输出
    output = session.stdout.slice(session.readOffset);
    session.readOffset = session.stdout.length;
  } else {
    output = session.stdout;
  }

  // 截断过长的输出
  if (output.length > max_chars) {
    output = output.slice(-max_chars);
    output = '...[输出已截断，仅显示最后部分]...\n' + output;
  }

  const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(1);
  const result: any = {
    session_id,
    status: session.status,
    elapsed_seconds: parseFloat(elapsed),
    output: output || '(暂无新输出)',
  };

  if (session.stderr) {
    const stderrOutput = session.stderr.length > 5000
      ? '...[早期输出已截断]...\n' + session.stderr.slice(-5000)
      : session.stderr;
    result.stderr = stderrOutput;
  }
  if (session.exitCode !== undefined) {
    result.exit_code = session.exitCode;
  }

  return {
    is_error: false,
    content: JSON.stringify(result),
    metadata: { status: session.status, hasNewOutput: output.length > 0 },
  };
}

// ============================
// 工具 3: 终止后台命令
// ============================

export async function killTerminalTool(args: KillTerminalArgs): Promise<ToolUseResult> {
  const { session_id } = args;

  if (!session_id) {
    return { is_error: true, content: '缺少必要参数: session_id' };
  }

  const session = _sessions.get(session_id);
  if (!session) {
    return { is_error: true, content: `未找到终端会话 "${session_id}"` };
  }

  if (session.status !== 'running') {
    return {
      is_error: false,
      content: `终端会话 "${session_id}" 已经结束 (状态: ${session.status})`,
    };
  }

  try {
    if (session.subscription) {
      session.subscription.unsubscribe();
    }
    session.status = 'completed';
    return {
      is_error: false,
      content: `终端会话 "${session_id}" 已终止`,
    };
  } catch (err: any) {
    return {
      is_error: true,
      content: `终止终端会话失败: ${err?.message || err}`,
    };
  }
}

// ============================
// 工具 4: 列出活跃终端
// ============================

export async function listTerminalSessionsTool(): Promise<ToolUseResult> {
  const sessions = [..._sessions.values()].map(s => ({
    session_id: s.id,
    command: s.command.length > 80 ? s.command.slice(0, 80) + '...' : s.command,
    status: s.status,
    elapsed: `${((Date.now() - s.startTime) / 1000).toFixed(0)}s`,
    output_size: `${s.stdout.length} chars`,
  }));

  if (sessions.length === 0) {
    return {
      is_error: false,
      content: '当前没有后台终端会话',
    };
  }

  return {
    is_error: false,
    content: JSON.stringify({ sessions }, null, 2),
    metadata: { count: sessions.length },
  };
}

// ============================
// 清理（供 chat-engine destroy 调用）
// ============================

export function cleanupAllTerminalSessions(): void {
  for (const session of _sessions.values()) {
    if (session.subscription) {
      try { session.subscription.unsubscribe(); } catch { /* ignore */ }
    }
  }
  _sessions.clear();
}
