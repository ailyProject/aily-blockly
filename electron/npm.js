// 这个文件用于和npm交互，获取仓库信息
const { ipcMain } = require("electron");
const { exec } = require('child_process');


function registerNpmHandlers(mainWindow) {
    ipcMain.handle('npm-run', async (event, { cmd }) => {
        console.log('npm run cmd: ', cmd);
        return new Promise((resolve, reject) => {
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    console.error(`执行命令出错: ${error}`);
                    return reject(error);
                }
                if (stderr && !stdout) {
                    return reject(new Error(stderr));
                }
                try {
                    // 直接解析 JSON，无需额外处理
                    const result = JSON.parse(stdout);
                    resolve(result);
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