import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { TodoUpdateService } from '../../services/todoUpdate.service';
import { TodoItem, clearTodos } from '../../utils/todoStorage';

@Component({
  selector: 'app-floating-todo',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './floating-todo.component.html',
  styleUrls: ['./floating-todo.component.scss']
})
export class FloatingTodoComponent implements OnInit, OnDestroy, OnChanges {
  @Input() sessionId: string = '';
  
  todoList: TodoItem[] = [];
  isCollapsed: boolean = false;
  
  private updateSubscription?: Subscription;
  private backupTimer?: any;
  private todoUpdateService = inject(TodoUpdateService);

  ngOnInit() {
    // console.log('[TODO Panel] 初始化组件, sessionId:', this.sessionId);
    this.initializeTodoService();
    this.loadInitialTodos();
    this.setupBackupTimer();
  }

  ngOnChanges(changes: SimpleChanges) {
    // 监听sessionId的变化
    if (changes['sessionId'] && !changes['sessionId'].firstChange) {
      const newSessionId = changes['sessionId'].currentValue;
      const oldSessionId = changes['sessionId'].previousValue;
      
      // console.log('[TODO Panel] sessionId发生变化:', oldSessionId, '->', newSessionId);
      
      // 重新加载新sessionId的TODO数据
      this.loadTodosFromService();
    }
  }

  ngOnDestroy() {
    if (this.updateSubscription) {
      this.updateSubscription.unsubscribe();
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
    }
  }

  private initializeTodoService() {
    try {
      // console.log('[TODO Panel] 初始化TodoUpdateService');
      
      // 订阅TODO更新事件
      this.updateSubscription = this.todoUpdateService.todoUpdated$.subscribe((sessionId: string) => {
        // console.log('[TODO Panel] 接收到TODO更新事件:', sessionId);
        // 检查更新的sessionId是否与当前sessionId匹配
        if (sessionId === this.sessionId || sessionId === 'default') {
          this.loadTodosFromService();
        }
      });

      // 订阅TODO数据变化
      const dataSubscription = this.todoUpdateService.todoData$.subscribe((todoData: Map<string, TodoItem[]>) => {
        // console.log('[TODO Panel] 接收到TODO数据变化:', todoData);
        // 动态获取当前sessionId对应的TODO数据
        const currentSessionId = this.sessionId || 'default';
        const sessionTodos = todoData.get(currentSessionId);
        if (sessionTodos) {
          this.todoList = sessionTodos;
        }
      });

      if (this.updateSubscription) {
        const originalUnsubscribe = this.updateSubscription.unsubscribe.bind(this.updateSubscription);
        this.updateSubscription.unsubscribe = () => {
          originalUnsubscribe();
          dataSubscription.unsubscribe();
        };
      }

    } catch (error) {
      console.warn('[TODO Panel] TodoUpdateService 初始化失败:', error);
    }
  }

  private loadTodosFromService() {
    try {
      const sessionId = this.sessionId || 'default';
      this.todoList = this.todoUpdateService.getTodosForSession(sessionId);
    //   console.log('[TODO Panel] 从服务加载TODO列表:', this.todoList.length, '项');
    //   console.log('[TODO Panel] ✅ 详细数据:', this.todoList);
    //   console.log('[TODO Panel] ✅ isCollapsed:', this.isCollapsed);
    //   console.log('[TODO Panel] ✅ 组件状态检查 - todoList存在:', !!this.todoList, 'length:', this.todoList?.length);
    } catch (error) {
      console.warn('[TODO Panel] 加载TODO列表失败:', error);
    }
  }

  private loadInitialTodos() {
    try {
      // 首先尝试从服务加载
      this.loadTodosFromService();
      
      // 如果没有数据，显示测试数据
      if (!this.todoList || this.todoList.length === 0) {
        // // 如果服务不可用，显示测试数据
        // this.todoList = [
        //   {
        //     id: '1',
        //     content: '测试VSCode风格TODO显示',
        //     status: 'in_progress' as const,
        //     priority: 'high' as const,
        //     createdAt: Date.now(),
        //     updatedAt: Date.now()
        //   },
        //   {
        //     id: '2',
        //     content: '验证header扩展功能',
        //     status: 'pending' as const,
        //     priority: 'medium' as const,
        //     createdAt: Date.now(),
        //     updatedAt: Date.now()
        //   },
        //   {
        //     id: '3',
        //     content: '测试条件显示',
        //     status: 'completed' as const,
        //     priority: 'low' as const,
        //     createdAt: Date.now(),
        //     updatedAt: Date.now()
        //   }
        // ];
        // console.log('[TODO Panel] 使用测试数据，共', this.todoList.length, '项');
        this.todoList = [];
        // console.log('[TODO Panel] 加载初始TODO列表为空');
      }
    } catch (error) {
      console.warn('[TODO Panel] 加载初始TODO失败:', error);
      this.todoList = [];
    }
  }

  private setupBackupTimer() {
    // 每30秒执行一次备用刷新
    this.backupTimer = setInterval(() => {
      this.loadTodosFromService();
    }, 30000);
  }

  // 模板绑定方法
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    // console.log('[TODO Panel] 切换折叠状态:', this.isCollapsed);
  }

  getCompletedCount(): number {
    return this.todoList.filter(todo => todo.status === 'completed').length;
  }

  toggleTodoStatus(todo: TodoItem) {
    const statusOrder: Array<TodoItem['status']> = ['pending', 'in_progress', 'completed'];
    const currentIndex = statusOrder.indexOf(todo.status);
    const nextIndex = (currentIndex + 1) % statusOrder.length;
    
    const newStatus = statusOrder[nextIndex];
    todo.status = newStatus;
    
    // console.log('[TODO Panel] 切换TODO状态:', todo.id, '→', newStatus);
    
    // 通知服务状态变更
    try {
      const sessionId = this.sessionId || 'default';
      this.todoUpdateService.triggerTodoUpdate(sessionId);
    } catch (error) {
      console.warn('[TODO Panel] 更新TODO状态失败:', error);
    }
  }

  getPriorityLevel(priority?: TodoItem['priority']): string {
    return priority || 'low';
  }

  getPriorityText(priority?: TodoItem['priority']): string {
    const texts = {
      'high': '高',
      'medium': '中',
      'low': '低'
    };
    return texts[priority || 'low'];
  }

  trackByTodoId(index: number, todo: TodoItem): string {
    return todo.id;
  }

  clearAllTodos(event: Event) {
    // 阻止事件冒泡，避免触发header的折叠/展开
    event.stopPropagation();
    
    const sessionId = this.sessionId || 'default';
    // console.log('[TODO Panel] 清空所有TODO项, sessionId:', sessionId);
    
    try {
      // 清空存储中的TODO数据
      clearTodos(sessionId);
      
      // 更新本地数组
      this.todoList = [];
      
      // 通知服务数据已更新
      this.todoUpdateService.updateTodoData(sessionId, []);
      
      // console.log('[TODO Panel] ✅ 成功清空所有TODO项');
    } catch (error) {
      console.warn('[TODO Panel] ❌ 清空TODO项失败:', error);
    }
  }
}
