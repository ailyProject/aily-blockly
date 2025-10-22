// extension-loader.service.ts
import { Injectable } from '@angular/core'
import {
  registerExtension,
  ExtensionHostKind,
  type IExtensionManifest
} from '@codingame/monaco-vscode-api/extensions'
import type * as vscode from 'vscode'

export interface ExtensionLoadResult {
  id: string
  manifest: IExtensionManifest
  dispose: () => Promise<void>
  whenReady: () => Promise<void>
  getApi?: () => Promise<typeof vscode>
}

export interface ExtensionFileInfo {
  /** 扩展内的相对路径 */
  path: string
  /** 实际文件的 URL */
  url: string
  /** MIME 类型（可选） */
  mimeType?: string
}

@Injectable({
  providedIn: 'root'
})
export class ExtensionLoaderService {
  private loadedExtensions = new Map<string, ExtensionLoadResult>()

  /**
   * 从指定路径加载扩展
   * @param extensionPath 扩展所在的静态资源路径（例如：'assets/vscode-extensions/cpp'）
   * @param options 扩展配置选项
   */
  async loadExtension(
    extensionPath: string,
    options?: {
      /** 扩展主机类型，默认为 LocalWebWorker */
      hostKind?: ExtensionHostKind
      /** 是否为系统扩展，默认为 false */
      system?: boolean
      /** README 文件路径（相对于扩展目录） */
      readmePath?: string
      /** CHANGELOG 文件路径（相对于扩展目录） */
      changelogPath?: string
    }
  ): Promise<ExtensionLoadResult> {
    const baseUrl = extensionPath.endsWith('/') ? extensionPath : `${extensionPath}/`

    try {
      console.log(`Loading extension from: ${baseUrl}`)

      // 1. 加载 package.json
      const manifestUrl = `${baseUrl}package.json`
      const response = await fetch(manifestUrl)

      if (!response.ok) {
        throw new Error(`Failed to load manifest from ${manifestUrl}: ${response.statusText}`)
      }

      const manifest: IExtensionManifest = await response.json()
      const extensionId = `${manifest.publisher}.${manifest.name}`

      // 检查是否已加载
      if (this.loadedExtensions.has(extensionId)) {
        console.log(`Extension ${extensionId} already loaded`)
        return this.loadedExtensions.get(extensionId)!
      }

      console.log(`Registering extension: ${manifest.name} v${manifest.version}`)

      // 2. 注册扩展
      const hostKind = options?.hostKind ?? ExtensionHostKind.LocalWebWorker
      const registrationResult = registerExtension(
        manifest,
        hostKind,
        {
          system: options?.system ?? false,
          readmePath: options?.readmePath,
          changelogPath: options?.changelogPath
        }
      )

      // 3. 收集并注册扩展文件
      const files = this.collectExtensionFiles(manifest, baseUrl)
      console.log(`Collected ${files.length} files for extension ${manifest.name}`)

      // 只有 LocalWebWorker 和 LocalProcess 才有 registerFileUrl
      if ('registerFileUrl' in registrationResult) {
        for (const file of files) {
          try {
            (registrationResult as any).registerFileUrl(file.path, file.url, file.mimeType)
            console.log(`✓ Registered file: ${file.path}`)
          } catch (error) {
            console.warn(`✗ Failed to register file ${file.path}:`, error)
          }
        }
      } else {
        console.warn(`Extension host kind does not support registerFileUrl`)
      }
      // 4. 等待扩展准备就绪
      await registrationResult.whenReady()
      console.log(`Extension ${manifest.name} loaded successfully`)
      const result: ExtensionLoadResult = {
        id: registrationResult.id,
        manifest,
        dispose: registrationResult.dispose,
        whenReady: registrationResult.whenReady,
        getApi: 'getApi' in registrationResult ? (registrationResult.getApi as () => Promise<typeof vscode>) : undefined
      }

      this.loadedExtensions.set(extensionId, result)

      return result
    } catch (error) {
      console.error(`Failed to load extension from ${extensionPath}:`, error)
      throw error
    }
  }

  /**
   * 注册一个虚拟扩展（不从文件系统加载）
   * 用于注册自定义的语言提供者、命令等
   */
  async registerVirtualExtension(
    manifest: IExtensionManifest,
    hostKind: ExtensionHostKind = ExtensionHostKind.LocalProcess
  ): Promise<ExtensionLoadResult> {
    const extensionId = `${manifest.publisher}.${manifest.name}`

    if (this.loadedExtensions.has(extensionId)) {
      console.log(`Virtual extension ${extensionId} already registered`)
      return this.loadedExtensions.get(extensionId)!
    }

    console.log(`Registering virtual extension: ${manifest.name}`)

    const registrationResult = registerExtension(manifest, hostKind)

    await registrationResult.whenReady()

    const result: ExtensionLoadResult = {
      id: registrationResult.id,
      manifest,
      dispose: registrationResult.dispose,
      whenReady: registrationResult.whenReady,
      getApi: 'getApi' in registrationResult ? (registrationResult.getApi as () => Promise<typeof vscode>) : undefined
    }

    this.loadedExtensions.set(extensionId, result)

    return result
  }

  /**
   * 批量加载多个扩展
   */
  async loadExtensions(
    extensions: Array<{
      path: string
      options?: {
        hostKind?: ExtensionHostKind
        system?: boolean
        readmePath?: string
        changelogPath?: string
      }
    }>
  ): Promise<ExtensionLoadResult[]> {
    const results: ExtensionLoadResult[] = []

    for (const extension of extensions) {
      try {
        const result = await this.loadExtension(extension.path, extension.options)
        results.push(result)
      } catch (error) {
        console.error(`Failed to load extension from ${extension.path}:`, error)
        // 继续加载其他扩展
      }
    }

    return results
  }

  /**
   * 获取已加载的扩展
   */
  getLoadedExtension(extensionId: string): ExtensionLoadResult | undefined {
    return this.loadedExtensions.get(extensionId)
  }

  /**
   * 获取所有已加载的扩展
   */
  getAllLoadedExtensions(): ExtensionLoadResult[] {
    return Array.from(this.loadedExtensions.values())
  }

  /**
   * 卸载扩展
   */
  async unloadExtension(extensionId: string): Promise<void> {
    const extension = this.loadedExtensions.get(extensionId)
    if (extension) {
      await extension.dispose()
      this.loadedExtensions.delete(extensionId)
      console.log(`Extension ${extensionId} unloaded`)
    }
  }

  /**
   * 从外部目录加载扩展（通过Electron的VSIX加载器）
   * @param extensionPath 外部扩展目录的完整路径
   * @param options 扩展配置选项
   */
  async loadExternalExtension(
    extensionPath: string,
    options?: {
      /** 扩展主机类型，默认为 LocalWebWorker */
      hostKind?: ExtensionHostKind
      /** 是否为系统扩展，默认为 false */
      system?: boolean
    }
  ): Promise<ExtensionLoadResult> {
    try {
      console.log(`Loading external extension from: ${extensionPath}`)

      // 检查是否在Electron环境中
      if (!window['fs'] || !window['fs'].readFileSync) {
        throw new Error('External extension loading requires Electron environment')
      }

      // 通过Electron IPC加载扩展清单
      const manifest = await this.loadExternalManifest(extensionPath)
      const extensionId = `${manifest.publisher}.${manifest.name}`

      // 检查是否已加载
      if (this.loadedExtensions.has(extensionId)) {
        console.log(`External extension ${extensionId} already loaded`)
        return this.loadedExtensions.get(extensionId)!
      }

      console.log(`Registering external extension: ${manifest.name} v${manifest.version}`)

      // 注册扩展
      const hostKind = options?.hostKind ?? ExtensionHostKind.LocalWebWorker
      
      // 为cpptools扩展启用所需的API提案
      const extensionOptions: any = {
        system: options?.system ?? false
      }
      
      if (manifest.publisher === 'ms-vscode' && manifest.name === 'cpptools') {
        extensionOptions.enableProposedApi = ['terminalDataWriteEvent', 'chatParticipantAdditions']
      }
      
      const registrationResult = registerExtension(
        manifest,
        hostKind,
        extensionOptions
      )

      // 注册扩展文件（从外部目录）
      await this.registerExternalExtensionFiles(extensionPath, manifest, registrationResult)

      // 等待扩展准备就绪
      await registrationResult.whenReady()
      console.log(`External extension ${manifest.name} loaded successfully`)

      const result: ExtensionLoadResult = {
        id: registrationResult.id,
        manifest,
        dispose: registrationResult.dispose,
        whenReady: registrationResult.whenReady,
        getApi: 'getApi' in registrationResult ? (registrationResult.getApi as () => Promise<typeof vscode>) : undefined
      }

      this.loadedExtensions.set(extensionId, result)

      return result
    } catch (error) {
      console.error(`Failed to load external extension from ${extensionPath}:`, error)
      throw error
    }
  }

  /**
   * 通过Electron文件系统加载外部扩展的清单文件
   */
  private async loadExternalManifest(extensionPath: string): Promise<IExtensionManifest> {
    const packageJsonPath = `${extensionPath}/package.json`
    const manifestContent = window['fs'].readFileSync(packageJsonPath, 'utf8')
    return JSON.parse(manifestContent)
  }

  /**
   * 注册外部扩展的文件
   */
  private async registerExternalExtensionFiles(
    extensionPath: string,
    manifest: IExtensionManifest,
    registrationResult: any
  ): Promise<void> {
    // 只有 LocalWebWorker 和 LocalProcess 才有 registerFileUrl
    if (!('registerFileUrl' in registrationResult)) {
      return
    }

    const contributes = manifest.contributes
    if (!contributes) {
      return
    }

    // 处理语言配置文件
    if (contributes.languages) {
      for (const language of contributes.languages) {
        if (language.configuration) {
          await this.registerExternalFile(extensionPath, language.configuration, registrationResult, 'application/json')
        }
      }
    }

    // 处理语法文件（TextMate grammars）
    if (contributes.grammars) {
      for (const grammar of contributes.grammars) {
        if (grammar.path) {
          await this.registerExternalFile(extensionPath, grammar.path, registrationResult, 'application/json')
        }
      }
    }

    // 处理主题文件
    if (contributes.themes) {
      for (const theme of contributes.themes) {
        if (theme.path) {
          await this.registerExternalFile(extensionPath, theme.path, registrationResult, 'application/json')
        }
      }
    }

    // 处理代码片段
    if (contributes.snippets) {
      for (const snippet of contributes.snippets) {
        if (snippet.path) {
          await this.registerExternalFile(extensionPath, snippet.path, registrationResult, 'application/json')
        }
      }
    }

    // 处理扩展图标
    if (manifest.icon) {
      const iconExt = manifest.icon.split('.').pop()?.toLowerCase()
      const mimeType = iconExt === 'png' ? 'image/png' :
        iconExt === 'svg' ? 'image/svg+xml' :
          iconExt === 'jpg' || iconExt === 'jpeg' ? 'image/jpeg' :
            undefined
      
      await this.registerExternalFile(extensionPath, manifest.icon, registrationResult, mimeType)
    }
  }

  /**
   * 注册单个外部文件
   */
  private async registerExternalFile(
    extensionPath: string,
    relativePath: string,
    registrationResult: any,
    mimeType?: string
  ): Promise<void> {
    try {
      const fullPath = `${extensionPath}/${relativePath}`
      const fileContent = window['fs'].readFileSync(fullPath, 'utf8')
      
      // 创建Blob URL
      const blob = new Blob([fileContent], { type: mimeType || 'text/plain' })
      const url = URL.createObjectURL(blob)
      
      registrationResult.registerFileUrl(relativePath, url, mimeType)
      console.log(`Registered external file: ${relativePath} -> ${url}`)
    } catch (error) {
      console.warn(`Failed to register external file ${relativePath}:`, error)
    }
  }

  /**
   * 收集扩展中需要注册的文件
   */
  private collectExtensionFiles(
    manifest: IExtensionManifest,
    baseUrl: string
  ): ExtensionFileInfo[] {
    const files: ExtensionFileInfo[] = []
    
    // **关键修复**: 首先注册扩展的主入口文件（如果存在）
    // 这个文件包含了扩展的所有逻辑，包括命令的实现
    if (manifest.main) {
      // 处理主入口文件路径
      let mainPath = manifest.main
      // 如果路径以 ./ 开头，去掉它
      if (mainPath.startsWith('./')) {
        mainPath = mainPath.substring(2)
      }
      // 如果没有扩展名，添加 .js
      if (!mainPath.endsWith('.js')) {
        mainPath = `${mainPath}.js`
      }
      
      files.push({
        path: mainPath,
        url: `${baseUrl}${mainPath}`,
        mimeType: 'application/javascript'
      })
      console.log(`Registered main entry: ${mainPath}`)
    }

    const contributes = manifest.contributes

    if (!contributes) {
      return files
    }

    // 处理语言配置文件
    if (contributes.languages) {
      for (const language of contributes.languages) {
        if (language.configuration) {
          files.push({
            path: language.configuration,
            url: `${baseUrl}${language.configuration}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理语法文件（TextMate grammars）
    if (contributes.grammars) {
      for (const grammar of contributes.grammars) {
        if (grammar.path) {
          files.push({
            path: grammar.path,
            url: `${baseUrl}${grammar.path}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理主题文件
    if (contributes.themes) {
      for (const theme of contributes.themes) {
        if (theme.path) {
          files.push({
            path: theme.path,
            url: `${baseUrl}${theme.path}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理图标主题
    if (contributes.iconThemes) {
      for (const iconTheme of contributes.iconThemes) {
        if (iconTheme.path) {
          files.push({
            path: iconTheme.path,
            url: `${baseUrl}${iconTheme.path}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理产品图标主题
    if (contributes.productIconThemes) {
      for (const productIconTheme of contributes.productIconThemes) {
        if (productIconTheme.path) {
          files.push({
            path: productIconTheme.path,
            url: `${baseUrl}${productIconTheme.path}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理代码片段
    if (contributes.snippets) {
      for (const snippet of contributes.snippets) {
        if (snippet.path) {
          files.push({
            path: snippet.path,
            url: `${baseUrl}${snippet.path}`,
            mimeType: 'application/json'
          })
        }
      }
    }

    // 处理扩展图标
    if (manifest.icon) {
      const iconExt = manifest.icon.split('.').pop()?.toLowerCase()
      const mimeType = iconExt === 'png' ? 'image/png' :
        iconExt === 'svg' ? 'image/svg+xml' :
          iconExt === 'jpg' || iconExt === 'jpeg' ? 'image/jpeg' :
            undefined

      files.push({
        path: manifest.icon,
        url: `${baseUrl}${manifest.icon}`,
        mimeType
      })
    }

    return files
  }
}