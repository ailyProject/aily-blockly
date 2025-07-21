import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {

  boardList: any[] = [];
  toolList: any[] = [];
  sdkList: any[] = [];
  compilerList: any[] = [];

  constructor() { }

  async getToolList(prefix: string, registry: string) {
    const cmd = `npm search @aily-project/tool- --json=true --registry=${registry}`;
    const result = await window['npm'].run({ cmd });
    const allToolList = JSON.parse(result);

    const installedDict = await this.getInstalledDependencies(prefix);
    allToolList.forEach((tool) => {
      // 判断名称与版本是否对应
      if (installedDict[tool.name] && installedDict[tool.name].version === tool.version) {
        tool.installed = true;
      } else {
        tool.installed = false;
      }
    });

    console.log('allToolList: ', allToolList);
    this.toolList = allToolList;
  }

  async getSdkList(prefix: string, registry: string) {
    const cmd = `npm search @aily-project/sdk- --json=true --registry=${registry}`;
    const result = await window['npm'].run({ cmd });
    const allSdkList = JSON.parse(result);

    const installedDict = await this.getInstalledDependencies(prefix);
    allSdkList.forEach((sdk) => {
      // 判断名称与版本是否对应
      if (installedDict[sdk.name] && installedDict[sdk.name].version === sdk.version) {
        sdk.installed = true;
      } else {
        sdk.installed = false;
      }
    });
    this.sdkList = allSdkList;

    // console.log('sdkList: ', this.sdkList);
  }

  async getCompilerList(prefix: string, registry: string) {
    const cmd = `npm search @aily-project/compiler- --json=true --registry=${registry}`;
    const result = await window['npm'].run({ cmd });
    const allCompilerList = JSON.parse(result);

    const installedDict = await this.getInstalledDependencies(prefix);
    allCompilerList.forEach((compiler) => {
      // 判断名称与版本是否对应
      if (installedDict[compiler.name] && installedDict[compiler.name].version === compiler.version) {
        compiler.installed = true;
      } else {
        compiler.installed = false;
      }
    });
    this.compilerList = allCompilerList;

    // console.log('compilerList: ', this.compilerList);
  }

  async getBoardList(prefix: string, registry: string) {
    const allBoardList = await this.getAllBoardList(registry);
    const installedDict = await this.getInstalledDependencies(prefix);
    allBoardList.forEach((board) => {
      // 判断名称与版本是否对应
      if (installedDict[board.name] && installedDict[board.name].version === board.version) {
        board.installed = true;
      } else {
        board.installed = false;
      }
    });
    this.boardList = allBoardList;

    // console.log('boardList: ', this.boardList);
  }

  async getAllBoardList(registry) {
    // 执行搜索时，配置的scope registry使用不到，需要在命令行中指定registry
    const cmd = `npm search @aily-project/board- --json=true --registry=${registry}`
    const result = await window['npm'].run({ cmd });
    const allBoardList = JSON.parse(result);
    // const allBoardList = await window['dependencies'].boardList();
    // console.log('allBoardList: ', allBoardList);
    return allBoardList;
  }

  // installed dependencies
  async getInstalledDependencies(prefix: string) {
    try {
      // 首先尝试 npm ls
      const cmd = `npm ls --json=true --depth=0 --silent --prefix ${prefix}`;
      const result = await window['npm'].run({ cmd });
      const installedDict = JSON.parse(result);
      return installedDict["dependencies"] || {};
    } catch (error) {
      try {
        console.warn('npm ls failed, fallback to directory scan');

        // 备选方案：直接扫描 node_modules 目录
        const nodeModulesPath = `${prefix}/node_modules`;
        const dependencies = {};

        if (window['fs'].existsSync(nodeModulesPath)) {
          // 不使用 withFileTypes，直接获取文件名数组
          const dirs = window['fs'].readDirSync(nodeModulesPath);

          for (const dir of dirs) {
            console.log("dirName: ", dir.name);
            if (!dir.name.startsWith('.')) {
              const dirPath = window['path'].join(nodeModulesPath, dir.name);
              // 使用 statSync 检查是否为目录
              try {
                if (window['path'].isDir(dirPath)) {
                  // 检查是否为 scoped package（以 @ 开头）
                  if (dir.name.startsWith('@')) {
                    // 处理 scoped packages，需要扫描 scope 目录下的子目录
                    const scopedDirs = window['fs'].readDirSync(dirPath);
                    for (const scopedDir of scopedDirs) {
                      console.log("scopedDirName: ", scopedDir.name);
                      if (!scopedDir.name.startsWith('.')) {
                        const scopedDirPath = window['path'].join(dirPath, scopedDir.name);
                        try {
                          if (window['path'].isDir(scopedDirPath)) {
                            const packageJsonPath = window['path'].join(scopedDirPath, 'package.json');
                            if (window['fs'].existsSync(packageJsonPath)) {
                              const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
                              dependencies[packageJson.name] = {
                                version: packageJson.version
                              };
                            }
                          }
                        } catch (scopedStatError) {
                          // 如果 scoped package stat 失败，跳过这个条目
                          console.warn(`Failed to stat scoped directory ${scopedDirPath}: `, scopedStatError);
                          continue;
                        }
                      }
                    }
                  } else {
                    // 处理普通 packages
                    const packageJsonPath = window['path'].join(nodeModulesPath, dir.name, 'package.json');
                    if (window['fs'].existsSync(packageJsonPath)) {
                      const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
                      dependencies[packageJson.name] = {
                        version: packageJson.version
                      };
                    }
                  }
                }
              } catch (statError) {
                // 如果 stat 失败，跳过这个条目
                console.warn(`Failed to stat directory ${dirPath}: `, statError);
                continue;
              }
            }
          }
        }
        console.log("dependencies: ", dependencies);
        return dependencies;
      } catch (fsError) {
        console.error('Directory scan failed: ', fsError);
        return {};
      }
    }
  }

  async install(lib) {
    // 根据board对象的name来判断是工具还是sdk还是compiler-
    let action = '';
    if (lib.name.startsWith('@aily-project/tool-')) {
      action = 'install-tool';
    } else if (lib.name.startsWith('@aily-project/sdk-')) {
      action = 'install-sdk';
    } else if (lib.name.startsWith('@aily-project/compiler-')) {
      action = 'install-compiler';
    }
    const result = await window['iWindow'].send({
      to: "main",
      timeout: 1000 * 60 * 5,
      data: {
        action: 'npm-exec',
        detail: {
          action: action,
          data: JSON.stringify(lib)
        }
      }
    })

    console.log("install result: ", result);
    return result;
  }

  async uninstall(lib) {
    // 根据board对象的name来判断是工具还是sdk还是compiler-
    let action = '';
    if (lib.name.startsWith('@aily-project/tool-')) {
      action = 'uninstall-tool';
    } else if (lib.name.startsWith('@aily-project/sdk-')) {
      action = 'uninstall-sdk';
    } else if (lib.name.startsWith('@aily-project/compiler-')) {
      action = 'uninstall-compiler';
    }

    const result = await window['iWindow'].send({
      to: "main",
      timeout: 1000 * 60 * 5,
      data: {
        action: 'npm-exec',
        detail: {
          action: action,
          data: JSON.stringify(lib)
        }
      }
    })

    console.log("uninstall result: ", result);
    return result;
  }
}
