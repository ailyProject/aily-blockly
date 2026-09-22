const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec, execFileSync } = require('child_process');
const os = require('os');
const ailyCodeProject = require('./aily-code-project');
const targetCompileContext = require('./target-compile-context');
const { prepareCompileSource } = require('./compile-source');
const { createLibrarySourceFingerprint, createLibraryProjectionRecorder, writeLibraryProjections } = require('./library-source-evidence');
const { acquireBuildWorkspace, OWNER_ENV } = require('./build-workspace-lease');
const { invalidateBuildDelivery } = require('./compile-delivery');
const { readBuildRequest } = require('./build-request');
const { confirmBuildSource } = require('./build-source-capture');

const LIBRARY_CACHE_SCHEMA_VERSION = 2;
const CODER_LOCAL_LIBRARY_RECEIPT = '.aily-coder-local-library.json';

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
        config = readBuildRequest(configPath);
    } catch (error) {
        logger.error('Failed to read config file:', error);
        process.exit(1);
    }

    const workspace = acquireBuildWorkspace(config.currentProjectPath, 'preprocess', { inherited: process.env[OWNER_ENV] });
    try {
        confirmBuildSource(config);
        invalidateBuildDelivery(config.currentProjectPath);
        await preprocessProject(config, workspace);
        confirmBuildSource(config);
    } finally { workspace.release(); }
}

async function preprocessProject(config, workspace) {
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
    const libraryEvidence = config.recordProjectDelivery === true ? createLibraryProjectionRecorder() : undefined;

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
    const localLibrariesPath = isAilyCode
        ? ailyCodeProject.resolveLibrariesPath(currentProjectPath)
        : null;
    const librariesPath = path.join(tempPath, 'libraries');
    const preprocessCachePath = isAilyCode
        ? ailyCodeProject.resolvePreprocessResultPath(currentProjectPath)
        : path.join(tempPath, 'preprocess.json');
    
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
    const testContextInputs = targetCompileContext.captureInputs([
        projectPackageJsonPath, boardJsonPath, boardPackageJsonPath,
    ]);
    const boardDependencies = boardPackageJson.boardDependencies || {};

    // 缓存文件路径
    const cacheFilePath = path.join(tempPath, 'library-cache.json');
    let libraryCache = {};
    if (fs.existsSync(cacheFilePath)) {
        try {
            libraryCache = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
        } catch (e) {
            // ignore
        }
    }

    // 1. 创建文件夹
    mkdirp(tempPath);
    if (!isAilyCode) mkdirp(librariesPath);
    // Cache invalidation is a workspace mutation; do it only under the owner.
    fs.rmSync(preprocessCachePath, { force: true });

    // 2. One source-preparation authority for background and actual builds.
    await prepareCompileSource(config);

    // 3. 处理库文件
    // Coder passes package-local final src roots directly to aily-builder.
    // Localized/editable libraries remain physical roots under sketch/libraries
    // and are searched last so they override npm packages with the same headers.
    const libsPath = collectDependencyLibraryPackages(
        dependencies,
        currentProjectPath,
        isAilyCode
    );
    logger.log(`开始处理 ${libsPath.length} 个库文件`);
    let copiedLibraries = [];
    let librarySearchPaths;
    if (isAilyCode) {
        // Remove the obsolete projection created by older builds. New builds
        // never create .temp/lib* or copy/hard-link dependency sources.
        rm(path.join(currentProjectPath, '.temp', 'libraries'));
        rm(path.join(currentProjectPath, '.temp', 'library-cache.json'));
        librarySearchPaths = await resolveCoderLibrarySearchPaths(
            libsPath,
            currentProjectPath,
            za7Path,
            localLibrariesPath,
            libraryEvidence
        );
    } else {
        const componentLibraries = collectComponentLibraries(currentProjectPath);
        copiedLibraries = await processLibrariesParallel(
            libsPath,
            librariesPath,
            currentProjectPath,
            za7Path,
            developmentMode,
            libraryCache,
            libraryEvidence
        );
        copiedLibraries.push(...await processComponentLibraries(componentLibraries, librariesPath, libraryEvidence));
        librarySearchPaths = [librariesPath];
    }

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
    if (!isAilyCode) {
        librarySearchPaths = prependSdkLibrarySearchPath(fullSdkPath, librarySearchPaths);
    }

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
    logger.log('开始预编译...');
    const builderCommand = 'aily-builder';
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

    logger.log(`执行预编译: ${builderCommand} ${pre_args.join(' ')}`);

    // 使用同步执行预编译，确保完成后再继续
    await new Promise((resolve, reject) => {
        const preChild = spawn(builderCommand, pre_args, {
            cwd: currentProjectPath,
            shell: true,
            stdio: 'inherit',
            env: workspace.builderEnvironment('preprocess')
        });

        let spawnError;
        preChild.on('close', (code, signal) => {
            if (spawnError) { reject(spawnError); return; }
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
            spawnError = new Error(`预编译进程错误: ${error.message}`);
            if (!preChild.pid) reject(spawnError);
        });
    });

    workspace.assertBuilderIdle();
    try {
        targetCompileContext.publishTargetCompileContext(preprocessCachePath, currentProjectPath, testContextInputs);
    } catch (error) {
        logger.warn('无法写入 C++ 测试上下文:', error.message);
    }
    if (libraryEvidence) writeLibraryProjections(config, libraryEvidence);

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

function isCompilableLibraryPackage(packageName) {
    return typeof packageName === 'string'
        && (packageName.startsWith('@aily-project/lib-')
            || packageName.startsWith('@aily-project-coder/lib-'))
        && !packageName.startsWith('@aily-project/lib-core');
}

function collectLibraryPackages(projectDependencies, currentProjectPath, requireProjectOwnedPackages = false) {
    const libraries = [];
    const visited = new Set();
    const projectPath = path.resolve(currentProjectPath);
    const realProjectPath = fs.realpathSync(currentProjectPath);
    const pending = Object.keys(projectDependencies || {}).map(packageName => ({
        packageName,
        packagePath: path.join(projectPath, 'node_modules', packageName),
    }));

    for (let index = 0; index < pending.length; index++) {
        const { packageName, packagePath } = pending[index];
        if (!isCompilableLibraryPackage(packageName) || !fs.existsSync(packagePath)) {
            continue;
        }
        let realPackagePath;
        try {
            realPackagePath = fs.realpathSync(packagePath);
        } catch {
            continue;
        }
        // Coder package roots are compiler inputs, so keep its real paths inside
        // the project. Blockly keeps its established npm-link/junction behavior:
        // the project-owned node_modules entry may resolve to a canonical local
        // library outside the project and is staged into .temp/libraries.
        if ((requireProjectOwnedPackages && !isPathWithin(realProjectPath, realPackagePath))
            || visited.has(realPackagePath)) {
            continue;
        }
        visited.add(realPackagePath);
        libraries.push({
            packageName,
            packagePath: requireProjectOwnedPackages ? realPackagePath : packagePath
        });

        const packageJsonPath = path.join(realPackagePath, 'package.json');
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
            if (!isCompilableLibraryPackage(dependencyName)) return;
            const dependencyPath = resolveLibraryDependencyPath(
                packagePath,
                projectPath,
                dependencyName
            );
            if (dependencyPath) {
                pending.push({ packageName: dependencyName, packagePath: dependencyPath });
            }
        });
    }

    return libraries;
}

function resolveLibraryDependencyPath(parentPackagePath, projectRoot, dependencyName) {
    let cursor = parentPackagePath;
    while (isPathWithin(projectRoot, cursor)) {
        const candidate = path.join(cursor, 'node_modules', dependencyName);
        if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
        if (cursor === projectRoot) break;
        cursor = path.dirname(cursor);
    }
    return null;
}

function collectDependencyLibraryPackages(projectDependencies, currentProjectPath, isAilyCode = false) {
    return collectLibraryPackages(projectDependencies, currentProjectPath, isAilyCode);
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
 * Board SDKs may ship Arduino-compatible libraries beside their core and
 * variants. aily-builder does not discover that directory from --sdk-path,
 * so pass it explicitly. Keep it first: later project/package roots retain
 * their existing override precedence.
 */
function prependSdkLibrarySearchPath(fullSdkPath, librarySearchPaths) {
    const current = Array.isArray(librarySearchPaths) ? librarySearchPaths : [];
    const sdkLibrariesPath = path.join(fullSdkPath, 'libraries');
    if (!fs.existsSync(sdkLibrariesPath) || !fs.statSync(sdkLibrariesPath).isDirectory()) {
        return current;
    }

    const sdkRoot = path.resolve(sdkLibrariesPath);
    return [
        sdkLibrariesPath,
        ...current.filter(searchPath => path.resolve(searchPath) !== sdkRoot)
    ];
}

/**
 * Materialize project-local component libraries after npm libraries so an
 * editable project copy has the same precedence as a sketchbook Arduino
 * library. Components are intentionally refreshed every build: their source
 * is local, small, and must never be hidden behind the npm library cache.
 */
async function processComponentLibraries(componentLibraries, librariesPath, evidence) {
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
            const before = evidence?.capture(component.sourcePath);
            linkItem(component.sourcePath, targetPath, !!evidence);
            if (evidence) evidence.add(`component:${component.name}`, before, targetPath, [], true);
            copied.push(component.name);
        } catch (error) {
            throw new Error(`组件库 ${component.name} 处理失败: ${error.message}`);
        }
    }
    return copied;
}

async function processLibrariesParallel(libsPath, librariesPath, currentProjectPath, za7Path, devmode, libraryCache, evidence) {
    const tasks = libsPath.map(lib => processLibrary(lib, librariesPath, currentProjectPath, za7Path, devmode, libraryCache, evidence));
    const results = await Promise.all(tasks);
    const failures = results.flatMap((result, index) => result.success ? [] : [
        `${typeof libsPath[index] === 'string' ? libsPath[index] : libsPath[index].packageName}: ${result.error}`
    ]);
    if (failures.length > 0) {
        throw new Error(`Library source preparation failed:\n${failures.join('\n')}`);
    }
    
    const copiedLibraries = [];
    results.forEach(result => {
        copiedLibraries.push(...result.targetNames);
    });
    return copiedLibraries;
}

async function resolveCoderLibrarySearchPaths(libsPath, currentProjectPath, za7Path, localLibrariesPath, evidence) {
    const result = [];
    const seen = new Set();
    const localizedSourceRoots = collectLocalizedCoderSourceRoots(
        localLibrariesPath,
        currentProjectPath
    );

    const append = (sourcePath, owner = 'coder-local', inputs = []) => {
        if (!sourcePath || !fs.existsSync(sourcePath)) return;
        const canonical = fs.realpathSync(sourcePath);
        if (seen.has(canonical)) return;
        // Reject escaping/cyclic links before handing a source tree to the builder.
        createLibrarySourceFingerprint(canonical);
        if (evidence) evidence.add(owner, evidence.capture(canonical), canonical, inputs);
        seen.add(canonical);
        result.push(canonical);
    };

    for (const lib of libsPath) {
        const packageName = typeof lib === 'string' ? lib : lib.packageName;
        const packageRoot = typeof lib === 'string'
            ? path.join(currentProjectPath, 'node_modules', lib)
            : lib.packagePath;
        const sourcePathBase = path.join(packageRoot, 'src');
        const inputs = evidence ? [evidence.capture(path.join(packageRoot, 'package.json'))] : [];

        if (!fs.existsSync(sourcePathBase)) {
            const sourceZipPath = path.join(packageRoot, 'src.7z');
            if (!fs.existsSync(sourceZipPath)) {
                logger.warn(`库 ${packageName} 没有 src 或 src.7z，已跳过`);
                continue;
            }
            try {
                if (evidence) inputs.push(evidence.capture(sourceZipPath));
                extractLibrarySourceArchive(za7Path, sourceZipPath, sourcePathBase);
            } catch (error) {
                throw new Error(`库 ${packageName} 解压失败: ${error.message}`);
            }
        }

        const sourcePath = resolveNestedSrcPath(sourcePathBase);
        const packageOverrides = localizedSourceRoots.get(packageName);
        if (!packageOverrides?.size) {
            for (const searchRoot of coderLibraryCompileSearchRoots(sourcePath)) append(searchRoot, packageName, inputs);
            continue;
        }

        // A localized root is the editable project authority. Do not also hand
        // its npm-managed source to the builder: retaining both makes header and
        // library-name resolution depend on incidental scan order after reload.
        for (const root of coderPackageLibraryRoots(sourcePath)) {
            if (!packageOverrides.has(canonicalExistingPath(root))) {
                for (const searchRoot of coderLibraryCompileSearchRoots(root)) append(searchRoot, packageName, inputs);
            }
        }
    }

    // Local project libraries remain last so they override npm roots. Standard
    // Arduino libraries also contribute their src/ directory because that is
    // the public include and recursive compilation root.
    for (const searchRoot of coderLibraryCompileSearchRoots(localLibrariesPath)) append(searchRoot);
    return result;
}

function canonicalExistingPath(candidate) {
    try {
        return fs.realpathSync(candidate);
    } catch {
        return path.resolve(candidate);
    }
}

function collectLocalizedCoderSourceRoots(localLibrariesPath, currentProjectPath) {
    const result = new Map();
    if (!localLibrariesPath || !fs.existsSync(localLibrariesPath)) return result;

    for (const entry of fs.readdirSync(localLibrariesPath, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const receiptPath = path.join(localLibrariesPath, entry.name, CODER_LOCAL_LIBRARY_RECEIPT);
        let receipt;
        try {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        } catch {
            continue;
        }
        if (receipt?.source !== 'aily-chat'
            || typeof receipt.sourcePackage !== 'string'
            || typeof receipt.sourceLibraryRoot !== 'string') {
            continue;
        }
        const sourceRoot = path.resolve(currentProjectPath, receipt.sourceLibraryRoot);
        if (!isPathWithin(path.resolve(currentProjectPath), sourceRoot)) continue;
        const roots = result.get(receipt.sourcePackage) || new Set();
        roots.add(canonicalExistingPath(sourceRoot));
        result.set(receipt.sourcePackage, roots);
    }
    return result;
}

function coderPackageLibraryRoots(sourcePath) {
    if (!fs.existsSync(sourcePath)) return [];
    const entries = fs.readdirSync(sourcePath, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.'));
    if (entries.some(entry => !entry.isDirectory())) return [sourcePath];
    return entries.filter(entry => entry.isDirectory()).map(entry => path.join(sourcePath, entry.name));
}

function coderLibraryCompileSearchRoots(sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) return [];
    const result = [sourcePath];
    for (const libraryRoot of coderPackageLibraryRoots(sourcePath)) {
        const manifestPath = path.join(libraryRoot, 'library.properties');
        const standardSourceRoot = path.join(libraryRoot, 'src');
        if (fs.existsSync(manifestPath)
            && fs.existsSync(standardSourceRoot)
            && fs.statSync(standardSourceRoot).isDirectory()) {
            result.push(standardSourceRoot);
        }
    }
    return result;
}

async function processLibrary(lib, librariesPath, currentProjectPath, za7Path, devmode, libraryCache, evidence) {
    try {
        const packageName = typeof lib === 'string' ? lib : lib.packageName;
        const packageRoot = typeof lib === 'string'
            ? path.join(currentProjectPath, 'node_modules', lib)
            : lib.packagePath;
        const defaultPackageRoot = path.join(currentProjectPath, 'node_modules', packageName);
        const cacheKey = path.resolve(packageRoot) === path.resolve(defaultPackageRoot)
            ? packageName
            : path.relative(currentProjectPath, packageRoot).split(path.sep).join('/');
        const sourcePathBase = path.join(packageRoot, 'src');
        const inputs = evidence ? [evidence.capture(path.join(packageRoot, 'package.json'))] : [];

        // Prepare source
        let sourcePath = sourcePathBase;
        if (!fs.existsSync(sourcePath)) {
            const sourceZipPath = path.join(packageRoot, 'src.7z');
            if (fs.existsSync(sourceZipPath)) {
                try {
                    if (evidence) inputs.push(evidence.capture(sourceZipPath));
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
        const hasDirectFiles = hasDirectSourceFiles(sourcePath);
        const projections = hasDirectFiles
            ? [{ source: sourcePath, name: packageName.split('/').pop() }]
            : fs.readdirSync(sourcePath).filter(name => !name.startsWith('.') && fs.statSync(path.join(sourcePath, name)).isDirectory())
                .map(name => ({ source: path.join(sourcePath, name), name }));
        for (const entry of projections) {
            entry.target = resolveLibraryTargetPath(librariesPath, entry.name);
            if (!entry.target) throw new Error('Invalid library projection target.');
        }
        const cached = libraryCache[cacheKey];
        if (!evidence && !devmode && cached && isLibraryCacheValid(cached, sourceFingerprint, projections)) {
            return { targetNames: cached.targetNames, success: true };
        }

        removeCachedLibraryTargets(cached, librariesPath);

        // A final src root containing files is itself one Arduino library.
        // Only a directory-only wrapper is expanded into its immediate child roots.
        if (evidence) for (const entry of projections) {
            // Remove old hard links before taking file-state evidence; strict builds copy bytes.
            rm(entry.target);
            entry.before = evidence.capture(entry.source);
        }
        let result;
        if (hasDirectFiles) {
            result = await processLibraryWithHeaders(packageName, sourcePath, librariesPath, !!evidence);
        } else {
            result = await processLibraryDirectories(packageName, sourcePath, librariesPath, !!evidence);
        }

        if (result.success) {
            if (evidence) for (const entry of projections) evidence.add(packageName, entry.before, entry.target, inputs);
            libraryCache[cacheKey] = {
                schemaVersion: LIBRARY_CACHE_SCHEMA_VERSION,
                sourceFingerprint,
                hasHeaderFiles: hasDirectFiles,
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
    const extractedItems = fs.readdirSync(extractPath).filter(item => !item.startsWith('.'));
    const nestedSourcePath = path.join(extractPath, 'src');
    const extractedSourcePath = extractedItems.length === 1 && extractedItems[0] === 'src' && fs.statSync(nestedSourcePath).isDirectory()
        ? nestedSourcePath
        : extractPath;

    if (fs.existsSync(sourcePath)) {
        rm(sourcePath);
    }

    fs.renameSync(extractedSourcePath, sourcePath);
}

function isPathWithin(rootPath, candidatePath) {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === ''
        || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath));
}

function isLibraryCacheValid(cached, sourceFingerprint, projections) {
    return cached.schemaVersion === LIBRARY_CACHE_SCHEMA_VERSION
        && cached.sourceFingerprint === sourceFingerprint
        && Array.isArray(cached.targetNames)
        && cached.targetNames.length === projections.length
        && projections.every(entry => {
            if (!cached.targetNames.includes(entry.name)) return false;
            try {
                return createLibrarySourceFingerprint(entry.source) === createLibrarySourceFingerprint(entry.target);
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
    if (fs.existsSync(librariesRoot) && fs.lstatSync(librariesRoot).isSymbolicLink()) {
        throw new Error('Library projection root must not be a symlink/junction.');
    }
    const targetPath = path.resolve(librariesRoot, targetName);
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
        throw new Error('Library projection target must not be a symlink/junction.');
    }
    return isPathWithin(librariesRoot, targetPath) ? targetPath : null;
}

function resolveNestedSrcPath(sourcePath) {
    if (!fs.existsSync(sourcePath)) return sourcePath;
    try {
        let items = fs.readdirSync(sourcePath).filter(item => !item.startsWith('.'));
        while (items.length === 1 && items[0] === 'src') {
            const nested = path.join(sourcePath, 'src');
            if (fs.statSync(nested).isDirectory()) {
                sourcePath = nested;
                items = fs.readdirSync(sourcePath).filter(item => !item.startsWith('.'));
                continue;
            }
            break;
        }
    } catch (e) {}
    return sourcePath;
}

function hasDirectSourceFiles(sourcePath) {
    if (!fs.existsSync(sourcePath)) return false;
    try {
        return fs.readdirSync(sourcePath, { withFileTypes: true })
            .some(entry => !entry.name.startsWith('.') && entry.isFile());
    } catch {
        return false;
    }
}

async function processLibraryWithHeaders(lib, sourcePath, librariesPath, copyOnly = false) {
    const targetName = lib.split('/').pop();
    const targetPath = path.join(librariesPath, targetName);

    rm(targetPath);

    try {
        linkItem(sourcePath, targetPath, copyOnly);
        return { targetNames: [targetName], success: true };
    } catch (e) {
        return { targetNames: [], success: false, error: e.message };
    }
}

async function processLibraryDirectories(lib, sourcePath, librariesPath, copyOnly = false) {
    const targetNames = [];
    if (!fs.existsSync(sourcePath)) return { targetNames: [], success: true };

    const items = fs.readdirSync(sourcePath);
    for (const item of items) {
        if (item.startsWith('.')) continue;
        const fullSourcePath = path.join(sourcePath, item);
        if (fs.statSync(fullSourcePath).isDirectory()) {
            const targetPath = path.join(librariesPath, item);
            
            rm(targetPath);

            linkItem(fullSourcePath, targetPath, copyOnly);
            targetNames.push(item);
        }
    }
    return { targetNames, success: true };
}

function linkItem(src, dest, copyOnly = false) {
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true });
        }
        const items = fs.readdirSync(src);
        for (const item of items) {
            linkItem(path.join(src, item), path.join(dest, item), copyOnly);
        }
    } else {
        if (fs.existsSync(dest)) {
            fs.unlinkSync(dest);
        }
        if (copyOnly) { fs.copyFileSync(src, dest); return; }
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
    collectDependencyLibraryPackages,
    collectWorkspaceLibraries,
    collectLibraryPackages,
    createLibrarySourceFingerprint,
    isCompilableLibraryPackage,
    normalizeExtractedSourceDirectory,
    processComponentLibraries,
    processLibrariesParallel,
    prependSdkLibrarySearchPath,
    resolveCoderLibrarySearchPaths,
};
