const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');

// 简单的日志工具
const logger = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        logger.error('Usage: node upload.js <config-path>');
        process.exit(1);
    }

    let config;
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        logger.error('Failed to read config file:', error);
        process.exit(1);
    }

    const {
        currentProjectPath,
        buildPath,
        boardModule,
        appDataPath,
        serialPort: initialSerialPort,
        uploadParam: configUploadParam
    } = config;

    // console.log('上传配置:', {
    //     currentProjectPath,
    //     buildPath,
    //     boardModule,
    //     appDataPath,
    //     serialPort: initialSerialPort,
    //     uploadParam: configUploadParam
    // });

    try {
        // 1. 路径准备
        const tempPath = path.join(currentProjectPath, '.temp');
        // const buildPath = path.join(tempPath, 'build');
        const compilerPath = path.join(appDataPath, 'compiler');
        const sdkPath = path.join(appDataPath, 'sdk');
        const toolsPath = path.join(appDataPath, 'tools');

        // 2. 读取项目信息
        const projectPackageJsonPath = path.join(currentProjectPath, 'package.json');
        if (!fs.existsSync(projectPackageJsonPath)) {
            throw new Error(`未找到项目包文件: ${projectPackageJsonPath}`);
        }
        const projectPackageJson = JSON.parse(fs.readFileSync(projectPackageJsonPath, 'utf8'));
        const projectConfig = projectPackageJson.aily || {};

        // 3. 读取板子信息
        const boardModulePath = path.join(currentProjectPath, 'node_modules', boardModule);
        const boardJsonPath = path.join(boardModulePath, 'board.json');
        const boardPackageJsonPath = path.join(boardModulePath, 'package.json');

        if (!fs.existsSync(boardJsonPath)) {
            throw new Error(`未找到板子配置文件: ${boardJsonPath}`);
        }
        const boardJson = JSON.parse(fs.readFileSync(boardJsonPath, 'utf8'));

        if (!fs.existsSync(boardPackageJsonPath)) {
            throw new Error(`未找到板子包文件: ${boardPackageJsonPath}`);
        }
        const boardPackageJson = JSON.parse(fs.readFileSync(boardPackageJsonPath, 'utf8'));
        const boardDependencies = boardPackageJson.boardDependencies || {};

        // 4. 获取上传参数（优先使用配置中已清理的参数）
        let uploadParam = configUploadParam || boardJson.uploadParam;
        if (!uploadParam) {
            throw new Error('未找到上传参数(uploadParam)');
        }

        // 去掉末尾的分号
        uploadParam = uploadParam.trim().replace(/;+$/, '');

        logger.log('使用的上传参数:', uploadParam);

        // 6. 获取波特率
        const baudRate = projectConfig?.UploadSpeed || '115200';

        // 7. 获取工具依赖
        const toolDependencies = {};
        Object.entries(boardDependencies || {})
            .filter(([key, value]) => key.startsWith('tool-') || key.startsWith('@aily-project/tool-'))
            .forEach(([key, value]) => {
                let name = key;
                const prefixAily = '@aily-project/tool-';
                const prefixTool = 'tool-';
                if (name.startsWith(prefixAily)) {
                    name = name.slice(prefixAily.length);
                } else if (name.startsWith(prefixTool)) {
                    name = name.slice(prefixTool.length);
                }
                toolDependencies[name] = value;
            });

        // 8. 获取SDK路径
        let fullSdkPath = '';
        Object.entries(boardDependencies || {}).forEach(([key, version]) => {
            if (key.startsWith('@aily-project/sdk-')) {
                const sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
                fullSdkPath = path.join(sdkPath, sdk);
            }
        });

        // 9. 使用传入的串口（已在调用前预处理）
        let finalSerialPort = initialSerialPort;
        logger.log('使用串口:', finalSerialPort);

        // 10. 处理上传参数
        const platform = os.platform() === 'win32' ? 'win32' : (os.platform() === 'darwin' ? 'darwin' : 'linux');
        
        const { command, args } = await processUploadParams(
            uploadParam,
            buildPath,
            toolsPath,
            fullSdkPath,
            baudRate,
            toolDependencies,
            finalSerialPort,
            platform
        );

        logger.log(`Executing: ${command} ${args.join(' ')}`);

        // 11. 执行上传命令
        const child = spawn(command, args, {
            cwd: buildPath,
            shell: true,
            stdio: 'inherit'
        });

        child.on('close', (code) => {
            if (code !== 0) {
                process.exit(code);
            } else {
                process.exit(0);
            }
        });

    } catch (error) {
        logger.error(`[ERROR] ${error.message}`);
        process.exit(1);
    }
}

async function processUploadParams(uploadParam, buildPath, toolsPath, sdkPath, baudRate, toolDependencies, serialPort, platform) {
    // 1. 基础变量替换
    let paramString = uploadParam;
    
    // 替换 ${baud}
    if (paramString.includes('${baud}')) {
        paramString = paramString.replace(/\$\{baud\}/g, baudRate || '115200');
    }

    // 替换 ${serial}
    if (paramString.includes('${serial}')) {
        paramString = paramString.replace(/\$\{serial\}/g, serialPort);
    }

    // 替换 ${boot_app0}
    if (paramString.includes('${boot_app0}')) {
        paramString = paramString.replace(/\$\{boot_app0\}/g, `"${path.join(sdkPath, 'tools', 'partitions', 'boot_app0.bin')}"`);
    }

    // 替换 ${bootloader}
    if (paramString.includes('${bootloader}')) {
        const bootLoaderFile = await findFile(buildPath, '*.bootloader.bin');
        paramString = paramString.replace(/\$\{bootloader\}/g, `"${bootLoaderFile}"`);
    }

    // 替换 ${partitions}
    if (paramString.includes('${partitions}')) {
        const partitionsFile = await findFile(buildPath, '*.partitions.bin');
        paramString = paramString.replace(/\$\{partitions\}/g, `"${partitionsFile}"`);
    }

    // 分割参数
    let paramList = parseArgs(paramString);

    // 2. 查找工具可执行文件
    const toolName = paramList[0];
    let toolVersion = toolDependencies[toolName];
    
    if (!toolVersion) {
        // 模糊匹配
        const matchedTool = Object.keys(toolDependencies).find(key => {
            return key.toLowerCase().includes(toolName.toLowerCase());
        });
        if (matchedTool) {
            toolVersion = toolDependencies[matchedTool];
        }
    }

    const isWindows = platform === 'win32';
    const toolFileName = toolName + (isWindows ? '.exe' : '');
    
    let commandPath = await findFile(toolsPath, toolFileName, toolVersion);
    // console.log("Command Path: ", commandPath);
    
    if (!commandPath) {
        throw new Error(`无法找到可执行文件: ${toolFileName}`);
    }

    // 3. 处理 ${'filename'} 格式的文件路径参数
    for (let i = 1; i < paramList.length; i++) {
        const param = paramList[i];
        const match = param.match(/\$\{\'(.+?)\'\}/);
        
        if (match) {
            const fileName = match[1];
            const ext = path.extname(fileName).toLowerCase().replace('.', '');
            
            let findRes = '';
            
            if (!['bin', 'elf', 'hex', 'eep', 'img', 'uf2'].includes(ext)) {
                findRes = await findFile(toolsPath, fileName);
                if (!findRes) {
                    findRes = await findFile(path.join(sdkPath, 'tools'), fileName);
                }
            } else {
                // console.log('Searching build path for file:', buildPath, fileName);
                findRes = await findFile(buildPath, fileName);
            }

            if (findRes) {
                paramList[i] = param.replace(`\$\{\'${fileName}\'\}`, `"${findRes}"`);
            } else {
                logger.warn(`无法找到文件: ${fileName}`);
            }
        }
    }

    return {
        command: commandPath,
        args: paramList.slice(1)
    };
}

// 简单的参数解析，处理引号
function parseArgs(str) {
    const args = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '"') {
            inQuote = !inQuote;
            // current += char; // 保留引号? 通常spawn不需要引号包裹参数，除非是参数内容的一部分
        } else if (char === ' ' && !inQuote) {
            if (current) {
                args.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current) args.push(current);
    return args;
}

// 递归查找文件
async function findFile(basePath, pattern, version = '') {
    if (!fs.existsSync(basePath)) return '';

    const files = await findFilesRecursive(basePath);
    
    let matchedFiles = [];
    
    if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
        matchedFiles = files.filter(f => regex.test(path.basename(f)));
    } else {
        matchedFiles = files.filter(f => path.basename(f) === pattern);
    }

    if (matchedFiles.length === 0) return '';

    if (version && matchedFiles.length > 1) {
        const versionMatched = matchedFiles.find(f => f.includes(version));
        if (versionMatched) return versionMatched;
    }

    // 优先返回路径最短的，或者按某种规则排序
    return matchedFiles[0];
}

async function findFilesRecursive(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(await findFilesRecursive(filePath));
        } else {
            results.push(filePath);
        }
    }
    return results;
}

main().catch(e => {
    logger.error(e);
    process.exit(1);
});
