// 导入 glob 同步方法
let globSync;
try {
    const globModule = require('glob');
    globSync = globModule.globSync || globModule.sync;
    
    if (!globSync) {
        throw new Error('无法找到 glob 同步方法');
    }
} catch (error) {
    console.error('无法导入 glob 模块:', error.message);
    console.log('请安装 glob: npm install glob');
    process.exit(1);
}

const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { createHash } = require('crypto');

/**
 * 文件查找器类
 * 使用 glob 在指定路径下递归查找文件
 */
class FileFinder {
    constructor() {
        this.defaultOptions = {
            dot: false,          // 不包含隐藏文件
            ignore: [            // 忽略的文件夹
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**'
            ]
        };
    }

    /**
     * 在指定路径下查找文件
     * @param {string} searchPath - 搜索路径
     * @param {string} pattern - 搜索模式（支持 glob 语法）
     * @param {Object} options - 可选配置
     * @returns {Array} 匹配的文件路径数组
     */
    findFiles(searchPath, pattern, options = {}) {
        try {
            // 验证搜索路径是否存在
            if (!fs.existsSync(searchPath)) {
                throw new Error(`搜索路径不存在: ${searchPath}`);
            }

            // 合并配置选项
            const mergedOptions = {
                ...this.defaultOptions,
                ...options,
                cwd: searchPath,  // 设置工作目录
                absolute: true    // 返回绝对路径
            };

            // 构建搜索模式，确保递归搜索所有子文件夹
            const searchPattern = pattern.startsWith('**/') ? pattern : `**/${pattern}`;

            // 执行搜索
            const matches = globSync(searchPattern, mergedOptions) || [];

            // 过滤结果，确保只返回文件（不包含文件夹）
            const files = [];
            for (const match of matches) {
                try {
                    const stat = fs.statSync(match);
                    if (stat.isFile()) {
                        files.push(match);
                    }
                } catch (statError) {
                    console.warn(`无法获取文件状态 ${match}:`, statError.message);
                }
            }

            return files;
        } catch (error) {
            console.error('文件搜索出错:', error.message);
            throw error;
        }
    }

    /**
     * 查找特定扩展名的文件
     * @param {string} searchPath - 搜索路径
     * @param {string|Array} extensions - 文件扩展名（如 '.js' 或 ['.js', '.ts']）
     * @param {Object} options - 可选配置
     * @returns {Array} 匹配的文件路径数组
     */
    findFilesByExtension(searchPath, extensions, options = {}) {
        // 统一处理扩展名格式
        const exts = Array.isArray(extensions) ? extensions : [extensions];
        const normalizedExts = exts.map(ext => ext.startsWith('.') ? ext : `.${ext}`);

        let pattern;
        if (normalizedExts.length === 1) {
            pattern = `**/*${normalizedExts[0]}`;
        } else {
            // 支持多个扩展名
            const extPattern = normalizedExts.map(ext => ext.slice(1)).join(',');
            pattern = `**/*.{${extPattern}}`;
        }

        return this.findFiles(searchPath, pattern, options);
    }

    /**
     * 根据文件名查找文件（支持模糊匹配）
     * @param {string} searchPath - 搜索路径
     * @param {string} fileName - 文件名（支持通配符）
     * @param {Object} options - 可选配置
     * @returns {Array} 匹配的文件路径数组
     */
    findFilesByName(searchPath, fileName, options = {}) {
        const pattern = `**/*${fileName}*`;
        return this.findFiles(searchPath, pattern, options);
    }

    /**
     * 查找包含特定内容的文件
     * @param {string} searchPath - 搜索路径
     * @param {string} pattern - 文件名模式
     * @param {string} content - 要搜索的内容
     * @param {Object} options - 可选配置
     * @returns {Array} 包含指定内容的文件路径数组
     */
    findFilesWithContent(searchPath, pattern, content, options = {}) {
        const files = this.findFiles(searchPath, pattern, options);
        const matchingFiles = [];

        for (const file of files) {
            try {
                const fileContent = fs.readFileSync(file, 'utf8');
                if (fileContent.includes(content)) {
                    matchingFiles.push(file);
                }
            } catch (error) {
                console.warn(`无法读取文件 ${file}:`, error.message);
            }
        }

        return matchingFiles;
    }

    /**
     * 获取目录统计信息
     * @param {string} searchPath - 搜索路径
     * @param {Object} options - 可选配置
     * @returns {Object} 目录统计信息
     */
    getDirectoryStats(searchPath, options = {}) {
        const allFiles = this.findFiles(searchPath, '**/*', options);
        
        const stats = {
            totalFiles: allFiles.length,
            fileTypes: {},
            totalSize: 0
        };

        for (const file of allFiles) {
            try {
                const stat = fs.statSync(file);
                const ext = path.extname(file).toLowerCase() || '无扩展名';
                
                stats.fileTypes[ext] = (stats.fileTypes[ext] || 0) + 1;
                stats.totalSize += stat.size;
            } catch (error) {
                console.warn(`无法获取文件状态 ${file}:`, error.message);
            }
        }

        return stats;
    }
}

/**
 * 计算文本的MD5值
 * @param text 要计算MD5的文本
 * @returns MD5哈希值（32位十六进制字符串）
 */
function calculateMD5(text) {
    return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * 计算Buffer的MD5值
 * @param buffer 要计算MD5的Buffer
 * @returns MD5哈希值（32位十六进制字符串）
 */
function calculateMD5FromBuffer(buffer) {
    return createHash('md5').update(buffer).digest('hex');
}

/**
 * 计算文件内容的MD5值
 * @param content 文件内容（字符串或Buffer）
 * @returns MD5哈希值（32位十六进制字符串）
 */
function calculateContentMD5(content) {
    if (typeof content === 'string') {
        return calculateMD5(content);
    }
    return calculateMD5FromBuffer(content);
}


function registerToolsHandlers(mainWindow) {
    // 注册文件查找相关的 IPC 处理器
    ipcMain.handle("find-file", async (event, searchPath, fileName) => {
        try {
            const finder = new FileFinder();
            const files = finder.findFilesByName(searchPath, fileName);
            return files;
        } catch (error) {
            console.error('文件查找失败:', error);
            throw error;
        }
    });

    // 注册按扩展名查找文件的处理器
    ipcMain.handle("find-files-by-extension", async (event, options) => {
        try {
            const finder = new FileFinder();
            const files = finder.findFilesByExtension(options.searchPath, options.extensions, options.options);
            return files;
        } catch (error) {
            console.error('按扩展名查找文件失败:', error);
            throw error;
        }
    });

    // 注册查找包含特定内容的文件的处理器
    ipcMain.handle("find-files-with-content", async (event, options) => {
        try {
            const finder = new FileFinder();
            const files = finder.findFilesWithContent(options.searchPath, options.pattern, options.content, options.options);
            return files;
        } catch (error) {
            console.error('查找包含内容的文件失败:', error);
            throw error;
        }
    });

    // 注册获取目录统计信息的处理器
    ipcMain.handle("get-directory-stats", async (event, options) => {
        try {
            const finder = new FileFinder();
            const stats = finder.getDirectoryStats(options.searchPath, options.options);
            return stats;
        } catch (error) {
            console.error('获取目录统计信息失败:', error);
            throw error;
        }
    });

    // 注册计算文本MD5的处理器
    ipcMain.handle("calculate-md5", async (event, text) => {
        try {
            return calculateMD5(text);
        } catch (error) {
            console.error('计算文本MD5失败:', error);
            throw error;
        }
    });
}


// 导出模块
module.exports = {
    registerToolsHandlers,
    FileFinder  // 也导出类，以便其他地方直接使用
};