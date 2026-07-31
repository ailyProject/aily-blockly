const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
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

function isDevelopmentEnvironment() {
    return process.env.DEV === 'true' || process.env.DEV === '1';
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
        code
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
        const buildPath = path.join(currentProjectPath, '.build');
        const blockSourceMapPath = path.join(
            buildPath,
            'aily-block-source-map.json'
        );
        const builderCompileReportPath = path.join(
            buildPath,
            'aily-builder-compile-report.json'
        );
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
        copyProjectSrcToSketch(currentProjectPath, sketchPath);

        // 纯 Blockly 仍会写 sketch.ino，便于与其它工具对齐；Aily Code 仅以 entry 为准
        if (!isAilyCode) {
            fs.writeFileSync(sketchFilePath, code);
        }

        // Never let a previous build's Blockly mapping survive a source change.
        // The Builder independently verifies all source metadata before adding
        // this file to the simulation Artifact.
        fs.rmSync(blockSourceMapPath, { force: true });
        fs.rmSync(builderCompileReportPath, { force: true });
        if (!isAilyCode && Array.isArray(config.blockSourceMappings)) {
            mkdirp(buildPath);
            const sourceBytes = Buffer.from(code, 'utf8');
            const sourceMap = {
                schemaVersion: 1,
                kind: 'aily-block-source-map',
                source: {
                    path: path.basename(sketchFilePath),
                    sizeBytes: sourceBytes.length,
                    sha256: crypto
                        .createHash('sha256')
                        .update(sourceBytes)
                        .digest('hex')
                },
                mappings: normalizeBlockSourceMappings(
                    config.blockSourceMappings
                )
            };
            fs.writeFileSync(
                blockSourceMapPath,
                `${JSON.stringify(sourceMap, null, 2)}\n`,
                'utf8'
            );
        }

        // 输出目录就绪（upload / getBuildPath 与此一致）
        if (frameworkOutputDir) {
            mkdirp(frameworkOutputDir);
        }

        // 3. 检查预编译缓存是否存在
        if (!fs.existsSync(preprocessCachePath)) {
            throw new Error(`未找到预编译缓存: ${preprocessCachePath}，请先运行预处理脚本`);
        }
        syncPreprocessBuildPath(preprocessCachePath, buildPath);

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

        // 5. 执行编译
        const builderCommand = 'aily-builder';
        const args = [
            'compile',
            `"${compileSourcePath}"`,
            '--board', `"${boardType}"`,
            '--build-path', `"${buildPath}"`,
            '--preprocess-result', `"${preprocessCachePath}"`,
        ];
        if (supportsArtifactManifest(builderCommand)) {
            args.push(
                '--emit-artifact-manifest',
                `"${path.join(buildPath, 'aily-artifact-manifest.json')}"`
            );
            if (config.graphSemanticRevision !== undefined) {
                if (!/^[a-f0-9]{64}$/.test(config.graphSemanticRevision)) {
                    throw new Error('graphSemanticRevision 必须是小写 SHA-256。');
                }
                if (!supportsSceneGraphProvenance(builderCommand)) {
                    throw new Error(
                        '当前 aily-builder 不支持 Scene graph provenance，'
                        + '不能生成可替换的仿真 Artifact。'
                    );
                }
                args.push(
                    '--graph-semantic-revision',
                    config.graphSemanticRevision
                );
            }
        } else {
            logger.warn(
                '当前 aily-builder 不支持仿真 Artifact 输出；'
                + '普通编译继续执行，仿真前请升级 aily-builder。'
            );
        }

        if (isDevelopmentEnvironment() || process.env.AILY_E2E === '1') {
            args.push('--generate-archive-cloud-cache');
        }

        /** @type {{ cwd: string, shell: boolean, stdio: string[], env?: NodeJS.ProcessEnv }} */
        const spawnOpts = {
            cwd: currentProjectPath,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        };

        if (frameworkOutputDir) {
            spawnOpts.env = {
                ...process.env,
                AILY_BUILDER_BUILD_PATH: frameworkOutputDir
            };
        }

        logger.log(`执行编译: ${builderCommand} ${args.join(' ')}`);

        const startedAt = new Date();
        const output = [];
        let spawnError = null;
        const child = spawn(builderCommand, args, spawnOpts);
        child.stdout.on('data', (chunk) => {
            process.stdout.write(chunk);
            output.push(String(chunk));
        });
        child.stderr.on('data', (chunk) => {
            process.stderr.write(chunk);
            output.push(String(chunk));
        });
        child.on('error', (error) => {
            spawnError = error;
            output.push(`\n[BUILDER_SPAWN_ERROR] ${formatFatalError(error)}\n`);
        });

        child.on('close', (code, signal) => {
            writeBuilderCompileReport(
                builderCompileReportPath,
                buildBuilderCompileReport({
                    status: !spawnError && !signal && code === 0
                        ? 'passed'
                        : 'failed',
                    builderCommand,
                    args,
                    code,
                    signal,
                    spawnError,
                    startedAt,
                    output: output.join('')
                })
            );
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

function buildBuilderCompileReport({
    status,
    builderCommand,
    args,
    code,
    signal,
    spawnError,
    startedAt,
    output
}) {
    const completedAt = new Date();
    const normalizedOutput = output.replace(
        /\u001b\[[0-9;]*m/g,
        ''
    );
    const cacheLines = normalizedOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.includes('[ARCHIVE_CLOUD_CACHE]'))
        .slice(-200);
    const restoreMatch = normalizedOutput.match(
        /\[ARCHIVE_CLOUD_CACHE\]\s+local hits=(\d+)\s+remote hits=(\d+)\s+misses=(\d+)/
    );
    const storeMatch = normalizedOutput.match(
        /\[ARCHIVE_CLOUD_CACHE\]\s+stored archives=(\d+)\s+skipped=(\d+)\s+size=([^\r\n]+)/
    );
    const scheduledMatch = normalizedOutput.match(
        /\[ARCHIVE_CLOUD_CACHE\]\s+scheduled remote downloads=(\d+)/
    );
    return {
        schemaVersion: 1,
        kind: 'aily-builder-compile-report',
        status,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        builder: {
            command: builderCommand,
            args
        },
        exit: {
            code,
            signal: signal || null,
            error: spawnError ? formatFatalError(spawnError) : null
        },
        archiveCloudCache: {
            observed: cacheLines.length > 0,
            localHits: restoreMatch ? Number(restoreMatch[1]) : null,
            remoteHits: restoreMatch ? Number(restoreMatch[2]) : null,
            misses: restoreMatch ? Number(restoreMatch[3]) : null,
            scheduledRemoteDownloads: scheduledMatch
                ? Number(scheduledMatch[1])
                : 0,
            storedArchives: storeMatch ? Number(storeMatch[1]) : null,
            skippedArchives: storeMatch ? Number(storeMatch[2]) : null,
            storedSize: storeMatch ? storeMatch[3].trim() : null,
            lines: cacheLines
        }
    };
}

function writeBuilderCompileReport(filePath, report) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.${process.pid}.tmp`;
        fs.writeFileSync(
            temporaryPath,
            `${JSON.stringify(report, null, 2)}\n`,
            'utf8'
        );
        fs.rmSync(filePath, { force: true });
        fs.renameSync(temporaryPath, filePath);
    } catch (error) {
        logger.warn(
            `Failed to write Builder compile report ${filePath}: `
            + formatFatalError(error)
        );
    }
}

function normalizeBlockSourceMappings(value) {
    return value
        .filter((mapping) => (
            mapping
            && typeof mapping === 'object'
            && typeof mapping.blockId === 'string'
            && mapping.blockId.length > 0
            && mapping.blockId.length <= 256
            && Array.isArray(mapping.ranges)
        ))
        .map((mapping) => {
            const ranges = normalizeBlockSourceRanges(mapping.ranges);
            return {
                blockId: mapping.blockId,
                ...(mapping.executionRole === 'statement'
                    || mapping.executionRole === 'value'
                    ? { executionRole: mapping.executionRole }
                    : {}),
                ranges,
                ...(Array.isArray(mapping.executableRanges)
                    ? {
                        executableRanges:
                            normalizeBlockSourceRanges(mapping.executableRanges)
                    }
                    : {}),
                ...(Array.isArray(mapping.supportRanges)
                    ? {
                        supportRanges:
                            normalizeBlockSourceRanges(mapping.supportRanges)
                    }
                    : {})
            };
        })
        .filter((mapping) => mapping.ranges.length > 0)
        .sort((left, right) => left.blockId.localeCompare(right.blockId));
}

function normalizeBlockSourceRanges(value) {
    if (!Array.isArray(value)) return [];
    return value
        .filter((range) => (
            range
            && typeof range === 'object'
            && Number.isSafeInteger(range.startLine)
            && Number.isSafeInteger(range.endLine)
            && range.startLine >= 1
            && range.endLine >= range.startLine
        ))
        .map((range) => ({
            startLine: range.startLine,
            endLine: range.endLine
        }))
        .sort((left, right) => (
            left.startLine - right.startLine
            || left.endLine - right.endLine
        ));
}

function supportsArtifactManifest(builderCommand) {
    try {
        const capabilitiesResult = spawnSync(
            builderCommand,
            ['capabilities', '--json'],
            {
                shell: true,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 5000,
            }
        );
        if (capabilitiesResult.status === 0) {
            const capabilities = JSON.parse(capabilitiesResult.stdout || '{}');
            if (
                capabilities?.schemaVersion === 1
                && capabilities?.capabilities?.simulationArtifactManifest
                    ?.schemaVersion === 1
            ) {
                return true;
            }
        }

        const result = spawnSync(
            builderCommand,
            ['compile', '--help'],
            {
                shell: true,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 5000,
            }
        );
        return `${result.stdout || ''}\n${result.stderr || ''}`
            .includes('--emit-artifact-manifest');
    } catch {
        return false;
    }
}

function supportsSceneGraphProvenance(builderCommand) {
    try {
        const capabilitiesResult = spawnSync(
            builderCommand,
            ['capabilities', '--json'],
            {
                shell: true,
                encoding: 'utf8',
                windowsHide: true,
                timeout: 5000,
            }
        );
        if (capabilitiesResult.status === 0) {
            const capabilities = JSON.parse(capabilitiesResult.stdout || '{}');
            return (
                capabilities?.schemaVersion === 1
                && capabilities?.capabilities?.sceneGraphProvenance
                    ?.schemaVersion === 1
                && capabilities.capabilities.sceneGraphProvenance.cliOption
                    === '--graph-semantic-revision'
            );
        }
        return false;
    } catch {
        return false;
    }
}

main().catch(e => {
    exitWithFatalError(e);
});

function syncPreprocessBuildPath(preprocessCachePath, buildPath) {
    try {
        const preprocessResult = JSON.parse(fs.readFileSync(preprocessCachePath, 'utf8'));
        preprocessResult.envVars = preprocessResult.envVars || {};
        if (preprocessResult.envVars.BUILD_PATH !== buildPath) {
            preprocessResult.envVars.BUILD_PATH = buildPath;
            fs.writeFileSync(preprocessCachePath, JSON.stringify(preprocessResult, null, 2));
        }
    } catch (error) {
        logger.warn(`Failed to update preprocess build path: ${error.message}`);
    }
}

function copyProjectSrcToSketch(currentProjectPath, sketchPath) {
    const projectSrcPath = path.join(currentProjectPath, 'src');
    if (!fs.existsSync(projectSrcPath)) {
        return;
    }
    if (!fs.statSync(projectSrcPath).isDirectory()) {
        logger.warn(`Project src path exists but is not a directory: ${projectSrcPath}`);
        return;
    }
    fs.cpSync(projectSrcPath, sketchPath, { recursive: true });
}
