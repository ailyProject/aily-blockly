const path = require('path');
const fs = require('fs');
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const os = require('os');

class VsixLoader {
  constructor() {
    this.loadedExtensions = new Map();
    this.vsixDirectory = path.join(__dirname, '..', 'child', 'vsix');
    this.tempDirectory = path.join(os.tmpdir(), 'aily-vsix-temp');
    
    // 确保临时目录存在
    if (!fs.existsSync(this.tempDirectory)) {
      fs.mkdirSync(this.tempDirectory, { recursive: true });
    }
  }

  /**
   * 注册所有 VSIX 相关的 IPC 处理器
   */
  registerHandlers() {
    // 获取所有可用的 VSIX 扩展
    ipcMain.handle('vsix:get-available-extensions', async () => {
      return this.getAvailableExtensions();
    });

    // 加载指定的 VSIX 扩展
    ipcMain.handle('vsix:load-extension', async (event, extensionPath) => {
      return this.loadExtension(extensionPath);
    });

    // 获取扩展的清单信息
    ipcMain.handle('vsix:get-manifest', async (event, extensionPath) => {
      return this.getExtensionManifest(extensionPath);
    });

    // 读取扩展文件内容
    ipcMain.handle('vsix:read-file', async (event, extensionPath, filePath) => {
      console.log('IPC vsix:read-file called with:', { extensionPath, filePath });
      return this.readExtensionFile(extensionPath, filePath);
    });

    // 获取扩展的所有文件列表
    ipcMain.handle('vsix:get-file-list', async (event, extensionPath) => {
      return this.getExtensionFileList(extensionPath);
    });

    // 卸载扩展
    ipcMain.handle('vsix:unload-extension', async (event, extensionPath) => {
      return this.unloadExtension(extensionPath);
    });
  }

  /**
   * 获取所有可用的 VSIX 扩展
   */
  async getAvailableExtensions() {
    try {
      if (!fs.existsSync(this.vsixDirectory)) {
        console.log('VSIX directory does not exist:', this.vsixDirectory);
        return [];
      }

      const files = fs.readdirSync(this.vsixDirectory);
      const vsixFiles = files.filter(file => file.endsWith('.vsix'));
      
      const extensions = [];
      for (const file of vsixFiles) {
        const extensionPath = path.join(this.vsixDirectory, file);
        try {
          const manifest = await this.getExtensionManifest(extensionPath);
          extensions.push({
            path: extensionPath,
            filename: file,
            manifest: manifest,
            id: manifest.name || file.replace('.vsix', ''),
            displayName: manifest.displayName || manifest.name || file.replace('.vsix', ''),
            version: manifest.version || '0.0.0',
            description: manifest.description || '',
            publisher: manifest.publisher || 'unknown'
          });
        } catch (error) {
          console.error(`Failed to load manifest for ${file}:`, error);
        }
      }

      return extensions;
    } catch (error) {
      console.error('Error getting available extensions:', error);
      return [];
    }
  }

  /**
   * 加载指定的 VSIX 扩展
   */
  async loadExtension(extensionPath) {
    try {
      if (this.loadedExtensions.has(extensionPath)) {
        return this.loadedExtensions.get(extensionPath);
      }

      const manifest = await this.getExtensionManifest(extensionPath);
      const fileList = await this.getExtensionFileList(extensionPath);
      
      const extensionData = {
        path: extensionPath,
        manifest: manifest,
        files: fileList,
        loadedAt: new Date().toISOString()
      };

      this.loadedExtensions.set(extensionPath, extensionData);
      
      console.log(`Successfully loaded VSIX extension: ${manifest.name || 'unknown'}`);
      return extensionData;
    } catch (error) {
      console.error('Error loading extension:', error);
      throw error;
    }
  }

  /**
   * 使用 7za.exe 解压 VSIX 文件
   */
  async extractVsix(vsixPath, outputDir) {
    return new Promise((resolve, reject) => {
      const sevenZaPath = process.env.AILY_7ZA_PATH || '7za.exe';
      
      // 确保输出目录存在
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // 使用 7za.exe 解压文件
      const args = ['x', vsixPath, `-o${outputDir}`, '-y']; // -y 表示对所有询问回答yes
      
      const process7za = spawn(sevenZaPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process7za.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process7za.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process7za.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`7za extraction failed with code ${code}: ${stderr}`));
        }
      });

      process7za.on('error', (err) => {
        reject(new Error(`Failed to start 7za process: ${err.message}`));
      });
    });
  }

  /**
   * 列出 VSIX 文件内容
   */
  async listVsixContents(vsixPath) {
    return new Promise((resolve, reject) => {
      const sevenZaPath = process.env.AILY_7ZA_PATH || '7za.exe';
      
      // 使用 7za.exe 列出文件内容
      const args = ['l', vsixPath];
      
      const process7za = spawn(sevenZaPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process7za.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process7za.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process7za.on('close', (code) => {
        if (code === 0) {
          // 解析 7za 输出的文件列表
          const files = this.parse7zaOutput(stdout);
          resolve(files);
        } else {
          reject(new Error(`7za list failed with code ${code}: ${stderr}`));
        }
      });

      process7za.on('error', (err) => {
        reject(new Error(`Failed to start 7za process: ${err.message}`));
      });
    });
  }

  /**
   * 解析 7za 输出的文件列表
   */
  parse7zaOutput(output) {
    const lines = output.split('\n');
    const files = [];
    let inFileSection = false;

    for (const line of lines) {
      if (line.includes('------------------- ----- ------------ ------------')) {
        inFileSection = true;
        continue;
      }
      
      if (inFileSection && line.trim() === '') {
        break;
      }

      if (inFileSection && line.trim()) {
        // 解析文件信息行
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 6) {
          const fileName = parts.slice(5).join(' ');
          const size = parseInt(parts[3]) || 0;
          const compressedSize = parseInt(parts[4]) || 0;
          
          if (fileName && !fileName.endsWith('/')) {
            files.push({
              path: fileName,
              size: size,
              compressedSize: compressedSize
            });
          }
        }
      }
    }

    return files;
  }

  /**
   * 获取扩展的清单信息
   */
  async getExtensionManifest(extensionPath) {
    try {
      // 参数验证
      if (!extensionPath || typeof extensionPath !== 'string') {
        throw new Error('Extension path is required and must be a string');
      }

      // 为此扩展创建临时目录
      const extensionId = path.basename(extensionPath, '.vsix');
      const tempExtractDir = path.join(this.tempDirectory, extensionId);
      
      // 清理可能存在的旧文件
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }

      // 解压 VSIX 文件
      await this.extractVsix(extensionPath, tempExtractDir);

      // 查找 package.json 文件
      let manifestPath = null;
      const possiblePaths = [
        path.join(tempExtractDir, 'extension', 'package.json'),
        path.join(tempExtractDir, 'package.json')
      ];

      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          manifestPath = possiblePath;
          break;
        }
      }

      if (!manifestPath) {
        throw new Error('package.json not found in VSIX file');
      }

      // 读取并解析 manifest
      const manifestContent = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestContent);

      return manifest;
    } catch (error) {
      throw new Error(`Failed to get extension manifest: ${error.message}`);
    }
  }

  /**
   * 读取扩展文件内容
   */
  async readExtensionFile(extensionPath, filePath) {
    try {
        console.log(extensionPath,filePath);
        
      // 参数验证
      if (!extensionPath || typeof extensionPath !== 'string') {
        throw new Error('Extension path is required and must be a string');
      }
      if (!filePath || typeof filePath !== 'string') {
        throw new Error('File path is required and must be a string');
      }

      const extensionId = path.basename(extensionPath, '.vsix');
      const tempExtractDir = path.join(this.tempDirectory, extensionId);
      
      // 如果还没有解压，先解压
      if (!fs.existsSync(tempExtractDir)) {
        await this.extractVsix(extensionPath, tempExtractDir);
      }

      // 查找文件
      const possiblePaths = [
        path.join(tempExtractDir, filePath),
        path.join(tempExtractDir, 'extension', filePath),
        path.join(tempExtractDir, filePath.replace(/^extension\//, ''))
      ];

      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          return fs.readFileSync(possiblePath);
        }
      }

      throw new Error(`File not found in VSIX: ${filePath}`);
    } catch (error) {
      throw new Error(`Failed to read extension file: ${error.message}`);
    }
  }

  /**
   * 获取扩展的所有文件列表
   */
  async getExtensionFileList(extensionPath) {
    try {
      // 参数验证
      if (!extensionPath || typeof extensionPath !== 'string') {
        throw new Error('Extension path is required and must be a string');
      }

      return await this.listVsixContents(extensionPath);
    } catch (error) {
      throw new Error(`Failed to get extension file list: ${error.message}`);
    }
  }

  /**
   * 卸载扩展
   */
  unloadExtension(extensionPath) {
    if (this.loadedExtensions.has(extensionPath)) {
      // 清理临时文件
      const extensionId = path.basename(extensionPath, '.vsix');
      const tempExtractDir = path.join(this.tempDirectory, extensionId);
      
      if (fs.existsSync(tempExtractDir)) {
        try {
          fs.rmSync(tempExtractDir, { recursive: true, force: true });
        } catch (error) {
          console.warn(`Failed to cleanup temp directory for ${extensionId}:`, error);
        }
      }

      this.loadedExtensions.delete(extensionPath);
      console.log(`Unloaded extension: ${extensionPath}`);
      return true;
    }
    return false;
  }

  /**
   * 获取已加载的扩展列表
   */
  getLoadedExtensions() {
    return Array.from(this.loadedExtensions.values());
  }

  /**
   * 清理所有临时文件
   */
  cleanup() {
    try {
      if (fs.existsSync(this.tempDirectory)) {
        fs.rmSync(this.tempDirectory, { recursive: true, force: true });
        console.log('Cleaned up VSIX temporary directory');
      }
    } catch (error) {
      console.warn('Failed to cleanup VSIX temporary directory:', error);
    }
  }
}

// 导出实例
const vsixLoader = new VsixLoader();

module.exports = {
  vsixLoader,
  registerVsixHandlers: () => vsixLoader.registerHandlers()
};
