# openAndSendToAilyChat 使用指南

## 概述

`openAndSendToAilyChat` 是一个全局函数，用于打开 aily-chat 面板并发送消息。推荐用于按钮触发等需要确保面板已打开的场景。

此方法由 `UiService.init()` 注册，使用前需确保主窗口已初始化。

## 基础用法

### 打开对话框并自动触发发送
```typescript
window.openAndSendToAilyChat('生成项目连线图', { autoSend: true });
```

### 只填入输入框，让用户手动确认
```typescript
window.openAndSendToAilyChat('帮我分析这段代码');
```

## 选项说明

| 参数 | 类型 | 说明 |
|------|------|------|
| text | `string` | 要发送的文本内容 |
| options | `Record<string, any>` | 可选，建议传 `{ autoSend: true }` 以自动触发发送 |

## 测试

在浏览器控制台中测试：
```javascript
window.openAndSendToAilyChat('这是一个测试消息', { autoSend: true });
```