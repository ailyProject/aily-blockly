const { ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");

function writePackageJson(data, prjPath) {
  const boardParts = data.boardValue.split('@');
  const boardDeps = boardParts[1];
  const boardDepsVersion = boardParts[2];

  const packageJson = {
    name: data.name,
    version: data.version,
    description: data.description,
    main: "index.js",
    board: data.board,
    scripts: {
      start: "electron ."
    },
    dependencies: {
      [`@${boardDeps}`]: `^${boardDepsVersion}`
    }
  }
  const packageJsonPath = path.join(prjPath, "package.json");
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

/**
 * 新建临时项目文件夹，并生成 package.json 文件
 */
function createTemporaryProject() {
  // 使用操作系统提供的临时目录（Windows 下通常是 C:\Users\<User>\AppData\Local\Temp）
  const tmpDir = os.tmpdir();

  // 生成一个唯一的目录名称
  const projectFolderName = `aily-project-${Date.now()}`;
  const projectFolderPath = path.join(tmpDir, 'aily-project', projectFolderName);

  // 创建临时文件夹
  fs.mkdirSync(projectFolderPath, { recursive: true });

  console.log(`临时项目文件夹已创建于: ${projectFolderPath}`);
  return projectFolderPath;
}


function createProject(data) {
  if (!fs.existsSync(data.path)) {
    fs.mkdirSync(data.path, { recursive: true });
  }

  // 判断projectName项目是否已存在
  const projectPath = path.join(data.path, data.name);
  if (fs.existsSync(projectPath)) {
    throw new Error("项目已存在");
  }

  // 创建项目文件夹
  fs.mkdirSync(projectPath, { recursive: true });

  // 生成 package.json 文件
  writePackageJson(data, projectPath);

  return projectPath;
}

function registerProjectHandlers(mainWindow) {
  ipcMain.handle("project-new", async (event, data) => {
    try {
      const projectPath = createProject(data);
      return { success: true, data: projectPath };
    } catch (error) {
      console.error("project-new error: ", error);
      return { success: false };
    }
  });

  ipcMain.handle("project-newTmp", async (event, data) => {
    try {
      const projectPath = createTemporaryProject();
      return { success: true, data: projectPath };
    } catch (error) {
      console.error("project-tmp error: ", error);
      return { success: false };
    }
  });

  ipcMain.on('project-update', (event, data) => {
    if (mainWindow) {
      mainWindow.webContents.send('project-update', data);
    }
  });
}

module.exports = {
  registerProjectHandlers
}