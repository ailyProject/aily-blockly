const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ailyCodeProject = require('./aily-code-project');

// 简单的日志工具
const logger = {
    log: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
};

function formatFatalError(error) {
    if (!error) return 'Unknown error';
    if (error instanceof Error) {
        return error.stack || error.message;
    }
    return String(error);
}

function exitWithFatalError(error) {
    logger.error(`[ERROR] ${formatFatalError(error)}`);
    process.exit(1);
}

process.on('uncaughtException', (error) => {
    exitWithFatalError(error);
});

process.on('unhandledRejection', (reason) => {
    exitWithFatalError(reason);
});

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        logger.error('Usage: node compile.js <config-path>');
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
        boardModule,
        code,
        ailyBuilderPath
    } = config;

    // 辅助函数：递归创建目录
    function mkdirp(dir) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    try {
        // 1. 路径准备（Aily Code 编译入口见 project.aci.entry，产物输出到 .aily/build/<framework>）
        const tempPath = path.join(currentProjectPath, '.temp');
        const sketchPath = path.join(tempPath, 'sketch');
        const sketchFilePath = path.join(sketchPath, 'sketch.ino');
        const isAilyCode = ailyCodeProject.isAilyCodeProjectRoot(currentProjectPath);
        const compileSourcePath = isAilyCode
            ? ailyCodeProject.resolveCompileSourcePath(currentProjectPath)
            : sketchFilePath;
        const preprocessCachePath = path.join(tempPath, 'preprocess.json');
        let frameworkOutputDir = null;
        if (isAilyCode) {
            frameworkOutputDir = ailyCodeProject.resolveFrameworkBuildDir(currentProjectPath);
        }

        // 2. 确保目录存在并写入最新 Blockly 生成的代码（与 preprocess 同源路径）
        mkdirp(tempPath);
        mkdirp(sketchPath);
        mkdirp(path.dirname(compileSourcePath));
        fs.writeFileSync(compileSourcePath, code);

        // 纯 Blockly 仍会写 sketch.ino，便于与其它工具对齐；Aily Code 仅以 entry 为准
        if (!isAilyCode) {
            fs.writeFileSync(sketchFilePath, code);
        }

        // 输出目录就绪（upload / getBuildPath 与此一致）
        if (frameworkOutputDir) {
            mkdirp(frameworkOutputDir);
        }

        // 3. 检查预编译缓存是否存在
        if (!fs.existsSync(preprocessCachePath)) {
            throw new Error(`未找到预编译缓存: ${preprocessCachePath}，请先运行预处理脚本`);
        }

        // 3. 读取板子信息获取boardType
        const boardModulePath = path.join(currentProjectPath, 'node_modules', boardModule);
        const boardJsonPath = path.join(boardModulePath, 'board.json');

        if (!fs.existsSync(boardJsonPath)) {
            throw new Error(`未找到板子配置文件: ${boardJsonPath}`);
        }
        const boardJson = JSON.parse(fs.readFileSync(boardJsonPath, 'utf8'));

        // 4. 获取编译命令中的boardType
        let compilerParam = boardJson.compilerParam;
        if (!compilerParam) {
            throw new Error('未找到编译命令(compilerParam)');
        }

        let compilerParamList = compilerParam.split(' ');
        let boardType = "";

        for (let i = 0; i < compilerParamList.length; i++) {
            if (compilerParamList[i] === '-b' || compilerParamList[i] === '--board') {
                if (i + 1 < compilerParamList.length) {
                    boardType = compilerParamList[i + 1];
                    break;
                }
            }
        }

        if (!boardType) {
            throw new Error('未找到板子类型(boardType)');
        }

        // 5. 执行编译；Aily Code 时将 AILY_BUILDER_BUILD_PATH 指到 `.aily/build/<framework>`，
        // 与 Electron 全局行为一致（aily-builder 可能在其下再分子目录，upload 递归查找固件）。
        const args = [
            `"${path.join(ailyBuilderPath, 'index.js')}"`,
            'compile',
            `"${compileSourcePath}"`,
            '--board', `"${boardType}"`,
            '--preprocess-result', `"${preprocessCachePath}"`,
        ];

        logger.log(`执行编译: node ${args.join(' ')}`);

        /** @type {{ cwd: string, shell: boolean, stdio: string[], env?: NodeJS.ProcessEnv }} */
        const spawnOpts = {
            cwd: currentProjectPath,
            shell: true,
            stdio: 'inherit'
        };

        if (frameworkOutputDir) {
            spawnOpts.env = {
                ...process.env,
                AILY_BUILDER_BUILD_PATH: frameworkOutputDir
            };
        }

        const child = spawn('node', args, spawnOpts);

        child.on('close', (code, signal) => {
            if (signal) {
                logger.error(`[ERROR] 编译进程被信号终止: ${signal}`);
                process.exit(1);
                return;
            }

            if (code !== 0) {
                logger.error(`[ERROR] 编译进程异常退出，退出码: ${code}`);
                process.exit(code || 1);
                return;
            }

            logger.log('编译完成');
            process.exit(0);
        });

    } catch (error) {
        logger.error(`[ERROR] ${error.message}`);
        process.exit(1);
    }
}

main().catch(e => {
    exitWithFatalError(e);
});
