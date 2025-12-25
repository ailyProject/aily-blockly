import { ToolUseResult } from "./tools";
import { 
  TodoItem, 
  TodoQuery,
  getTodos,
  setTodos,
  addTodo,
  updateTodo,
  deleteTodo,
  clearTodos,
  getTodoById,
  getTodosByStatus,
  getTodosByPriority,
  queryTodos,
  getTodoStatistics,
  optimizeTodoStorage,
  validateTodos
} from "../utils/todoStorage";
import { notifyTodoUpdate } from "../services/todoUpdate.service";

// =============================================================================
// TodoManager - IDE端运行的todo管理器
// =============================================================================

interface TodoManagerConfig {
  reminderThreshold: number; // 提醒阈值，默认为5
  maxThreshold: number; // 最大阈值，默认为10
  enabled: boolean; // 是否启用
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

  private constructor() {
    // console.log('🎯 TodoManager 初始化');
  }

  /**
   * 配置管理器
   */
  configure(config: Partial<TodoManagerConfig>): void {
    this.config = { ...this.config, ...config };
    // console.log(`⚙️ TodoManager 配置更新:`, this.config);
  }

  /**
   * 启动监测 - 当 todoWrite 工具被使用时调用
   */
  startMonitoring(): void {
    this.isActive = true;
    this.callCount = 0;
    this.lastReminderCall = 0;
    // console.log('🔍 TodoManager 开始监测工具调用');
  }

  /**
   * 停止监测
   */
  stopMonitoring(): void {
    this.isActive = false;
    this.callCount = 0;
    // console.log('⏹️ TodoManager 停止监测');
  }

  /**
   * 重置调用计数
   */
  resetCallCount(): void {
    this.callCount = 0;
    this.lastReminderCall = 0;
    // console.log('🔄 TodoManager 调用计数已重置');
  }

  /**
   * 记录工具调用 - 在每个工具调用时调用（除了todoWrite）
   */
  recordToolCall(toolName: string): void {
    if (!this.config.enabled || !this.isActive) {
      return;
    }

    if (toolName === 'todoWrite') {
      // 如果是todoWrite工具，重置计数
      this.callCount = 0;
      this.lastReminderCall = 0;
      // console.log('🔄 TodoManager 计数重置（todoWrite调用）');
      return;
    }

    this.callCount++;
    // console.log(`📊 TodoManager 记录调用: ${toolName}, 当前计数: ${this.callCount}`);
  }

  /**
   * 检查是否需要提醒，并返回提醒信息
   */
  checkAndGetReminder(sessionId: string = 'default'): string | null {
    if (!this.config.enabled || !this.isActive) {
      return null;
    }

    // 检查是否达到提醒阈值
    const shouldRemind = this.callCount >= this.config.reminderThreshold && 
                        this.callCount > this.lastReminderCall;

    if (!shouldRemind) {
      return null;
    }

    this.lastReminderCall = this.callCount;

    // 获取todo信息
    const todos = getTodos(sessionId);
    const stats = getTodoStatistics(sessionId);

    if (stats.total === 0) {
      return null; // 没有todo则不提醒
    }

    // 根据计数程度决定提醒强度
    const isUrgent = this.callCount >= this.config.maxThreshold;
    const urgencyPrefix = isUrgent ? '🚨 **紧急提醒**' : '💡 **友好提醒**';

    // 生成提醒信息
    let reminder = `\n\n${urgencyPrefix}: 您有 ${stats.byStatus.pending} 个待处理任务`;
    
    if (stats.byStatus.in_progress > 0) {
      reminder += `, ${stats.byStatus.in_progress} 个进行中任务`;
    }
    
    reminder += `。`;

    // 如果是紧急提醒，显示具体任务
    if (isUrgent && stats.byStatus.pending > 0) {
      const pendingTodos = getTodosByStatus('pending', sessionId).slice(0, 3);
      reminder += `\n\n🔥 **待处理任务**:`;
      pendingTodos.forEach((todo, index) => {
        const priorityIcon = todo.priority === 'high' ? '🔴' : 
                           todo.priority === 'medium' ? '🟡' : '🟢';
        reminder += `\n${index + 1}. ${priorityIcon} ${todo.content}`;
      });
      
      if (stats.byStatus.pending > 3) {
        reminder += `\n... 还有 ${stats.byStatus.pending - 3} 个任务`;
      }
    }

    reminder += `\n\n💬 使用 manage_todo_list 工具来查看或更新任务状态`;

    // console.log(`📢 TodoManager 生成提醒 (计数: ${this.callCount})`);
    return reminder;
  }

  /**
   * 获取状态信息
   */
  getStatus(): {
    isActive: boolean;
    callCount: number;
    config: TodoManagerConfig;
  } {
    return {
      isActive: this.isActive,
      callCount: this.callCount,
      config: { ...this.config }
    };
  }
}

// 导出管理器实例
export const todoManager = TodoManager.getInstance();

/**
 * 工具调用拦截器 - 在其他工具的返回结果中注入todo提醒
 * 这个函数应该在每个工具函数的最后被调用
 */
export function injectTodoReminder(
  toolResult: ToolUseResult, 
  toolName: string, 
  sessionId: string = 'default'
): ToolUseResult {
  // 记录工具调用
  todoManager.recordToolCall(toolName);
  
  // 检查是否需要提醒
  const reminder = todoManager.checkAndGetReminder(sessionId);
  
  if (!reminder) {
    return toolResult; // 不需要提醒，返回原结果
  }
  
  // 需要提醒，在结果中添加提醒信息
  const enhancedResult = { ...toolResult };
  
  if (enhancedResult.is_error) {
    // 如果是错误结果，在错误信息后添加提醒
    enhancedResult.content = `${enhancedResult.content}${reminder}`;
  } else {
    // 如果是成功结果，在成功信息后添加提醒
    enhancedResult.content = `${enhancedResult.content}${reminder}`;
  }
  
  // console.log(`📢 为工具 ${toolName} 注入todo提醒`);
  return enhancedResult;
}

/**
 * 配置TodoManager - 供IDE调用
 */
export function configureTodoManager(config: Partial<TodoManagerConfig>): void {
  todoManager.configure(config);
}

/**
 * 获取TodoManager状态 - 供IDE调用
 */
export function getTodoManagerStatus() {
  return todoManager.getStatus();
}

export async function todoWriteTool(toolArgs: any): Promise<ToolUseResult> {
  let toolResult = null;
  let is_error = false;

  // 🎯 启动TodoManager监测
  todoManager.startMonitoring();

  try {
    const { 
      operation, 
      sessionId = 'default', 
      todos, 
      id, 
      content, 
      status, 
      priority, 
      tags, 
      estimatedHours,
      query 
    } = toolArgs;

    // 生成简洁的显示格式，专注于核心信息
    const formatTodoList = (todos: TodoItem[]): string => {
      if (todos.length === 0) {
        return 'TODO列表为空';
      }

      let result = 'TODO列表:\n\n| ID | priority | content | status |\n| --- | --- | --- | --- |\n';

      todos.forEach((todo) => {
        result += `| ${todo.id} | ${todo.priority.toUpperCase()} | ${todo.content} | ${todo.status.toUpperCase()} |\n`;
      });
      
      return result.trim();
    };

    const generateId = (): string => {
      return Date.now().toString(36) + Math.random().toString(36).substr(2);
    };

    switch (operation) {
      case 'update':
        // 批量更新TODO列表
        let todosArray = todos;
        
        // 如果 todos 是字符串，尝试解析为 JSON
        if (typeof todos === 'string') {
          try {
            todosArray = JSON.parse(todos);
            // console.log('📝 解析 todos 字符串为数组:', todosArray);
          } catch (parseError) {
            toolResult = `❌ **错误**: todos 参数不是有效的 JSON 格式\n\n💡 **错误详情**: ${parseError instanceof Error ? parseError.message : '解析失败'}\n\n💡 **正确用法**: \`{"operation": "update", "todos": [...]}\``;
            is_error = true;
            break;
          }
        }
        
        if (!todosArray || !Array.isArray(todosArray)) {
          toolResult = `❌ **错误**: todos 必须是一个数组\n\n💡 **当前类型**: ${typeof todosArray}\n\n💡 **正确用法**: \`{"operation": "update", "todos": [...]}\``;
          is_error = true;
          break;
        }

        // 验证todos格式
        const validatedTodos: TodoItem[] = todosArray.map((todo: any) => ({
          id: todo.id || generateId(),
          content: todo.content?.trim() || '',
          status: ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending',
          priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium',
          tags: Array.isArray(todo.tags) ? todo.tags : [],
          estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
          createdAt: todo.createdAt || Date.now(),
          updatedAt: Date.now()
        }));

        // 验证
        const validation = validateTodos(validatedTodos);
        if (!validation.result) {
          toolResult = `❌ **验证失败**: ${validation.message}`;
          is_error = true;
          break;
        }

        setTodos(validatedTodos, sessionId);
        notifyTodoUpdate(sessionId); // 触发UI更新通知
        toolResult = `✅ **TODO列表更新成功**\n\n${formatTodoList(validatedTodos)}`;
        break;

      case 'add':
        if (!content?.trim()) {
          toolResult = '❌ **错误**: 缺少任务内容\n\n💡 **正确用法**: `{"operation": "add", "content": "任务内容", "priority": "high|medium|low", "status": "pending|in_progress|completed", "tags": ["标签"]}` ';
          is_error = true;
          break;
        }

        try {
          const newTodo = {
            id: generateId(),
            content: content.trim(),
            status: ['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending' as const,
            priority: priority || 'medium' as const,
            tags: Array.isArray(tags) ? tags : [],
            estimatedHours: estimatedHours,
          };

          // 检查是否已有in_progress任务（当新任务要设置为in_progress时）
          if (newTodo.status === 'in_progress') {
            const inProgressTodos = getTodosByStatus('in_progress', sessionId);
            if (inProgressTodos.length > 0) {
              toolResult = '❌ **错误**: 已有任务在进行中，请先完成当前任务或创建为待处理状态';
              is_error = true;
              break;
            }
          }

          const updatedTodos = addTodo(newTodo, sessionId);
          notifyTodoUpdate(sessionId); // 触发UI更新通知
          
          const statusIcon = newTodo.status === 'completed' ? '✅' : 
                            newTodo.status === 'in_progress' ? '🔄' : '⏸️';
          const priorityIcon = newTodo.priority === 'high' ? '🔴' : 
                              newTodo.priority === 'medium' ? '🟡' : '🟢';
          const tagsDisplay = Array.isArray(newTodo.tags) && newTodo.tags.length > 0 
            ? ` 🏷️[${newTodo.tags.join(', ')}]` 
            : '';
          const hoursDisplay = newTodo.estimatedHours 
            ? ` ⏱️${newTodo.estimatedHours}h` 
            : '';
            
          toolResult = `✅ **任务添加成功**: ${statusIcon} ${priorityIcon} ${newTodo.content}${tagsDisplay}${hoursDisplay} \`(${newTodo.id})\`\n\n${formatTodoList(updatedTodos)}`;
        } catch (error) {
          toolResult = `❌ **添加失败**: ${error instanceof Error ? error.message : '未知错误'}`;
          is_error = true;
        }
        break;

      case 'batch_add':
        let batchTodosArray = todos;
        
        // 如果 todos 是字符串，尝试解析为 JSON
        if (typeof todos === 'string') {
          try {
            batchTodosArray = JSON.parse(todos);
            // console.log('📝 解析 batch_add todos 字符串为数组:', batchTodosArray);
          } catch (parseError) {
            toolResult = `❌ **错误**: todos 参数不是有效的 JSON 格式\n\n💡 **错误详情**: ${parseError instanceof Error ? parseError.message : '解析失败'}\n\n💡 **正确用法**: \`{"operation": "batch_add", "todos": [...]}\``;
            is_error = true;
            break;
          }
        }
        
        if (!batchTodosArray || !Array.isArray(batchTodosArray) || batchTodosArray.length === 0) {
          toolResult = `❌ **错误**: todos 必须是一个非空数组\n\n💡 **当前类型**: ${typeof batchTodosArray}\n\n💡 **正确用法**: \`{"operation": "batch_add", "todos": [{"content": "任务1", "priority": "high"}, {"content": "任务2"}]}\``;
          is_error = true;
          break;
        }

        try {
          const currentTodos = getTodos(sessionId);
          const inProgressCount = currentTodos.filter(t => t.status === 'in_progress').length;
          
          const newTodos = batchTodosArray.map((todo: any) => ({
            id: todo.id || generateId(),
            content: todo.content?.trim() || '',
            status: ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending',
            priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium',
            tags: Array.isArray(todo.tags) ? todo.tags : [],
            estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
          }));

          // 验证新任务
          const newInProgressCount = newTodos.filter(t => t.status === 'in_progress').length;
          if (inProgressCount + newInProgressCount > 1) {
            toolResult = '❌ **错误**: 添加后将有多个进行中任务，同时只能有一个任务处于进行中状态';
            is_error = true;
            break;
          }

          // 逐个添加任务
          let addedCount = 0;
          let failedTasks: string[] = [];
          
          for (const newTodo of newTodos) {
            try {
              if (!newTodo.content?.trim()) {
                failedTasks.push(`空内容任务`);
                continue;
              }
              
              await addTodo(newTodo, sessionId);
              addedCount++;
            } catch (error) {
              failedTasks.push(`"${newTodo.content}": ${error instanceof Error ? error.message : '未知错误'}`);
            }
          }

          const updatedTodos = getTodos(sessionId);
          if (addedCount > 0) {
            notifyTodoUpdate(sessionId); // 触发UI更新通知
          }
          
          let resultMessage = `✅ **批量添加完成**: 成功添加${addedCount}个任务`;
          if (failedTasks.length > 0) {
            resultMessage += `\n⚠️ **失败${failedTasks.length}个**:\n${failedTasks.map(task => `  • ${task}`).join('\n')}`;
          }
          
          toolResult = `${resultMessage}\n\n${formatTodoList(updatedTodos)}`;
        } catch (error) {
          toolResult = `❌ **批量添加失败**: ${error instanceof Error ? error.message : '未知错误'}`;
          is_error = true;
        }
        break;

      case 'query':
        if (!query) {
          toolResult = '❌ **错误**: 缺少查询条件\n\n💡 **正确用法**: `{"operation": "query", "query": {"status": ["pending"], "priority": ["high"]}}` ';
          is_error = true;
          break;
        }

        const queryResults = queryTodos(query, sessionId);
        toolResult = `🔍 **查询结果** (${queryResults.length}项)\n\n${formatTodoList(queryResults)}`;
        break;

      case 'stats':
        const statistics = getTodoStatistics(sessionId);
        toolResult = `📊 **详细统计**\n\n` +
          `**总数**: ${statistics.total}项\n` +
          `**状态分布**:\n` +
          `  • ⏸️ 待处理: ${statistics.byStatus.pending}项\n` +
          `  • 🔄 进行中: ${statistics.byStatus.in_progress}项\n` +
          `  • ✅ 已完成: ${statistics.byStatus.completed}项\n\n` +
          `**优先级分布**:\n` +
          `  • 🔴 高优先级: ${statistics.byPriority.high}项\n` +
          `  • 🟡 中优先级: ${statistics.byPriority.medium}项\n` +
          `  • 🟢 低优先级: ${statistics.byPriority.low}项\n\n` +
          `**时间估算**: ⏱️ 总计${statistics.estimatedTotalHours}小时\n` +
          `**性能指标**: 📈 缓存效率${statistics.cacheEfficiency}% (${statistics.metrics.cacheHits}/${statistics.metrics.totalOperations})`;
        break;

      case 'list':
        const currentTodos = getTodos(sessionId);
        toolResult = formatTodoList(currentTodos);
        break;

      case 'toggle':
        if (!id) {
          toolResult = '❌ **错误**: 缺少任务ID\n\n💡 **正确用法**: `{"operation": "toggle", "id": "任务ID"}` ';
          is_error = true;
          break;
        }

        try {
          const todo = getTodoById(id, sessionId);
          if (!todo) {
            toolResult = `❌ **错误**: 找不到ID为 ${id} 的任务`;
            is_error = true;
            break;
          }

          const newStatus = todo.status === 'completed' ? 'pending' : 
                           todo.status === 'pending' ? 'in_progress' :
                           'completed';

          // 检查是否已有in_progress任务
          if (newStatus === 'in_progress') {
            const inProgressTodos = getTodosByStatus('in_progress', sessionId);
            if (inProgressTodos.length > 0) {
              toolResult = '❌ **错误**: 已有任务在进行中，请先完成当前任务';
              is_error = true;
              break;
            }
          }

          const updatedTodos = updateTodo(id, { status: newStatus }, sessionId);
          notifyTodoUpdate(sessionId); // 触发UI更新通知
          
          const statusText = newStatus === 'completed' ? '完成' : 
                            newStatus === 'in_progress' ? '开始进行' : '重置为待处理';
          toolResult = `✅ **任务状态更新**: ${todo.content} → ${statusText}\n\n${formatTodoList(updatedTodos)}`;
        } catch (error) {
          toolResult = `❌ **更新失败**: ${error instanceof Error ? error.message : '未知错误'}`;
          is_error = true;
        }
        break;

      case 'delete':
        if (!id) {
          toolResult = '❌ **错误**: 缺少任务ID\n\n💡 **正确用法**: `{"operation": "delete", "id": "任务ID"}` ';
          is_error = true;
          break;
        }

        try {
          const todo = getTodoById(id, sessionId);
          if (!todo) {
            toolResult = `❌ **错误**: 找不到ID为 ${id} 的任务`;
            is_error = true;
            break;
          }

          const updatedTodos = deleteTodo(id, sessionId);
          notifyTodoUpdate(sessionId); // 触发UI更新通知
          toolResult = `✅ **任务删除成功**: ${todo.content}\n\n${formatTodoList(updatedTodos)}`;
        } catch (error) {
          toolResult = `❌ **删除失败**: ${error instanceof Error ? error.message : '未知错误'}`;
          is_error = true;
        }
        break;

      case 'clear':
        const count = getTodos(sessionId).length;
        clearTodos(sessionId);
        if (count > 0) {
          notifyTodoUpdate(sessionId); // 触发UI更新通知
        }
        toolResult = `✅ **清空完成**: 删除了${count}个任务`;
        break;

      case 'optimize':
        optimizeTodoStorage(sessionId);
        const optimizedTodos = getTodos(sessionId);
        notifyTodoUpdate(sessionId); // 触发UI更新通知
        toolResult = `✅ **存储优化完成**\n\n${formatTodoList(optimizedTodos)}`;
        break;

      default:
        toolResult = `❌ **错误**: 不支持的操作 "${operation}"\n\n💡 **支持的操作**:\n` +
          `• \`add\` - 添加单个任务 (支持content, priority, status, tags, estimatedHours)\n` +
          `• \`batch_add\` - 批量添加任务 (支持todos数组)\n` +
          `• \`list\` - 查看列表\n` +
          `• \`toggle\` - 切换状态\n` +
          `• \`delete\` - 删除任务\n` +
          `• \`update\` - 批量更新\n` +
          `• \`query\` - 高级查询 (按状态、优先级、内容、标签筛选)\n` +
          `• \`stats\` - 详细统计信息\n` +
          `• \`clear\` - 清空列表\n` +
          `• \`optimize\` - 优化存储`;
        is_error = true;
    }

  } catch (error) {
    is_error = true;
    toolResult = `❌ 执行出错: ${error instanceof Error ? error.message : '未知错误'}`;
  }

  // 获取最新的todos列表用于返回
  let resultTodos: any[] = [];
  let currentSessionId = 'default';
  try {
    // 从toolArgs中获取sessionId，如果没有则使用default
    currentSessionId = toolArgs?.sessionId || 'default';
    if (!is_error) {
      resultTodos = getTodos(currentSessionId);
    }
  } catch (error) {
    // 忽略获取todos的错误，不影响主要结果
  }

  return {
    content: toolResult,
    is_error
  };
}
