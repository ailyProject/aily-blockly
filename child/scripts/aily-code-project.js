'use strict';

/**
 * 判断项目根是否为 Coder 布局（package.json.type === "coder"）。
 * Blockly 打开的 aily-code 骨架与纯 Blockly 工程的区分点在此文件。
 */
const fs = require('fs');
const path = require('path');

function isAilyCodeProjectRoot(projectRoot) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
        return manifest?.type === 'coder';
    } catch {
        return false;
    }
}

function resolveCompileWorkspacePath(projectRoot) {
    return path.join(projectRoot, 'sketch');
}

/**
 * 从 package.json 读取 entry，默认为 src/main.cpp，返回绝对路径。
 * 仅在 isAilyCodeProjectRoot 为 true 时调用。
 */
function resolveCompileSourcePath(projectRoot) {
    const packagePath = path.join(projectRoot, 'package.json');
    let entry = 'src/main.cpp';
    try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        if (manifest.entry && typeof manifest.entry === 'string') {
            entry = manifest.entry.replace(/\\/g, '/');
        }
    } catch (e) {
        // entry 缺失或 JSON 损坏时使用默认入口
    }
    const segments = entry.split('/').filter(Boolean);
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry) || segments.includes('..')) {
        throw new Error(`package.json entry escapes the sketch workspace: ${entry}`);
    }
    return path.normalize(path.join(resolveCompileWorkspacePath(projectRoot), ...segments));
}

function resolveLibrariesPath(projectRoot) {
    return path.join(resolveCompileWorkspacePath(projectRoot), 'libraries');
}

function resolvePreprocessResultPath(projectRoot) {
    return path.join(resolveCompileWorkspacePath(projectRoot), 'preprocess.json');
}

/**
 * 固件输出目录：`.aily/build/<frameworkSegment>`，
 * framework 取自 package.json.framework，缺省为 devmode 再缺省 arduino。
 */
function resolveFrameworkBuildDir(projectRoot) {
    const packagePath = path.join(projectRoot, 'package.json');
    let fw = 'arduino';
    try {
        const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
        const raw = manifest?.framework ?? manifest?.devmode ?? 'arduino';
        fw = String(raw || 'arduino').trim() || 'arduino';
    } catch (e) {
        // 使用默认框架名
    }
    const seg = fw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'arduino';
    return path.join(projectRoot, '.aily', 'build', seg);
}

module.exports = {
    isAilyCodeProjectRoot,
    resolveCompileWorkspacePath,
    resolveCompileSourcePath,
    resolveLibrariesPath,
    resolvePreprocessResultPath,
    resolveFrameworkBuildDir
};
