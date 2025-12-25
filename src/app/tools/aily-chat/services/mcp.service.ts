import { Injectable } from '@angular/core';
import { ConfigService } from '../../../services/config.service.js';

interface McpServerStdioConfig {
  command: string;
  args: string[];
  enabled: boolean;
}

interface McpConfig {
  mcpServers: {
    [key: string]: McpServerStdioConfig;
  };
}

export interface MCPTool {
  name: string;
  description: string;
  input_schema: { [key: string]: any };
}

@Injectable({
  providedIn: 'root'
})
export class McpService {
  clients: string[] = [];
  tools: MCPTool[] = [];
  mcpConfigName: string = "mcp.json";
  private isInitialized = false; // 添加初始化标志位

  constructor(
    private configService: ConfigService
  ) {}

  async init() {
    // 防止重复初始化
    if (this.isInitialized) {
      // console.log('MCP服务已经初始化过，跳过重复初始化');
      return;
    }

    // console.log('开始初始化MCP服务...');
    this.isInitialized = true;
    
    try {
      await this.connectToServer();

      // 使用Map基于name属性进行去重
      const toolMap = new Map<string, MCPTool>();

      // 先添加已有工具
      this.tools.forEach(tool => {
        toolMap.set(tool.name, tool);
      });

      // 获取所有工具
      for (const serverName of this.clients) {
        const tempTools = await this.getTools(serverName);
        // 添加新工具，同名工具会被覆盖
        tempTools.forEach(tool => {
          toolMap.set(tool.name, tool);
        });
      }

      // 转换回数组
      this.tools = Array.from(toolMap.values());
      // console.log('MCP服务初始化完成，加载工具数量:', this.tools.length);
    } catch (error) {
      console.warn('MCP服务初始化失败:', error);
      this.isInitialized = false; // 初始化失败时重置标志位
      throw error;
    }
  }

  // 读取mcp.json配置文件
  private async loadConfig(): Promise<McpConfig> {
    try {
      // 获取配置文件内容
      const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const primaryConfigFilePath = `${appDataPath}/mcp/${this.mcpConfigName}`;
      const fallbackConfigFilePath = `./src/app/tools/aily-chat/mcp/${this.mcpConfigName}`;
      
      let configFilePath = primaryConfigFilePath;
      
      // 优先检查appDataPath下的配置文件
      const primaryExists = await window['path'].isExists(primaryConfigFilePath);
      if (!primaryExists) {
        // 如果主配置文件不存在，检查备用配置文件
        const fallbackExists = await window['path'].isExists(fallbackConfigFilePath);
        if (fallbackExists) {
          configFilePath = fallbackConfigFilePath;
          // console.log(`使用备用MCP配置文件: ${fallbackConfigFilePath}`);
        } else {
          console.warn(`MCP配置文件 ${primaryConfigFilePath} 和 ${fallbackConfigFilePath} 都不存在，使用默认配置`);
          return { mcpServers: {} };
        }
      } else {
        // console.log(`使用主MCP配置文件: ${primaryConfigFilePath}`);
      }
      
      const configContent = await window['fs'].readFileSync(configFilePath, 'utf-8');
      // console.log("configContent: ", configContent);
      
      // 解析JSON内容
      const config: McpConfig = JSON.parse(configContent);
      // console.log("MCP Config: ", config);

      // 检查配置格式
      if (!config.mcpServers || typeof config.mcpServers !== 'object') {
        throw new Error('MCP配置文件格式不正确');
      }

      // 返回配置
      return config;
    } catch (error) {
      // console.warn('无法加载MCP配置文件:', error);
      throw new Error('无法加载MCP配置文件');
    }
  }

  // 处理配置中的路径变量
  private processPath(path: string): string {
    // 这里可以根据实际情况替换${workspaceFolder}等变量
    return path.replace('${workspaceFolder}', '.');
  }

  async connectToServer() {
    try {
      const config = await this.loadConfig();

      // 遍历配置中的所有服务器
      for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        // 检查是否启用
        if (!serverConfig.enabled) {
          // console.log(`MCP服务 ${serverName} 已禁用，跳过连接`);
          continue;
        }

        // 检查是否已经连接过
        if (this.clients.includes(serverName)) {
          // console.log(`MCP服务 ${serverName} 已经连接过，跳过重复连接`);
          continue;
        }

        this.clients.push(serverName)

        // 处理参数中的路径变量
        const processedArgs = serverConfig.args.map(arg => this.processPath(arg));

        // 连接到服务器
        try {
          // console.log(`正在连接到MCP服务 ${serverName}...`);
          const Connect = await window["mcp"].connect(serverName, serverConfig.command, processedArgs);
          if (Connect.success === true) {
            // console.log(`成功连接到MCP服务 ${serverName}`);
          } else {
            // console.warn(`连接到MCP服务 ${serverName} 失败:`, Connect.error);
            // 连接失败时从clients中移除
            const index = this.clients.indexOf(serverName);
            if (index > -1) {
              this.clients.splice(index, 1);
            }
          }
        } catch (e) {
          // console.warn(`连接到MCP服务 ${serverName} 时发生错误:`, e);
          // 连接失败时从clients中移除
          const index = this.clients.indexOf(serverName);
          if (index > -1) {
            this.clients.splice(index, 1);
          }
        }
      }
    } catch (e) {
      // console.warn("连接到MCP服务器失败:", e);
      throw e;
    }
  }

  async getTools(serverName: string): Promise<MCPTool[]> {
    try {
      // 获取所有工具
      const result = await window["mcp"].getTools(serverName);
      if (result.success) {
        return result.tools;
      } else {
        // console.warn("获取工具失败:", result.error);
        return [];
      }
    } catch (e) {
      // console.warn("获取工具时发生错误:", e);
      return [];
    }
  }

  /**
   * 重置MCP服务，清理所有连接和工具
   */
  reset() {
    // console.log('重置MCP服务...');
    this.isInitialized = false;
    this.clients = [];
    this.tools = [];
  }

  /**
   * 获取初始化状态
   */
  get initialized(): boolean {
    return this.isInitialized;
  }

  async use_tool(toolName: string, args: { [key: string]: unknown }) {
    try {
      const result = await window["mcp"].useTool(toolName, args);
      /*** 
        "success": true,
        "result": {
        "content": [
            {
              "type": "text",
              "text": "1 validation error for Fetch\nurl\n  Input should be a valid URL, relative URL without a base [type=url_parsing, input_value='www.baidu.com', input_type=str]\n    For further information visit https://errors.pydantic.dev/2.11/v/url_parsing"
            }
          ],
        "isError": true
      }
      */

      if (result.success && result.isError !== true) {
        return {
          "content": result.result.content.map((item: any) => item.text).join("\n"),
          "is_error": false
        }
      } else {
        return {
          "content": "Tool usage failed: " + result.error,
          "is_error": true
        }
      }
    } catch (e) {
      return {
        "content": "Error using tool: " + e,
        "is_error": true
      }
    }
  }
}