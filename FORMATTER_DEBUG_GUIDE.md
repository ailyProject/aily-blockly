# 格式化器调试指南

## 问题分析

报错 `"there is no formatter for 'plaintext'"` 说明：
1. 编辑器的语言被设置为了 `plaintext`
2. 但是格式化提供者只注册了 `json` 语言

## 修复方案

### 1. 添加了 plaintext 格式化支持

为了防止这个错误，现在为 `plaintext` 也注册了格式化提供者：

```typescript
// 为 plaintext 也注册一个格式化提供者（防止报错）
vscode.languages.registerDocumentFormattingEditProvider(
  { scheme: '*', language: 'plaintext' },
  {
    provideDocumentFormattingEdits(document, options, token) {
      // 尝试作为 JSON 格式化
      try {
        const text = document.getText();
        const parsed = JSON.parse(text);
        const formatted = JSON.stringify(parsed, null, options.tabSize || 2);
        return [vscode.TextEdit.replace(fullRange, formatted)];
      } catch (error) {
        return []; // 如果不是 JSON，返回空数组
      }
    }
  }
);
```

### 2. 添加了调试日志

现在代码会输出以下调试信息：

- `[编辑器初始化]` - 显示文件路径和推断的语言
- `[创建编辑器]` - 显示使用的语言和内容长度
- `[模型检查]` - 显示实际创建的模型语言ID
- `[JSON格式化]` - 格式化时显示文档语言和URI
- `[Plaintext格式化]` - 如果是 plaintext，会显示警告

## 测试步骤

### 1. 打开浏览器开发者工具

按 F12 打开开发者工具，切换到 Console 标签页

### 2. 打开一个 JSON 文件

观察控制台输出，应该看到：

```
[编辑器初始化] 文件路径: xxx.json, 推断语言: json
JSON 语言：使用手动注册的格式化提供者，跳过扩展加载
[创建编辑器] 使用语言: json, 内容长度: xxx
✓ 格式化提供者已注册（JSON 和 plaintext，使用 VSCode API，支持快捷键 Shift+Alt+F）
[模型检查] 实际模型语言ID: json
```

### 3. 测试格式化

按 **Shift+Alt+F** 或右键选择 "Format Document"

观察控制台输出：

- **如果语言是 json**：
  ```
  [JSON格式化] 文档语言: json, URI: file:///xxx.json
  ✓ 文档格式化成功
  ```

- **如果语言是 plaintext**（不应该出现，但如果出现）：
  ```
  [Plaintext格式化] 检测到 plaintext，尝试作为 JSON 格式化
  ```

### 4. 检查问题

如果看到 `[模型检查] 实际模型语言ID: plaintext`，说明：

**可能的原因：**

1. **文件路径为空或无效**
   - 检查：`[编辑器初始化] 文件路径: undefined` 或 `null`
   - 解决：确保传入正确的 `filePath` 属性

2. **文件扩展名不在映射表中**
   - 检查：文件扩展名是否在 `getLanguageFromFilePath` 的 `languageMap` 中
   - 解决：添加扩展名映射

3. **Monaco 自动检测覆盖了语言设置**
   - 可能：Monaco 根据内容自动检测为 plaintext
   - 解决：使用 `createModelReference` 代替 `createModel`

## 验证清单

- [ ] 控制台显示正确的语言ID（json，不是 plaintext）
- [ ] 按 Shift+Alt+F 能正常格式化
- [ ] 没有 "no formatter" 错误
- [ ] 格式化后 JSON 正确缩进

## 如果还是不行

### 方案 A：检查文件路径

```typescript
// 在组件中添加
ngOnInit() {
  console.log('Monaco Editor Component initialized');
  console.log('filePath:', this.filePath);
  console.log('code length:', this.code?.length);
}
```

### 方案 B：强制设置语言

如果模型语言ID不对，可以强制设置：

```typescript
// 在创建编辑器后
if (actualModel && actualModel.getLanguageId() !== language) {
  console.warn(`语言不匹配！期望: ${language}, 实际: ${actualModel.getLanguageId()}`);
  // 强制设置语言
  monaco.editor.setModelLanguage(actualModel, language);
  console.log(`已强制设置语言为: ${language}`);
}
```

### 方案 C：使用 createModelReference

完全按照 monaco-vscode-api 的推荐方式：

```typescript
import { RegisteredFileSystemProvider, RegisteredMemoryFile, registerFileSystemOverlay } 
  from '@codingame/monaco-vscode-files-service-override'

// 注册文件到虚拟文件系统
const fileUri = monaco.Uri.file(this.filePath);
const fileSystemProvider = new RegisteredFileSystemProvider(false);
fileSystemProvider.registerFile(new RegisteredMemoryFile(fileUri, this.code));
const overlayDisposable = registerFileSystemOverlay(1, fileSystemProvider);

// 使用 createModelReference
const modelRef = await monaco.editor.createModelReference(fileUri);
this.editorInstance = monaco.editor.create(this.monacoContainer.nativeElement, {
  model: modelRef.object.textEditorModel,
  ...options
});
```

## 联系信息

如果问题仍然存在，请提供：

1. 控制台完整日志
2. 文件路径的值
3. 文件扩展名
4. 错误截图

这将帮助快速定位问题根源。
