import { ToolUseResult } from "./tools";
import {
  TodoItem,
  getTodos,
  setTodos,
  clearTodos,
  getTodosByStatus,
  getTodoStatistics,
  validateTodos
} from "../utils/todoStorage";
import { notifyTodoUpdate } from "../services/todoUpdate.service";

// =============================================================================
// TodoManager - IDE端运行的todo管理器（提醒机制）
// =============================================================================

interface TodoManagerConfig {
  reminderThreshold: number;
  maxThreshold: number;
  enabled: boolean;
}

class TodoManager {
  private static instance: TodoManager;
  private callCount: number = 0;
  private isActive: boolean = false;
  private config: TodoManagerConfig = {
    reminderThreshold: 5,
    maxThreshold: 10,
    enabled: true
  };
  private lastReminderCall: number = 0;

  static getInstance(): TodoManager {
    if (!TodoManager.instance) {
      TodoManager.instance = new TodoManager();
    }
    return TodoManager.instance;
  }

  private constructor() {}

  configure(config: Partial<TodoManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  startMonitoring(): void {
    this.isActive = true;
    this.callCount = 0;
    this.lastReminderCall = 0;
  }

  stopMonitoring(): void {
    this.isActive = false;
    this.callCount = 0;
  }

  resetCallCount(): void {
    this.callCount = 0;
    this.lastReminderCall = 0;
  }

  recordToolCall(toolName: string): void {
    if (!this.config.enabled || !this.isActive) return;
    if (toolName === 'todo_write_tool') {
      this.callCount = 0;
      this.lastReminderCall = 0;
      return;
    }
    this.callCount++;
  }

  checkAndGetReminder(sessionId: string = 'default'): string | null {
    if (!this.config.enabled || !this.isActive) return null;

    const shouldRemind = this.callCount >= this.config.reminderThreshold &&
      this.callCount > this.lastReminderCall;
    if (!shouldRemind) return null;

    this.lastReminderCall = this.callCount;

    const stats = getTodoStatistics(sessionId);
    if (stats.total === 0) return null;

    const isUrgent = this.callCount >= this.config.maxThreshold;
    const urgencyPrefix = isUrgent ? ' **紧急提醒**' : ' **友好提醒**';

    let reminder = `<reminder>\n\n${urgencyPrefix}: 您有 ${stats.byStatus['not-started']} 个待处理任务`;
    if (stats.byStatus['in-progress'] > 0) {
      reminder += `，${stats.byStatus['in-progress']} 个进行中任务`;
    }
    reminder += `。`;

    if (isUrgent && stats.byStatus['not-started'] > 0) {
      const pendingTodos = getTodosByStatus('not-started', sessionId).slice(0, 3);
      reminder += `\n\n **待处理任务**:`;
      pendingTodos.forEach((todo, index) => {
        const priorityIcon = todo.priority === 'high' ? '' :
          todo.priority === 'medium' ? '' : '';
        reminder += `\n${index + 1}. ${priorityIcon} ${todo.content}`;
      });
      if (stats.byStatus['not-started'] > 3) {
        reminder += `\n... 还有 ${stats.byStatus['not-started'] - 3} 个任务`;
      }
    }

    reminder += `\n\n 使用 todo_write_tool 工具来查看或更新任务状态</reminder>`;
    return reminder;
  }

  getStatus(): { isActive: boolean; callCount: number; config: TodoManagerConfig } {
    return { isActive: this.isActive, callCount: this.callCount, config: { ...this.config } };
  }
}

export const todoManager = TodoManager.getInstance();

/**
 * 工具调用拦截器 - 在其他工具的返回结果中注入todo提醒
 */
export function injectTodoReminder(
  toolName: string,
  sessionId: string = 'default'
): string {
  todoManager.recordToolCall(toolName);
  const reminder = todoManager.checkAndGetReminder(sessionId) || '';
  return reminder;
}

export function configureTodoManager(config: Partial<TodoManagerConfig>): void {
  todoManager.configure(config);
}

export function getTodoManagerStatus() {
  return todoManager.getStatus();
}

// =============================================================================
// 状态兼容映射 - 兼容 LLM 可能传入的旧格式状态值
// =============================================================================

const STATUS_ALIASES: Record<string, TodoItem['status']> = {
  'not-started': 'not-started',
  'in-progress': 'in-progress',
  'completed': 'completed',
  'pending': 'not-started',
  'in_progress': 'in-progress',
  'todo': 'not-started',
  'done': 'completed',
};

function normalizeStatus(status: string | undefined): TodoItem['status'] {
  if (!status) return 'not-started';
  return STATUS_ALIASES[status.toLowerCase()] || 'not-started';
}

// =============================================================================
// todoWriteTool - update=全量替换, add=追加
// =============================================================================

function formatTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return 'TODO列表为空';

  const statusIcon = (s: TodoItem['status']) =>
    s === 'completed' ? '' : s === 'in-progress' ? '' : '';

  let result = '# TODO列表\n\n| ID | 状态 | 优先级 | 内容 |\n| --- | --- | --- | --- |\n';
  todos.forEach((todo) => {
    result += `| ${todo.id} | ${statusIcon(todo.status)} ${todo.status} | ${todo.priority.toUpperCase()} | ${todo.content} |\n`;
  });
  return result.trim();
}

// 解析 todos 数组参数（支持 JSON 字符串）
function parseTodosParam(raw: any): any[] | string {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); }
    catch { return 'todos 参数不是有效的 JSON 格式'; }
  }
  return raw;
}

// 构建 TodoItem，id 缺失时按 content 匹配现有任务复用 id
function buildTodoItem(todo: any, existingByContent: Map<string, TodoItem>, usedIds: Set<number>): TodoItem {
  const content = (todo.content || todo.title || '').trim();
  const hasId = typeof todo.id === 'number';
  let resolvedId: number;
  let createdAt = todo.createdAt || Date.now();

  if (hasId) {
    resolvedId = todo.id;
  } else {
    const matched = existingByContent.get(content.toLowerCase());
    if (matched && !usedIds.has(matched.id)) {
      resolvedId = matched.id;
      createdAt = matched.createdAt || createdAt;
    } else {
      resolvedId = -1; // 后续分配
    }
  }
  usedIds.add(resolvedId);

  return {
    id: resolvedId,
    content,
    status: normalizeStatus(todo.status),
    priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium',
    tags: Array.isArray(todo.tags) ? todo.tags : [],
    estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
    createdAt,
    updatedAt: Date.now()
  };
}

// 为 id === -1 的项分配新 id
function assignMissingIds(todos: TodoItem[], existingTodos: TodoItem[]): void {
  const allKnownIds = new Set([
    ...existingTodos.map(t => t.id),
    ...todos.filter(t => t.id > 0).map(t => t.id)
  ]);
  let nextId = allKnownIds.size > 0 ? Math.max(...allKnownIds) + 1 : 1;
  for (const todo of todos) {
    if (todo.id === -1) {
      todo.id = nextId++;
    }
  }
}

export async function todoWriteTool(toolArgs: any): Promise<ToolUseResult> {
  todoManager.startMonitoring();

  try {
    const { operation, sessionId = 'default' } = toolArgs;

    switch (operation) {
      // ====== update：全量替换（与 Copilot manage_todo_list 一致）======
      case 'update': {
        let todosArray = parseTodosParam(toolArgs.todos);
        if (typeof todosArray === 'string') {
          return { is_error: true, content: ` ${todosArray}` };
        }
        if (!Array.isArray(todosArray) || todosArray.length === 0) {
          return { is_error: true, content: ' update 需要一个非空的 todos 数组（全量替换）' };
        }

        const existingTodos = getTodos(sessionId);
        const existingByContent = new Map<string, TodoItem>();
        for (const t of existingTodos) {
          existingByContent.set(t.content.toLowerCase(), t);
        }
        const usedIds = new Set<number>();

        const validatedTodos = todosArray.map((todo: any) =>
          buildTodoItem(todo, existingByContent, usedIds)
        );
        assignMissingIds(validatedTodos, existingTodos);

        const validation = validateTodos(validatedTodos);
        if (!validation.result) {
          return { is_error: true, content: ` 验证失败: ${validation.message}` };
        }

        setTodos(validatedTodos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` TODO列表已替换（${validatedTodos.length} 项）\n\n${formatTodoList(validatedTodos)}` };
      }

      // ====== add：追加任务（支持单项和批量）======
      case 'add':
      case 'batch_add': {
        let todosArray = parseTodosParam(toolArgs.todos);
        if (typeof todosArray === 'string') {
          return { is_error: true, content: ` ${todosArray}` };
        }

        // 无 todos 数组时，从顶层参数构建单项
        if (!todosArray) {
          const content = (toolArgs.content || toolArgs.title || '').trim();
          if (!content) {
            return { is_error: true, content: ' add 需要 content 或 todos 数组' };
          }
          todosArray = [{
            content,
            status: toolArgs.status,
            priority: toolArgs.priority,
            tags: toolArgs.tags,
            estimatedHours: toolArgs.estimatedHours,
          }];
        }

        if (!Array.isArray(todosArray) || todosArray.length === 0) {
          return { is_error: true, content: ' todos 必须是一个非空数组' };
        }

        const currentTodos = getTodos(sessionId);
        let nextId = currentTodos.length > 0 ? Math.max(...currentTodos.map(t => t.id)) + 1 : 1;
        const newTodos: TodoItem[] = todosArray
          .filter((t: any) => (t.content || t.title || '').trim())
          .map((todo: any) => ({
            id: nextId++,
            content: (todo.content || todo.title || '').trim(),
            status: normalizeStatus(todo.status),
            priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium',
            tags: Array.isArray(todo.tags) ? todo.tags : [],
            estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }));

        const updatedTodos = [...currentTodos, ...newTodos];
        setTodos(updatedTodos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` 添加了 ${newTodos.length} 个任务\n\n${formatTodoList(updatedTodos)}` };
      }

      // ====== 切换状态 ======
      case 'toggle': {
        const id = Number(toolArgs.id);
        if (isNaN(id)) {
          return { is_error: true, content: ' 缺少有效的任务 ID (数字)' };
        }

        const todos = getTodos(sessionId);
        const todo = todos.find(t => t.id === id);
        if (!todo) {
          return { is_error: true, content: ` 找不到 ID 为 ${id} 的任务。当前任务IDs: ${todos.map(t => t.id).join(', ')}` };
        }

        const statusCycle: Record<string, TodoItem['status']> = {
          'not-started': 'in-progress',
          'in-progress': 'completed',
          'completed': 'not-started'
        };
        const newStatus = statusCycle[todo.status];

        if (newStatus === 'in-progress' && todos.some(t => t.id !== id && t.status === 'in-progress')) {
          return { is_error: true, content: ' 已有其他任务在进行中' };
        }

        todo.status = newStatus;
        todo.updatedAt = Date.now();
        setTodos(todos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` 任务 ${id} 状态更新:  ${newStatus}\n\n${formatTodoList(todos)}` };
      }

      // ====== 查询/列表 ======
      case 'list':
      case 'read': {
        const currentTodos = getTodos(sessionId);
        return { is_error: false, content: formatTodoList(currentTodos) };
      }

      // ====== 删除 ======
      case 'delete': {
        const id = Number(toolArgs.id);
        if (isNaN(id)) {
          return { is_error: true, content: ' 缺少有效的任务 ID (数字)' };
        }

        const todos = getTodos(sessionId);
        const idx = todos.findIndex(t => t.id === id);
        if (idx === -1) {
          return { is_error: true, content: ` 找不到 ID 为 ${id} 的任务。当前任务IDs: ${todos.map(t => t.id).join(', ')}` };
        }

        const removed = todos.splice(idx, 1)[0];
        setTodos(todos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` 任务删除成功: ${removed.content}\n\n${formatTodoList(todos)}` };
      }

      // ====== 清空 ======
      case 'clear': {
        const count = getTodos(sessionId).length;
        clearTodos(sessionId);
        if (count > 0) notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` 清空完成: 删除了 ${count} 个任务` };
      }

      // ====== 统计 ======
      case 'stats': {
        const statistics = getTodoStatistics(sessionId);
        return {
          is_error: false,
          content: ` 统计\n\n` +
            `总数: ${statistics.total} |  待处理: ${statistics.byStatus['not-started']} | ` +
            ` 进行中: ${statistics.byStatus['in-progress']} |  已完成: ${statistics.byStatus.completed}\n` +
            ` 高: ${statistics.byPriority.high} |  中: ${statistics.byPriority.medium} |  低: ${statistics.byPriority.low}\n` +
            ` 预估总工时: ${statistics.estimatedTotalHours}h`
        };
      }

      default:
        return {
          is_error: true,
          content: ` 不支持的操作 "${operation}"。支持: update, add, batch_add, list, read, toggle, delete, clear, stats`
        };
    }
  } catch (error) {
    return {
      is_error: true,
      content: ` 执行出错: ${error instanceof Error ? error.message : '未知错误'}`
    };
  }
}
