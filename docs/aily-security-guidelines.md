# Aily Blockly 安全限制指南

## 概述

本文档定义了 Aily Blockly 项目中 AI 助手（Aily Chat）与用户交互时的安全模型。系统在提供强大的代码生成、文件操作和命令执行能力的同时，需要确保用户系统的安全性。

## 安全原则

### 1. 项目作用域限制
所有文件操作默认限制在以下目录范围内：
- **项目根目录** (`projectRootPath`)：用户项目的存放根目录
- **当前项目路径** (`currentProjectPath`)：当前打开的项目目录
- **库存放路径** (`librariesPath`)：项目依赖库的存放位置
- **AppData 路径** (`appDataPath`)：SDK、编译器工具和配置缓存

### 2. 最小权限原则
- AI 工具只请求完成任务所需的最小权限
- 写操作比读操作需要更高级别的验证
- 系统目录和敏感文件不可访问

### 3. 透明度原则
- 所有工具调用都会在界面上显示状态
- 用户可以清楚地看到 AI 正在执行什么操作
- 操作完成后提供明确的反馈

## 路径访问控制

### 允许访问的路径

```typescript
// 允许访问的目录
const allowedPaths = {
  // 项目相关目录
  projectRoot: projectService.projectRootPath,
  currentProject: projectService.currentProjectPath,
  projectLibraries: `${currentProjectPath}/libraries`,
  
  // 应用数据目录
  appData: window.path.getAppDataPath(),
  sdkCache: `${appDataPath}/sdk`,
  libraryCache: `${appDataPath}/libraries`,
  
  // 临时目录（用于编译等操作）
  temp: os.tmpdir()
};
```

### 受保护的路径（禁止访问）

```typescript
const protectedPaths = [
  // 系统核心目录
  '/',
  'C:\\',
  'C:\\Windows',
  'C:\\Program Files',
  '/etc',
  '/sys',
  '/proc',
  '/usr',
  
  // 用户敏感目录
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.config/git',
  
  // 版本控制敏感目录
  '.git',
  '.git/config',
  '.git/hooks',
  
  // 环境配置文件
  '.bashrc',
  '.zshrc',
  '.profile',
  '.env',
  '.env.local',
  '.env.production'
];
```

### 路径验证函数

```typescript
/**
 * 验证路径是否在允许的目录范围内
 * @param inputPath 用户请求的路径
 * @param allowedBase 允许的基础目录
 * @returns boolean 是否允许访问
 */
function isPathAllowed(inputPath: string, allowedBase: string): boolean {
  const normalizedInput = path.resolve(inputPath);
  const normalizedBase = path.resolve(allowedBase);
  
  // 检查路径是否在允许目录内
  if (!normalizedInput.startsWith(normalizedBase)) {
    return false;
  }
  
  // 检查路径穿越攻击 (../)
  const relative = path.relative(normalizedBase, normalizedInput);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  
  // 检查是否为受保护路径
  if (isSensitivePath(normalizedInput)) {
    return false;
  }
  
  return true;
}

/**
 * 检查是否为敏感路径
 */
function isSensitivePath(filePath: string): boolean {
  const sensitivePatterns = [
    /[/\\]\.git[/\\]/,
    /[/\\]\.ssh[/\\]/,
    /[/\\]\.env(\..+)?$/,
    /[/\\]\.bashrc$/,
    /[/\\]\.zshrc$/,
    /[/\\]id_rsa/,
    /[/\\]\.aws[/\\]/
  ];
  
  return sensitivePatterns.some(pattern => pattern.test(filePath));
}
```

## 命令执行安全

### 命令分类

#### ✅ 安全命令（自动允许）
```typescript
const safeCommands = [
  // 编译和构建相关
  'npm install',
  
  // 文件操作（只读）
  'ls',
  'dir',
  'cat',
  'type',
  'pwd',
  'cd',
  
  // Git 只读操作
  'git status',
  'git log',
  'git diff',
  'git branch',
  
  // 开发工具
  'node --version',
  'npm --version',
  'python --version'
];
```

#### ⚠️ 需要确认的命令
```typescript
const confirmCommands = [
  // Git 修改操作
  'git commit',
  'git push',
  'git merge',
  'git reset',
  
  // 包管理修改
  'npm uninstall',
  'npm update',
  
  // 文件删除
  'rm',
  'del',
  'rmdir'

  // 网络操作
  'curl | sh',
  'wget | sh',
  'curl | bash',
];
```

#### ❌ 禁止的命令
```typescript
const blockedCommands = [
  // 系统级危险操作
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'format',
  'fdisk',
  'dd if=',
  'mkfs',
  ':(){:|:&};:',  // Fork 炸弹
  
  // 权限提升
  'sudo rm -rf',
  'chmod 777 /',
  'chown root',
  
  // 系统关键操作
  'shutdown',
  'reboot',
  'halt',
  'poweroff'
];

/**
 * 检查命令是否被阻止
 */
function isCommandBlocked(command: string): { blocked: boolean; reason?: string } {
  const normalizedCmd = command.toLowerCase().trim();
  
  for (const blocked of blockedCommands) {
    if (normalizedCmd.includes(blocked.toLowerCase())) {
      return {
        blocked: true,
        reason: `禁止执行危险命令: ${blocked}`
      };
    }
  }
  
  // 检查危险的通配符操作
  if (/rm\s+(-rf?\s+)?[/*]/.test(normalizedCmd)) {
    return {
      blocked: true,
      reason: '禁止使用通配符删除根目录或关键目录'
    };
  }
  
  return { blocked: false };
}
```

### 命令执行限制

```typescript
interface CommandExecutionLimits {
  // 执行超时（毫秒）
  timeout: 300000,  // 5分钟
  
  // 输出大小限制（字节）
  maxOutputSize: 1048576,  // 1MB
  
  // 必须在项目目录内执行
  requireProjectContext: true,
  
  // 禁止创建子 shell
  allowSubshell: false
}
```

## 文件操作安全

### 读取操作

```typescript
interface FileReadLimits {
  // 单个文件大小限制
  maxFileSize: 10485760,  // 10MB
  
  // 单次读取行数限制
  maxLinesPerRead: 10000,
  
  // 单次读取字节限制
  maxBytesPerRead: 1048576,  // 1MB
  
  // 允许的文件类型
  allowedExtensions: [
    // 代码文件
    '.c', '.cpp', '.h', '.hpp', '.ino',
    '.js', '.ts', '.jsx', '.tsx',
    '.py', '.java', '.go', '.rs',
    
    // 配置文件
    '.json', '.yaml', '.yml', '.toml',
    '.xml', '.ini', '.cfg',
    
    // 文档
    '.md', '.txt', '.rst',
    
    // Web
    '.html', '.css', '.scss', '.less'
  ],
  
  // 禁止读取的文件类型
  blockedExtensions: [
    '.exe', '.dll', '.so', '.dylib',
    '.key', '.pem', '.crt',
    '.db', '.sqlite'
  ]
}
```

### 写入操作

```typescript
interface FileWriteLimits {
  // 单次写入大小限制
  maxWriteSize: 5242880,  // 5MB
  
  // 是否自动创建备份
  createBackup: true,
  
  // 备份文件前缀
  backupPrefix: 'ABIBAK_',
  
  // 禁止创建的文件
  blockedFileNames: [
    '.bashrc',
    '.zshrc',
    '.profile',
    '.env',
    'id_rsa',
    'id_ed25519'
  ],
  
  // 禁止写入的目录
  blockedDirectories: [
    '.git',
    '.ssh',
    'node_modules'  // 应通过 npm 管理
  ]
}
```

### 删除操作安全

```typescript
/**
 * 检查是否为关键删除目标
 */
function isCriticalRemovalTarget(absPath: string): boolean {
  const homedir = os.homedir();
  const normalized = path.normalize(absPath);
  
  // 禁止删除根目录
  if (normalized === '/' || normalized === 'C:\\') {
    return true;
  }
  
  // 禁止删除用户主目录
  if (normalized === homedir) {
    return true;
  }
  
  // 禁止删除项目根目录
  if (normalized === projectRootPath) {
    return true;
  }
  
  // 禁止删除顶级系统目录
  const parentDir = path.dirname(normalized);
  if (parentDir === '/' || parentDir === 'C:\\') {
    return true;
  }
  
  return false;
}
```

## MCP 服务器安全

### 服务器白名单

```typescript
// 允许的 MCP 服务器列表
const allowedMCPServers = [
  'aily-builder',      // Aily 构建服务
  'filesystem',        // 文件系统操作（受限）
  'arduino-cli'        // Arduino 编译上传
];
```

### MCP 工具权限

```typescript
interface MCPToolPermission {
  // 服务器名称
  serverName: string;
  
  // 允许的工具列表
  allowedTools: string[];
  
  // 自动批准的操作
  autoApproveOperations: string[];
  
  // 需要确认的操作
  requireConfirmation: string[];
}

const mcpPermissions: MCPToolPermission[] = [
  {
    serverName: 'aily-builder',
    allowedTools: ['*'],
    autoApproveOperations: ['read', 'compile', 'analyze'],
    requireConfirmation: ['write', 'delete', 'upload']
  }
];
```

## 资源限制

```typescript
interface ResourceLimits {
  // 单次操作文件数量
  maxFilesPerOperation: 100,
  
  // 目录遍历深度
  maxDirectoryDepth: 10,
  
  // 并发操作数
  maxConcurrentOperations: 5,
  
  // 单个会话内存限制
  maxSessionMemory: 536870912,  // 512MB
  
  // API 请求频率限制
  apiRateLimit: {
    requestsPerMinute: 60,
    requestsPerHour: 1000
  }
}
```

## Blockly 工作区安全

### 工作区操作限制

```typescript
interface WorkspaceSafetyLimits {
  // 最大 Block 数量
  maxBlocks: 1000,
  
  // 最大嵌套深度
  maxNestingDepth: 20,
  
  // 单次操作的 Block 数量
  maxBlocksPerOperation: 50,
  
  // 禁止的操作
  blockedOperations: [
    'deleteAllBlocks',      // 需要确认
    'clearWorkspace',       // 需要确认
    'importFromExternal'    // 需要验证来源
  ]
}
```

### 代码生成安全

```typescript
interface CodeGenerationSafety {
  // 生成代码大小限制
  maxGeneratedCodeSize: 1048576,  // 1MB
  
  // 禁止生成的代码模式
  blockedCodePatterns: [
    /system\s*\(/,          // 系统调用
    /exec\s*\(/,            // 执行外部命令
    /eval\s*\(/,            // 动态执行
    /shell_exec/,           // Shell 执行
    /__import__/            // Python 动态导入
  ],
  
  // 验证生成的代码
  validateGeneratedCode: true
}
```

## 用户数据保护

### 敏感数据处理

```typescript
// 日志中需要脱敏的字段
const sensitiveFields = [
  'password',
  'apiKey',
  'token',
  'secret',
  'credential',
  'private_key'
];

/**
 * 脱敏日志输出
 */
function sanitizeForLogging(data: any): any {
  if (typeof data !== 'object' || data === null) {
    return data;
  }
  
  const sanitized = { ...data };
  for (const field of sensitiveFields) {
    if (field in sanitized) {
      sanitized[field] = '***REDACTED***';
    }
  }
  return sanitized;
}
```

### 会话隔离

```typescript
interface SessionIsolation {
  // 每个会话独立的工作空间
  isolatedWorkspace: true,
  
  // 会话间不共享历史
  isolatedHistory: true,
  
  // 会话超时时间（毫秒）
  sessionTimeout: 3600000,  // 1小时
  
  // 自动清理临时文件
  cleanupOnSessionEnd: true
}
```

## 错误处理和恢复

### 安全失败模式

```typescript
interface SafeFailureMode {
  // 操作失败时的处理
  onFailure: {
    // 回滚已执行的操作
    rollback: true,
    
    // 保留备份文件
    preserveBackups: true,
    
    // 记录错误日志
    logError: true,
    
    // 通知用户
    notifyUser: true
  },
  
  // 备份保留策略
  backupRetention: {
    // 保留最近 N 个备份
    maxBackups: 5,
    
    // 备份保留时间（天）
    retentionDays: 3
  }
}
```

### 操作回滚

```typescript
interface OperationRollback {
  // 支持回滚的操作类型
  rollbackableOperations: [
    'file_write',
    'file_delete',
    'block_modification'
  ],
  
  // 自动创建回滚点
  createRollbackPoints: true,
  
  // 回滚点保存数量
  maxRollbackPoints: 10
}
```

## 审计和监控

### 操作日志

```typescript
interface AuditLog {
  // 记录时间戳
  timestamp: Date;
  
  // 操作类型
  operation: string;
  
  // 使用的工具
  tool: string;
  
  // 操作目标
  target: string;
  
  // 操作参数（已脱敏）
  params: any;
  
  // 操作结果
  result: 'success' | 'failure' | 'blocked';
  
  // 会话 ID
  sessionId: string;
  
  // 拒绝原因（如果被拒绝）
  blockReason?: string;
}
```

### 异常检测

```typescript
/**
 * 检测可疑操作模式
 */
function detectSuspiciousPattern(recentOperations: AuditLog[]): boolean {
  // 短时间内大量删除操作
  const deleteOps = recentOperations.filter(
    op => op.operation === 'delete' && 
          Date.now() - op.timestamp.getTime() < 60000
  );
  if (deleteOps.length > 10) {
    return true;
  }
  
  // 频繁访问不同目录
  const uniqueDirs = new Set(
    recentOperations.map(op => path.dirname(op.target))
  );
  if (uniqueDirs.size > 20) {
    return true;
  }
  
  // 多次被阻止的操作
  const blockedOps = recentOperations.filter(
    op => op.result === 'blocked'
  );
  if (blockedOps.length > 5) {
    return true;
  }
  
  return false;
}
```

## 实施建议

### 开发者实施清单

1. **路径验证**
   - [ ] 所有文件操作前验证路径
   - [ ] 实现路径穿越检测
   - [ ] 维护敏感路径黑名单

2. **命令安全**
   - [ ] 实现命令白名单/黑名单
   - [ ] 危险命令需要用户确认
   - [ ] 限制命令执行超时

3. **备份机制**
   - [ ] 写操作前自动备份
   - [ ] 实现备份轮转策略
   - [ ] 提供回滚功能

4. **日志审计**
   - [ ] 记录所有工具调用
   - [ ] 敏感数据脱敏
   - [ ] 实现异常检测

5. **用户反馈**
   - [ ] 显示操作状态
   - [ ] 危险操作提示确认
   - [ ] 错误信息友好展示

## 安全保障总结

| 威胁类型 | 防护措施 | 状态 |
|---------|---------|------|
| 路径穿越攻击 | 路径验证、`../` 检测、符号链接检查 | ✅ |
| 删除系统目录 | 关键路径保护、禁止 `rm -rf /` | ✅ |
| 敏感文件访问 | 敏感路径黑名单、扩展名过滤 | ✅ |
| 恶意命令执行 | 命令黑名单、超时限制 | ✅ |
| 资源耗尽 | 文件大小限制、并发控制 | ✅ |
| 数据泄露 | 日志脱敏、会话隔离 | ✅ |
| 误操作恢复 | 自动备份、回滚机制 | ✅ |
