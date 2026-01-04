# ShortcutService 快捷键管理服务

全局快捷键管理服务，用于统一管理应用中的键盘快捷键。支持快捷键注册、监听、冲突检测等功能。

## 目录

- [基本用法](#基本用法)
- [API 参考](#api-参考)
- [快捷键格式](#快捷键格式)
- [冲突处理](#冲突处理)
- [最佳实践](#最佳实践)
- [完整示例](#完整示例)

---

## 基本用法

### 1. 注入服务

```typescript
import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { ShortcutService } from '../services/shortcut.service';

@Component({
  selector: 'app-my-component',
  templateUrl: './my-component.component.html'
})
export class MyComponent implements OnInit, OnDestroy {
  private shortcutService = inject(ShortcutService);
  private shortcutIds: string[] = [];

  ngOnInit() {
    this.registerShortcuts();
  }

  ngOnDestroy() {
    // 清理注册的快捷键
    this.shortcutIds.forEach(id => this.shortcutService.unregisterById(id));
  }
}
```

### 2. 注册快捷键

```typescript
// 基本注册
const id = this.shortcutService.register({
  key: 'ctrl+s',
  description: '保存文件',
  source: 'editor'
}, (event) => {
  this.saveFile();
});

this.shortcutIds.push(id);
```

### 3. 监听快捷键事件（Observable 方式）

```typescript
import { Subscription } from 'rxjs';

private subscription: Subscription;

ngOnInit() {
  this.subscription = this.shortcutService.on('ctrl+shift+p').subscribe((event) => {
    console.log('命令面板快捷键被触发');
    this.openCommandPalette();
  });
}

ngOnDestroy() {
  this.subscription?.unsubscribe();
}
```

---

## API 参考

### 注册与取消注册

#### `register(config: ShortcutConfig, handler: Function): string`

注册一个快捷键。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `config.key` | `string` | ✅ | 快捷键标识符，如 `"ctrl+s"` |
| `config.description` | `string` | ❌ | 快捷键描述 |
| `config.preventDefault` | `boolean` | ❌ | 是否阻止默认行为（默认 `true`） |
| `config.stopPropagation` | `boolean` | ❌ | 是否阻止事件冒泡（默认 `false`） |
| `config.global` | `boolean` | ❌ | 是否在输入框中也触发（默认 `false`） |
| `config.source` | `string` | ❌ | 注册来源标识，便于管理 |
| `handler` | `Function` | ✅ | 快捷键触发时的回调函数 |

**返回值：** 注册ID（用于取消注册）

**示例：**

```typescript
const id = this.shortcutService.register({
  key: 'ctrl+shift+n',
  description: '新建项目',
  preventDefault: true,
  stopPropagation: true,
  global: false,
  source: 'project-manager'
}, (event: KeyboardEvent) => {
  this.createNewProject();
});
```

#### `unregisterById(id: string): boolean`

通过注册ID取消注册。

```typescript
const success = this.shortcutService.unregisterById(registrationId);
```

#### `unregister(key: string, source?: string): number`

取消指定快捷键的注册。可选择只取消特定来源的注册。

```typescript
// 取消所有 ctrl+s 的注册
this.shortcutService.unregister('ctrl+s');

// 只取消来源为 'editor' 的 ctrl+s 注册
this.shortcutService.unregister('ctrl+s', 'editor');
```

#### `unregisterBySource(source: string): number`

取消指定来源的所有快捷键注册。

```typescript
// 取消 'editor' 注册的所有快捷键
const count = this.shortcutService.unregisterBySource('editor');
console.log(`已取消 ${count} 个快捷键`);
```

---

### 事件监听

#### `on(key: string): Observable<ShortcutEvent>`

监听指定快捷键的触发事件。

```typescript
this.shortcutService.on('ctrl+p').subscribe((event) => {
  console.log('快捷键:', event.key);
  console.log('原始事件:', event.originalEvent);
  console.log('时间戳:', event.timestamp);
});
```

#### `onAny(): Observable<ShortcutEvent>`

监听所有快捷键的触发事件。

```typescript
this.shortcutService.onAny().subscribe((event) => {
  console.log(`快捷键 ${event.key} 被触发`);
});
```

---

### 控制方法

#### `enable() / disable()`

启用或禁用整个快捷键服务。

```typescript
// 打开模态框时禁用快捷键
this.shortcutService.disable();

// 关闭模态框后重新启用
this.shortcutService.enable();
```

#### `pause(key: string) / resume(key: string)`

暂停或恢复指定的快捷键。

```typescript
// 编辑模式下暂停 Delete 键
this.shortcutService.pause('del');

// 退出编辑模式后恢复
this.shortcutService.resume('del');
```

#### `trigger(key: string)`

程序化触发快捷键（模拟按键）。

```typescript
// 模拟按下 Ctrl+S
this.shortcutService.trigger('ctrl+s');
```

---

### 查询方法

#### `isRegistered(key: string): boolean`

检查快捷键是否已注册。

```typescript
if (this.shortcutService.isRegistered('ctrl+s')) {
  console.log('Ctrl+S 已被注册');
}
```

#### `getRegistrations(key: string): ShortcutRegistration[]`

获取指定快捷键的所有注册信息。

```typescript
const registrations = this.shortcutService.getRegistrations('ctrl+s');
registrations.forEach(reg => {
  console.log(`来源: ${reg.source}, 描述: ${reg.description}`);
});
```

#### `getAllRegistrations(): Map<string, ShortcutRegistration[]>`

获取所有已注册的快捷键。

```typescript
const all = this.shortcutService.getAllRegistrations();
all.forEach((registrations, key) => {
  console.log(`${key}: ${registrations.length} 个注册`);
});
```

#### `getShortcutList(): Array<{key, description, source}>`

获取快捷键列表（适合用于显示帮助信息）。

```typescript
const shortcuts = this.shortcutService.getShortcutList();
// 返回按 key 排序的数组
// [{ key: 'ctrl+n', description: '新建', source: 'menu' }, ...]
```

---

## 快捷键格式

### 修饰键

| 修饰键 | 别名 |
|--------|------|
| `ctrl` | `control` |
| `alt` | `option` |
| `shift` | - |
| `meta` | `cmd`, `command`, `win`, `windows` |

### 特殊键

| 键名 | 别名 |
|------|------|
| `space` | `spacebar` |
| `esc` | `escape` |
| `del` | `delete` |
| `up` | `arrowup` |
| `down` | `arrowdown` |
| `left` | `arrowleft` |
| `right` | `arrowright` |

### 格式规范

- 使用 `+` 连接修饰键和主键
- 大小写不敏感
- 修饰键顺序会自动规范化为：`ctrl` → `alt` → `shift` → `meta`

```typescript
// 以下写法等效
'ctrl+s'
'Ctrl+S'
'CTRL+S'

// 以下写法等效
'ctrl+shift+s'
'shift+ctrl+s'
'Ctrl+Shift+S'

// Mac 上的 Command 键
'meta+s'
'cmd+s'
'command+s'
```

### 常用快捷键示例

```typescript
'ctrl+s'        // 保存
'ctrl+shift+s'  // 另存为
'ctrl+z'        // 撤销
'ctrl+shift+z'  // 重做
'ctrl+c'        // 复制
'ctrl+v'        // 粘贴
'ctrl+x'        // 剪切
'ctrl+a'        // 全选
'ctrl+f'        // 查找
'ctrl+h'        // 替换
'ctrl+n'        // 新建
'ctrl+o'        // 打开
'ctrl+p'        // 打印/快速打开
'ctrl+shift+p'  // 命令面板
'f1'            // 帮助
'f2'            // 重命名
'f5'            // 运行
'f11'           // 全屏
'esc'           // 取消/关闭
'del'           // 删除
'ctrl+enter'    // 确认
```

---

## 冲突处理

### 冲突检测

当同一快捷键被多次注册时，服务会在控制台输出警告：

```
[ShortcutService] 快捷键冲突警告: "ctrl+s" 已被注册 (来源: editor)。
新注册来源: "panel"。后注册的处理函数也会被触发。
```

### 冲突行为

- **所有处理函数都会执行**：按注册顺序依次执行
- **阻止默认行为**：如果任一注册设置了 `preventDefault: true`，则阻止
- **阻止冒泡**：如果任一注册设置了 `stopPropagation: true`，则阻止

### 避免冲突的建议

1. **使用 `source` 标识来源**：便于追踪和管理
2. **在组件销毁时取消注册**：使用 `unregisterById` 或 `unregisterBySource`
3. **检查是否已注册**：使用 `isRegistered()` 方法
4. **使用唯一的快捷键**：查看 `getShortcutList()` 已有快捷键

```typescript
// 注册前检查
if (!this.shortcutService.isRegistered('ctrl+shift+n')) {
  this.shortcutService.register({
    key: 'ctrl+shift+n',
    source: 'my-component'
  }, handler);
}
```

---

## 最佳实践

### 1. 组件生命周期管理

```typescript
@Component({ ... })
export class MyComponent implements OnInit, OnDestroy {
  private shortcutService = inject(ShortcutService);
  private registrationIds: string[] = [];

  ngOnInit() {
    // 注册快捷键并保存ID
    this.registrationIds.push(
      this.shortcutService.register({
        key: 'ctrl+s',
        source: 'my-component'
      }, () => this.save())
    );
  }

  ngOnDestroy() {
    // 方式1: 逐个取消
    this.registrationIds.forEach(id => 
      this.shortcutService.unregisterById(id)
    );

    // 方式2: 按来源批量取消
    this.shortcutService.unregisterBySource('my-component');
  }
}
```

### 2. 使用统一的来源标识

```typescript
// 定义常量
const SHORTCUT_SOURCE = 'blockly-editor';

// 注册时使用
this.shortcutService.register({
  key: 'ctrl+z',
  source: SHORTCUT_SOURCE
}, handler);

// 销毁时批量清理
this.shortcutService.unregisterBySource(SHORTCUT_SOURCE);
```

### 3. 输入框中的快捷键

默认情况下，当焦点在输入框（`input`、`textarea`、`contenteditable`）中时，快捷键不会触发。

如果需要在输入框中也触发，设置 `global: true`：

```typescript
this.shortcutService.register({
  key: 'ctrl+enter',
  global: true,  // 在输入框中也触发
  source: 'form'
}, () => this.submit());
```

### 4. 异步处理函数

处理函数支持返回 Promise，错误会被自动捕获并记录：

```typescript
this.shortcutService.register({
  key: 'ctrl+s',
  source: 'editor'
}, async (event) => {
  await this.saveAsync();
  this.showNotification('已保存');
});
```

### 5. 模态框/弹窗场景

```typescript
openModal() {
  // 打开模态框时禁用全局快捷键
  this.shortcutService.disable();
  
  // 或者只暂停特定快捷键
  this.shortcutService.pause('del');
  this.shortcutService.pause('esc');
  
  this.modalRef = this.modal.create({ ... });
  
  this.modalRef.afterClose.subscribe(() => {
    // 关闭后恢复
    this.shortcutService.enable();
    // 或
    this.shortcutService.resume('del');
    this.shortcutService.resume('esc');
  });
}
```

---

## 完整示例

### 编辑器组件示例

```typescript
import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { ShortcutService } from '../services/shortcut.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-code-editor',
  templateUrl: './code-editor.component.html'
})
export class CodeEditorComponent implements OnInit, OnDestroy {
  private shortcutService = inject(ShortcutService);
  private readonly SOURCE = 'code-editor';
  private subscriptions: Subscription[] = [];

  ngOnInit() {
    this.setupShortcuts();
  }

  ngOnDestroy() {
    // 清理所有快捷键注册
    this.shortcutService.unregisterBySource(this.SOURCE);
    
    // 清理订阅
    this.subscriptions.forEach(sub => sub.unsubscribe());
  }

  private setupShortcuts() {
    // 保存
    this.shortcutService.register({
      key: 'ctrl+s',
      description: '保存文件',
      preventDefault: true,
      source: this.SOURCE
    }, () => this.save());

    // 撤销
    this.shortcutService.register({
      key: 'ctrl+z',
      description: '撤销',
      source: this.SOURCE
    }, () => this.undo());

    // 重做
    this.shortcutService.register({
      key: 'ctrl+shift+z',
      description: '重做',
      source: this.SOURCE
    }, () => this.redo());

    // 格式化代码
    this.shortcutService.register({
      key: 'ctrl+shift+f',
      description: '格式化代码',
      source: this.SOURCE
    }, () => this.formatCode());

    // 使用 Observable 方式监听
    const sub = this.shortcutService.on('ctrl+shift+p').subscribe(() => {
      this.openCommandPalette();
    });
    this.subscriptions.push(sub);
  }

  private save() {
    console.log('保存文件');
    // 保存逻辑...
  }

  private undo() {
    console.log('撤销');
    // 撤销逻辑...
  }

  private redo() {
    console.log('重做');
    // 重做逻辑...
  }

  private formatCode() {
    console.log('格式化代码');
    // 格式化逻辑...
  }

  private openCommandPalette() {
    console.log('打开命令面板');
    // 命令面板逻辑...
  }
}
```

### 快捷键帮助面板示例

```typescript
@Component({
  selector: 'app-shortcut-help',
  template: `
    <div class="shortcut-help">
      <h3>快捷键列表</h3>
      <table>
        <tr *ngFor="let item of shortcuts">
          <td class="key">{{ item.key }}</td>
          <td class="description">{{ item.description }}</td>
          <td class="source">{{ item.source }}</td>
        </tr>
      </table>
    </div>
  `
})
export class ShortcutHelpComponent implements OnInit {
  private shortcutService = inject(ShortcutService);
  shortcuts: Array<{ key: string; description: string; source: string }> = [];

  ngOnInit() {
    this.shortcuts = this.shortcutService.getShortcutList();
  }
}
```

---

## 接口定义

```typescript
// 快捷键配置
interface ShortcutConfig {
  key: string;              // 快捷键标识符
  description?: string;     // 描述
  preventDefault?: boolean; // 阻止默认行为
  stopPropagation?: boolean;// 阻止冒泡
  global?: boolean;         // 输入框中是否触发
  source?: string;          // 来源标识
}

// 快捷键事件
interface ShortcutEvent {
  key: string;                    // 快捷键标识符
  originalEvent: KeyboardEvent;   // 原始键盘事件
  timestamp: number;              // 时间戳
}

// 快捷键注册信息
interface ShortcutRegistration extends ShortcutConfig {
  handler: (event: KeyboardEvent) => void | Promise<void>;
  registeredAt: number;
  id: string;
}
```

---

## 注意事项

1. **服务已在 `AppComponent` 中初始化**，无需手动调用 `init()`
2. **跨平台兼容**：`meta` 键在 Windows 上是 Windows 键，在 Mac 上是 Command 键
3. **浏览器限制**：某些快捷键（如 `ctrl+w`、`ctrl+n`）可能被浏览器拦截
4. **Electron 环境**：在 Electron 中可以注册更多系统快捷键
5. **性能**：事件监听在 Angular Zone 外执行，处理函数在 Zone 内执行
