# Monaco VSCode API 格式化修复说明

## 问题根源

### 错误的 API 使用方式

之前的代码使用了 **Monaco Editor 原生 API**：
```typescript
monaco.languages.registerDocumentFormattingEditProvider('json', {...})
```

### 为什么会失败？

当使用 `@codingame/monaco-vscode-api` 时，这个库**覆盖了 Monaco 的服务层**，使其工作方式更接近真实的 VSCode。在这种架构下：

1. **Monaco 原生 API 被部分禁用**
   - `monaco.languages.registerDocumentFormattingEditProvider` 注册的提供者**不会被 VSCode 服务层识别**
   - VSCode 的格式化命令（`editor.action.formatDocument`）只查找通过 **VSCode API** 注册的提供者

2. **错误消息的含义**
   - `"there is no formatter for json files"` - VSCode 服务找不到格式化提供者
   - `"there are multiple formatters for 'json' files"` - 多个扩展或服务尝试提供格式化
   - `"there is no formatter for 'plaintext'"` - fallback 到不支持格式化的语言

## 正确的解决方案

### 使用 VSCode API

根据 [@codingame/monaco-vscode-api 文档](https://github.com/CodinGame/monaco-vscode-api)：

> To be able to use the VSCode api directly from your code, you need to import `vscode/localExtensionHost`

正确的方式是：

```typescript
// ❌ 错误：使用 Monaco API
monaco.languages.registerDocumentFormattingEditProvider('json', {...})

// ✅ 正确：使用 VSCode API
import * as vscode from 'vscode'
vscode.languages.registerDocumentFormattingEditProvider(
  { scheme: '*', language: 'json' },
  { provideDocumentFormattingEdits: (...) => {...} }
)
```

### 关键区别

| 特性 | Monaco API | VSCode API |
|------|-----------|-----------|
| 注册方式 | `monaco.languages.register...` | `vscode.languages.register...` |
| 语言选择器 | `'json'` (字符串) | `{ scheme: '*', language: 'json' }` (对象) |
| 返回值 | Monaco TextEdit | `vscode.TextEdit` 对象 |
| Range 对象 | `monaco.Range` | `vscode.Range` |
| Document 访问 | `model.getValue()` | `document.getText()` |
| 与 VSCode 命令集成 | ❌ 不兼容 | ✅ 完全兼容 |

## 修复的代码

### 之前（不工作）

```typescript
private registerJsonFormattingProvider(): void {
  monaco.languages.registerDocumentFormattingEditProvider('json', {
    provideDocumentFormattingEdits: (model, options, token) => {
      const text = model.getValue();
      const formatted = JSON.stringify(JSON.parse(text), null, 2);
      return [{
        range: model.getFullModelRange(),
        text: formatted
      }];
    }
  });
}
```

### 之后（工作）

```typescript
private async registerJsonFormattingProvider(): Promise<void> {
  // 导入 VSCode API
  const vscode = await import('vscode');
  
  // 使用 VSCode API 注册
  vscode.languages.registerDocumentFormattingEditProvider(
    { scheme: '*', language: 'json' },  // 语言选择器对象
    {
      provideDocumentFormattingEdits(document, options, token) {
        const text = document.getText();  // 使用 VSCode Document API
        const formatted = JSON.stringify(JSON.parse(text), null, options.tabSize || 2);
        
        // 返回 VSCode TextEdit
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(text.length)
        );
        
        return [vscode.TextEdit.replace(fullRange, formatted)];
      }
    }
  );
}
```

## 为什么这样修复有效？

1. **VSCode 服务层识别**
   - 使用 `vscode.languages` API 注册的提供者会被 VSCode 的语言服务正确识别
   - 快捷键（Shift+Alt+F）触发的格式化命令能找到这个提供者

2. **正确的对象类型**
   - 使用 `vscode.TextEdit` 和 `vscode.Range` 对象
   - 这些对象与 VSCode 内部服务兼容

3. **语言选择器**
   - `{ scheme: '*', language: 'json' }` 匹配所有 scheme 的 JSON 文件
   - 比简单字符串 `'json'` 更灵活和明确

## 其他修复

### Fallback 语言修复

```typescript
// ❌ 之前：使用 plaintext（没有格式化器）
const basicModel = monaco.editor.createModel(content, 'plaintext');

// ✅ 之后：使用实际的语言类型
const fallbackLanguage = this.getLanguageFromFilePath(this.filePath) || 'json';
const basicModel = monaco.editor.createModel(content, fallbackLanguage);
```

## 测试方法

1. **打开 JSON 文件**
2. **按 Shift+Alt+F** 或右键选择 "Format Document"
3. **验证**：
   - JSON 被正确格式化
   - 没有报错
   - 控制台显示：`✓ JSON 格式化提供者已注册（使用 VSCode API，支持快捷键 Shift+Alt+F）`

## 学到的教训

### 使用 monaco-vscode-api 的正确方式

1. **总是使用 VSCode API**
   - 不要直接使用 `monaco.*` API 来注册服务
   - 使用 `vscode.*` API（从 `'vscode'` 包导入）

2. **理解架构差异**
   - `monaco-vscode-api` 不是简单的 Monaco Editor
   - 它是一个完整的 VSCode 服务层实现
   - 需要按照 VSCode 扩展的方式编写代码

3. **查看官方文档**
   - [monaco-vscode-api GitHub](https://github.com/CodinGame/monaco-vscode-api)
   - [Wiki](https://github.com/CodinGame/monaco-vscode-api/wiki)
   - [Getting Started Guide](https://github.com/CodinGame/monaco-vscode-api/wiki/Getting-started-guide)

## 参考资料

- [Monaco VSCode API - VSCode API Usage](https://github.com/CodinGame/monaco-vscode-api#vscode-api-usage)
- [VSCode API - Languages](https://code.visualstudio.com/api/references/vscode-api#languages)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)

## 总结

**核心问题**：混淆了 Monaco Editor 原生 API 和 VSCode API

**解决方案**：在使用 `@codingame/monaco-vscode-api` 时，必须使用 `vscode.*` API 而不是 `monaco.*` API 来注册语言功能（格式化、补全等）

**结果**：格式化功能正常工作，支持快捷键，与 VSCode 行为一致 ✅
