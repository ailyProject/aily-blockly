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

  constructor(
    private configService: ConfigService
  ) {}

  async init() {
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
  }

  // 读取mcp.json配置文件
  private async loadConfig(): Promise<McpConfig> {
    try {
      // 获取配置文件内容
      const appDataPath = this.configService.data.appdata_path[this.configService.data.platform].replace('%HOMEPATH%', window['path'].getUserHome());
      const configFilePath = `${appDataPath}/mcp/${this.mcpConfigName}`;
      // 判断是否存在
      const fileExists = await window['path'].isExists(configFilePath);
      if (!fileExists) {
        console.warn(`MCP配置文件 ${configFilePath} 不存在，使用默认配置`);
        return { mcpServers: {} };
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
      console.error('无法加载MCP配置文件:', error);
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
          console.log(`MCP服务 ${serverName} 已禁用，跳过连接`);
          continue;
        }

        this.clients.push(serverName)

        // 处理参数中的路径变量
        const processedArgs = serverConfig.args.map(arg => this.processPath(arg));

        // 连接到服务器
        try {
          const Connect = await window["mcp"].connect(serverName, serverConfig.command, processedArgs);
          if (Connect.success === true) {
            console.log(`成功连接到MCP服务 ${serverName}`);
          } else {
            console.error(`连接到MCP服务 ${serverName} 失败:`, Connect.error);
          }
        } catch (e) {
          console.error(`连接到MCP服务 ${serverName} 时发生错误:`, e);
        }
      }
    } catch (e) {
      console.error("连接到MCP服务器失败:", e);
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
        console.error("获取工具失败:", result.error);
        return [];
      }
    } catch (e) {
      console.error("获取工具时发生错误:", e);
      return [];
    }
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