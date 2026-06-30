import { Injectable } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';
import { getTodos, TodoItem } from '../utils/todoStorage';

export interface TodoListSemanticItem {
  id: string;
  title: string;
  status: TodoItem['status'];
}

export interface TodoListSemanticData {
  kind: 'todoList';
  todoList: TodoListSemanticItem[];
  currentTask?: string;
  totalCount: number;
  completedCount: number;
  currentStep: number;
  summary?: string;
}

export interface TodoListSnapshot extends TodoListSemanticData {
  items: TodoItem[];
  source: 'storage' | 'lex';
  updatedAt: number;
}

export function buildTodoListSemanticDataFromTodos(todos: TodoItem[]): TodoListSemanticData {
  const completedCount = todos.filter(todo => todo.status === 'completed').length;
  const currentTodo = todos.find(todo => todo.status === 'in-progress')
    ?? todos.find(todo => todo.status === 'not-started')
    ?? null;
  const currentStep = todos.length === 0
    ? 0
    : currentTodo
      ? Math.min(todos.length, completedCount + 1)
      : todos.length;

  return {
    kind: 'todoList',
    todoList: todos.map(todo => ({
      id: String(todo.id),
      title: todo.content,
      status: todo.status,
    })),
    currentTask: currentTodo?.content,
    totalCount: todos.length,
    completedCount,
    currentStep,
    summary: todos.length
      ? `Todos (${currentStep}/${todos.length})`
      : 'Todos',
  };
}

@Injectable({
  providedIn: 'root'
})
export class TodoUpdateService {
  // 使用Subject来通知TODO数据变化
  private todoUpdatedSubject = new Subject<string>();
  
  // 使用BehaviorSubject来保存最新的TODO数据
  private todoDataSubject = new BehaviorSubject<Map<string, TodoItem[]>>(new Map());
  private todoListSnapshotSubject = new BehaviorSubject<Map<string, TodoListSnapshot>>(new Map());

  // 公开的Observable供组件订阅
  public todoUpdated$ = this.todoUpdatedSubject.asObservable();
  public todoData$ = this.todoDataSubject.asObservable();
  public todoListSnapshot$ = this.todoListSnapshotSubject.asObservable();

  constructor() {
    // 将服务实例注册到全局对象，以便notifyTodoUpdate函数可以访问
    (window as any)['todoUpdateService'] = this;
    // console.log('🔧 TodoUpdateService已注册到全局对象');
  }

  /**
   * 触发TODO数据更新通知（仅通知，不更新数据）
   * @param sessionId 会话ID
   */
  triggerTodoUpdate(sessionId: string): void {
    // console.log('🔔 触发TODO更新通知:', sessionId);
    this.todoUpdatedSubject.next(sessionId);
  }

  /**
   * 从存储重新加载TODO数据并通知
   * @param sessionId 会话ID
   */
  refreshTodoData(sessionId: string): void {
    // console.log('🔄 从存储重新加载TODO数据:', sessionId);
    
    // 获取最新的TODO数据
    const updatedTodos = getTodos(sessionId);

    this.commitTodoState(sessionId, updatedTodos, buildTodoListSemanticDataFromTodos(updatedTodos), 'storage');
  }

  /**
   * 获取指定会话的TODO数据
   * @param sessionId 会话ID
   * @returns TODO列表
   */
  getTodosForSession(sessionId: string): TodoItem[] {
    const currentData = this.todoDataSubject.value;
    return currentData.get(sessionId) || getTodos(sessionId);
  }

  getTodoListSnapshotForSession(sessionId: string): TodoListSnapshot {
    const currentSnapshots = this.todoListSnapshotSubject.value;
    const existingSnapshot = currentSnapshots.get(sessionId);
    if (existingSnapshot) {
      return existingSnapshot;
    }

    const todos = this.getTodosForSession(sessionId);
    return this.createTodoListSnapshot(todos, buildTodoListSemanticDataFromTodos(todos), 'storage');
  }

  /**
   * 检查TODO数据是否有变化
   * @param sessionId 会话ID
   * @param lastHash 上次的哈希值
   * @returns 是否有变化以及新的哈希值
   */
  checkForChanges(sessionId: string, lastHash: string): { hasChanged: boolean; newHash: string } {
    const currentTodos = this.getTodosForSession(sessionId);
    const newHash = this.generateTodoHash(currentTodos);
    
    return {
      hasChanged: newHash !== lastHash,
      newHash: newHash
    };
  }

  /**
   * 生成TODO数据的哈希值
   * @param todos TODO列表
   * @returns 哈希字符串
   */
  private generateTodoHash(todos: TodoItem[]): string {
    return todos.map(todo => 
      `${todo.id}:${todo.content}:${todo.status}:${todo.priority}:${todo.updatedAt}`
    ).join('|');
  }

  /**
   * 预加载会话的TODO数据
   * @param sessionId 会话ID
   */
  preloadTodos(sessionId: string): void {
    const todos = getTodos(sessionId);
    this.commitTodoState(sessionId, todos, buildTodoListSemanticDataFromTodos(todos), 'storage', false);
  }

  /**
   * 更新指定会话的TODO数据
   * @param sessionId 会话ID
   * @param todos TODO项目数组
   */
  updateTodoData(sessionId: string, todos: TodoItem[]): void {
    // console.log('📝 更新TODO数据:', sessionId, todos);
    this.commitTodoState(sessionId, todos, buildTodoListSemanticDataFromTodos(todos), 'storage');
  }

  updateTodoListSemanticData(
    sessionId: string,
    semanticData: TodoListSemanticData,
    todos?: TodoItem[],
  ): void {
    const normalizedTodos = todos ?? semanticData.todoList.map(item => ({
      id: Number(item.id),
      content: item.title,
      status: item.status,
      priority: 'medium' as const,
      updatedAt: Date.now(),
    }));
    this.commitTodoState(sessionId, normalizedTodos, semanticData, 'lex');
  }

  private commitTodoState(
    sessionId: string,
    todos: TodoItem[],
    semanticData: TodoListSemanticData,
    source: TodoListSnapshot['source'],
    emitUpdate: boolean = true,
  ): void {
    const newData = new Map(this.todoDataSubject.value);
    newData.set(sessionId, todos);
    this.todoDataSubject.next(newData);

    const newSnapshots = new Map(this.todoListSnapshotSubject.value);
    newSnapshots.set(sessionId, this.createTodoListSnapshot(todos, semanticData, source));
    this.todoListSnapshotSubject.next(newSnapshots);

    if (emitUpdate) {
      this.todoUpdatedSubject.next(sessionId);
    }
  }

  private createTodoListSnapshot(
    todos: TodoItem[],
    semanticData: TodoListSemanticData,
    source: TodoListSnapshot['source'],
  ): TodoListSnapshot {
    return {
      ...semanticData,
      items: [...todos],
      source,
      updatedAt: Date.now(),
    };
  }
}

/**
 * 全局TODO更新通知辅助函数
 * 可以在任何地方调用来触发TODO更新
 */
export function notifyTodoUpdate(sessionId: string, todos?: TodoItem[]): void {
  // 由于这是一个辅助函数，我们需要通过全局对象来访问服务实例
  if ((window as any)['todoUpdateService']) {
    if (todos) {
      // 如果提供了数据，直接更新
      (window as any)['todoUpdateService'].updateTodoData(sessionId, todos);
    } else {
      // 如果没有提供数据，从存储重新加载
      (window as any)['todoUpdateService'].refreshTodoData(sessionId);
    }
  } else {
    console.warn('TodoUpdateService实例未找到，请确保服务已正确注入');
  }
}
