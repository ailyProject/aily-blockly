import { Injectable } from '@angular/core';
import { Subject, Observable, filter, map, take, timeout, catchError, of } from 'rxjs';

// 定义动作接口
export interface Action<T = any> {
  type: string;
  payload?: T;
  timestamp?: number;
  id?: string; // 用于标识动作，以便接收反馈
  requireFeedback?: boolean; // 标识是否需要反馈
}

// 定义反馈接口
export interface ActionFeedback<T = any> {
  actionId: string;
  success: boolean;
  data: any;
  error?: string;
  timestamp: number;
}

// 定义反馈回调函数接口
export interface FeedbackCallback<T = any> {
  (feedback: ActionFeedback<T>): void;
}

@Injectable({
  providedIn: 'root'
})
export class ActionService {
  private actionSubject = new Subject<Action>();
  private feedbackSubject = new Subject<ActionFeedback>();
  private listenerMap = new Map<string, any>(); // 存储监听器

  constructor() { }

  /**
   * 发出一个动作
   * @param type 动作类型
   * @param payload 动作数据（可选）
   * @param feedbackCallback 反馈回调函数（可选，如果提供则表示需要反馈）
   * @param timeoutMs 等待反馈的超时时间（毫秒，默认5000ms）
   */
  dispatch<T = any>(
    type: string,
    payload?: T,
    feedbackCallback?: FeedbackCallback<T>,
    timeoutMs: number = 5000
  ): void {
    const actionId = this.generateActionId();
    const action: Action<T> = {
      type,
      payload,
      timestamp: Date.now(),
      id: actionId,
      requireFeedback: !!feedbackCallback
    };

    this.actionSubject.next(action);

    if (feedbackCallback) {
      this.waitForFeedback<T>(actionId, timeoutMs).subscribe(feedbackCallback);
    }
  }

  /**
   * 发送反馈
   * @param actionId 动作ID
   * @param success 是否成功
   * @param data 反馈数据（可选）
   * @param error 错误信息（可选）
   */
  sendFeedback<T = any>(actionId: string, success: boolean, data?: T, error?: string): void {
    const feedback: ActionFeedback<T> = {
      actionId,
      success,
      data,
      error,
      timestamp: Date.now()
    };
    this.feedbackSubject.next(feedback);
  }

  /**
   * 等待指定动作的反馈
   * @param actionId 动作ID
   * @param timeoutMs 超时时间（毫秒）
   * @returns Observable<ActionFeedback>
   */
  private waitForFeedback<T = any>(actionId: string, timeoutMs: number): Observable<ActionFeedback<T>> {
    return this.feedbackSubject.asObservable().pipe(
      filter(feedback => feedback.actionId === actionId),
      take(1),
      timeout(timeoutMs),
      catchError(error => {
        // 超时或其他错误时返回错误反馈
        return of({
          actionId,
          success: false,
          error: error.name === 'TimeoutError' ? '等待反馈超时' : error.message,
          timestamp: Date.now()
        } as ActionFeedback<T>);
      })
    );
  }

  /**
   * 生成唯一的动作ID
   * @returns string
   */
  private generateActionId(): string {
    return `action_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 监听指定类型的动作
   * @param actionType 要监听的动作类型
   * @param handler 处理函数，返回反馈数据或Promise<反馈数据>
   * @param listenerId 可选的监听器ID，用于后续取消监听
   * @returns 取消订阅函数，也可以使用unlisten方法取消
   */
  listen<T = any, R = any>(
    actionType: string,
    handler: (action: Action<T>) => R | Promise<R>,
    listenerId?: string
  ): () => void {
    const subscription = this.actionSubject.asObservable().pipe(
      filter(action => action.type === actionType),
      map(action => action as Action<T>)
    ).subscribe({
      next: async (action) => {
        // 无论是否需要反馈，都执行handler
        try {
          const result = await handler(action);

          // 只有在需要反馈时才发送反馈
          if (action.requireFeedback && action.id) {
            this.sendFeedback(action.id, true, result);
          }
        } catch (error) {
          // 只有在需要反馈时才发送错误反馈
          if (action.requireFeedback && action.id) {
            this.sendFeedback(
              action.id,
              false,
              undefined,
              error instanceof Error ? error.message : '处理失败'
            );
          } else {
            // 不需要反馈时，只是在控制台警告
            console.warn('处理动作时发生错误:', error);
          }
        }
      }
    });

    // 如果提供了listenerId，存储到map中
    if (listenerId) {
      this.listenerMap.set(listenerId, subscription);
    }

    return () => {
      subscription.unsubscribe();
      if (listenerId) {
        this.listenerMap.delete(listenerId);
      }
    };
  }

  /**
   * 取消指定ID的监听器
   * @param listenerId 监听器ID
   * @returns 是否成功取消
   */
  unlisten(listenerId: string): boolean {
    const subscription = this.listenerMap.get(listenerId);
    if (subscription) {
      subscription.unsubscribe();
      this.listenerMap.delete(listenerId);
      return true;
    }
    return false;
  }

  /**
   * 取消所有监听器
   */
  unlistenAll(): void {
    this.listenerMap.forEach(subscription => {
      subscription.unsubscribe();
    });
    this.listenerMap.clear();
  }

  /**
   * 获取当前活跃的监听器数量
   * @returns 监听器数量
   */
  getListenerCount(): number {
    return this.listenerMap.size;
  }

  /**
   * 获取所有监听器ID列表
   * @returns 监听器ID数组
   */
  getListenerIds(): string[] {
    return Array.from(this.listenerMap.keys());
  }

  /**
   * 检查指定ID的监听器是否存在
   * @param listenerId 监听器ID
   * @returns 是否存在
   */
  hasListener(listenerId: string): boolean {
    return this.listenerMap.has(listenerId);
  }

  /**
   * 监听多个动作类型
   * @param actionTypes 要监听的动作类型数组
   * @param handler 处理函数
   * @param listenerId 可选的监听器ID
   * @returns 取消订阅函数
   */
  listenMultiple<T = any, R = any>(
    actionTypes: string[],
    handler: (action: Action<T>) => R | Promise<R>,
    listenerId?: string
  ): () => void {
    const subscription = this.actionSubject.asObservable().pipe(
      filter(action => actionTypes.includes(action.type)),
      map(action => action as Action<T>)
    ).subscribe({
      next: async (action) => {
        try {
          const result = await handler(action);

          if (action.requireFeedback && action.id) {
            this.sendFeedback(action.id, true, result);
          }
        } catch (error) {
          if (action.requireFeedback && action.id) {
            this.sendFeedback(
              action.id,
              false,
              undefined,
              error instanceof Error ? error.message : '处理失败'
            );
          } else {
            console.warn('处理动作时发生错误:', error);
          }
        }
      }
    });

    if (listenerId) {
      this.listenerMap.set(listenerId, subscription);
    }

    return () => {
      subscription.unsubscribe();
      if (listenerId) {
        this.listenerMap.delete(listenerId);
      }
    };
  }

  /**
   * 监听所有动作
   * @param handler 处理函数
   * @param listenerId 可选的监听器ID
   * @returns 取消订阅函数
   */
  listenAll<R = any>(
    handler: (action: Action) => R | Promise<R>,
    listenerId?: string
  ): () => void {
    const subscription = this.actionSubject.asObservable().subscribe({
      next: async (action) => {
        try {
          const result = await handler(action);

          if (action.requireFeedback && action.id) {
            this.sendFeedback(action.id, true, result);
          }
        } catch (error) {
          if (action.requireFeedback && action.id) {
            this.sendFeedback(
              action.id,
              false,
              undefined,
              error instanceof Error ? error.message : '处理失败'
            );
          } else {
            console.warn('处理动作时发生错误:', error);
          }
        }
      }
    });

    if (listenerId) {
      this.listenerMap.set(listenerId, subscription);
    }

    return () => {
      subscription.unsubscribe();
      if (listenerId) {
        this.listenerMap.delete(listenerId);
      }
    };
  }

  /**
   * 一次性监听动作（只监听一次）
   * @param actionType 动作类型
   * @param handler 处理函数
   * @returns 取消订阅函数
   */
  once<T = any, R = any>(
    actionType: string,
    handler: (action: Action<T>) => R | Promise<R>
  ): () => void {
    let subscription: any;

    subscription = this.actionSubject.asObservable().pipe(
      filter(action => action.type === actionType),
      map(action => action as Action<T>)
    ).subscribe({
      next: async (action) => {
        try {
          const result = await handler(action);

          if (action.requireFeedback && action.id) {
            this.sendFeedback(action.id, true, result);
          }
        } catch (error) {
          if (action.requireFeedback && action.id) {
            this.sendFeedback(
              action.id,
              false,
              undefined,
              error instanceof Error ? error.message : '处理失败'
            );
          } else {
            console.warn('处理动作时发生错误:', error);
          }
        } finally {
          // 处理完后自动取消订阅
          subscription.unsubscribe();
        }
      }
    });

    return () => subscription.unsubscribe();
  }

  /**
   * 发出需要反馈的动作（返回Observable用于链式调用）
   * @param type 动作类型
   * @param payload 动作数据（可选）
   * @param timeoutMs 超时时间（毫秒，默认5000ms）
   * @returns Observable<ActionFeedback<T>>
   */
  dispatchWithFeedback<T = any>(
    type: string,
    payload?: T,
    timeoutMs: number = 5000
  ): Observable<ActionFeedback<T>> {
    const actionId = this.generateActionId();
    const action: Action<T> = {
      type,
      payload,
      timestamp: Date.now(),
      id: actionId,
      requireFeedback: true
    };

    this.actionSubject.next(action);
    return this.waitForFeedback<T>(actionId, timeoutMs);
  }

  /**
   * 获取反馈流（用于调试或监控）
   * @returns Observable<ActionFeedback>
   */
  getFeedbackStream(): Observable<ActionFeedback> {
    return this.feedbackSubject.asObservable();
  }
}
