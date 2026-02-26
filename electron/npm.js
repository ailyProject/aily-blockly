// 这个文件用于和npm交互，获取仓库信息
const { ipcMain } = require("electron");
const { exec } = require('child_process');


function registerNpmHandlers(mainWindow) {
    ipcMain.handle('npm-run', async (event, { cmd, option = {} }) => {
        console.log('npm run cmd: ', cmd);
        return new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    if (option?.ignoreErr) {
                        return resolve(false);
                    }
                    console.error(`执行命令出错: ${error}`);
                    return reject(error);
                }
                if (stderr && !stdout) {
                    return reject(new Error(stderr));
                }
                try {
                    resolve(stdout);
                } catch (e) {
                    reject(new Error(e.message));
                }
            });
        })
    });
}

module.exports = {
    registerNpmHandlers,
};