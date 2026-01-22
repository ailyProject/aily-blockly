/**
 * Aily Blockly 安全服务
 * 实现路径验证、敏感文件检测、权限控制等核心安全功能
 * 
 * @see docs/aily-security-guidelines.md
 */

import * as os from 'os';

// ==================== 类型定义 ====================

export interface SecurityCheckResult {
    allowed: boolean;
    reason?: string;
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
}

export interface PathSecurityContext {
    currentProjectPath: string;
    librariesPath?: string;
    nodeModulesPath?: string;  // 当前项目下的 node_modules 目录
    allowProjectPathAccess?: boolean; // 是否允许操作当前项目路径
    allowNodeModulesAccess?: boolean;  // 是否允许操作 node_modules 目录，默认 false
    additionalAllowedPaths?: string[];  // 用户添加的额外允许路径（如上下文文件/文件夹）
}

export interface FileReadLimits {
    maxFileSize: number;          // 单个文件大小限制 (10MB)
    maxLinesPerRead: number;      // 单次读取行数限制
    maxBytesPerRead: number;      // 单次读取字节限制 (1MB)
    allowedExtensions: string[];  // 允许的文件类型
    blockedExtensions: string[];  // 禁止读取的文件类型
}

export interface FileWriteLimits {
    maxWriteSize: number;         // 单次写入大小限制 (5MB)
    createBackup: boolean;        // 是否自动创建备份
    backupPrefix: string;         // 备份文件前缀
    blockedFileNames: string[];   // 禁止创建的文件
    blockedDirectories: string[]; // 禁止写入的目录
}

export interface ResourceLimits {
    maxFilesPerOperation: number;       // 单次操作文件数量
    maxDirectoryDepth: number;          // 目录遍历深度
    maxConcurrentOperations: number;    // 并发操作数
    maxSessionMemory: number;           // 单个会话内存限制 (512MB)
}

// ==================== 常量配置 ====================

/**
 * 受保护的路径（禁止访问）
 */
export const PROTECTED_PATHS: string[] = [
    // 系统核心目录
    '/',
    'C:\\',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    '/etc',
    '/sys',
    '/proc',
    '/usr',
    '/bin',
    '/sbin',
    '/boot',
    '/dev',
    '/root',
    
    // 用户敏感目录（相对于用户主目录）
    '.ssh',
    '.gnupg',
    '.aws',
    '.config/git',
    '.docker',
    
    // 环境配置文件
    '.bashrc',
    '.zshrc',
    '.profile',
    '.bash_profile',
    '.env',
    '.env.local',
    '.env.production',
    '.env.development',
];

/**
 * 敏感路径匹配模式
 */
export const SENSITIVE_PATH_PATTERNS: RegExp[] = [
    /[/\\]\.git[/\\]/,              // .git 目录内部
    /[/\\]\.git$/,                   // .git 目录本身
    /[/\\]\.ssh[/\\]/,              // .ssh 目录
    /[/\\]\.env(\..+)?$/,           // 环境变量文件
    /[/\\]\.bashrc$/,               // bash 配置
    /[/\\]\.zshrc$/,                // zsh 配置
    /[/\\]\.profile$/,              // profile 文件
    /[/\\]id_rsa/,                  // SSH 私钥
    /[/\\]id_ed25519/,              // SSH 私钥
    /[/\\]id_dsa/,                  // SSH 私钥
    /[/\\]\.aws[/\\]/,              // AWS 配置
    /[/\\]\.npmrc$/,                // npm 配置（可能包含 token）
    /[/\\]\.docker[/\\]/,           // Docker 配置
    /[/\\]\.kube[/\\]/,             // Kubernetes 配置
    /[/\\]credentials/i,            // 凭证文件
    /[/\\]secrets?\./i,             // 秘密文件
    /[/\\]password/i,               // 密码文件
    /[/\\]\.pem$/,                  // PEM 密钥
    /[/\\]\.key$/,                  // 密钥文件
    /[/\\]\.crt$/,                  // 证书文件（谨慎）
];

/**
 * 文件读取限制配置
 */
export const FILE_READ_LIMITS: FileReadLimits = {
    maxFileSize: 10 * 1024 * 1024,      // 10MB
    maxLinesPerRead: 10000,
    maxBytesPerRead: 1 * 1024 * 1024,   // 1MB
    allowedExtensions: [
        // 代码文件
        '.c', '.cpp', '.h', '.hpp', '.ino', '.pde',
        '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
        '.py', '.java', '.go', '.rs', '.rb', '.php',
        '.swift', '.kt', '.kts', '.scala', '.clj',
        '.cs', '.vb', '.fs', '.lua', '.r', '.jl',
        '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
        
        // 配置文件
        '.json', '.yaml', '.yml', '.toml', '.xml',
        '.ini', '.cfg', '.conf', '.properties',
        '.eslintrc', '.prettierrc', '.babelrc',
        
        // 文档
        '.md', '.txt', '.rst', '.adoc', '.org',
        '.tex', '.rtf',
        
        // Web
        '.html', '.htm', '.css', '.scss', '.sass', '.less',
        '.vue', '.svelte', '.astro',
        
        // 数据
        '.csv', '.tsv',
        
        // 其他
        '.gitignore', '.dockerignore', '.editorconfig',
        '.makefile', 'Makefile', '.cmake',
    ],
    blockedExtensions: [
        // 密钥和证书
        '.key', '.pem', '.crt', '.cer', '.p12', '.pfx',
        '.jks', '.keystore',
        
        // 数据库
        '.db', '.sqlite', '.sqlite3', '.mdb', '.accdb',
        
        // 归档（可能包含敏感内容）
        '.zip', '.tar', '.gz', '.rar', '.7z',
        
        // 其他敏感
        '.wallet', '.dat',
    ]
};

/**
 * 文件写入限制配置
 */
export const FILE_WRITE_LIMITS: FileWriteLimits = {
    maxWriteSize: 5 * 1024 * 1024,      // 5MB
    createBackup: true,
    backupPrefix: 'ABIBAK_',
    blockedFileNames: [
        '.bashrc',
        '.zshrc',
        '.profile',
        '.bash_profile',
        '.env',
        '.env.local',
        '.env.production',
        '.npmrc',
        'id_rsa',
        'id_ed25519',
        'id_dsa',
        'known_hosts',
        'authorized_keys',
        'config',  // SSH config
        'credentials',
        'secrets',
    ],
    blockedDirectories: [
        '.git',
        '.ssh',
        '.gnupg',
        '.aws',
        'node_modules',     // 应通过 npm 管理
        '.npm',
        '.cache',
        '.docker',
    ]
};

/**
 * 资源限制配置
 */
export const RESOURCE_LIMITS: ResourceLimits = {
    maxFilesPerOperation: 100,
    maxDirectoryDepth: 10,
    maxConcurrentOperations: 5,
    maxSessionMemory: 512 * 1024 * 1024,  // 512MB
};

// ==================== 路径安全检查 ====================

/**
 * 规范化路径（解析为绝对路径）
 * 注意：返回的是系统原生格式路径，路径比较请使用 isPathInside
 */
export function normalizePath(inputPath: string): string {
    if (!inputPath) return '';
    
    // 使用 window.path.resolve 解析为绝对路径
    try {
        return window['path'].resolve(inputPath);
    } catch {
        // 降级处理：简单清理路径
        return inputPath.replace(/[\\/]+/g, '/');
    }
}

/**
 * 判断子路径是否在父路径内部（标准做法，自动处理分隔符）
 * 使用 path.relative 判断，无需手动处理分隔符差异
 */
export function isPathInside(childPath: string, parentPath: string): boolean {
    try {
        // 验证输入参数
        if (!childPath || !parentPath) {
            return false;
        }
        
        const resolvedChild = window['path'].resolve(childPath);
        const resolvedParent = window['path'].resolve(parentPath);
        const relative = window['path'].relative(resolvedParent, resolvedChild);
        
        // 如果相对路径以 '..' 开头或是绝对路径，则 child 不在 parent 内部
        const result = !relative.startsWith('..') && !window['path'].isAbsolute(relative);
        return result;
    } catch (error: any) {
        console.error(`[isPathInside] 异常: child="${childPath}", parent="${parentPath}"`, error);
        return false;
    }
}

/**
 * 检查路径是否包含路径穿越攻击
 * 如果路径不在基础目录内部，则认为存在路径穿越
 */
export function hasPathTraversal(inputPath: string, basePath: string): boolean {
    return !isPathInside(inputPath, basePath);
}

/**
 * 检查是否为敏感路径
 */
export function isSensitivePath(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath);
    
    return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

/**
 * 判断两个路径是否指向同一位置（自动处理分隔符和大小写）
 */
export function isSamePath(path1: string, path2: string): boolean {
    try {
        const resolved1 = window['path'].resolve(path1);
        const resolved2 = window['path'].resolve(path2);
        // Windows 不区分大小写，其他系统区分
        const isWindows = window['process']?.platform === 'win32' || /^[A-Za-z]:/.test(resolved1);
        if (isWindows) {
            return resolved1.toLowerCase() === resolved2.toLowerCase();
        }
        return resolved1 === resolved2;
    } catch {
        return false;
    }
}

/**
 * 检查是否为受保护的系统路径
 */
export function isProtectedSystemPath(filePath: string): boolean {
    const resolvedPath = normalizePath(filePath);
    const homedir = getHomedir();
    
    // 检查是否是根目录或系统关键目录
    for (const protectedPath of PROTECTED_PATHS) {
        // 绝对路径直接比较
        if (protectedPath.startsWith('/') || /^[A-Za-z]:/.test(protectedPath)) {
            if (isSamePath(resolvedPath, protectedPath)) {
                return true;
            }
        } else {
            // 相对于用户主目录的敏感路径
            const fullSensitivePath = window['path'].join(homedir, protectedPath);
            // 检查是否是该敏感路径或在其内部
            if (isSamePath(resolvedPath, fullSensitivePath) || isPathInside(resolvedPath, fullSensitivePath)) {
                return true;
            }
        }
    }
    
    return false;
}

/**
 * 检查路径是否在允许的目录范围内
 */
export function isPathAllowed(
    inputPath: string, 
    context: PathSecurityContext
): SecurityCheckResult {
    const normalizedInput = normalizePath(inputPath);
    
    // 1. 检查是否为受保护的系统路径
    if (isProtectedSystemPath(normalizedInput)) {
        return {
            allowed: false,
            reason: `禁止访问系统保护路径: ${inputPath}`,
            riskLevel: 'critical'
        };
    }
    
    // 2. 检查是否为敏感路径
    if (isSensitivePath(normalizedInput)) {
        return {
            allowed: false,
            reason: `禁止访问敏感路径: ${inputPath}`,
            riskLevel: 'high'
        };
    }
    
    // 2.5 检查是否在用户添加的额外允许路径中（这些是项目外部的独立目录）
    const additionalPaths = context.additionalAllowedPaths || [];
    let isInAdditionalPath = false;
    for (const additionalPath of additionalPaths) {
        if (additionalPath && (isPathInside(normalizedInput, additionalPath) || isSamePath(normalizedInput, additionalPath))) {
            isInAdditionalPath = true;
            break;
        }
    }
    
    // 2.6 特别检查 node_modules 目录访问权限（仅针对当前项目下的 node_modules）
    // 如果路径在用户添加的额外路径中，则跳过此检查
    if (context.nodeModulesPath && !isInAdditionalPath) {
        const isInNodeModules = isPathInside(normalizedInput, context.nodeModulesPath) || 
                                 isSamePath(normalizedInput, context.nodeModulesPath);
        if (isInNodeModules && !context.allowNodeModulesAccess) {
            return {
                allowed: false,
                reason: `禁止访问 node_modules 目录: ${inputPath}（未开启 node_modules 访问权限）`,
                riskLevel: 'medium'
            };
        }
    }
    
    // 3. 检查是否在允许的目录范围内（当前项目路径 + 用户添加的额外路径）
    const rawAllowedBases = [
        context.allowProjectPathAccess ? context.currentProjectPath : undefined,
        // librariesPath 是项目路径的子目录，同样需要受 allowProjectPathAccess 控制
        context.allowProjectPathAccess ? context.librariesPath : undefined,
        // 只有开启了 allowNodeModulesAccess 才将 nodeModulesPath 加入允许列表
        context.allowNodeModulesAccess ? context.nodeModulesPath : undefined,
        getTempDir(),  // 临时目录
        ...(context.additionalAllowedPaths || []),  // 用户添加的额外允许路径
    ];
    
    const allowedBases = rawAllowedBases.filter(Boolean) as string[];
    
    let isInAllowedPath = false;
    
    for (const base of allowedBases) {
        if (!base) continue;
        
        // 使用 isPathInside 判断路径包含关系（自动处理分隔符和路径穿越）
        const inside = isPathInside(normalizedInput, base);
        if (inside) {
            isInAllowedPath = true;
            break;
        }
    }
    
    if (!isInAllowedPath) {
        return {
            allowed: false,
            reason: `路径不在允许的目录范围内: ${inputPath}`,
            riskLevel: 'medium'
        };
    }
    
    return { allowed: true };
}

/**
 * 检查是否为关键删除目标（禁止删除）
 */
export function isCriticalRemovalTarget(
    absPath: string, 
    context: PathSecurityContext
): SecurityCheckResult {
    const resolvedPath = normalizePath(absPath);
    const homedir = getHomedir();
    
    // 禁止删除根目录
    if (resolvedPath === '/' || /^[A-Za-z]:[\\/]?$/.test(resolvedPath)) {
        return {
            allowed: false,
            reason: '禁止删除根目录',
            riskLevel: 'critical'
        };
    }
    
    // 禁止删除用户主目录
    if (isSamePath(resolvedPath, homedir)) {
        return {
            allowed: false,
            reason: '禁止删除用户主目录',
            riskLevel: 'critical'
        };
    }
    
    // 禁止删除当前项目目录本身
    if (context.currentProjectPath && isSamePath(resolvedPath, context.currentProjectPath)) {
        return {
            allowed: false,
            reason: '禁止删除当前项目目录',
            riskLevel: 'critical'
        };
    }
    
    // 禁止删除顶级系统目录
    const parentDir = window['path'].dirname(resolvedPath);
    if (parentDir === '/' || /^[A-Za-z]:[\\/]?$/.test(parentDir)) {
        return {
            allowed: false,
            reason: '禁止删除顶级系统目录',
            riskLevel: 'critical'
        };
    }
    
    return { allowed: true };
}

// ==================== 文件扩展名检查 ====================

/**
 * 获取文件扩展名
 */
export function getFileExtension(filePath: string): string {
    const ext = window['path'].extname(filePath).toLowerCase();
    return ext;
}

/**
 * 检查文件是否允许读取
 */
export function isFileReadAllowed(filePath: string): SecurityCheckResult {
    const ext = getFileExtension(filePath);
    const fileName = window['path'].basename(filePath).toLowerCase();
    
    // 检查是否为禁止的扩展名
    if (FILE_READ_LIMITS.blockedExtensions.includes(ext)) {
        return {
            allowed: false,
            reason: `禁止读取此类型文件: ${ext}`,
            riskLevel: 'medium'
        };
    }
    
    // 如果有扩展名，检查是否在允许列表中
    // 对于无扩展名的文件，需要额外谨慎
    if (!ext && !fileName.startsWith('.')) {
        // 无扩展名且不是以点开头的隐藏文件
        // 允许，但可能需要额外检查
    }
    
    return { allowed: true };
}

/**
 * 检查文件是否允许写入
 */
export function isFileWriteAllowed(filePath: string): SecurityCheckResult {
    const fileName = window['path'].basename(filePath).toLowerCase();
    const dirName = window['path'].dirname(filePath);
    
    // 检查是否为禁止创建的文件名
    for (const blocked of FILE_WRITE_LIMITS.blockedFileNames) {
        if (fileName === blocked.toLowerCase() || fileName.endsWith(blocked.toLowerCase())) {
            return {
                allowed: false,
                reason: `禁止创建此文件: ${fileName}`,
                riskLevel: 'high'
            };
        }
    }
    
    // 检查是否在禁止写入的目录
    for (const blockedDir of FILE_WRITE_LIMITS.blockedDirectories) {
        const pattern = new RegExp(`[/\\\\]${blockedDir}([/\\\\]|$)`, 'i');
        if (pattern.test(filePath)) {
            return {
                allowed: false,
                reason: `禁止写入此目录: ${blockedDir}`,
                riskLevel: 'medium'
            };
        }
    }
    
    return { allowed: true };
}

// ==================== 综合安全验证 ====================

/**
 * 验证文件读取操作的安全性
 */
export function validateFileRead(
    filePath: string,
    context: PathSecurityContext,
    fileSize?: number
): SecurityCheckResult {
    // 1. 文件类型检查
    const typeCheck = isFileReadAllowed(filePath);
    if (!typeCheck.allowed) {
        return typeCheck;
    }
    
    // 2. 文件大小检查
    if (fileSize !== undefined && fileSize > FILE_READ_LIMITS.maxFileSize) {
        return {
            allowed: false,
            reason: `文件过大 (${(fileSize / 1024 / 1024).toFixed(2)}MB)，超过限制 (${FILE_READ_LIMITS.maxFileSize / 1024 / 1024}MB)`,
            riskLevel: 'low'
        };
    }
    
    return { allowed: true };
}

/**
 * 验证文件写入操作的安全性
 */
export function validateFileWrite(
    filePath: string,
    context: PathSecurityContext,
    contentSize?: number
): SecurityCheckResult {
    // 1. 路径安全检查
    const pathCheck = isPathAllowed(filePath, context);
    if (!pathCheck.allowed) {
        return pathCheck;
    }
    
    // 2. 文件类型检查
    const typeCheck = isFileWriteAllowed(filePath);
    if (!typeCheck.allowed) {
        return typeCheck;
    }
    
    // 3. 写入大小检查
    if (contentSize !== undefined && contentSize > FILE_WRITE_LIMITS.maxWriteSize) {
        return {
            allowed: false,
            reason: `写入内容过大 (${(contentSize / 1024 / 1024).toFixed(2)}MB)，超过限制 (${FILE_WRITE_LIMITS.maxWriteSize / 1024 / 1024}MB)`,
            riskLevel: 'low'
        };
    }
    
    return { allowed: true };
}

/**
 * 验证文件删除操作的安全性
 */
export function validateFileDelete(
    filePath: string,
    context: PathSecurityContext
): SecurityCheckResult {
    // 1. 路径安全检查
    const pathCheck = isPathAllowed(filePath, context);
    if (!pathCheck.allowed) {
        return pathCheck;
    }
    
    // 2. 关键目标检查
    const criticalCheck = isCriticalRemovalTarget(filePath, context);
    if (!criticalCheck.allowed) {
        return criticalCheck;
    }
    
    return { allowed: true };
}

/**
 * 验证目录操作的安全性
 */
export function validateDirectoryOperation(
    dirPath: string,
    context: PathSecurityContext,
    operation: 'read' | 'create' | 'delete'
): SecurityCheckResult {
    // 1. 路径安全检查
    const pathCheck = isPathAllowed(dirPath, context);
    if (!pathCheck.allowed) {
        return pathCheck;
    }
    
    // 2. 删除操作的特殊检查
    if (operation === 'delete') {
        const criticalCheck = isCriticalRemovalTarget(dirPath, context);
        if (!criticalCheck.allowed) {
            return criticalCheck;
        }
    }
    
    return { allowed: true };
}

// ==================== 辅助函数 ====================

/**
 * 获取用户主目录
 */
export function getHomedir(): string {
    try {
        if (typeof window !== 'undefined' && window['os']?.homedir) {
            return window['os'].homedir();
        }
        // 降级处理
        return process.env['HOME'] || process.env['USERPROFILE'] || '';
    } catch {
        return '';
    }
}

/**
 * 获取临时目录
 */
export function getTempDir(): string {
    try {
        if (typeof window !== 'undefined' && window['os']?.tmpdir) {
            const tmpDir = window['os'].tmpdir();
            return tmpDir;
        }
        // 降级处理：Windows 优先使用 TEMP/TMP 环境变量
        const tempDir = window['env'].get('TEMP') || window['env'].get('TMP') || '/tmp';
        return tempDir;
    } catch (error) {
        console.error('[getTempDir] 异常:', error);
        return '/tmp';
    }
}

/**
 * 敏感数据脱敏
 */
export function sanitizeForLogging(data: any): any {
    const sensitiveFields = [
        'password',
        'passwd',
        'pwd',
        'apiKey',
        'api_key',
        'apikey',
        'token',
        'accessToken',
        'access_token',
        'refreshToken',
        'refresh_token',
        'secret',
        'secretKey',
        'secret_key',
        'credential',
        'credentials',
        'private_key',
        'privateKey',
        'auth',
        'authorization',
        'bearer',
    ];
    
    if (data === null || data === undefined) {
        return data;
    }
    
    if (typeof data === 'string') {
        // 检查是否像是敏感数据（长随机字符串）
        if (data.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(data)) {
            return '***POSSIBLY_SENSITIVE***';
        }
        return data;
    }
    
    if (typeof data !== 'object') {
        return data;
    }
    
    if (Array.isArray(data)) {
        return data.map(item => sanitizeForLogging(item));
    }
    
    const sanitized = { ...data };
    for (const key of Object.keys(sanitized)) {
        const lowerKey = key.toLowerCase();
        if (sensitiveFields.some(field => lowerKey.includes(field.toLowerCase()))) {
            sanitized[key] = '***REDACTED***';
        } else if (typeof sanitized[key] === 'object') {
            sanitized[key] = sanitizeForLogging(sanitized[key]);
        }
    }
    
    return sanitized;
}

/**
 * 安全上下文创建选项
 */
export interface SecurityContextOptions {
    /** 项目根路径 */
    projectRootPath?: string;
    /** 当前项目路径 */
    currentProjectPath?: string;
    /** 应用数据路径 */
    appDataPath?: string;
    /** 额外允许的路径列表（如用户添加的上下文文件/文件夹） */
    additionalAllowedPaths?: string[];
    /** 是否允许访问库文件（默认 true） */
    includeLibraries?: boolean;
}

/**
 * 创建安全上下文
 * @param currentProjectPath 当前项目路径
 * @param options 可选配置项
 * @param options.allowProjectPathAccess 是否允许操作当前项目路径，默认 false
 * @param options.nodeModulesPath 当前项目下的 node_modules 目录路径
 * @param options.allowNodeModulesAccess 是否允许操作 node_modules 目录，默认 false
 * @param options.additionalAllowedPaths 额外允许的路径列表（如用户添加的上下文文件/文件夹）
 */
export function createSecurityContext(
    currentProjectPath: string,
    options?: {
        nodeModulesPath?: string;
        allowProjectPathAccess?: boolean;
        allowNodeModulesAccess?: boolean;
        additionalAllowedPaths?: string[];
    }
): PathSecurityContext {
    const opts = options || {};
    return {
        currentProjectPath,
        librariesPath: currentProjectPath ? window['path']?.join(currentProjectPath, 'libraries') : undefined,
        nodeModulesPath: opts.nodeModulesPath ?? (currentProjectPath ? window['path']?.join(currentProjectPath, 'node_modules') : undefined),
        allowProjectPathAccess: opts.allowProjectPathAccess ?? false,
        allowNodeModulesAccess: opts.allowNodeModulesAccess ?? false,
        additionalAllowedPaths: opts.additionalAllowedPaths || []
    };
}

// ==================== 导出类型和常量 ====================

export const SecurityService = {
    // 路径检查
    normalizePath,
    isPathInside,
    isSamePath,
    hasPathTraversal,
    isSensitivePath,
    isProtectedSystemPath,
    isPathAllowed,
    isCriticalRemovalTarget,
    
    // 文件检查
    getFileExtension,
    isFileReadAllowed,
    isFileWriteAllowed,
    
    // 综合验证
    validateFileRead,
    validateFileWrite,
    validateFileDelete,
    validateDirectoryOperation,
    
    // 辅助
    getHomedir,
    getTempDir,
    sanitizeForLogging,
    createSecurityContext,
    
    // 配置
    FILE_READ_LIMITS,
    FILE_WRITE_LIMITS,
    RESOURCE_LIMITS,
};

export default SecurityService;
