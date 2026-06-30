'use strict';

/**
 * 判断项目根是否为 Aily Code 布局（存在 project.aci）。
 * Blockly 打开的 aily-code 骨架与纯 Blockly 工程的区分点在此文件。
 */
const fs = require('fs');
const path = require('path');

function isAilyCodeProjectRoot(projectRoot) {
    return fs.existsSync(path.join(projectRoot, 'project.aci'));
}

/**
 * 从 project.aci 读取 entry，默认为 src/main.cpp，返回绝对路径。
 * 仅在 isAilyCodeProjectRoot 为 true 时调用。
 */
function resolveCompileSourcePath(projectRoot) {
    const aciPath = path.join(projectRoot, 'project.aci');
    let entry = 'src/main.cpp';
    try {
        const aci = JSON.parse(fs.readFileSync(aciPath, 'utf8'));
        if (aci.entry && typeof aci.entry === 'string') {
            entry = aci.entry.replace(/\\/g, '/');
        }
    } catch (e) {
        // entry 缺失或 JSON 损坏时使用默认入口
    }
    const segments = entry.split('/').filter(Boolean);
    return path.normalize(path.join(projectRoot, ...segments));
}

/**
 * 固件输出目录：`.aily/build/<frameworkSegment>`，
 * framework 取自 project.aci.target.framework，缺省为 devmode 再缺省 arduino。
 */
function resolveFrameworkBuildDir(projectRoot) {
    const aciPath = path.join(projectRoot, 'project.aci');
    let fw = 'arduino';
    try {
        const aci = JSON.parse(fs.readFileSync(aciPath, 'utf8'));
        const raw = aci?.target?.framework ?? aci?.devmode ?? 'arduino';
        fw = String(raw || 'arduino').trim() || 'arduino';
    } catch (e) {
        // 使用默认框架名
    }
    const seg = fw.toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'arduino';
    return path.join(projectRoot, '.aily', 'build', seg);
}

module.exports = {
    isAilyCodeProjectRoot,
    resolveCompileSourcePath,
    resolveFrameworkBuildDir
};
