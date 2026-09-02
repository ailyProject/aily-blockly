const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec, execFileSync } = require('child_process');
const os = require('os');
const ailyCodeProject = require('./aily-code-project');
const platformRuntime = require('./platform-runtime');
const { resolveBuilderInvocation } = require('./builder-invocation');

const LIBRARY_CACHE_SCHEMA_VERSION = 2;

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

function getBoardOptionEntries(projectConfig) {
    if (!projectConfig || typeof projectConfig !== 'object') {
        return [];
    }

    return Object.entries(projectConfig).filter(([, value]) => (
        value !== null && value !== undefined && value !== ''
    ));
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
    const developmentMode = devmode === true || devmode?.enabled === true;

    // 1. 路径准备
    const isAilyCode = ailyCodeProject.isAilyCodeProjectRoot(currentProjectPath);
    const tempPath = isAilyCode
        ? ailyCodeProject.resolveCompileWorkspacePath(currentProjectPath)
        : path.join(currentProjectPath, '.temp');
    const buildPath = path.join(currentProjectPath, '.build');
    const sketchPath = isAilyCode ? tempPath : path.join(tempPath, 'sketch');
    const sketchFilePath = path.join(sketchPath, 'sketch.ino');
    const compileSourcePath = isAilyCode
        ? ailyCodeProject.resolveCompileSourcePath(currentProjectPath)
        : sketchFilePath;
    const librariesPath = isAilyCode
        ? ailyCodeProject.resolveLibrariesPath(currentProjectPath)
        : path.join(tempPath, 'libraries');
    
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
    const platformRef = platformRuntime.readPlatformRefFromProjectPackage(currentProjectPath);
    const boardDependencies = platformRuntime.resolveEffectiveBoardDependencies(
        boardPackageJson.boardDependencies,
        appDataPath,
        platformRef?.packageName,
    );

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

        // 2. Coder 直接预处理 package.json.entry；Blockly 仍物化 sketch 及 src 辅助文件。
        mkdirp(path.dirname(compileSourcePath));
        fs.writeFileSync(compileSourcePath, code);
        if (!isAilyCode) {
            copyProjectSrcToSketch(currentProjectPath, sketchPath);
        }

        // 3. 处理库文件
        const libsPath = collectLibraryPackages(dependencies, currentProjectPath);
        const componentLibraries = isAilyCode
            ? collectWorkspaceLibraries(librariesPath)
            : collectComponentLibraries(currentProjectPath);

        logger.log(`开始处理 ${libsPath.length} 个库文件`);
        const packageLibraryPaths = isAilyCode
            ? await prepareCoderPackageLibraries(libsPath, currentProjectPath, za7Path)
            : [];
        const copiedLibraries = isAilyCode
            ? componentLibraries.map(component => component.name)
            : await processLibrariesParallel(
                libsPath,
                librariesPath,
                currentProjectPath,
                za7Path,
                developmentMode,
                libraryCache
            );
        if (!isAilyCode) {
            copiedLibraries.push(...await processComponentLibraries(componentLibraries, librariesPath));
        }
        const librarySearchPaths = isAilyCode
            ? [librariesPath, ...packageLibraryPaths]
            : [librariesPath];
        
        // 保存缓存
        if (!isAilyCode) {
            try {
                fs.writeFileSync(cacheFilePath, JSON.stringify(libraryCache, null, 2));
            } catch (e) {
                logger.warn('保存库缓存失败:', e);
            }
        }

        // 4. 清理未使用的库
        if (!isAilyCode && fs.existsSync(librariesPath)) {
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
            for (const [key, value] of getBoardOptionEntries(projectConfig)) {
                buildPropertyParams.push(`--board-options ${key}=${value}`);

                if (key === 'PartitionScheme' && value === 'custom') {
                    copyCustomPartitionFile({
                        currentProjectPath,
                        sketchPath,
                        customPartitionFilePath,
                        compileSourcePath,
                        isAilyCode
                    });
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
        const preprocessCachePath = isAilyCode
            ? ailyCodeProject.resolvePreprocessResultPath(currentProjectPath)
            : path.join(tempPath, 'preprocess.json');
        
        logger.log('开始预编译...');
        const pre_args = [
            'preprocess',
            // `...parseArgs(compilerParam)`,
            `"${compileSourcePath}"`,
            '--board', `"${boardType}"`,
            '--sdk-path', `"${fullSdkPath}"`,
            '--tools-path', `"${toolsPath}"`,
            '--build-path', `"${buildPath}"`,
            '--tool-versions', `"${toolVersions.join(',')}"`,
            '--save-result', `"${preprocessCachePath}"`
        ];
        for (const librarySearchPath of librarySearchPaths) {
            pre_args.push('--libraries-path', `"${librarySearchPath}"`);
        }

        // 添加项目配置参数（如 UploadSpeed, FlashMode, FlashSize, PartitionScheme, PSRAM 等）
        if (projectConfig) {
            for (const [key, value] of getBoardOptionEntries(projectConfig)) {
                pre_args.push('--board-options', `${key}=${value}`);
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

        const builderInvocation = resolveBuilderInvocation(pre_args);
        logger.log(`执行预编译: ${builderInvocation.command} ${builderInvocation.args.join(' ')}`);

        // 使用同步执行预编译，确保完成后再继续
        await new Promise((resolve, reject) => {
            const preChild = spawn(builderInvocation.command, builderInvocation.args, {
                cwd: currentProjectPath,
                shell: builderInvocation.shell,
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

function copyCustomPartitionFile({
    currentProjectPath,
    sketchPath,
    customPartitionFilePath,
    compileSourcePath,
    isAilyCode
}) {
    const sourcePartitionFile = isAilyCode
        ? path.join(path.dirname(compileSourcePath), 'partitions.csv')
        : path.join(currentProjectPath, 'src', 'partitions.csv');
    const legacyPartitionFile = path.join(currentProjectPath, 'partitions.csv');
    const candidates = [
        { filePath: sourcePartitionFile, kind: 'source' },
        { filePath: legacyPartitionFile, kind: 'legacy' },
        { filePath: customPartitionFilePath, kind: 'configured' }
    ].filter(candidate => candidate.filePath && fs.existsSync(candidate.filePath));

    const selected = candidates[0];
    if (!selected) {
        throw new Error(`选择了自定义分区方案，但未找到 partitions.csv 分区文件。请将文件保存到 ${sourcePartitionFile}`);
    }

    if (selected.kind === 'legacy') {
        logger.warn(`检测到旧位置分区文件，建议迁移到 ${sourcePartitionFile}`);
    }

    const destPartitionFilePath = isAilyCode
        ? sourcePartitionFile
        : path.join(sketchPath, 'partitions.csv');
    if (path.resolve(selected.filePath) === path.resolve(destPartitionFilePath)) {
        return;
    }
    try {
        fs.copyFileSync(selected.filePath, destPartitionFilePath);
    } catch (error) {
        throw new Error(`复制分区文件失败: ${error.message}`);
    }
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

function isCompilableLibraryPackage(packageName) {
    return typeof packageName === 'string'
        && packageName.startsWith('@aily-project/lib-')
        && !packageName.startsWith('@aily-project/lib-core');
}

function collectLibraryPackages(projectDependencies, currentProjectPath) {
    const libraries = [];
    const visited = new Set();
    const pending = Object.keys(projectDependencies || {});

    for (let index = 0; index < pending.length; index++) {
        const packageName = pending[index];
        if (!isCompilableLibraryPackage(packageName) || visited.has(packageName)) {
            continue;
        }
        visited.add(packageName);
        libraries.push(packageName);

        const packagePath = path.join(currentProjectPath, 'node_modules', packageName);
        const packageJsonPath = path.join(packagePath, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            logger.warn(`Library package is not installed: ${packageName}`);
            continue;
        }

        let packageJson;
        try {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        } catch (error) {
            logger.warn(`Failed to read library package.json: ${packageJsonPath}: ${error.message}`);
            continue;
        }

        Object.keys(packageJson.dependencies || {}).forEach(dependencyName => {
            pending.push(dependencyName);
        });
    }

    return libraries;
}

/**
 * Aily Coder local libraries: each immediate directory under project-root
 * components/ is one Arduino-compatible library root. Files and symlinks at
 * the components root are deliberately ignored so discovery cannot escape the
 * project-owned source tree.
 */
function collectComponentLibraries(currentProjectPath) {
    const componentsPath = path.join(currentProjectPath, 'components');
    if (!fs.existsSync(componentsPath) || !fs.statSync(componentsPath).isDirectory()) {
        return [];
    }

    return fs.readdirSync(componentsPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({
            name: entry.name,
            sourcePath: path.join(componentsPath, entry.name)
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

/** Coder uses sketch/libraries directly; these directories are already build inputs. */
function collectWorkspaceLibraries(librariesPath) {
    if (!fs.existsSync(librariesPath) || !fs.statSync(librariesPath).isDirectory()) {
        return [];
    }

    return fs.readdirSync(librariesPath, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => ({
            name: entry.name,
            sourcePath: path.join(librariesPath, entry.name)
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Materialize project-local component libraries after npm libraries so an
 * editable project copy has the same precedence as a sketchbook Arduino
 * library. Components are intentionally refreshed every build: their source
 * is local, small, and must never be hidden behind the npm library cache.
 */
async function processComponentLibraries(componentLibraries, librariesPath) {
    const copied = [];
    for (const component of componentLibraries) {
        const targetPath = resolveLibraryTargetPath(librariesPath, component.name);
        if (!targetPath) {
            logger.warn(`忽略不安全的组件库名称: ${String(component.name)}`);
            continue;
        }
        try {
            // Fingerprinting also rejects nested links that escape the library root.
            createLibrarySourceFingerprint(component.sourcePath);
            rm(targetPath);
            linkItem(component.sourcePath, targetPath);
            copied.push(component.name);
        } catch (error) {
            throw new Error(`组件库 ${component.name} 处理失败: ${error.message}`);
        }
    }
    return copied;
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

/**
 * Coder keeps installed @aily-project/lib-* packages intact under node_modules.
 * src.7z is expanded in-place to <package>/src and each package src directory is
 * passed to aily-builder as an independent library search root. sketch/libraries
 * remains reserved for intentional project-local source libraries.
 */
async function prepareCoderPackageLibraries(libsPath, currentProjectPath, za7Path) {
    const results = await Promise.all(libsPath.map(async lib => {
        const packageRoot = path.join(currentProjectPath, 'node_modules', lib);
        const sourcePathBase = path.join(packageRoot, 'src');
        if (!fs.existsSync(sourcePathBase)) {
            const sourceZipPath = path.join(packageRoot, 'src.7z');
            if (!fs.existsSync(sourceZipPath)) {
                logger.warn(`Coder library package has no src or src.7z: ${lib}`);
                return '';
            }
            try {
                extractLibrarySourceArchive(za7Path, sourceZipPath, sourcePathBase);
            } catch (error) {
                throw new Error(`Coder library ${lib} extraction failed: ${error.message}`);
            }
        }

        const sourcePath = resolveNestedSrcPath(sourcePathBase);
        createLibrarySourceFingerprint(sourcePath);
        return sourcePath;
    }));
    return results.filter(Boolean);
}

async function processLibrary(lib, librariesPath, currentProjectPath, za7Path, devmode, libraryCache) {
    try {
        const sourcePathBase = path.join(currentProjectPath, 'node_modules', lib, 'src');

        // Prepare source
        let sourcePath = sourcePathBase;
        if (!fs.existsSync(sourcePath)) {
            const sourceZipPath = path.join(currentProjectPath, 'node_modules', lib, 'src.7z');
            if (fs.existsSync(sourceZipPath)) {
                try {
                    extractLibrarySourceArchive(za7Path, sourceZipPath, sourcePath);
                } catch (error) {
                    return { targetNames: [], success: false, error: `解压失败: ${error.message}` };
                }
            } else {
                return { targetNames: [], success: true }; // No src, skip
            }
        }

        sourcePath = resolveNestedSrcPath(sourcePath);

        const sourceFingerprint = createLibrarySourceFingerprint(sourcePath);
        const cached = libraryCache[lib];
        if (!devmode && cached && isLibraryCacheValid(cached, sourceFingerprint, librariesPath)) {
            return { targetNames: cached.targetNames, success: true };
        }

        removeCachedLibraryTargets(cached, librariesPath);

        const hasHeaders = checkForHeaderFiles(sourcePath);
        let result;
        if (hasHeaders) {
            result = await processLibraryWithHeaders(lib, sourcePath, librariesPath);
        } else {
            result = await processLibraryDirectories(lib, sourcePath, librariesPath);
        }

        if (result.success) {
            libraryCache[lib] = {
                schemaVersion: LIBRARY_CACHE_SCHEMA_VERSION,
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

function extractLibrarySourceArchive(za7Path, sourceZipPath, sourcePath) {
    const extractPath = path.join(path.dirname(sourcePath), `.src-extract-${process.pid}-${Date.now()}`);

    try {
        mkdirp(extractPath);
        execFileSync(za7Path, ['x', sourceZipPath, `-o${extractPath}`, '-y']);
        normalizeExtractedSourceDirectory(extractPath, sourcePath);
    } finally {
        rm(extractPath);
    }
}

function normalizeExtractedSourceDirectory(extractPath, sourcePath) {
    const extractedItems = fs.readdirSync(extractPath);
    const nestedSourcePath = path.join(extractPath, 'src');
    const extractedSourcePath = extractedItems.length === 1 && extractedItems[0] === 'src' && fs.statSync(nestedSourcePath).isDirectory()
        ? nestedSourcePath
        : extractPath;

    if (fs.existsSync(sourcePath)) {
        rm(sourcePath);
    }

    fs.renameSync(extractedSourcePath, sourcePath);
}

function createLibrarySourceFingerprint(sourcePath) {
    const rootRealPath = fs.realpathSync(sourcePath);
    const activeDirectories = new Set();
    const hash = crypto.createHash('sha256');

    const visit = (currentPath, relativePath) => {
        const realPath = fs.realpathSync(currentPath);
        if (!isPathWithin(rootRealPath, realPath)) {
            throw new Error(`Library source link escapes its root: ${currentPath}`);
        }

        const stat = fs.statSync(currentPath);
        const normalizedPath = relativePath.split(path.sep).join('/');

        if (stat.isDirectory()) {
            if (activeDirectories.has(realPath)) {
                throw new Error(`Library source contains a directory link cycle: ${currentPath}`);
            }

            hash.update(`directory\0${normalizedPath}\0`);
            activeDirectories.add(realPath);

            const items = fs.readdirSync(currentPath).sort((left, right) => left.localeCompare(right));
            for (const item of items) {
                visit(path.join(currentPath, item), path.join(relativePath, item));
            }

            activeDirectories.delete(realPath);
            return;
        }

        if (stat.isFile()) {
            const content = fs.readFileSync(currentPath);
            hash.update(`file\0${normalizedPath}\0${content.length}\0`);
            hash.update(content);
            hash.update('\0');
            return;
        }

        hash.update(`other\0${normalizedPath}\0`);
    };

    visit(sourcePath, '');
    return `sha256:${hash.digest('hex')}`;
}

function isPathWithin(rootPath, candidatePath) {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === ''
        || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function isLibraryCacheValid(cached, sourceFingerprint, librariesPath) {
    return cached.schemaVersion === LIBRARY_CACHE_SCHEMA_VERSION
        && cached.sourceFingerprint === sourceFingerprint
        && Array.isArray(cached.targetNames)
        && cached.targetNames.every(targetName => {
            const targetPath = resolveLibraryTargetPath(librariesPath, targetName);
            if (!targetPath) return false;

            try {
                return fs.statSync(targetPath).isDirectory();
            } catch {
                return false;
            }
        });
}

function removeCachedLibraryTargets(cached, librariesPath) {
    if (!Array.isArray(cached?.targetNames)) return;

    for (const targetName of cached.targetNames) {
        const targetPath = resolveLibraryTargetPath(librariesPath, targetName);
        if (!targetPath) {
            logger.warn(`忽略不安全的库缓存目标: ${String(targetName)}`);
            continue;
        }

        rm(targetPath);
    }
}

function resolveLibraryTargetPath(librariesPath, targetName) {
    if (typeof targetName !== 'string'
        || !targetName
        || targetName === '.'
        || targetName === '..'
        || path.basename(targetName) !== targetName) {
        return null;
    }

    const librariesRoot = path.resolve(librariesPath);
    const targetPath = path.resolve(librariesRoot, targetName);
    return isPathWithin(librariesRoot, targetPath) ? targetPath : null;
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

async function processLibraryWithHeaders(lib, sourcePath, librariesPath) {
    const targetName = lib.split('@aily-project/')[1];
    const targetPath = path.join(librariesPath, targetName);

    rm(targetPath);

    try {
        linkItem(sourcePath, targetPath);
        return { targetNames: [targetName], success: true };
    } catch (e) {
        return { targetNames: [], success: false, error: e.message };
    }
}

async function processLibraryDirectories(lib, sourcePath, librariesPath) {
    const targetNames = [];
    if (!fs.existsSync(sourcePath)) return { targetNames: [], success: true };

    const items = fs.readdirSync(sourcePath);
    for (const item of items) {
        const fullSourcePath = path.join(sourcePath, item);
        if (fs.statSync(fullSourcePath).isDirectory()) {
            const targetPath = path.join(librariesPath, item);
            
            rm(targetPath);

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
    main().catch(e => {
        exitWithFatalError(e);
    });
}

module.exports = {
    collectComponentLibraries,
    collectWorkspaceLibraries,
    collectLibraryPackages,
    createLibrarySourceFingerprint,
    isCompilableLibraryPackage,
    normalizeExtractedSourceDirectory,
    prepareCoderPackageLibraries,
    processComponentLibraries,
    processLibrariesParallel,
};
