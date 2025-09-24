import { Injectable } from '@angular/core';
import { ElectronService } from '../../../services/electron.service';

export interface VsixExtension {
    path: string;
    filename: string;
    manifest: any;
    id: string;
    displayName: string;
    version: string;
    description: string;
    publisher: string;
}

export interface ExtensionData {
    path: string;
    manifest: any;
    files: any[];
    loadedAt: string;
}

@Injectable({
    providedIn: 'root'
})
export class VsixService {
    private loadedExtensions = new Map<string, ExtensionData>();
    private extensionApis = new Map<string, any>();

    constructor(
        private electronService: ElectronService
    ) {}

    /**
     * 获取所有可用的 VSIX 扩展
     */
    async getAvailableExtensions(): Promise<VsixExtension[]> {
        try {
            return await window['ipcRenderer'].invoke('vsix:get-available-extensions');
        } catch (error) {
            console.error('Failed to get available extensions:', error);
            return [];
        }
    }

    /**
     * 加载指定的 VSIX 扩展
     */
    async loadExtension(extensionPath: string): Promise<ExtensionData | null> {
        try {
            // 首先从 Electron 端加载扩展数据
            const extensionData = await window['ipcRenderer'].invoke('vsix:load-extension', extensionPath);

            if (!extensionData) {
                throw new Error('Failed to load extension data from Electron');
            }

            // 将扩展数据缓存到本地
            this.loadedExtensions.set(extensionPath, extensionData);

            // 初始化扩展（如果需要）
            await this.initializeExtension(extensionData);

            console.log(`Successfully loaded VSIX extension: ${extensionData.manifest.name || 'unknown'}`);
            return extensionData;
        } catch (error) {
            console.error('Failed to load extension:', error);
            return null;
        }
    }

    /**
     * 初始化扩展
     */
    private async initializeExtension(extensionData: ExtensionData): Promise<void> {
        try {
            const manifest = extensionData.manifest;

            // 检查扩展的激活事件
            if (manifest.activationEvents) {
                console.log(`Extension ${manifest.name} has activation events:`, manifest.activationEvents);

                // 处理不同的激活事件
                for (const event of manifest.activationEvents) {
                    await this.handleActivationEvent(extensionData, event);
                }
            }

            // 如果扩展有主入口文件，尝试加载
            if (manifest.main) {
                await this.loadExtensionMainFile(extensionData, manifest.main);
            }

            // 注册扩展的贡献点
            if (manifest.contributes) {
                await this.registerContributions(extensionData, manifest.contributes);
            }

        } catch (error) {
            console.error('Failed to initialize extension:', error);
        }
    }

    /**
     * 处理扩展的激活事件
     */
    private async handleActivationEvent(extensionData: ExtensionData, event: string): Promise<void> {
        console.log(`Handling activation event: ${event} for extension ${extensionData.manifest.name}`);

        // 根据不同的激活事件类型进行处理
        switch (true) {
            case event === '*':
                // 立即激活
                await this.activateExtension(extensionData);
                break;
            case event.startsWith('onLanguage:'):
                // 当特定语言文件被打开时激活
                const language = event.replace('onLanguage:', '');
                console.log(`Extension will be activated when ${language} files are opened`);
                break;
            case event.startsWith('onCommand:'):
                // 当特定命令被执行时激活
                const command = event.replace('onCommand:', '');
                console.log(`Extension will be activated when command ${command} is executed`);
                break;
            case event.startsWith('workspaceContains:'):
                // 当工作区包含特定文件时激活
                const pattern = event.replace('workspaceContains:', '');
                console.log(`Extension will be activated when workspace contains ${pattern}`);
                break;
            default:
                console.log(`Unknown activation event: ${event}`);
        }
    }

    /**
     * 激活扩展
     */
    private async activateExtension(extensionData: ExtensionData): Promise<void> {
        try {
            console.log(`Activating extension: ${extensionData.manifest.name}`);

            // 这里可以添加扩展激活的具体逻辑
            // 例如：执行扩展的激活函数、注册命令等

            // 标记扩展为已激活
            extensionData.manifest._activated = true;

        } catch (error) {
            console.error('Failed to activate extension:', error);
        }
    }

    /**
     * 加载扩展的主入口文件
     */
    private async loadExtensionMainFile(extensionData: ExtensionData, mainFile: string): Promise<void> {
        try {
            console.log(`Loading main file: ${mainFile} for extension ${extensionData.manifest.name}`);

            // 验证 mainFile 参数
            if (!mainFile || typeof mainFile !== 'string') {
                console.warn(`Invalid main file for extension ${extensionData.manifest.name}:`, mainFile);
                return;
            }

            // 从 Electron 端读取主文件内容
            console.log('Reading main file with readExtensionFile:', extensionData.path, mainFile);

            const fileContent = await this.readExtensionFile(extensionData.path, mainFile);

            if (fileContent) {
                // 现在可以通过 monaco-vscode-api 执行扩展主文件
                console.log(`Main file loaded for extension ${extensionData.manifest.name}`);
                // 可以考虑通过 VSCode API 的扩展激活机制来处理
            }

        } catch (error) {
            console.error('Failed to load extension main file:', error);
        }
    }

    /**
     * 注册扩展的贡献点
     */
    private async registerContributions(extensionData: ExtensionData, contributes: any): Promise<void> {
        try {
            console.log(`Registering contributions for extension ${extensionData.manifest.name}:`, contributes);

            // 注册命令
            if (contributes.commands) {
                await this.registerCommands(extensionData, contributes.commands);
            }

            // 注册语言支持
            if (contributes.languages) {
                await this.registerLanguages(extensionData, contributes.languages);
            }

            // 注册语法高亮
            if (contributes.grammars) {
                await this.registerGrammars(extensionData, contributes.grammars);
            }

            // 注册主题
            if (contributes.themes) {
                await this.registerThemes(extensionData, contributes.themes);
            }

            // 注册配置
            if (contributes.configuration) {
                await this.registerConfiguration(extensionData, contributes.configuration);
            }

        } catch (error) {
            console.error('Failed to register contributions:', error);
        }
    }

    /**
     * 注册命令
     */
    private async registerCommands(extensionData: ExtensionData, commands: any[]): Promise<void> {
        for (const command of commands) {
            console.log(`Registering command: ${command.command} - ${command.title}`);
            // 这里可以添加注册命令到 Monaco 编辑器的逻辑
        }
    }

    /**
     * 注册语言支持
     */
    private async registerLanguages(extensionData: ExtensionData, languages: any[]): Promise<void> {
        for (const language of languages) {
            console.log(`Registering language: ${language.id}`);
            // 这里可以添加注册语言到 Monaco 编辑器的逻辑
        }
    }

    /**
     * 注册语法高亮
     */
    private async registerGrammars(extensionData: ExtensionData, grammars: any[]): Promise<void> {
        for (const grammar of grammars) {
            console.log(`Registering grammar for language: ${grammar.language}`);
            // 这里可以添加注册语法高亮的逻辑
        }
    }

    /**
     * 注册主题
     */
    private async registerThemes(extensionData: ExtensionData, themes: any[]): Promise<void> {
        for (const theme of themes) {
            console.log(`Registering theme: ${theme.label}`);
            // 这里可以添加注册主题的逻辑
        }
    }

    /**
     * 注册配置
     */
    private async registerConfiguration(extensionData: ExtensionData, configuration: any): Promise<void> {
        console.log(`Registering configuration for extension ${extensionData.manifest.name}`);
        // 这里可以添加注册配置的逻辑
    }

    /**
     * 卸载扩展
     */
    async unloadExtension(extensionPath: string): Promise<boolean> {
        try {
            // 从 Electron 端卸载
            const result = await window['ipcRenderer'].invoke('vsix:unload-extension', extensionPath);

            // 从本地缓存中移除
            if (this.loadedExtensions.has(extensionPath)) {
                this.loadedExtensions.delete(extensionPath);
            }

            if (this.extensionApis.has(extensionPath)) {
                this.extensionApis.delete(extensionPath);
            }

            console.log(`Unloaded extension: ${extensionPath}`);
            return result;
        } catch (error) {
            console.error('Failed to unload extension:', error);
            return false;
        }
    }

    /**
     * 获取已加载的扩展列表
     */
    getLoadedExtensions(): ExtensionData[] {
        return Array.from(this.loadedExtensions.values());
    }

    /**
     * 获取扩展的清单信息
     */
    async getExtensionManifest(extensionPath: string): Promise<any | null> {
        try {
            return await window['ipcRenderer'].invoke('vsix:get-manifest', extensionPath);
        } catch (error) {
            console.error('Failed to get extension manifest:', error);
            return null;
        }
    }

    /**
     * 读取扩展文件内容
     */
    async readExtensionFile(extensionPath: string, filePath: string): Promise<Buffer | null> {
        try {
            console.log('VsixService readExtensionFile called with:', { extensionPath, filePath });
            console.log('typeof extensionPath:', typeof extensionPath, 'typeof filePath:', typeof filePath);

            // 参数验证
            if (!extensionPath || typeof extensionPath !== 'string') {
                console.error('Invalid extensionPath:', extensionPath);
                return null;
            }
            if (!filePath || typeof filePath !== 'string') {
                console.error('Invalid filePath:', filePath);
                return null;
            }

            return await window['ipcRenderer'].invoke('vsix:read-file', { extensionPath, filePath });
        } catch (error) {
            console.error('Failed to read extension file:', error);
            return null;
        }
    }

    /**
     * 获取扩展的文件列表
     */
    async getExtensionFileList(extensionPath: string): Promise<any[] | null> {
        try {
            return await window['ipcRenderer'].invoke('vsix:get-file-list', extensionPath);
        } catch (error) {
            console.error('Failed to get extension file list:', error);
            return null;
        }
    }

    /**
     * 初始化所有可用的扩展
     */
    async initializeAllExtensions(): Promise<void> {
        try {
            const availableExtensions = await this.getAvailableExtensions();
            console.log(`Found ${availableExtensions.length} VSIX extensions`);

            // 加载所有扩展
            for (const extension of availableExtensions) {
                try {
                    console.log(`Loading extension: ${extension.displayName} (${extension.path})`);
                    await this.loadExtension(extension.path);
                } catch (error) {
                    console.error(`Failed to load extension ${extension.displayName}:`, error);
                    // 继续加载其他扩展，不让单个扩展的错误影响整体
                }
            }

        } catch (error) {
            console.error('Failed to initialize extensions:', error);
        }
    }
}
