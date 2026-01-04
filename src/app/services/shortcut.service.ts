import { Injectable, NgZone } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';

/**
 * 快捷键修饰符
 */
export interface ShortcutModifiers {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean; // Windows键 / Command键(Mac)
}

/**
 * 快捷键配置
 */
export interface ShortcutConfig {
  /** 快捷键标识符，格式如: "ctrl+s", "ctrl+shift+p" */
  key: string;
  /** 快捷键描述 */
  description?: string;
  /** 是否阻止默认行为 */
  preventDefault?: boolean;
  /** 是否阻止事件冒泡 */
  stopPropagation?: boolean;
  /** 是否全局有效（即使焦点在输入框中也触发） */
  global?: boolean;
  /** 注册者/来源标识 */
  source?: string;
}

/**
 * 快捷键注册信息
 */
export interface ShortcutRegistration extends ShortcutConfig {
  /** 处理函数 */
  handler: (event: KeyboardEvent) => void | Promise<void>;
  /** 注册时间戳 */
  registeredAt: number;
  /** 唯一ID */
  id: string;
}

/**
 * 快捷键事件
 */
export interface ShortcutEvent {
  /** 快捷键标识符 */
  key: string;
  /** 原始键盘事件 */
  originalEvent: KeyboardEvent;
  /** 时间戳 */
  timestamp: number;
}

/**
 * 解析后的快捷键
 */
interface ParsedShortcut {
  key: string; // 主键（如 's', 'p', 'f1' 等）
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/**
 * 全局快捷键管理服务
 * 
 * 功能：
 * - 注册/取消注册快捷键
 * - 监听键盘事件并触发相应处理函数
 * - 检测快捷键冲突并输出警告
 * - 支持组合键（Ctrl, Alt, Shift, Meta）
 * 
 * 使用示例：
 * ```typescript
 * // 注册快捷键
 * this.shortcutService.register({
 *   key: 'ctrl+s',
 *   description: '保存',
 *   preventDefault: true,
 *   source: 'editor'
 * }, (event) => {
 *   this.save();
 * });
 * 
 * // 监听快捷键事件
 * this.shortcutService.on('ctrl+s').subscribe((event) => {
 *   console.log('Ctrl+S 被触发');
 * });
 * 
 * // 取消注册
 * this.shortcutService.unregister('ctrl+s', 'editor');
 * ```
 */
@Injectable({
  providedIn: 'root'
})
export class ShortcutService {
  /** 已注册的快捷键映射 */
  private registrations = new Map<string, ShortcutRegistration[]>();

  /** 快捷键事件Subject */
  private shortcutSubject = new Subject<ShortcutEvent>();

  /** 是否已初始化 */
  private initialized = false;

  /** 是否启用快捷键 */
  private enabled = true;

  /** 被暂停的快捷键列表 */
  private pausedKeys = new Set<string>();

  constructor(private ngZone: NgZone) {}

  /**
   * 初始化快捷键服务，绑定全局键盘事件监听器
   * 应在应用启动时调用一次
   */
  init(): void {
    if (this.initialized) {
      console.warn('[ShortcutService] 服务已初始化，请勿重复调用 init()');
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      document.addEventListener('keydown', this.handleKeyDown.bind(this), true);
    });

    this.initialized = true;
    console.log('[ShortcutService] 快捷键服务已初始化');
  }

  /**
   * 销毁快捷键服务，移除事件监听器
   */
  destroy(): void {
    document.removeEventListener('keydown', this.handleKeyDown.bind(this), true);
    this.registrations.clear();
    this.pausedKeys.clear();
    this.initialized = false;
    console.log('[ShortcutService] 快捷键服务已销毁');
  }

  /**
   * 启用快捷键服务
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * 禁用快捷键服务
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * 暂停指定快捷键
   * @param key 快捷键标识符
   */
  pause(key: string): void {
    const normalizedKey = this.normalizeKeyString(key);
    this.pausedKeys.add(normalizedKey);
  }

  /**
   * 恢复指定快捷键
   * @param key 快捷键标识符
   */
  resume(key: string): void {
    const normalizedKey = this.normalizeKeyString(key);
    this.pausedKeys.delete(normalizedKey);
  }

  /**
   * 注册快捷键
   * @param config 快捷键配置
   * @param handler 处理函数
   * @returns 注册ID，可用于取消注册
   */
  register(
    config: ShortcutConfig,
    handler: (event: KeyboardEvent) => void | Promise<void>
  ): string {
    const normalizedKey = this.normalizeKeyString(config.key);
    const id = this.generateId();

    const registration: ShortcutRegistration = {
      ...config,
      key: normalizedKey,
      handler,
      registeredAt: Date.now(),
      id,
      preventDefault: config.preventDefault ?? true,
      stopPropagation: config.stopPropagation ?? false,
      global: config.global ?? false,
    };

    // 检查冲突
    const existingRegistrations = this.registrations.get(normalizedKey);
    if (existingRegistrations && existingRegistrations.length > 0) {
      const sources = existingRegistrations.map(r => r.source || 'unknown').join(', ');
      console.warn(
        `[ShortcutService] 快捷键冲突警告: "${normalizedKey}" 已被注册 (来源: ${sources})。` +
        `新注册来源: "${config.source || 'unknown'}"。` +
        `后注册的处理函数也会被触发。`
      );
    }

    // 添加到注册列表
    if (!this.registrations.has(normalizedKey)) {
      this.registrations.set(normalizedKey, []);
    }
    this.registrations.get(normalizedKey)!.push(registration);

    console.log(
      `[ShortcutService] 已注册快捷键: "${normalizedKey}"` +
      (config.description ? ` (${config.description})` : '') +
      (config.source ? ` [来源: ${config.source}]` : '')
    );

    return id;
  }

  /**
   * 通过ID取消注册快捷键
   * @param id 注册ID
   * @returns 是否成功取消
   */
  unregisterById(id: string): boolean {
    for (const [key, registrations] of this.registrations.entries()) {
      const index = registrations.findIndex(r => r.id === id);
      if (index !== -1) {
        const removed = registrations.splice(index, 1)[0];
        if (registrations.length === 0) {
          this.registrations.delete(key);
        }
        console.log(
          `[ShortcutService] 已取消注册快捷键: "${key}"` +
          (removed.source ? ` [来源: ${removed.source}]` : '')
        );
        return true;
      }
    }
    return false;
  }

  /**
   * 取消注册指定快捷键
   * @param key 快捷键标识符
   * @param source 可选，指定来源以只取消该来源的注册
   * @returns 取消的注册数量
   */
  unregister(key: string, source?: string): number {
    const normalizedKey = this.normalizeKeyString(key);
    const registrations = this.registrations.get(normalizedKey);

    if (!registrations || registrations.length === 0) {
      return 0;
    }

    let removedCount = 0;

    if (source) {
      // 只移除指定来源的注册
      const filtered = registrations.filter(r => {
        if (r.source === source) {
          removedCount++;
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        this.registrations.delete(normalizedKey);
      } else {
        this.registrations.set(normalizedKey, filtered);
      }
    } else {
      // 移除所有注册
      removedCount = registrations.length;
      this.registrations.delete(normalizedKey);
    }

    if (removedCount > 0) {
      console.log(
        `[ShortcutService] 已取消注册快捷键: "${normalizedKey}"` +
        (source ? ` [来源: ${source}]` : '') +
        ` (共 ${removedCount} 个)`
      );
    }

    return removedCount;
  }

  /**
   * 取消指定来源的所有快捷键注册
   * @param source 来源标识
   * @returns 取消的注册数量
   */
  unregisterBySource(source: string): number {
    let totalRemoved = 0;

    for (const [key, registrations] of this.registrations.entries()) {
      const filtered = registrations.filter(r => {
        if (r.source === source) {
          totalRemoved++;
          return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        this.registrations.delete(key);
      } else {
        this.registrations.set(key, filtered);
      }
    }

    if (totalRemoved > 0) {
      console.log(`[ShortcutService] 已取消来源 "${source}" 的所有快捷键 (共 ${totalRemoved} 个)`);
    }

    return totalRemoved;
  }

  /**
   * 监听指定快捷键事件
   * @param key 快捷键标识符
   * @returns Observable<ShortcutEvent>
   */
  on(key: string): Observable<ShortcutEvent> {
    const normalizedKey = this.normalizeKeyString(key);
    return this.shortcutSubject.asObservable().pipe(
      filter(event => event.key === normalizedKey)
    );
  }

  /**
   * 监听所有快捷键事件
   * @returns Observable<ShortcutEvent>
   */
  onAny(): Observable<ShortcutEvent> {
    return this.shortcutSubject.asObservable();
  }

  /**
   * 获取指定快捷键的所有注册信息
   * @param key 快捷键标识符
   * @returns 注册信息数组
   */
  getRegistrations(key: string): ShortcutRegistration[] {
    const normalizedKey = this.normalizeKeyString(key);
    return this.registrations.get(normalizedKey) || [];
  }

  /**
   * 获取所有已注册的快捷键
   * @returns 快捷键及其注册信息的Map
   */
  getAllRegistrations(): Map<string, ShortcutRegistration[]> {
    return new Map(this.registrations);
  }

  /**
   * 检查快捷键是否已注册
   * @param key 快捷键标识符
   * @returns 是否已注册
   */
  isRegistered(key: string): boolean {
    const normalizedKey = this.normalizeKeyString(key);
    const registrations = this.registrations.get(normalizedKey);
    return !!registrations && registrations.length > 0;
  }

  /**
   * 获取快捷键列表（用于显示帮助等）
   * @returns 快捷键信息数组
   */
  getShortcutList(): Array<{ key: string; description: string; source: string }> {
    const list: Array<{ key: string; description: string; source: string }> = [];

    for (const [key, registrations] of this.registrations.entries()) {
      for (const reg of registrations) {
        list.push({
          key,
          description: reg.description || '',
          source: reg.source || 'unknown',
        });
      }
    }

    return list.sort((a, b) => a.key.localeCompare(b.key));
  }

  /**
   * 模拟触发快捷键
   * @param key 快捷键标识符
   */
  trigger(key: string): void {
    const normalizedKey = this.normalizeKeyString(key);
    const registrations = this.registrations.get(normalizedKey);

    if (!registrations || registrations.length === 0) {
      console.warn(`[ShortcutService] 无法触发未注册的快捷键: "${normalizedKey}"`);
      return;
    }

    // 创建模拟事件
    const mockEvent = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
    });

    this.executeHandlers(normalizedKey, registrations, mockEvent);
  }

  /**
   * 处理键盘事件
   */
  private handleKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) {
      return;
    }

    // 构建快捷键字符串
    const shortcutKey = this.buildKeyString(event);
    if (!shortcutKey) {
      return;
    }

    // 检查是否被暂停
    if (this.pausedKeys.has(shortcutKey)) {
      return;
    }

    // 获取注册信息
    const registrations = this.registrations.get(shortcutKey);
    if (!registrations || registrations.length === 0) {
      return;
    }

    // 检查是否在输入元素中
    const isInInput = this.isInputElement(event.target as HTMLElement);

    // 过滤出应该执行的注册（非global的在输入框中不执行）
    const applicableRegistrations = registrations.filter(r => r.global || !isInInput);

    if (applicableRegistrations.length === 0) {
      return;
    }

    // 阻止默认行为（如果任一注册需要）
    if (applicableRegistrations.some(r => r.preventDefault)) {
      event.preventDefault();
    }

    // 阻止冒泡（如果任一注册需要）
    if (applicableRegistrations.some(r => r.stopPropagation)) {
      event.stopPropagation();
    }

    // 在Angular Zone中执行处理函数
    this.ngZone.run(() => {
      this.executeHandlers(shortcutKey, applicableRegistrations, event);

      // 发出事件
      this.shortcutSubject.next({
        key: shortcutKey,
        originalEvent: event,
        timestamp: Date.now(),
      });
    });
  }

  /**
   * 执行处理函数
   */
  private executeHandlers(
    key: string,
    registrations: ShortcutRegistration[],
    event: KeyboardEvent
  ): void {
    for (const registration of registrations) {
      try {
        const result = registration.handler(event);
        if (result instanceof Promise) {
          result.catch(error => {
            console.error(
              `[ShortcutService] 快捷键 "${key}" 处理函数执行出错:`,
              error
            );
          });
        }
      } catch (error) {
        console.error(
          `[ShortcutService] 快捷键 "${key}" 处理函数执行出错:`,
          error
        );
      }
    }
  }

  /**
   * 检查元素是否为输入元素
   */
  private isInputElement(element: HTMLElement | null): boolean {
    if (!element) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    if (['input', 'textarea', 'select'].includes(tagName)) {
      return true;
    }

    // 检查contenteditable
    if (element.isContentEditable) {
      return true;
    }

    return false;
  }

  /**
   * 从键盘事件构建快捷键字符串
   */
  private buildKeyString(event: KeyboardEvent): string | null {
    // 忽略单独的修饰键
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
      return null;
    }

    const parts: string[] = [];

    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');

    // 规范化键名
    let key = event.key.toLowerCase();

    // 处理特殊键
    const keyMap: Record<string, string> = {
      ' ': 'space',
      'arrowup': 'up',
      'arrowdown': 'down',
      'arrowleft': 'left',
      'arrowright': 'right',
      'escape': 'esc',
      'delete': 'del',
    };

    key = keyMap[key] || key;
    parts.push(key);

    return parts.join('+');
  }

  /**
   * 规范化快捷键字符串
   * 例如: "Ctrl+Shift+S" -> "ctrl+shift+s"
   */
  private normalizeKeyString(keyString: string): string {
    const parts = keyString.toLowerCase().split('+').map(p => p.trim());

    // 分离修饰键和主键
    const modifiers: string[] = [];
    let mainKey = '';

    for (const part of parts) {
      if (['ctrl', 'control'].includes(part)) {
        modifiers.push('ctrl');
      } else if (['alt', 'option'].includes(part)) {
        modifiers.push('alt');
      } else if (part === 'shift') {
        modifiers.push('shift');
      } else if (['meta', 'cmd', 'command', 'win', 'windows'].includes(part)) {
        modifiers.push('meta');
      } else {
        mainKey = part;
      }
    }

    // 按固定顺序排列修饰键: ctrl, alt, shift, meta
    const orderedModifiers: string[] = [];
    if (modifiers.includes('ctrl')) orderedModifiers.push('ctrl');
    if (modifiers.includes('alt')) orderedModifiers.push('alt');
    if (modifiers.includes('shift')) orderedModifiers.push('shift');
    if (modifiers.includes('meta')) orderedModifiers.push('meta');

    // 特殊键名映射
    const keyMap: Record<string, string> = {
      'space': 'space',
      'spacebar': 'space',
      'escape': 'esc',
      'delete': 'del',
      'arrowup': 'up',
      'arrowdown': 'down',
      'arrowleft': 'left',
      'arrowright': 'right',
    };

    mainKey = keyMap[mainKey] || mainKey;

    return [...orderedModifiers, mainKey].join('+');
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `shortcut_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
