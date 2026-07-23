const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec, execSync } = require('child_process');
const os = require('os');

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

async function main() {
    const configPath = process.argv[2];
    if (!configPath) {
        logger.error('Usage: node preprocess.js <config-path>');
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
        appDataPath,
        za7Path,
        devmode,
        partitionFilePath: customPartitionFilePath
    } = config;

    // 1. 路径准备
    const tempPath = path.join(currentProjectPath, '.temp');
    const buildPath = path.join(currentProjectPath, '.build');
    const sketchPath = path.join(tempPath, 'sketch');
    const sketchFilePath = path.join(sketchPath, 'sketch.ino');
    const librariesPath = path.join(tempPath, 'libraries');
    
    const compilerPath = path.join(appDataPath, 'compiler');
    const sdkPath = path.join(appDataPath, 'sdk');
    const toolsPath = path.join(appDataPath, 'tools');

    // 2. 读取项目信息
    const projectPackageJsonPath = path.join(currentProjectPath, 'package.json');
    if (!fs.existsSync(projectPackageJsonPath)) {
        throw new Error(`未找到项目包文件: ${projectPackageJsonPath}`);
    }
    const projectPackageJson = JSON.parse(fs.readFileSync(projectPackageJsonPath, 'utf8'));
    const dependencies = projectPackageJson.dependencies || {};

    const macros = projectPackageJson.macros || projectPackageJson.MACROS || (projectPackageJson.projectConfig && projectPackageJson.projectConfig.macros) || [];
    const projectConfig = projectPackageJson.projectConfig || {};

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

    // 缓存文件路径
    const cacheFilePath = path.join(path.dirname(librariesPath), 'library-cache.json');
    let libraryCache = {};
    if (fs.existsSync(cacheFilePath)) {
        try {
            libraryCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
        } catch (e) {
            // ignore
        }
    }

    try {
        // 1. 创建文件夹
        mkdirp(tempPath);
        mkdirp(sketchPath);
        mkdirp(librariesPath);

        // 2. 生成sketch文件
        fs.writeFileSync(sketchFilePath, code);
        copyProjectSrcToSketch(currentProjectPath, sketchPath);

        // 3. 处理库文件
        const libsPath = [];
        Object.entries(dependencies || {}).forEach(([key, version]) => {
            if (key.startsWith('@aily-project/lib-') && !key.startsWith('@aily-project/lib-core')) {
                libsPath.push(key);
            }
        });

        logger.log(`开始处理 ${libsPath.length} 个库文件`);
        const copiedLibraries = await processLibrariesParallel(libsPath, librariesPath, currentProjectPath, za7Path, devmode, libraryCache);
        
        // 保存缓存
        try {
            fs.writeFileSync(cacheFilePath, JSON.stringify(libraryCache, null, 2));
        } catch (e) {
            logger.warn('保存库缓存失败:', e);
        }

        // 4. 清理未使用的库
        if (fs.existsSync(librariesPath)) {
            const librariesItems = fs.readdirSync(librariesPath);
            const existingFolders = librariesItems
                .filter(item => fs.statSync(path.join(librariesPath, item)).isDirectory());

            if (existingFolders.length > 0) {
                for (const folder of existingFolders) {
                    const shouldKeep = copiedLibraries.some(copiedLib => {
                        return folder === copiedLib || folder.startsWith(copiedLib);
                    });

                    if (!shouldKeep) {
                        const folderToDelete = path.join(librariesPath, folder);
                        logger.log(`删除未使用的库文件夹: ${folder}`);
                        try {
                            rm(folderToDelete);
                        } catch (error) {
                            logger.warn(`删除文件夹 ${folder} 失败:`, error);
                        }
                    }
                }
            }
        }

        // 5. 获取编译器、SDK、Tool信息
        let compiler = "";
        let sdk = "";
        const toolVersions = [];

        Object.entries(boardDependencies || {}).forEach(([key, version]) => {
            if (key.startsWith('@aily-project/compiler-')) {
                compiler = key.replace(/^@aily-project\/compiler-/, '') + '@' + version;
                toolVersions.push(compiler);
            } else if (key.startsWith('@aily-project/sdk-')) {
                sdk = key.replace(/^@aily-project\/sdk-/, '') + '_' + version;
            } else if (key.startsWith('@aily-project/tool-')) {
                let toolName = key.replace(/^@aily-project\/tool-/, '');
                if (toolName.startsWith('idf_')) {
                    toolName = 'esp32-arduino-libs';
                }
                const tool = toolName + '@' + version;
                toolVersions.push(tool);
            }
        });

        if (!compiler || !sdk) {
            throw new Error('未找到编译器或SDK信息');
        }

        // 6. 配置路径和参数
        const fullCompilerPath = path.join(compilerPath, compiler);
        const fullSdkPath = path.join(sdkPath, sdk);
        
        // 7. 获取编译命令
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
                    compilerParamList.splice(i, 2);
                    break;
                }
            }
            if (compilerParamList[i] === '-v' || compilerParamList[i] === '--verbose') {
                compilerParamList.splice(i, 1);
                i--;
            }
        }

        compilerParam = compilerParamList.join(' ');

        // 8. 解析项目编译参数
        let buildProperties = '';
        if (projectConfig) {
            const buildPropertyParams = [];
            for (const [key, value] of Object.entries(projectConfig)) {
                if (value !== null && value !== undefined && value !== '') {
                    buildPropertyParams.push(`--board-options ${key}=${value}`);
                }

                if (key === 'PartitionScheme' && value === 'custom') {
                    let partitionFile = path.join(currentProjectPath, 'partitions.csv');
                    if (!fs.existsSync(partitionFile) && customPartitionFilePath) {
                        partitionFile = customPartitionFilePath;
                    }

                    if (!partitionFile || !fs.existsSync(partitionFile)) {
                        partitionFile = path.join(boardModulePath, 'partitions.csv');
                    }

                    if (!partitionFile || !fs.existsSync(partitionFile)) {
                        throw new Error('选择了自定义分区方案，但未找到 partitions.csv 分区文件');
                    }

                    const destPartitionFilePath = path.join(sketchPath, 'partitions.csv');
                    try {
                        fs.copyFileSync(partitionFile, destPartitionFilePath);
                    } catch (error) {
                        throw new Error(`复制分区文件失败: ${error.message}`);
                    }
                }
            }
            buildProperties = buildPropertyParams.join(' ');
            if (buildProperties) {
                buildProperties = ' ' + buildProperties;
            }
        }

        if (macros) {
            let macroParams = [];
            macros.forEach(macroDef => {
                if (Array.isArray(macroDef)) {
                    macroDef.forEach(macro => {
                        macroParams.push(`--build-macros ${macro}`);
                    });
                } else if (typeof macroDef === 'string') {
                    macroParams.push(`--build-macros ${macroDef}`);
                }
            });
            if (macroParams.length > 0) {
                buildProperties += ' ' + macroParams.join(' ');
            }
        }

        compilerParam += buildProperties;

        // 9. 同步编译器工具
        await syncCompilerToolsToToolsPath(fullCompilerPath, toolsPath);

        // 10. 执行预编译
        const preprocessCachePath = path.join(tempPath, 'preprocess.json');
        
        logger.log('开始预编译...');
        const builderCommand = 'aily-builder';
        const pre_args = [
            'preprocess',
            // `...parseArgs(compilerParam)`,
            `"${sketchFilePath}"`,
            '--board', `"${boardType}"`,
            '--libraries-path', `"${librariesPath}"`,
            '--sdk-path', `"${fullSdkPath}"`,
            '--tools-path', `"${toolsPath}"`,
            '--build-path', `"${buildPath}"`,
            '--tool-versions', `"${toolVersions.join(',')}"`,
            '--save-result', `"${preprocessCachePath}"`
        ];

        // 添加项目配置参数（如 UploadSpeed, FlashMode, FlashSize, PartitionScheme, PSRAM 等）
        if (projectConfig) {
            for (const [key, value] of Object.entries(projectConfig)) {
                if (value !== null && value !== undefined && value !== '') {
                    pre_args.push('--board-options', `${key}=${value}`);
                }
            }
        }

        // 添加宏定义参数
        if (macros && macros.length > 0) {
            macros.forEach(macroDef => {
                if (Array.isArray(macroDef)) {
                    macroDef.forEach(macro => {
                        pre_args.push('--build-macros', macro);
                    });
                } else if (typeof macroDef === 'string') {
                    pre_args.push('--build-macros', macroDef);
                }
            });
        }

        logger.log(`执行预编译: ${builderCommand} ${pre_args.join(' ')}`);

        // 使用同步执行预编译，确保完成后再继续
        await new Promise((resolve, reject) => {
            const preChild = spawn(builderCommand, pre_args, {
                cwd: currentProjectPath,
                shell: true,
                stdio: 'inherit'
            });

            preChild.on('close', (code, signal) => {
                if (signal) {
                    reject(new Error(`预编译进程被信号终止: ${signal}`));
                    return;
                }

                if (code !== 0) {
                    reject(new Error(`预编译失败，退出码: ${code}`));
                    return;
                }

                resolve();
            });

            preChild.on('error', (error) => {
                reject(new Error(`预编译进程错误: ${error.message}`));
            });
        });

        // logger.log('预处理完成');
        process.exit(0);

    } catch (error) {
        logger.error(`[ERROR] ${error.message}`);
        process.exit(1);
    }
}

// Helpers

function mkdirp(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function rm(pathToRemove) {
    try {
        const stats = fs.lstatSync(pathToRemove);
        fs.rmSync(pathToRemove, { recursive: true, force: true });
    } catch (e) {
        // Ignore ENOENT (file not found), rethrow others
        if (e.code !== 'ENOENT') {
            logger.warn(`删除失败 ${pathToRemove}:`, e.message);
        }
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

    copyDirectoryContents(projectSrcPath, sketchPath);
}

function copyDirectoryContents(sourceDir, targetDir) {
    mkdirp(targetDir);

    const items = fs.readdirSync(sourceDir);
    for (const item of items) {
        copyItemRecursive(path.join(sourceDir, item), path.join(targetDir, item));
    }
}

function copyItemRecursive(sourcePath, targetPath) {
    const stat = fs.statSync(sourcePath);

    if (stat.isDirectory()) {
        if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
            rm(targetPath);
        }

        mkdirp(targetPath);
        copyDirectoryContents(sourcePath, targetPath);
        return;
    }

    if (!stat.isFile()) {
        return;
    }

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        rm(targetPath);
    }

    mkdirp(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
}

async function processLibrariesParallel(libsPath, librariesPath, currentProjectPath, za7Path, devmode, libraryCache) {
    const tasks = libsPath.map(lib => processLibrary(lib, librariesPath, currentProjectPath, za7Path, devmode, libraryCache));
    const results = await Promise.all(tasks);
    
    const copiedLibraries = [];
    results.forEach(result => {
        if (result.success) {
            copiedLibraries.push(...result.targetNames);
        } else {
            logger.warn(`库处理失败: ${result.error}`);
        }
    });
    return copiedLibraries;
}

async function processLibrary(lib, librariesPath, currentProjectPath, za7Path, devmode, libraryCache) {
    try {
        const sourcePathBase = path.join(currentProjectPath, 'node_modules', lib, 'src');
        const packageJsonPath = path.join(currentProjectPath, 'node_modules', lib, 'package.json');
        const sourceZipPath = path.join(currentProjectPath, 'node_modules', lib, 'src.7z');

        // Prepare source
        let sourcePath = sourcePathBase;
        if (!fs.existsSync(sourcePath)) {
            if (fs.existsSync(sourceZipPath)) {
                try {
                    execSync(`"${za7Path}" x "${sourceZipPath}" -o"${path.dirname(sourcePath)}" -y`);
                } catch (error) {
                    return { targetNames: [], success: false, error: `解压失败: ${error.message}` };
                }
            } else {
                return { targetNames: [], success: true }; // No src, skip
            }
        }

        sourcePath = resolveNestedSrcPath(sourcePath);

        // Source directory mtimes do not change when an existing nested file is
        // edited. Use a deterministic recursive metadata fingerprint instead,
        // and also verify that the cached output folders still exist. Expanded
        // src is authoritative; never overwrite local source with src.7z. A
        // package-manager update replaces the package directory, while a local
        // file/junction dependency may intentionally have src newer than its
        // archive. Re-extracting here would destroy those local source edits.
        const sourceFingerprint = computeLibraryFingerprint(
            sourcePath,
            packageJsonPath,
            sourceZipPath
        );
        const cached = libraryCache[lib];
        const cacheValid = isLibraryCacheValid(
            cached,
            sourceFingerprint,
            librariesPath
        );
        if (!devmode && cacheValid) {
            return { targetNames: cached.targetNames, success: true };
        }
        const replaceExisting = Boolean(devmode) || !cacheValid;

        const hasHeaders = checkForHeaderFiles(sourcePath);
        let result;
        if (hasHeaders) {
            result = await processLibraryWithHeaders(lib, sourcePath, librariesPath, replaceExisting);
        } else {
            result = await processLibraryDirectories(lib, sourcePath, librariesPath, replaceExisting);
        }

        if (result.success) {
            libraryCache[lib] = {
                timestamp: Date.now(),
                sourceFingerprint,
                hasHeaderFiles: hasHeaders,
                targetNames: result.targetNames
            };
        }
        return result;

    } catch (error) {
        return { targetNames: [], success: false, error: error.message };
    }
}

function computeLibraryFingerprint(sourcePath, packageJsonPath, sourceZipPath) {
    const hash = crypto.createHash('sha256');
    hash.update('aily-library-cache-v3\0');

    updatePathFingerprint(hash, sourcePath, 'src', new Set(), false);
    if (packageJsonPath && fs.existsSync(packageJsonPath)) {
        // package.json is small; hashing its contents guarantees that a version
        // change invalidates the cache even if metadata was preserved by a copy.
        updatePathFingerprint(hash, packageJsonPath, 'package.json', new Set(), true);
    } else {
        hash.update('missing-package-json\0');
    }
    if (sourceZipPath && fs.existsSync(sourceZipPath)) {
        // src.7z can be large. Its size and mtime are sufficient here because
        // expanded src is the actual copy input and package version is included.
        updatePathFingerprint(hash, sourceZipPath, 'src.7z', new Set(), false);
    } else {
        hash.update('missing-source-archive\0');
    }

    return `sha256:${hash.digest('hex')}`;
}

function updatePathFingerprint(
    hash,
    absolutePath,
    relativePath,
    activeDirectories,
    includeFileContent
) {
    const lstat = fs.lstatSync(absolutePath);
    const normalizedRelativePath = relativePath.split(path.sep).join('/');

    if (lstat.isSymbolicLink()) {
        hash.update(`L\0${normalizedRelativePath}\0${fs.readlinkSync(absolutePath)}\0`);
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
        const realPath = fs.realpathSync(absolutePath);
        if (activeDirectories.has(realPath)) {
            hash.update(`CYCLE\0${normalizedRelativePath}\0`);
            return;
        }

        hash.update(`D\0${normalizedRelativePath}\0`);
        activeDirectories.add(realPath);
        try {
            const entries = fs.readdirSync(absolutePath).sort();
            for (const entry of entries) {
                updatePathFingerprint(
                    hash,
                    path.join(absolutePath, entry),
                    path.join(relativePath, entry),
                    activeDirectories,
                    includeFileContent
                );
            }
        } finally {
            activeDirectories.delete(realPath);
        }
        return;
    }

    if (stat.isFile()) {
        hash.update(
            `F\0${normalizedRelativePath}\0${stat.size}\0${stat.mtimeMs}\0`
        );
        if (includeFileContent) {
            hash.update(fs.readFileSync(absolutePath));
            hash.update('\0');
        }
        return;
    }

    hash.update(`O\0${normalizedRelativePath}\0`);
}

function isLibraryCacheValid(cached, sourceFingerprint, librariesPath) {
    if (!cached || cached.sourceFingerprint !== sourceFingerprint) return false;
    if (!Array.isArray(cached.targetNames)) return false;

    try {
        return cached.targetNames.every(targetName => {
            const targetPath = path.join(librariesPath, targetName);
            return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
        });
    } catch {
        return false;
    }
}

function resolveNestedSrcPath(sourcePath) {
    if (!fs.existsSync(sourcePath)) return sourcePath;
    try {
        const items = fs.readdirSync(sourcePath);
        if (items.length === 1 && items[0] === 'src') {
            const nested = path.join(sourcePath, 'src');
            if (fs.statSync(nested).isDirectory()) {
                return nested;
            }
        }
    } catch (e) {}
    return sourcePath;
}

function checkForHeaderFiles(sourcePath) {
    if (!fs.existsSync(sourcePath)) return false;
    try {
        const files = fs.readdirSync(sourcePath);
        return files.some(f => f.endsWith('.h'));
    } catch {
        return false;
    }
}

async function processLibraryWithHeaders(lib, sourcePath, librariesPath, replaceExisting) {
    const targetName = lib.split('@aily-project/')[1];
    const targetPath = path.join(librariesPath, targetName);
    
    // Check if target exists (valid or broken symlink)
    let exists = false;
    let isBroken = false;
    try {
        fs.lstatSync(targetPath);
        exists = true;
        try {
            fs.statSync(targetPath);
        } catch (e) {
            isBroken = true;
        }
    } catch (e) {}

    if (exists) {
        if (replaceExisting || isBroken) {
            rm(targetPath);
        } else {
            return { targetNames: [targetName], success: true };
        }
    }

    try {
        linkItem(sourcePath, targetPath);
        return { targetNames: [targetName], success: true };
    } catch (e) {
        return { targetNames: [], success: false, error: e.message };
    }
}

async function processLibraryDirectories(lib, sourcePath, librariesPath, replaceExisting) {
    const targetNames = [];
    if (!fs.existsSync(sourcePath)) return { targetNames: [], success: true };

    const items = fs.readdirSync(sourcePath);
    for (const item of items) {
        const fullSourcePath = path.join(sourcePath, item);
        if (fs.statSync(fullSourcePath).isDirectory()) {
            const targetPath = path.join(librariesPath, item);
            
            // Check if target exists (valid or broken symlink)
            let exists = false;
            let isBroken = false;
            try {
                fs.lstatSync(targetPath);
                exists = true;
                try {
                    fs.statSync(targetPath);
                } catch (e) {
                    isBroken = true;
                }
            } catch (e) {}

            if (exists) {
                if (replaceExisting || isBroken) {
                    rm(targetPath);
                } else {
                    targetNames.push(item);
                    continue;
                }
            }

            try {
                linkItem(fullSourcePath, targetPath);
                targetNames.push(item);
            } catch (e) {
                // ignore or log
            }
        }
    }
    return { targetNames, success: true };
}

function linkItem(src, dest) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        const items = fs.readdirSync(src);
        for (const item of items) {
            linkItem(path.join(src, item), path.join(dest, item));
        }
    } else {
        if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
        }
        try {
            fs.linkSync(src, dest);
        } catch (e) {
            // Fallback to copy if hard link fails (e.g. cross-device)
            fs.copyFileSync(src, dest);
        }
    }
}

async function syncCompilerToolsToToolsPath(compilerPath, toolsPath) {
    if (!fs.existsSync(compilerPath)) return;
    mkdirp(toolsPath);
    
    const compilerDirName = path.basename(compilerPath);
    const targetCompilerPath = path.join(toolsPath, compilerDirName);
    
    if (fs.existsSync(targetCompilerPath)) return;
    
    try {
        linkItem(compilerPath, targetCompilerPath);
    } catch (e) {
        logger.warn('Failed to link compiler:', e);
    }
}

if (require.main === module) {
    process.on('uncaughtException', (error) => {
        exitWithFatalError(error);
    });

    process.on('unhandledRejection', (reason) => {
        exitWithFatalError(reason);
    });

    main().catch(e => {
        exitWithFatalError(e);
    });
}

module.exports = {
    computeLibraryFingerprint,
    isLibraryCacheValid,
    processLibrary
};
