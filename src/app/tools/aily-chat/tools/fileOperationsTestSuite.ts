import { ToolUseResult } from "./tools";
import { 
  listDirectoryTool,
  readFileTool,
  createFileTool,
  createFolderTool,
  editFileTool,
  deleteFileTool,
  deleteFolderTool,
  checkExistsTool,
  getDirectoryTreeTool
} from './index';

/**
 * 文件操作工具测试套件
 * 用于验证所有拆分后的文件操作工具是否正常工作
 */
export class FileOperationsTestSuite {
  private testBasePath: string;

  constructor(basePath: string = 'C:\\temp\\file-ops-test') {
    this.testBasePath = basePath;
  }

  async runAllTests(): Promise<void> {
    console.log('开始文件操作工具测试...');
    
    try {
      await this.testCreateFolder();
      await this.testCreateFile();
      await this.testReadFile();
      await this.testEditFile();
      await this.testListDirectory();
      await this.testCheckExists();
      await this.testGetDirectoryTree();
      await this.testDeleteFile();
      await this.testDeleteFolder();
      
      console.log('✅ 所有测试通过！');
    } catch (error) {
      console.warn('❌ 测试失败:', error);
    }
  }

  private async testCreateFolder(): Promise<void> {
    console.log('🧪 测试创建文件夹...');
    const result = await createFolderTool({
      path: this.testBasePath
    });
    
    if (result.is_error) {
      throw new Error(`创建文件夹失败: ${result.content}`);
    }
    console.log('✅ 创建文件夹测试通过');
  }

  private async testCreateFile(): Promise<void> {
    console.log('🧪 测试创建文件...');
    const result = await createFileTool({
      path: `${this.testBasePath}\\test.txt`,
      content: 'Hello, World!'
    });
    
    if (result.is_error) {
      throw new Error(`创建文件失败: ${result.content}`);
    }
    console.log('✅ 创建文件测试通过');
  }

  private async testReadFile(): Promise<void> {
    console.log('🧪 测试读取文件...');
    const result = await readFileTool({
      path: `${this.testBasePath}\\test.txt`
    });
    
    if (result.is_error) {
      throw new Error(`读取文件失败: ${result.content}`);
    }
    
    if (result.content !== 'Hello, World!') {
      throw new Error(`文件内容不匹配，期望: "Hello, World!"，实际: "${result.content}"`);
    }
    console.log('✅ 读取文件测试通过');
  }

  private async testEditFile(): Promise<void> {
    console.log('🧪 测试编辑文件...');
    const result = await editFileTool({
      path: `${this.testBasePath}\\test.txt`,
      content: 'Hello, Updated World!'
    });
    
    if (result.is_error) {
      throw new Error(`编辑文件失败: ${result.content}`);
    }
    console.log('✅ 编辑文件测试通过');
  }

  private async testListDirectory(): Promise<void> {
    console.log('🧪 测试列出目录...');
    const result = await listDirectoryTool({
      path: this.testBasePath
    });
    
    if (result.is_error) {
      throw new Error(`列出目录失败: ${result.content}`);
    }
    
    const files = JSON.parse(result.content);
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('目录列表应该包含至少一个文件');
    }
    console.log('✅ 列出目录测试通过');
  }

  private async testCheckExists(): Promise<void> {
    console.log('🧪 测试检查存在性...');
    const result = await checkExistsTool({
      path: `${this.testBasePath}\\test.txt`,
      type: 'file'
    });
    
    if (result.is_error) {
      throw new Error(`检查存在性失败: ${result.content}`);
    }
    
    const info = JSON.parse(result.content);
    if (!info.exists) {
      throw new Error('文件应该存在');
    }
    console.log('✅ 检查存在性测试通过');
  }

  private async testGetDirectoryTree(): Promise<void> {
    console.log('🧪 测试获取目录树...');
    const result = await getDirectoryTreeTool({
      path: this.testBasePath,
      maxDepth: 2
    });
    
    if (result.is_error) {
      throw new Error(`获取目录树失败: ${result.content}`);
    }
    
    const tree = JSON.parse(result.content);
    if (!tree || !tree.isDirectory) {
      throw new Error('目录树根节点应该是目录');
    }
    console.log('✅ 获取目录树测试通过');
  }

  private async testDeleteFile(): Promise<void> {
    console.log('🧪 测试删除文件...');
    const result = await deleteFileTool({
      path: `${this.testBasePath}\\test.txt`,
      createBackup: false
    });
    
    if (result.is_error) {
      throw new Error(`删除文件失败: ${result.content}`);
    }
    console.log('✅ 删除文件测试通过');
  }

  private async testDeleteFolder(): Promise<void> {
    console.log('🧪 测试删除文件夹...');
    const result = await deleteFolderTool({
      path: this.testBasePath,
      createBackup: false
    });
    
    if (result.is_error) {
      throw new Error(`删除文件夹失败: ${result.content}`);
    }
    console.log('✅ 删除文件夹测试通过');
  }
}

// 使用示例：
// const testSuite = new FileOperationsTestSuite();
// testSuite.runAllTests();
