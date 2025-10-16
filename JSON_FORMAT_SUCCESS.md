# ✅ JSON 格式化功能成功实现

## 🎯 问题描述

在使用 `@codingame/monaco-vscode-api` 集成 Monaco Editor 时，JSON 文件的格式化功能无法正常工作，报错：
- `"there is no formatter for json files"`
- `"there are multiple formatters for 'json' files"`
- `"there is no formatter for 'plaintext'"`

## 🔍 根本原因

**错误的 API 使用方式**：

在 `@codingame/monaco-vscode-api` 架构下，直接使用 Monaco Editor 原生 API (`monaco.languages.registerDocumentFormattingEditProvider`) 注册的格式化提供者**不会被 VSCode 服务层识别**。

当用户按下 `Shift+Alt+F` 格式化快捷键时，VSCode 命令系统会查找格式化提供者，但只能找到通过 **VSCode API** 注册的提供者。

## ✅ 解决方案

### 1. 使用 VSCode API 注册格式化提供者

```typescript
// ❌ 错误方式（不工作）
monaco.languages.registerDocumentFormattingEditProvider('json', {
  provideDocumentFormattingEdits: (model, options, token) => {
    // ...
  }
});

// ✅ 正确方式（工作）
import * as vscode from 'vscode';

vscode.languages.registerDocumentFormattingEditProvider(
  { scheme: '*', language: 'json' },  // 使用语言选择器对象
  {
    provideDocumentFormattingEdits(document, options, token) {
      const text = document.getText();
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, options.tabSize || 2);
      
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length)
      );
      
      return [vscode.TextEdit.replace(fullRange, formatted)];
    }
  }
);
```

### 2. 关键差异

| 特性 | Monaco API | VSCode API |
|------|-----------|-----------|
| 注册方法 | `monaco.languages.register...` | `vscode.languages.register...` |
| 语言选择器 | 字符串 `'json'` | 对象 `{ scheme: '*', language: 'json' }` |
| Document 对象 | Monaco Model | VSCode TextDocument |
| 获取文本 | `model.getValue()` | `document.getText()` |
| Range 对象 | `monaco.Range` | `vscode.Range` |
| TextEdit | Monaco TextEdit | `vscode.TextEdit` |
| 与快捷键集成 | ❌ 不兼容 | ✅ 完全兼容 |

### 3. 支持多种语言

为了避免 "no formatter for plaintext" 错误，也为 plaintext 注册了格式化提供者：

```typescript
// 为 plaintext 注册格式化提供者（作为 JSON 尝试格式化）
vscode.languages.registerDocumentFormattingEditProvider(
  { scheme: '*', language: 'plaintext' },
  {
    provideDocumentFormattingEdits(document, options, token) {
      try {
        const text = document.getText();
        const parsed = JSON.parse(text);
        const formatted = JSON.stringify(parsed, null, options.tabSize || 2);
        return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (error) {
        // 不是有效 JSON，返回空数组（不报错）
        return [];
      }
    }
  }
);
```

## 📝 实现细节

### 文件修改

**文件**: `src/app/editors/code-editor/components/monaco-editor/monaco-editor.component.ts`

**关键修改**：

1. **registerJsonFormattingProvider() 方法** (约 line 797-895)
   - 改为 `async` 方法
   - 使用 `await import('vscode')` 导入 VSCode API
   - 注册 3 个格式化提供者：
     * JSON 文档格式化
     * JSON 范围格式化
     * Plaintext 格式化（fallback）

2. **init() 方法** (约 line 763)
   - 调用改为 `await this.registerJsonFormattingProvider()`

3. **禁用 JSON 扩展加载** (约 line 534-539)
   - 跳过 `vscode/extensions/json` 扩展加载
   - 避免与手动注册的格式化提供者冲突

### 防止重复注册

使用静态标志确保格式化提供者只注册一次：

```typescript
private static jsonFormatterRegistered = false;

private async registerJsonFormattingProvider(): Promise<void> {
  if (MonacoEditorComponent.jsonFormatterRegistered) {
    return;
  }
  
  // 注册格式化提供者...
  
  MonacoEditorComponent.jsonFormatterRegistered = true;
}
```

## 🎉 功能验证

### 测试步骤

1. **打开 JSON 文件**
2. **按 `Shift+Alt+F`** 或右键选择 "Format Document"
3. **验证结果**：
   - ✅ JSON 被正确格式化
   - ✅ 没有错误提示
   - ✅ 控制台显示：`✓ 格式化提供者已注册（JSON 和 plaintext，使用 VSCode API，支持快捷键 Shift+Alt+F）`

### 支持的功能

- ✅ 文档格式化 (`Shift+Alt+F`)
- ✅ 选区格式化（选中代码后格式化）
- ✅ 自定义缩进大小（通过 `options.tabSize`）
- ✅ Plaintext 文件的 JSON 格式化（如果内容是 JSON）
- ✅ 防止重复注册
- ✅ 错误处理和回退

## 📚 参考文档

### 创建的文档

1. **MONACO_VSCODE_API_FIX.md** - 详细的问题分析和解决方案
2. **FORMATTER_DEBUG_GUIDE.md** - 调试指南和故障排除
3. **JSON_FORMAT_SUCCESS.md** (本文档) - 成功实现总结

### 外部资源

- [monaco-vscode-api GitHub](https://github.com/CodinGame/monaco-vscode-api)
- [monaco-vscode-api Wiki](https://github.com/CodinGame/monaco-vscode-api/wiki)
- [VSCode API - languages](https://code.visualstudio.com/api/references/vscode-api#languages)
- [Getting Started Guide](https://github.com/CodinGame/monaco-vscode-api/wiki/Getting-started-guide)

## 💡 经验教训

### 1. 理解架构差异

`@codingame/monaco-vscode-api` 不是简单的 Monaco Editor 封装，而是：
- 完整的 VSCode 服务层实现
- 需要按照 VSCode 扩展的方式编写代码
- Monaco API 和 VSCode API 不能混用

### 2. 使用正确的 API

在 `@codingame/monaco-vscode-api` 环境中：
- ✅ 使用 `vscode.*` API 注册语言功能（格式化、补全、hover 等）
- ❌ 不要使用 `monaco.*` API 注册这些功能
- ✅ `monaco.*` 只用于编辑器实例操作（create, updateOptions 等）

### 3. 语言选择器的重要性

VSCode API 使用更强大的语言选择器：
```typescript
{ scheme: '*', language: 'json' }  // 匹配所有 scheme 的 JSON 文件
{ scheme: 'file', language: 'json' }  // 只匹配 file:// 协议的 JSON 文件
```

### 4. 防御性编程

- 为可能出现的语言类型都提供格式化支持
- 使用 try-catch 处理格式化错误
- 返回空数组而不是抛出异常

## 🚀 未来改进

### 可选的增强功能

1. **使用 createModelReference**
   - 按照 monaco-vscode-api 推荐方式创建模型
   - 支持虚拟文件系统
   - 更好的文件生命周期管理

2. **添加更多语言支持**
   - C++ 格式化（使用 clang-format）
   - Markdown 格式化
   - 其他语言的格式化提供者

3. **自定义格式化选项**
   - 允许用户配置缩进大小
   - 支持不同的格式化风格
   - 保存时自动格式化

## ✨ 总结

通过使用正确的 VSCode API 而不是 Monaco API，成功实现了 JSON 文件的格式化功能。这个案例很好地展示了在使用 `@codingame/monaco-vscode-api` 时，理解其架构和正确使用 API 的重要性。

**核心要点**：
- 在 monaco-vscode-api 环境中，使用 `vscode.languages` API
- 使用语言选择器对象 `{ scheme: '*', language: 'xxx' }`
- 使用 VSCode 的 Document、Range、TextEdit 对象
- 为所有可能的语言提供格式化支持

---

**状态**: ✅ 已完成并验证  
**日期**: 2025年10月10日  
**版本**: 1.0.0
