'use strict';

const fs = require('fs');
const path = require('path');

/** runtimeDependencies → 与 Blockly boardDependencies 同构的 npm 声明表 */
function runtimeDependenciesToBoardDependencies(runtimeDependencies) {
    const result = {};
    if (!Array.isArray(runtimeDependencies)) {
        return result;
    }
    for (const item of runtimeDependencies) {
        const pkg = String(item?.package ?? '').trim();
        const ver = String(item?.version ?? '').trim();
        if (pkg && ver) {
            result[pkg] = ver;
        }
    }
    return result;
}

/** 从 AppData node_modules 中读取已安装 platform 包的 platform.json */
function readPlatformManifestFromAppData(appDataPath, platformPackageName) {
    const name = String(platformPackageName ?? '').trim();
    if (!name) {
        return null;
    }
    const manifestPath = path.join(appDataPath, 'node_modules', name, 'platform.json');
    if (!fs.existsSync(manifestPath)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
        return null;
    }
}

/** 从 Coder 工程 package.json 解析 platform npm 包名与可选版本。 */
function readPlatformRefFromProjectPackage(projectPath) {
    const packagePath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packagePath)) {
        return null;
    }
    try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (manifest?.type !== 'coder') {
            return null;
        }
        const packageName = String(manifest?.platform ?? '').trim();
        if (!packageName) {
            return null;
        }
        const version = String(manifest?.platformVersion ?? '').trim();
        return { packageName, ...(version ? { version } : {}) };
    } catch {
        return null;
    }
}

/** 合并主板 boardDependencies 与 platform runtimeDependencies（后者覆盖同名键） */
function mergeBoardDependencies(boardDependencies, platformRuntimeDeps) {
    return {
        ...(boardDependencies || {}),
        ...(platformRuntimeDeps || {}),
    };
}

/**
 * 解析 Aily Code 工程最终应使用的平台依赖（board + platform.json runtimeDependencies）。
 * platform 包须已安装到 AppData node_modules。
 */
function resolveEffectiveBoardDependencies(boardDependencies, appDataPath, platformPackageName) {
    const base = { ...(boardDependencies || {}) };
    const platformName = String(platformPackageName ?? '').trim();
    if (!platformName) {
        return base;
    }
    const manifest = readPlatformManifestFromAppData(appDataPath, platformName);
    const runtimeDeps = runtimeDependenciesToBoardDependencies(manifest?.runtimeDependencies);
    return mergeBoardDependencies(base, runtimeDeps);
}

module.exports = {
    runtimeDependenciesToBoardDependencies,
    readPlatformManifestFromAppData,
    readPlatformRefFromProjectPackage,
    mergeBoardDependencies,
    resolveEffectiveBoardDependencies,
};
