# clangd VSIX 插件调试指南

## 问题解决方案

### 1. "Default api is not ready yet" 错误

这个错误表示VSCode API还没有完全初始化。我们已经添加了以下修复：

- 增加了API准备检查和等待机制
- 延长了初始化等待时间
- 添加了双重安全检查
- 改进了错误处理，避免阻塞后续流程

### 2. 调试步骤

#### 步骤1：检查VSCode API状态
在浏览器控制台中运行：
```javascript
const editor = document.querySelector('app-monaco-editor')?.componentInstance;
if (editor) {
  editor.checkVSCodeAPIStatus();
}
```

#### 步骤2：生成完整状态报告
```javascript
const editor = document.querySelector('app-monaco-editor')?.componentInstance;
if (editor) {
  editor.generateClangdReport();
}
```

#### 步骤3：强制重新初始化（如果需要）
```javascript
const editor = document.querySelector('app-monaco-editor')?.componentInstance;
if (editor) {
  await editor.forceReinitialize();
}
```

### 3. 预期的成功日志

如果一切正常，您应该在控制台看到：

```
✅ LocalExtensionHost已导入，API应该可用
✅ VSCode API已准备就绪
✅ VSCode API 模块已加载
✅ vscode.languages API 可用
✅ clangd扩展已加载
✅ 成功为语言 cpp 注册补全提供者
✅ Successfully registered extension: clangd
```

### 4. 常见问题和解决方案

#### 问题：VSCode API 未定义
**解决方案：**
1. 确保所有依赖已正确安装
2. 检查import语句是否正确
3. 尝试强制重新初始化

#### 问题：扩展注册失败
**解决方案：**
1. 检查VSIX文件是否完整
2. 验证扩展清单文件格式
3. 查看详细错误日志

#### 问题：代码补全不工作
**解决方案：**
1. 确保当前文件语言设置为cpp/c
2. 检查是否有补全提供者注册
3. 手动触发补全测试

### 5. 测试代码模板

使用以下C++代码测试补全功能：

```cpp
#include <iostream>
#include <vector>
#include <string>

class TestClass {
public:
    void testMethod() {
        std::vector<int> vec;
        vec.  // 测试点1：在这里按Ctrl+Space
        
        std::string str = "hello";
        str.  // 测试点2：在这里按Ctrl+Space
    }
};

int main() {
    TestClass test;
    test.  // 测试点3：在这里按Ctrl+Space
    return 0;
}
```

### 6. 故障排除清单

- [ ] VSCode API已正确初始化
- [ ] clangd扩展文件存在于 child/vsix/ 目录
- [ ] 扩展已成功加载到内存
- [ ] 语言服务提供者已注册
- [ ] 当前文件语言设置正确
- [ ] Monaco编辑器实例正常工作

### 7. 联系支持

如果问题持续存在，请提供：
1. 完整的控制台日志
2. VSCode API状态报告
3. 扩展加载状态
4. 具体的错误信息

## 更新日志

- 修复了"Default api is not ready yet"错误
- 添加了API准备等待机制
- 改进了错误处理和调试工具
- 增加了强制重新初始化功能