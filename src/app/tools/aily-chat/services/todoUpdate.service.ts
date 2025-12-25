import { Injectable } from '@angular/core';
import { Subject, BehaviorSubject } from 'rxjs';
import { getTodos, TodoItem } from '../utils/todoStorage';

@Injectable({
  providedIn: 'root'
})
export class TodoUpdateService {
  // 使用Subject来通知TODO数据变化
  private todoUpdatedSubject = new Subject<string>();
  
  // 使用BehaviorSubject来保存最新的TODO数据
  private todoDataSubject = new BehaviorSubject<Map<string, TodoItem[]>>(new Map());

  // 公开的Observable供组件订阅
  public todoUpdated$ = this.todoUpdatedSubject.asObservable();
  public todoData$ = this.todoDataSubject.asObservable();

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
    
    // 更新数据缓存
    const currentData = this.todoDataSubject.value;
    const newData = new Map(currentData);
    newData.set(sessionId, updatedTodos);
    this.todoDataSubject.next(newData);
    
    // 发送更新通知
    this.todoUpdatedSubject.next(sessionId);
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
    const currentData = this.todoDataSubject.value;
    const newData = new Map(currentData);
    newData.set(sessionId, todos);
    this.todoDataSubject.next(newData);
  }

  /**
   * 更新指定会话的TODO数据
   * @param sessionId 会话ID
   * @param todos TODO项目数组
   */
  updateTodoData(sessionId: string, todos: TodoItem[]): void {
    // console.log('📝 更新TODO数据:', sessionId, todos);
    const newData = new Map(this.todoDataSubject.value);
    newData.set(sessionId, todos);
    this.todoDataSubject.next(newData);
    
    // 同时触发更新通知
    this.todoUpdatedSubject.next(sessionId);
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
