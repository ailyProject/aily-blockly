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

    let reminder = `\n\n${urgencyPrefix}: 您有 ${stats.byStatus['not-started']} 个待处理任务`;
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

    reminder += `\n\n 使用 todo_write_tool 工具来查看或更新任务状态`;
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
  toolResult: ToolUseResult,
  toolName: string,
  sessionId: string = 'default'
): ToolUseResult {
  todoManager.recordToolCall(toolName);
  const reminder = todoManager.checkAndGetReminder(sessionId);
  if (!reminder) return toolResult;
  return { ...toolResult, content: `${toolResult.content}${reminder}` };
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
// todoWriteTool - Copilot 风格的全量替换模式 + 快捷操作
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

export async function todoWriteTool(toolArgs: any): Promise<ToolUseResult> {
  todoManager.startMonitoring();

  try {
    const { operation, sessionId = 'default' } = toolArgs;

    switch (operation) {
      // ====== 核心操作：全量替换（推荐，与 Copilot manage_todo_list 一致）======
      case 'update': {
        let todosArray = toolArgs.todos;

        if (typeof todosArray === 'string') {
          try { todosArray = JSON.parse(todosArray); }
          catch { return { is_error: true, content: ' todos 参数不是有效的 JSON 格式' }; }
        }

        if (!Array.isArray(todosArray) || todosArray.length === 0) {
          return { is_error: true, content: ' todos 必须是一个非空数组' };
        }

        const validatedTodos: TodoItem[] = todosArray.map((todo: any, index: number) => ({
          id: typeof todo.id === 'number' ? todo.id : index + 1,
          content: (todo.content || todo.title || '').trim(),
          status: normalizeStatus(todo.status),
          priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium',
          tags: Array.isArray(todo.tags) ? todo.tags : [],
          estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
          createdAt: todo.createdAt || Date.now(),
          updatedAt: Date.now()
        }));

        const validation = validateTodos(validatedTodos);
        if (!validation.result) {
          return { is_error: true, content: ` 验证失败: ${validation.message}` };
        }

        setTodos(validatedTodos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` TODO列表更新成功\n\n${formatTodoList(validatedTodos)}` };
      }

      // ====== 快捷操作：添加单个任务 ======
      case 'add': {
        const content = (toolArgs.content || toolArgs.title || '').trim();
        if (!content) {
          return { is_error: true, content: ' 缺少任务内容 (content)' };
        }

        const currentTodos = getTodos(sessionId);
        const newStatus = normalizeStatus(toolArgs.status);

        if (newStatus === 'in-progress' && currentTodos.some(t => t.status === 'in-progress')) {
          return { is_error: true, content: ' 已有任务在进行中，请先完成当前任务' };
        }

        const maxId = currentTodos.length > 0 ? Math.max(...currentTodos.map(t => t.id)) : 0;
        const newTodo: TodoItem = {
          id: maxId + 1,
          content,
          status: newStatus,
          priority: ['high', 'medium', 'low'].includes(toolArgs.priority) ? toolArgs.priority : 'medium',
          tags: Array.isArray(toolArgs.tags) ? toolArgs.tags : [],
          estimatedHours: typeof toolArgs.estimatedHours === 'number' ? toolArgs.estimatedHours : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        const updatedTodos = [...currentTodos, newTodo];
        setTodos(updatedTodos, sessionId);
        notifyTodoUpdate(sessionId);
        return { is_error: false, content: ` 任务添加成功 (ID: ${newTodo.id})\n\n${formatTodoList(updatedTodos)}` };
      }

      // ====== 批量添加 ======
      case 'batch_add': {
        let batchArray = toolArgs.todos;
        if (typeof batchArray === 'string') {
          try { batchArray = JSON.parse(batchArray); }
          catch { return { is_error: true, content: ' todos 参数不是有效的 JSON 格式' }; }
        }
        if (!Array.isArray(batchArray) || batchArray.length === 0) {
          return { is_error: true, content: ' todos 必须是一个非空数组' };
        }

        const currentTodos = getTodos(sessionId);
        let nextId = currentTodos.length > 0 ? Math.max(...currentTodos.map(t => t.id)) + 1 : 1;

        const newTodos: TodoItem[] = batchArray
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
        return { is_error: false, content: ` 批量添加完成: 添加了 ${newTodos.length} 个任务\n\n${formatTodoList(updatedTodos)}` };
      }

      // ====== 查询/列表 ======
      case 'list':
      case 'read': {
        const currentTodos = getTodos(sessionId);
        return { is_error: false, content: formatTodoList(currentTodos) };
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
