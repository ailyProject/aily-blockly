// 这个文件负责下载package并放到对应位置
const { ipcMain } = require("electron");
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');

// 当前以arduino-cli来下载
const cliPath = '.\\child\\arduino-cli.exe';

function installPackageByArduinoCli(packageName, cliYamlPath) {
    console.log('installPackageByArduinoCli', packageName, cliYamlPath);
    return new Promise((resolve, reject) => {
        const arduinoCli = spawn(cliPath, ['core', 'install', packageName, '--config-file', cliYamlPath]);
        arduinoCli.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
        });
        arduinoCli.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
        });
        arduinoCli.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
        if (code === 0) {
            resolve();
        } else {
            reject();
        }
        });
    });
}

// 安装包
function installDependencies(package, prefix='') {
    return new Promise((resolve, reject) => {
        const args = ['i', package, '--registry', process.env.AILY_NPM_REGISTRY];
        if (prefix) {
            args.push('--prefix', prefix);
        }

        console.log("npm install args: ", args);
        const child = spawn('npm', args, { shell: true });
        child.stdout.on('data', (data) => {
            console.log(data.toString());
        });
        child.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`npm process exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

// 传入package.json文件安装依赖
function installDependenciesByFile(packageJsonPath) {
    return new Promise((resolve, reject) => {
        const args = ['i', '--registry', process.env.AILY_NPM_REGISTRY];
        const child = spawn('npm', args, { cwd: path.dirname(packageJsonPath), shell: true });
        child.stdout.on('data', (data) => {
            console.log(data.toString());
        });
        child.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`npm process exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

// board包列表
function searchBoards() {
    return new Promise((resolve, reject) => {
        // npm search --json=true --registry=process.env.AILY_NPM_REGISTRY
        const child = spawn('npm', ['search', '@aily-project/board' ,'--json=true', '--registry', process.env.AILY_NPM_REGISTRY], { shell: true });
        let result = '';
        child.stdout.on('data', (data) => {
            result += data.toString();
        });
        child.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`npm process exited with code ${code}`));
            } else {
                resolve(JSON.parse(result));
            }
        });
    });
}

// 已安装的依赖列表
function installedDependencies() {
    // console.log("processEnv: ", process.env)
    const currentPrjPath = process.env.AILY_PRJ_PATH;
    if (!currentPrjPath) {
        return Promise.resolve([]);
    }
    return new Promise((resolve, reject) => {
        const child = spawn('npm', ['ls', '--json=true', '--depth=0', `--prefix=${currentPrjPath}`], { shell: true });
        let result = '';
        child.stdout.on('data', (data) => {
            result += data.toString();
        });
        child.stderr.on('data', (data) => {
            console.error(data.toString());
        });
        child.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`npm process exited with code ${code}`));
            } else {
                resolve(JSON.parse(result));
            }
        });
    });
}


function registerBoardHandlers(mainWindow) {
    ipcMain.handle("builder-init", async (event, data) => {
        try {
            const deps = getDependencies(data.prjPath);
            // arduino-cli配置文件路径（每个项目下都有一个）
            let cliYamlPath = initArduinoCliConf(data.prjPath, data.appDataPath)

            const core = deps.boardConfList[0].core;
            await installPackageByArduinoCli(core, cliYamlPath);

            await Promise.all(
                deps.libraryConfList.map(async (libraryConf) => {
                    // TODO: 处理 library 安装逻辑
                })
            );

            // 临时文件夹路径
            const tmpPath = createTemporaryProject();

            genBuilderJson({
                core,
                cliYamlPath,
                type: deps.boardConfList[0].type,
                sketchPath: path.join(tmpPath, 'mySketch'),
                compilerOutput: path.join(tmpPath, 'output'),
                compilerParam: deps.boardConfList[0].compilerParam,
                uploadParam: deps.boardConfList[0].uploadParam,
            }, data.prjPath);

            return { success: true };
        } catch (error) {
            console.error("builder-init error: ", error);
            return { success: false };
        }
    });

    ipcMain.handle("dependencies-init", async (event, data) => {
        try {
            initNpmRegistry();
            return { success: true };
        } catch (error) {
            console.error("package-init error: ", error);
            return { success: false };
        }
    });

    ipcMain.handle("dependencies-install", async (event, data) => {
        try {
            if (data?.file && data?.file.endsWith('package.json')) {
                await installDependenciesByFile(data.file);
            } else {
                if (data?.global) {
                    await installDependencies(data?.package, process.env.AILY_NPM_PREFIX);
                } else {
                    await installDependencies(data?.package);
                }
            }
            return { success: true };
        } catch (error) {
            console.error("package-install error: ", error);
            return { success: false };
        }
    });

    ipcMain.handle("board-list", async (event, data) => {
        try {
            const boards = await searchBoards();
            return { success: true, boards };
        } catch (error) {
            console.error("board-list error: ", error);
            return { success: false };
        }
    });

    ipcMain.handle("installed-dependencies", async (event, data) => {
        try {
            const result = await installedDependencies();
            const deps = result.dependencies ? result.dependencies : [];
            return { success: true, deps };
        } catch (error) {
            console.error("installed-dependencies error: ", error);
            return { success: false };
        }
    });
}

module.exports = {
    registerBoardHandlers
}