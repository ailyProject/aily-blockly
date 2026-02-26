export interface TodoItem {
  id: number
  content: string
  status: 'not-started' | 'in-progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
  createdAt?: number
  updatedAt?: number
  tags?: string[]
  estimatedHours?: number
}

export interface TodoQuery {
  status?: TodoItem['status'][]
  priority?: TodoItem['priority'][]
  contentMatch?: string
  tags?: string[]
  dateRange?: { from?: Date; to?: Date }
}

export interface TodoStorageConfig {
  maxTodos: number
  autoArchiveCompleted: boolean
  sortBy: 'createdAt' | 'updatedAt' | 'priority' | 'status'
  sortOrder: 'asc' | 'desc'
}

export interface TodoMetrics {
  totalOperations: number
  cacheHits: number
  cacheMisses: number
  lastOperation: number
}

export interface ValidationResult {
  result: boolean
  errorCode?: number
  message?: string
  meta?: any
}

// 文件存储适配器 - 适配现有的 window['fs'] API
const FileStorageAdapter = {
  exists: (path: string) => window['fs'].existsSync(path),
  read: (path: string) => window['fs'].readFileSync(path, 'utf-8'),
  write: (path: string, content: string) => {
    const dir = window['path'].dirname(path);
    if (!window['fs'].existsSync(dir)) {
      window['fs'].mkdirSync(dir, { recursive: true });
    }
    window['fs'].writeFileSync(path, content, 'utf-8');
  }
};

// 配置和缓存
const DEFAULT_CONFIG: TodoStorageConfig = {
  maxTodos: 100,
  autoArchiveCompleted: false,
  sortBy: 'status',
  sortOrder: 'desc',
}

let todoCache: Map<string, TodoItem[]> = new Map()
let cacheTimestamp: Map<string, number> = new Map()
const CACHE_TTL = 5000 // 5秒缓存

// 智能排序函数
function smartSort(todos: TodoItem[]): TodoItem[] {
  return [...todos].sort((a, b) => {
    // 1. 状态优先级: in-progress > not-started > completed
    const statusOrder: Record<string, number> = { 'in-progress': 3, 'not-started': 2, completed: 1 }
    const statusDiff = (statusOrder[b.status] || 0) - (statusOrder[a.status] || 0)
    if (statusDiff !== 0) return statusDiff

    // 2. 优先级: high > medium > low
    const priorityOrder: Record<string, number> = { high: 3, medium: 2, low: 1 }
    const priorityDiff = (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0)
    if (priorityDiff !== 0) return priorityDiff

    // 3. 更新时间 (最新的在前)
    const aTime = a.updatedAt || 0
    const bTime = b.updatedAt || 0
    return bTime - aTime
  })
}

// 验证函数
export function validateTodos(todos: TodoItem[]): ValidationResult {
  // 检查重复ID
  const ids = todos.map(todo => todo.id)
  const uniqueIds = new Set(ids)
  if (ids.length !== uniqueIds.size) {
    return {
      result: false,
      errorCode: 1,
      message: 'Duplicate todo IDs found',
      meta: {
        duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      },
    }
  }

  // 检查多个in-progress任务
  const inProgressTasks = todos.filter(todo => todo.status === 'in-progress')
  if (inProgressTasks.length > 1) {
    return {
      result: false,
      errorCode: 2,
      message: 'Only one task can be in-progress at a time',
      meta: { inProgressTaskIds: inProgressTasks.map(t => t.id) },
    }
  }

  // 验证每个todo
  for (const todo of todos) {
    if (!todo.content?.trim()) {
      return {
        result: false,
        errorCode: 3,
        message: `Todo with ID "${todo.id}" has empty content`,
        meta: { todoId: todo.id },
      }
    }
    if (!['not-started', 'in-progress', 'completed'].includes(todo.status)) {
      return {
        result: false,
        errorCode: 4,
        message: `Invalid status "${todo.status}" for todo "${todo.id}"`,
        meta: { todoId: todo.id, invalidStatus: todo.status },
      }
    }
    if (!['high', 'medium', 'low'].includes(todo.priority)) {
      return {
        result: false,
        errorCode: 5,
        message: `Invalid priority "${todo.priority}" for todo "${todo.id}"`,
        meta: { todoId: todo.id, invalidPriority: todo.priority },
      }
    }
  }

  return { result: true }
}

// 指标管理
function updateMetrics(sessionId: string, operation: string, cacheHit: boolean = false): void {
  try {
    const metricsFile = `${window['path'].getAppDataPath()}/aily-todos/metrics_${sessionId}.json`
    let metrics: TodoMetrics = {
      totalOperations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      lastOperation: 0,
    }

    if (FileStorageAdapter.exists(metricsFile)) {
      const fileContent = FileStorageAdapter.read(metricsFile)
      metrics = { ...metrics, ...JSON.parse(fileContent) }
    }

    metrics.totalOperations++
    metrics.lastOperation = Date.now()

    if (cacheHit) {
      metrics.cacheHits++
    } else {
      metrics.cacheMisses++
    }

    FileStorageAdapter.write(metricsFile, JSON.stringify(metrics, null, 2))
  } catch (error) {
    console.warn('指标更新失败:', error)
  }
}

// 核心存储函数
export function getTodos(sessionId: string = 'default'): TodoItem[] {
  const now = Date.now()
  const cacheKey = sessionId
  
  // 检查缓存
  if (todoCache.has(cacheKey) && 
      cacheTimestamp.has(cacheKey) && 
      now - cacheTimestamp.get(cacheKey)! < CACHE_TTL) {
    updateMetrics(sessionId, 'getTodos', true)
    return todoCache.get(cacheKey)!
  }

  updateMetrics(sessionId, 'getTodos', false)
  
  const todoFile = `${window['path'].getAppDataPath()}/aily-todos/todos_${sessionId}.json`
  let todos: TodoItem[] = []
  
  try {
    if (FileStorageAdapter.exists(todoFile)) {
      const fileContent = FileStorageAdapter.read(todoFile)
      todos = JSON.parse(fileContent)
    }
  } catch (error) {
    console.warn('读取todos失败:', error)
    todos = []
  }
  
  // 更新缓存
  todoCache.set(cacheKey, [...todos])
  cacheTimestamp.set(cacheKey, now)
  
  return todos
}

export function setTodos(todos: TodoItem[], sessionId: string = 'default'): void {
  try {
    // 处理时间戳
    const processedTodos = todos.map(todo => {
      return {
        ...todo,
        updatedAt: Date.now(),
        createdAt: todo.createdAt || Date.now(),
      }
    })

    // 智能排序
    const sortedTodos = smartSort(processedTodos)
    
    const todoFile = `${window['path'].getAppDataPath()}/aily-todos/todos_${sessionId}.json`
    FileStorageAdapter.write(todoFile, JSON.stringify(sortedTodos, null, 2))
    
    // 清除缓存
    todoCache.delete(sessionId)
    cacheTimestamp.delete(sessionId)
    
    updateMetrics(sessionId, 'setTodos')
  } catch (error) {
    console.warn('保存todos失败:', error)
    throw error
  }
}

export function addTodo(todo: Omit<TodoItem, 'createdAt' | 'updatedAt'>, sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  
  // 检查重复ID
  if (todos.some(existing => existing.id === todo.id)) {
    throw new Error(`Todo with ID '${todo.id}' already exists`)
  }

  const newTodo: TodoItem = {
    ...todo,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  const updatedTodos = [...todos, newTodo]
  setTodos(updatedTodos, sessionId)
  updateMetrics(sessionId, 'addTodo')
  return updatedTodos
}

export function updateTodo(id: number, updates: Partial<TodoItem>, sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  const existingTodo = todos.find(todo => todo.id === id)

  if (!existingTodo) {
    throw new Error(`Todo with ID '${id}' not found`)
  }

  const updatedTodos = todos.map(todo =>
    todo.id === id ? { ...todo, ...updates, updatedAt: Date.now() } : todo,
  )

  setTodos(updatedTodos, sessionId)
  updateMetrics(sessionId, 'updateTodo')
  return updatedTodos
}

export function deleteTodo(id: number, sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  const todoExists = todos.some(todo => todo.id === id)

  if (!todoExists) {
    throw new Error(`Todo with ID '${id}' not found`)
  }

  const updatedTodos = todos.filter(todo => todo.id !== id)
  setTodos(updatedTodos, sessionId)
  updateMetrics(sessionId, 'deleteTodo')
  return updatedTodos
}

export function clearTodos(sessionId: string = 'default'): void {
  setTodos([], sessionId)
  updateMetrics(sessionId, 'clearTodos')
}

export function getTodoById(id: number, sessionId: string = 'default'): TodoItem | undefined {
  const todos = getTodos(sessionId)
  updateMetrics(sessionId, 'getTodoById')
  return todos.find(todo => todo.id === id)
}

export function getTodosByStatus(status: TodoItem['status'], sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  updateMetrics(sessionId, 'getTodosByStatus')
  return todos.filter(todo => todo.status === status)
}

export function getTodosByPriority(priority: TodoItem['priority'], sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  updateMetrics(sessionId, 'getTodosByPriority')
  return todos.filter(todo => todo.priority === priority)
}

export function queryTodos(query: TodoQuery, sessionId: string = 'default'): TodoItem[] {
  const todos = getTodos(sessionId)
  updateMetrics(sessionId, 'queryTodos')

  return todos.filter(todo => {
    // 状态筛选
    if (query.status && !query.status.includes(todo.status)) {
      return false
    }

    // 优先级筛选
    if (query.priority && !query.priority.includes(todo.priority)) {
      return false
    }

    // 内容搜索
    if (query.contentMatch && !todo.content.toLowerCase().includes(query.contentMatch.toLowerCase())) {
      return false
    }

    // 标签筛选
    if (query.tags && todo.tags) {
      const hasMatchingTag = query.tags.some(tag => todo.tags?.includes(tag))
      if (!hasMatchingTag) return false
    }

    // 日期范围筛选
    if (query.dateRange) {
      const todoDate = new Date(todo.createdAt || 0)
      if (query.dateRange.from && todoDate < query.dateRange.from) return false
      if (query.dateRange.to && todoDate > query.dateRange.to) return false
    }

    return true
  })
}

export function getTodoStatistics(sessionId: string = 'default') {
  const todos = getTodos(sessionId)
  
  let metrics: TodoMetrics = {
    totalOperations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    lastOperation: 0,
  }

  try {
    const metricsFile = `${window['path'].getAppDataPath()}/aily-todos/metrics_${sessionId}.json`
    if (FileStorageAdapter.exists(metricsFile)) {
      const fileContent = FileStorageAdapter.read(metricsFile)
      metrics = { ...metrics, ...JSON.parse(fileContent) }
    }
  } catch (error) {
    console.warn('读取指标失败:', error)
  }

  return {
    total: todos.length,
    byStatus: {
      'not-started': todos.filter(t => t.status === 'not-started').length,
      'in-progress': todos.filter(t => t.status === 'in-progress').length,
      completed: todos.filter(t => t.status === 'completed').length,
    },
    byPriority: {
      high: todos.filter(t => t.priority === 'high').length,
      medium: todos.filter(t => t.priority === 'medium').length,
      low: todos.filter(t => t.priority === 'low').length,
    },
    metrics,
    cacheEfficiency: metrics.totalOperations > 0 
      ? Math.round((metrics.cacheHits / metrics.totalOperations) * 100) 
      : 0,
    estimatedTotalHours: todos.reduce((sum, todo) => sum + (todo.estimatedHours || 0), 0),
  }
}

export function optimizeTodoStorage(sessionId: string = 'default'): void {
  // 清除缓存
  todoCache.delete(sessionId)
  cacheTimestamp.delete(sessionId)

  // 清理无效条目
  const todos = getTodos(sessionId)
  const validTodos = todos.filter(
    todo =>
      todo.id != null &&
      todo.content &&
      ['not-started', 'in-progress', 'completed'].includes(todo.status) &&
      ['high', 'medium', 'low'].includes(todo.priority),
  )

  if (validTodos.length !== todos.length) {
    setTodos(validTodos, sessionId)
  }

  updateMetrics(sessionId, 'optimizeTodoStorage')
}

// 对话上下文集成功能
export function getTodoContextSummary(sessionId: string = 'default'): string {
  const todos = getTodos(sessionId)
  const stats = getTodoStatistics(sessionId)
  
  if (todos.length === 0) {
    return "当前没有待办任务。"
  }
  
  const inProgress = todos.filter(t => t.status === 'in-progress')
  const pending = todos.filter(t => t.status === 'not-started')
  const highPriority = todos.filter(t => t.priority === 'high' && t.status !== 'completed')
  
  let summary = `📋 当前有${stats.total}个任务`
  
  if (inProgress.length > 0) {
    summary += `，正在进行：${inProgress[0].content}`
  }
  
  if (pending.length > 0) {
    summary += `，待处理${pending.length}项`
    if (highPriority.length > 0) {
      summary += `（${highPriority.length}项高优先级）`
    }
  }
  
  return summary + "。"
}

export function getNextTask(sessionId: string = 'default'): TodoItem | null {
  const todos = getTodos(sessionId)
  
  // 优先返回in-progress任务
  const inProgress = todos.find(t => t.status === 'in-progress')
  if (inProgress) return inProgress
  
  // 然后返回最高优先级的not-started任务
  const pendingTodos = todos.filter(t => t.status === 'not-started')
  if (pendingTodos.length === 0) return null
  
  // 按优先级排序
  const sortedPending = pendingTodos.sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 }
    return priorityOrder[b.priority] - priorityOrder[a.priority]
  })
  
  return sortedPending[0]
}

export function clearTodoStorage(): void {
  // 删除所有存储文件
  try {
    const dir = `${window['path'].getAppDataPath()}/aily-todos`
    if (FileStorageAdapter.exists(dir)) {
      const files = window['fs'].readdirSync(dir)
      for (const file of files) {
        if (file.startsWith('todos_') || file.startsWith('metrics_')) {
          window['fs'].unlinkSync(window['path'].join(dir, file))
        }
      }
    }
  } catch (error) {
    console.warn('清除存储失败:', error)
  }
}