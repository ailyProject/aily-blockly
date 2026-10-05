'use strict';
const fs = require('node:fs');
const path = require('node:path');
const isPathWithin = (root, candidate) => { const relative = path.relative(root, candidate); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

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
            console.warn(`Library package is not installed: ${packageName}`);
            continue;
        }

        let packageJson;
        try {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        } catch (error) {
            console.warn(`Failed to read library package.json: ${packageJsonPath}: ${error.message}`);
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

module.exports = { isCompilableLibraryPackage, collectLibraryPackages };
