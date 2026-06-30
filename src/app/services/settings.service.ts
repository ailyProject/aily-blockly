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

  // 缓存版本清单数据，避免重复请求
  private packageVersionListCache = new Map<string, { list: string[], timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
  /** 同一 registry 并发请求时共用一个请求，避免并行三次 vc-package-versions.json */
  private packageVersionListInflight = new Map<string, Promise<string[]>>();

  constructor(
    private http: HttpClient
  ) { }

  /**
   * 直接从 verdaccio 获取带版本的包列表，比逐包获取版本更快
   */
  async getPackageVersionList(registry: string): Promise<string[]> {
    const registryKey = registry.replace(/\/?$/, '/');
    const cached = this.packageVersionListCache.get(registryKey);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      console.log('Using cached package version list');
      return cached.list;
    }

    let inflight = this.packageVersionListInflight.get(registryKey);
    if (inflight) {
      return inflight;
    }

    inflight = (async (): Promise<string[]> => {
      try {
        const packageVersionsUrl = registryKey + 'vc-package-versions.json';
        const response: any = await this.http.get(packageVersionsUrl).toPromise();

        const packageList = response.list || [];

        this.packageVersionListCache.set(registryKey, {
          list: packageList,
          timestamp: Date.now()
        });

        console.log('Fetched vc-package-versions.json:', packageList.length);
        return packageList;
      } catch (error) {
        console.error('Failed to fetch vc-package-versions.json:', error);
        throw error;
      } finally {
        this.packageVersionListInflight.delete(registryKey);
      }
    })();

    this.packageVersionListInflight.set(registryKey, inflight);
    return inflight;
  }

  private parsePackageVersion(packageVersion: string): { name: string, version: string } | null {
    const value = packageVersion.trim();
    const versionSeparatorIndex = value.lastIndexOf('@');
    if (versionSeparatorIndex <= 0 || versionSeparatorIndex === value.length - 1) {
      return null;
    }

    return {
      name: value.slice(0, versionSeparatorIndex),
      version: value.slice(versionSeparatorIndex + 1)
    };
  }

  /**
   * 使用带版本的包列表快速筛选依赖，不再逐包获取版本详情
   */
  async searchByVerdaccioDb(searchKey: string, prefix: string, registry: string) {
    try {
      const allPackageVersions = await this.getPackageVersionList(registry);
      
      const matchedPackages = allPackageVersions
        .map(item => this.parsePackageVersion(item))
        .filter((item): item is { name: string, version: string } => !!item && item.name.startsWith(searchKey));
      console.log(`Found ${matchedPackages.length} package versions matching "${searchKey}"`);
      
      if (matchedPackages.length === 0) {
        return [];
      }
      
      const installedDict = await this.getInstalledDependencies(prefix);
      
      const resultList = matchedPackages.map(item => ({
        name: item.name,
        version: item.version,
        installed: installedDict[item.name]?.version === item.version
      }));
      
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
      // 首先尝试 npm ls（prefix 必须加引号：macOS 常见路径含 Application Support 空格，否则 exec 会拆参失败）
      const cmd = `npm ls --json=true --depth=0 --silent --prefix "${prefix}"`;
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
