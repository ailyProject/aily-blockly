import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class SettingsService {

  boardList: any[] = [];
  toolList: any[] = [];
  sdkList: any[] = [];
  compilerList: any[] = [];

  // 缓存 verdaccio-db 数据，避免重复请求
  private verdaccioDbCache: { list: string[], timestamp: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

  constructor(
    private http: HttpClient
  ) { }

  /**
   * 直接从 verdaccio 获取 .verdaccio-db.json 文件
   * 这个文件包含所有包的列表，比使用 search API 更快
   */
  async getVerdaccioDb(registry: string): Promise<string[]> {
    // 检查缓存是否有效
    if (this.verdaccioDbCache && (Date.now() - this.verdaccioDbCache.timestamp) < this.CACHE_TTL) {
      console.log('Using cached verdaccio-db');
      return this.verdaccioDbCache.list;
    }

    try {
      // 直接获取 .verdaccio-db.json 静态文件
      const dbJsonUrl = registry.replace(/\/?$/, '/') + 'vc-packages.json';
      const response: any = await this.http.get(dbJsonUrl).toPromise();
      
      // .verdaccio-db.json 格式: { "list": ["package1", "package2", ...], "secret": "..." }
      const packageList = response.list || [];
      
      this.verdaccioDbCache = {
        list: packageList,
        timestamp: Date.now()
      };
      
      console.log('Fetched verdaccio-db.json:', packageList.length);
      return packageList;
    } catch (error) {
      console.error('Failed to fetch verdaccio-db.json:', error);
      return [];
    }
  }

  /**
   * 获取单个包的详细信息（版本等）
   */
  async getPackageInfo(packageName: string, registry: string): Promise<any> {
    try {
      // 使用标准 npm registry API 获取包信息
      const apiUrl = registry.replace(/\/?$/, '/') + encodeURIComponent(packageName);
      const response: any = await this.http.get(apiUrl).toPromise();
      return response;
    } catch (error) {
      console.warn(`Failed to fetch package info for ${packageName}:`, error);
      return null;
    }
  }

  /**
   * 使用 verdaccio-db 快速筛选包列表
   * 先从 db 获取所有包名，筛选出匹配的，再批量获取详情
   */
  async searchByVerdaccioDb(searchKey: string, prefix: string, registry: string) {
    try {
      // 1. 获取所有包名列表
      const allPackages = await this.getVerdaccioDb(registry);
      
      // 2. 筛选匹配的包名
      const matchedPackages = allPackages.filter(name => name.startsWith(searchKey));
      console.log(`Found ${matchedPackages.length} packages matching "${searchKey}"`);
      
      if (matchedPackages.length === 0) {
        return [];
      }
      
      // 3. 获取已安装的依赖
      const installedDict = await this.getInstalledDependencies(prefix);
      
      // 4. 并行获取所有匹配包的详细信息
      const packageInfoPromises = matchedPackages.map(name => this.getPackageInfo(name, registry));
      const packageInfos = await Promise.all(packageInfoPromises);
      
      // 5. 构建结果列表
      const resultList = [];
      for (const packageInfo of packageInfos) {
        if (!packageInfo || !packageInfo.versions) continue;
        
        const packageName = packageInfo.name;
        const versions = packageInfo.versions;
        
        Object.keys(versions).forEach(version => {
          let installed = false;
          if (installedDict[packageName] && installedDict[packageName].version === version) {
            installed = true;
          }
          
          resultList.push({
            name: packageName,
            version: version,
            installed: installed,
            ...versions[version]
          });
        });
      }
      
      console.log('searchByVerdaccioDb result:', resultList.length);
      return resultList;
    } catch (error) {
      console.error('searchByVerdaccioDb failed, falling back to API search:', error);
      // 失败时回退到原来的 API 搜索
      return this.searchByAPI(searchKey, prefix, registry);
    }
  }

  async searchVersionsByAPI(packageName: string, registry: string) {
    const apiUrl = registry.replace(/\/?$/, '/') + '-/verdaccio/data/sidebar/' + encodeURIComponent(packageName);
    const response: any = await this.http.get(apiUrl).toPromise();
    const versions = response.versions || {};
    console.log('versions: ', versions);
    return versions;
  }

  async searchByAPI(searchKey: string, prefix: string, registry: string) {
    const apiUrl = registry.replace(/\/?$/, '/') + '-/v1/search?text=' + searchKey + '&size=250';
    const response: any = await this.http.get(apiUrl).toPromise();
    const searchResList = response.objects.map(obj => obj.package);
    const installedDict = await this.getInstalledDependencies(prefix);
    const resultList = [];
    for (const item of searchResList) {
      const versions_dict = await this.searchVersionsByAPI(item.name, registry);
      // 轮询所有版本,判断是否安装

      Object.keys(versions_dict).forEach(version => {
        // 判断名称与版本是否对应
        let installed = false;
        if (installedDict[item.name] && installedDict[item.name].version === version) {
          installed = true;
        }

        resultList.push({
          name: item.name,
          version: version,
          installed: installed,
          ...versions_dict[version]
        });
      });
    }
    console.log('searchResList: ', resultList);
    return resultList;
  }


  async getToolList(prefix: string, registry: string) {
    this.toolList = await this.searchByVerdaccioDb('@aily-project/tool-', prefix, registry);
  }

  async getSdkList(prefix: string, registry: string) {
    this.sdkList = await this.searchByVerdaccioDb('@aily-project/sdk-', prefix, registry);
  }

  async getCompilerList(prefix: string, registry: string) {
    this.compilerList = await this.searchByVerdaccioDb('@aily-project/compiler-', prefix, registry);
  }

  async getBoardList(prefix: string, registry: string) {
    this.boardList = await this.searchByVerdaccioDb('@aily-project/board-', prefix, registry);
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
