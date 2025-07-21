# sendToAilyChat 使用指南

## 概述

`sendToAilyChat` 是一个全局函数，允许任何组件向聊天组件发送文本内容。

## 基础用法

### 简单调用
```typescript
// 发送文本到聊天组件
window.sendToAilyChat('帮我生成Arduino代码');
```

### 完整选项
```typescript
window.sendToAilyChat('编译错误：xxx', {
  sender: 'Compiler',    // 发送者标识
  type: 'error',         // 消息类型
  cover: true           // 是否覆盖现有内容
});
```

## 选项说明

### ChatTextOptions 接口
```typescript
interface ChatTextOptions {
  sender?: string;   // 发送者标识，便于调试
  type?: string;     // 消息类型：help、code、error、log、question、warning
  cover?: boolean;   // true=覆盖内容，false=追加内容，默认为true
}
```

### cover 选项建议

| 场景 | cover 值 | 说明 |
|------|----------|------|
| 错误信息 | `true` | 错误需要优先显示 |
| 代码审查 | `true` | 专注于当前代码 |
| 快速问题 | `true` | 清空重新开始 |
| 日志分析 | `false` | 可能需要累积多个日志 |
| 警告信息 | `false` | 可能有多个警告 |
| 帮助提示 | `false` | 可以与现有内容共存 |

## 使用场景

### 错误处理
```typescript
// 编译错误 - 优先显示
window.sendToAilyChat(`编译错误：${error}`, {
  sender: 'Compiler',
  type: 'error',
  cover: true
});
```

### 代码审查
```typescript
// 代码审查 - 专注模式
window.sendToAilyChat(`请审查代码：\n${code}`, {
  sender: 'CodeReview',
  type: 'code',
  cover: true
});
```

### 日志分析
```typescript
// 双击日志发送到聊天
window.sendToAilyChat(`运行日志：\n${logDetail}`, {
  sender: 'LogComponent',
  type: 'log',
  cover: false
});
```

### 快速问题
```typescript
// 清空输入框，准备新问题
window.sendToAilyChat('什么是PWM？', {
  sender: 'QuickHelp',
  type: 'question',
  cover: true
});
```

## 其他调用方式

### Angular 服务注入
```typescript
constructor(private chatService: ChatCommunicationService) {}

this.chatService.sendTextToChat('Hello', { sender: 'MyComponent' });
```

### 静态方法
```typescript
ChatCommunicationService.sendToChat('Hello', { sender: 'Static' });
```

### 与UI服务配合
```typescript
// 先打开聊天工具，再发送文本
this.uiService.openTool('aily-chat');
setTimeout(() => {
  window.sendToAilyChat('需要帮助');
}, 500);
```

## 特性

- ✅ **向后兼容** - 支持旧的调用方式
- ✅ **类型安全** - 完整的TypeScript类型定义
- ✅ **智能覆盖** - 可选择覆盖或追加内容
- ✅ **调试友好** - 发送者和类型信息便于调试
- ✅ **全局可用** - 在任何地方都可以调用

## 测试

在浏览器控制台中测试：
```javascript
window.sendToAilyChat('这是一个测试消息');
```