import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

export interface ShortcutAction {
  type: 'save' | 'open' | 'close' | 'find' | 'replace' | 'new' | 'undo' | 'redo' | 'copy' | 'paste' | 'cut';
  data?: any;
}

export interface ShortcutKeyMapping {
  key: string;
  action: ShortcutAction;
  description: string;
  context?: string; // 上下文，用于区分不同模块的快捷键
}

@Injectable({
  providedIn: 'root'
})
export class ShortcutService {
  // 快捷键事件主题
  private shortcutKeySubject = new Subject<ShortcutAction>();
  
  // 快捷键事件观察者
  shortcutKey$ = this.shortcutKeySubject.asObservable();

  // 全局快捷键映射
  private globalShortcutMap = new Map<string, ShortcutKeyMapping>([
    ['ctrl+s', { 
      key: 'ctrl+s', 
      action: { type: 'save' }, 
      description: '保存当前文件',
      context: 'global'
    }],
    ['ctrl+o', { 
      key: 'ctrl+o', 
      action: { type: 'open' }, 
      description: '打开文件',
      context: 'global'
    }],
    ['ctrl+n', { 
      key: 'ctrl+n', 
      action: { type: 'new' }, 
      description: '新建文件',
      context: 'global'
    }],
    ['ctrl+w', { 
      key: 'ctrl+w', 
      action: { type: 'close' }, 
      description: '关闭当前标签页',
      context: 'editor'
    }],
    ['ctrl+f', { 
      key: 'ctrl+f', 
      action: { type: 'find' }, 
      description: '查找',
      context: 'editor'
    }],
    ['ctrl+h', { 
      key: 'ctrl+h', 
      action: { type: 'replace' }, 
      description: '替换',
      context: 'editor'
    }],
    ['ctrl+z', { 
      key: 'ctrl+z', 
      action: { type: 'undo' }, 
      description: '撤销',
      context: 'editor'
    }],
    ['ctrl+y', { 
      key: 'ctrl+y', 
      action: { type: 'redo' }, 
      description: '重做',
      context: 'editor'
    }],
    ['ctrl+c', { 
      key: 'ctrl+c', 
      action: { type: 'copy' }, 
      description: '复制',
      context: 'editor'
    }],
    ['ctrl+v', { 
      key: 'ctrl+v', 
      action: { type: 'paste' }, 
      description: '粘贴',
      context: 'editor'
    }],
    ['ctrl+x', { 
      key: 'ctrl+x', 
      action: { type: 'cut' }, 
      description: '剪切',
      context: 'editor'
    }],
  ]);

  // 上下文特定的快捷键映射
  private contextShortcutMaps = new Map<string, Map<string, ShortcutKeyMapping>>();

  constructor() { }

  /**
   * 触发快捷键事件
   * @param action 快捷键动作
   */
  triggerShortcut(action: ShortcutAction): void {
    this.shortcutKeySubject.next(action);
  }

  /**
   * 从键盘事件生成标准化的快捷键字符串
   * @param event 键盘事件
   * @returns 标准化的快捷键字符串
   */
  getShortcutFromEvent(event: KeyboardEvent): string {
    const parts: string[] = [];

    // Mac 上 Command 与 Windows 上 Ctrl 等效，统一为 ctrl 便于跨平台匹配
    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    // 添加主键，忽略修饰键本身
    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }

  /**
   * 检查是否为支持的快捷键
   * @param shortcutKey 快捷键字符串
   * @param context 上下文（可选）
   * @returns 快捷键映射或null
   */
  getShortcutMapping(shortcutKey: string, context?: string): ShortcutKeyMapping | null {
    // 先检查上下文特定的快捷键
    if (context && this.contextShortcutMaps.has(context)) {
      const contextMap = this.contextShortcutMaps.get(context);
      const mapping = contextMap?.get(shortcutKey);
      if (mapping) {
        return mapping;
      }
    }

    // 再检查全局快捷键
    return this.globalShortcutMap.get(shortcutKey) || null;
  }

  /**
   * 获取快捷键动作
   * @param shortcutKey 快捷键字符串
   * @param context 上下文（可选）
   * @returns 快捷键动作或null
   */
  getShortcutAction(shortcutKey: string, context?: string): ShortcutAction | null {
    const mapping = this.getShortcutMapping(shortcutKey, context);
    return mapping ? mapping.action : null;
  }

  /**
   * 注册上下文特定的快捷键
   * @param context 上下文名称
   * @param shortcuts 快捷键映射数组
   */
  registerContextShortcuts(context: string, shortcuts: ShortcutKeyMapping[]): void {
    if (!this.contextShortcutMaps.has(context)) {
      this.contextShortcutMaps.set(context, new Map());
    }

    const contextMap = this.contextShortcutMaps.get(context)!;
    shortcuts.forEach(shortcut => {
      contextMap.set(shortcut.key, shortcut);
    });
  }

  /**
   * 取消注册上下文快捷键
   * @param context 上下文名称
   */
  unregisterContextShortcuts(context: string): void {
    this.contextShortcutMaps.delete(context);
  }

  /**
   * 获取所有支持的快捷键（按上下文分组）
   * @param context 指定上下文（可选）
   * @returns 快捷键映射
   */
  getSupportedShortcuts(context?: string): Map<string, ShortcutKeyMapping> {
    if (context && this.contextShortcutMaps.has(context)) {
      return new Map(this.contextShortcutMaps.get(context));
    }
    return new Map(this.globalShortcutMap);
  }

  /**
   * 获取所有快捷键（全局和上下文）
   * @returns 所有快捷键映射的数组
   */
  getAllShortcuts(): ShortcutKeyMapping[] {
    const allShortcuts: ShortcutKeyMapping[] = [];
    
    // 添加全局快捷键
    this.globalShortcutMap.forEach(mapping => {
      allShortcuts.push(mapping);
    });

    // 添加上下文快捷键
    this.contextShortcutMaps.forEach(contextMap => {
      contextMap.forEach(mapping => {
        allShortcuts.push(mapping);
      });
    });

    return allShortcuts;
  }

  /**
   * 检查特定快捷键类型
   * @param shortcutKey 快捷键字符串
   * @param actionType 动作类型
   * @returns 是否匹配
   */
  isShortcutType(shortcutKey: string, actionType: ShortcutAction['type']): boolean {
    const action = this.getShortcutAction(shortcutKey);
    return action?.type === actionType;
  }

  /**
   * 创建快捷键监听器
   * @param element 监听的DOM元素
   * @param context 上下文
   * @param callback 回调函数
   * @returns 清理函数
   */
  createKeyListener(
    element: HTMLElement | Document, 
    context: string,
    callback: (action: ShortcutAction, mapping: ShortcutKeyMapping) => void
  ): () => void {
    const listener = (event: KeyboardEvent) => {
      const shortcutKey = this.getShortcutFromEvent(event);
      const mapping = this.getShortcutMapping(shortcutKey, context);
      
      if (mapping) {
        event.preventDefault();
        callback(mapping.action, mapping);
      }
    };

    element.addEventListener('keydown', listener);

    // 返回清理函数
    return () => {
      element.removeEventListener('keydown', listener);
    };
  }
}
