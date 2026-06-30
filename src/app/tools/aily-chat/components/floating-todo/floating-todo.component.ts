import { Component, Input, OnInit, OnDestroy, OnChanges, SimpleChanges, inject, ChangeDetectorRef, ElementRef, ViewChild, ViewChildren, QueryList, HostBinding } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { TodoListSnapshot, TodoUpdateService } from '../../services/todoUpdate.service';
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
  @Input() requestInProgress: boolean = false;
  
  todoList: TodoItem[] = [];
  todoListSnapshot: TodoListSnapshot | null = null;
  isCollapsed: boolean = false;

  @ViewChild('todoListContainer') private todoListContainerRef?: ElementRef<HTMLElement>;
  @ViewChildren('todoItemButton') private todoItemButtonRefs?: QueryList<ElementRef<HTMLButtonElement>>;
  
  private updateSubscription?: Subscription;
  private backupTimer?: any;
  private userManuallyExpanded = false;
  private todoUpdateService = inject(TodoUpdateService);
  private cdr = inject(ChangeDetectorRef);

  @HostBinding('class.chat-todo-widget-host')
  readonly hostClass = true;

  @HostBinding('class.has-todos')
  get hasTodosClass(): boolean {
    return this.hasTodos;
  }

  get hasTodos(): boolean {
    return this.todoList.length > 0;
  }

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

      this.userManuallyExpanded = false;
      this.isCollapsed = false;
      
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
        // 检查更新的sessionId是否与当前sessionId匹配
        if (sessionId === this.sessionId || sessionId === 'default') {
          this.loadTodosFromService();
        }
      });

      // 订阅TODO语义快照变化
      const dataSubscription = this.todoUpdateService.todoListSnapshot$.subscribe((todoData: Map<string, TodoListSnapshot>) => {
        const currentSessionId = this.sessionId || 'default';
        const snapshot = todoData.get(currentSessionId);
        if (snapshot) {
          this.todoListSnapshot = snapshot;
          this.todoList = snapshot.items;
          this.applyAutoCollapseState(snapshot.items);
          this.cdr.detectChanges();
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
      const snapshot = this.todoUpdateService.getTodoListSnapshotForSession(sessionId);
      this.todoListSnapshot = snapshot;
      this.todoList = snapshot.items;
      this.applyAutoCollapseState(snapshot.items);
      this.cdr.detectChanges();
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
    this.userManuallyExpanded = !this.isCollapsed;
    // console.log('[TODO Panel] 切换折叠状态:', this.isCollapsed);
  }

  hasFocus(): boolean {
    const container = this.todoListContainerRef?.nativeElement;
    const activeElement = document.activeElement;
    return !!container && !!activeElement && container.contains(activeElement);
  }

  focus(): boolean {
    if (this.todoList.length === 0) {
      return false;
    }

    if (this.isCollapsed) {
      this.toggleCollapse();
    }

    this.cdr.detectChanges();
    this.todoItemButtonRefs?.first?.nativeElement.focus();
    return this.hasFocus();
  }

  private applyAutoCollapseState(todos: readonly TodoItem[]): void {
    if (todos.length === 0) {
      this.userManuallyExpanded = false;
      this.isCollapsed = false;
      return;
    }

    const allIncomplete = todos.every(todo => todo.status === 'not-started');
    if (allIncomplete) {
      this.userManuallyExpanded = false;
      return;
    }

    const hasInProgressOrCompleted = todos.some(todo => todo.status === 'in-progress' || todo.status === 'completed');
    if (hasInProgressOrCompleted && !this.userManuallyExpanded) {
      this.isCollapsed = true;
    }
  }

  getToggleAriaLabel(): string {
    return this.isCollapsed ? 'Expand Todos' : 'Collapse Todos';
  }

  getTodoListTitleId(): string {
    return `todo-list-title-${this.sessionId || 'default'}`;
  }

  getTodoListContainerId(): string {
    return `todo-list-container-${this.sessionId || 'default'}`;
  }

  getCompletedCount(): number {
    return this.todoListSnapshot?.completedCount
      ?? this.todoList.filter(todo => todo.status === 'completed').length;
  }

  getCurrentTodo(): TodoItem | null {
    return this.todoList.find(todo => todo.status === 'in-progress')
      ?? this.todoList.find(todo => todo.status === 'not-started')
      ?? null;
  }

  getCurrentStep(): number {
    if (this.todoListSnapshot) {
      return this.todoListSnapshot.currentStep;
    }

    if (!this.todoList.length) {
      return 0;
    }

    const currentTodo = this.getCurrentTodo();
    return currentTodo ? Math.min(this.todoList.length, this.getCompletedCount() + 1) : this.todoList.length;
  }

  getHeaderTitle(): string {
    const totalCount = this.todoListSnapshot?.totalCount ?? this.todoList.length;
    if (!totalCount) {
      return 'Todos';
    }

    if (!this.isCollapsed) {
      return `Todos (${this.getCurrentStep()}/${totalCount})`;
    }

    const currentTodoTitle = this.todoListSnapshot?.currentTask ?? this.getCurrentTodo()?.content;
    if (currentTodoTitle) {
      return `${currentTodoTitle} (${this.getCurrentStep()}/${totalCount})`;
    }

    return `Todos (${totalCount}/${totalCount})`;
  }

  getHeaderStatus(): TodoItem['status'] | null {
    if (!this.isCollapsed) {
      return null;
    }

    const semanticCurrentTask = this.todoListSnapshot?.currentTask;
    if (semanticCurrentTask) {
      return this.todoList.find(todo => todo.content === semanticCurrentTask)?.status
        ?? this.getCurrentTodo()?.status
        ?? (this.todoList.length ? 'completed' : null);
    }

    return this.getCurrentTodo()?.status ?? (this.todoList.length ? 'completed' : null);
  }

  hasInProgressTodo(): boolean {
    return this.todoList.some(todo => todo.status === 'in-progress');
  }

  isClearDisabled(): boolean {
    return this.requestInProgress && this.hasInProgressTodo();
  }

  getClearButtonTitle(): string {
    return this.isClearDisabled()
      ? 'Cannot clear todos while a task is in progress'
      : 'Clear all todos';
  }

  getTodoAriaLabel(todo: TodoItem): string {
    return `${todo.content}, ${this.getTodoStatusLabel(todo.status)}`;
  }

  private getTodoStatusLabel(status: TodoItem['status']): string {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'in-progress':
        return 'in progress';
      default:
        return 'not started';
    }
  }

  toggleTodoStatus(todo: TodoItem) {
    const statusOrder: Array<TodoItem['status']> = ['not-started', 'in-progress', 'completed'];
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

  trackByTodoId(index: number, todo: TodoItem): number {
    return todo.id;
  }

  clearAllTodos(event: Event) {
    // 阻止事件冒泡，避免触发header的折叠/展开
    event.stopPropagation();

    if (this.isClearDisabled()) {
      return;
    }
    
    const sessionId = this.sessionId || 'default';
    // console.log('[TODO Panel] 清空所有TODO项, sessionId:', sessionId);
    
    try {
      // 清空存储中的TODO数据
      clearTodos(sessionId);
      
      // 更新本地数组
      this.todoList = [];
      this.userManuallyExpanded = false;
      this.isCollapsed = false;
      this.todoListSnapshot = this.todoUpdateService.getTodoListSnapshotForSession(sessionId);
      
      // 通知服务数据已更新
      this.todoUpdateService.updateTodoData(sessionId, []);
      
      // console.log('[TODO Panel] ✅ 成功清空所有TODO项');
    } catch (error) {
      console.warn('[TODO Panel] ❌ 清空TODO项失败:', error);
    }
  }
}
