# Monaco Editor 代码高亮使用指南

## 功能概述

我们为 `CodeViewerComponent` 添加了以下高亮功能：

1. **整行高亮** - 高亮指定的行范围
2. **文本搜索高亮** - 高亮所有匹配的文本
3. **范围高亮** - 高亮指定的字符范围
4. **滚动并高亮** - 跳转到指定行并高亮
5. **清除高亮** - 清除所有高亮效果

## API 方法

### 1. highlightLines(startLine: number, endLine: number, className?: string)
高亮指定的行范围

```typescript
// 高亮第5-8行
this.codeViewer.highlightLines(5, 8);

// 高亮第10行，使用自定义样式
this.codeViewer.highlightLines(10, 10, 'highlighted-error');
```

### 2. highlightText(searchText: string, className?: string)
高亮所有匹配的文本

```typescript
// 高亮所有"function"关键字
this.codeViewer.highlightText('function');

// 高亮所有"error"文本，使用错误样式
this.codeViewer.highlightText('error', 'highlighted-error');
```

### 3. highlightRange(startLine: number, startColumn: number, endLine: number, endColumn: number, className?: string)
高亮指定的字符范围

```typescript
// 高亮第3行第5列到第3行第15列
this.codeViewer.highlightRange(3, 5, 3, 15);

// 高亮多行范围
this.codeViewer.highlightRange(2, 1, 5, 20, 'highlighted-warning');
```

### 4. scrollToLineAndHighlight(lineNumber: number)
滚动到指定行并高亮

```typescript
// 跳转到第50行并高亮
this.codeViewer.scrollToLineAndHighlight(50);
```

### 5. clearHighlight()
清除所有高亮效果

```typescript
// 清除所有高亮
this.codeViewer.clearHighlight();
```

## 预定义样式类

| 样式类名 | 用途 | 效果 |
|---------|------|------|
| `highlighted-line` | 默认行高亮 | 黄色背景，左侧金色边框 |
| `highlighted-text` | 默认文本高亮 | 黄色背景 |
| `highlighted-range` | 默认范围高亮 | 蓝色背景，蓝色边框 |
| `highlighted-error` | 错误高亮 | 红色背景，波浪下划线 |
| `highlighted-warning` | 警告高亮 | 橙色背景，波浪下划线 |
| `highlighted-success` | 成功高亮 | 绿色背景，左侧绿色边框 |

## 实际使用场景

### 1. 语法错误提示
```typescript
// 当检测到语法错误时
highlightSyntaxError(lineNumber: number) {
  this.codeViewer.highlightLines(lineNumber, lineNumber, 'highlighted-error');
  this.codeViewer.scrollToLineAndHighlight(lineNumber);
}
```

### 2. 搜索结果高亮
```typescript
// 搜索并高亮代码
searchInCode(keyword: string) {
  this.codeViewer.highlightText(keyword, 'highlighted-text');
}
```

### 3. 调试断点显示
```typescript
// 设置调试断点高亮
setBreakpoint(lineNumber: number) {
  this.codeViewer.highlightLines(lineNumber, lineNumber, 'highlighted-warning');
}
```

### 4. 代码比较差异
```typescript
// 高亮代码差异
highlightDifference(startLine: number, endLine: number) {
  this.codeViewer.highlightLines(startLine, endLine, 'highlighted-success');
}
```

## 注意事项

1. **编辑器实例准备**: 确保在编辑器完全初始化后再调用高亮方法
2. **清除高亮**: 在应用新高亮前会自动清除之前的高亮
3. **自定义样式**: 可以通过传入自定义 CSS 类名来定制高亮样式
4. **性能考虑**: 避免频繁调用高亮方法，特别是在大文件中

## 扩展自定义样式

如果需要添加新的高亮样式，在 SCSS 文件中添加：

```scss
::ng-deep {
  .my-custom-highlight {
    background-color: rgba(128, 0, 128, 0.2) !important;
    border: 2px solid purple;
    border-radius: 4px;
  }
}
```

然后使用：
```typescript
this.codeViewer.highlightText('custom', 'my-custom-highlight');
```