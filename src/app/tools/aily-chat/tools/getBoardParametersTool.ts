import { ToolUseResult } from "./tools";

interface GetBoardParametersParams {
  parameters?: string | string[]; // 支持字符串或数组
}

/**
 * 获取开发板参数工具
 * 从当前打开项目的开发板配置(board.json)中读取详细参数
 * 
 * 支持的参数包括:
 * - analogPins: 模拟引脚列表
 * - digitalPins: 数字引脚列表
 * - pwmPins: PWM引脚列表
 * - servoPins: 舵机引脚列表
 * - serialPort: 串口列表
 * - serialSpeed: 串口波特率选项
 * - spi: SPI接口列表
 * - spiPins: SPI引脚映射
 * - i2c: I2C接口列表
 * - i2cPins: I2C引脚映射
 * - builtinLed: 内置LED
 * - rgbLed: RGB LED
 * - interruptPins: 中断引脚列表
 * - 以及其他board.json中定义的所有字段
 */
export const getBoardParametersTool = {
  name: 'get_board_parameters',
  
  /**
   * 获取开发板参数
   * @param projectService 项目服务实例
   * @param params 参数对象,包含可选的parameters数组
   * @returns 工具使用结果
   */
  async handler(projectService: any, params: GetBoardParametersParams): Promise<ToolUseResult> {
    const { parameters } = params;
    
    try {
      // 检查项目是否打开
      if (!projectService.currentProjectPath) {
        return {
          is_error: true,
          content: JSON.stringify({
            error: '当前没有打开的项目',
            message: '请先打开一个项目'
          }, null, 2)
        };
      }

      // 通过 projectService 获取开发板配置
      let boardData: any;
      let boardName: string;
      
      try {
        boardData = await projectService.getBoardJson();
        const boardModule = await projectService.getBoardModule();
        // 从 @aily-project/board-xxx 中提取 xxx 作为开发板名称
        boardName = boardModule ? boardModule.replace('@aily-project/board-', '') : 'unknown';
      } catch (error) {
        return {
          is_error: true,
          content: JSON.stringify({
            error: '获取开发板配置失败',
            message: error.message || '开发板包可能未安装'
          }, null, 2)
        };
      }

      // 处理 parameters 参数 - 支持字符串、数组、或空值
      let paramList: string[] = [];
      
      if (!parameters) {
        // 未指定参数,返回所有数据
        return {
          is_error: false,
          content: JSON.stringify({
            boardName,
            parameters: boardData,
            availableParameters: Object.keys(boardData)
          }, null, 2),
          metadata: {
            boardName,
            parameterCount: Object.keys(boardData).length,
            availableParameters: Object.keys(boardData)
          }
        };
      } else if (typeof parameters === 'string') {
        // 字符串格式: 支持 JSON 数组字符串或逗号分隔
        const trimmed = parameters.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            paramList = JSON.parse(trimmed);
          } catch {
            // JSON 解析失败,尝试按逗号分隔
            paramList = trimmed.slice(1, -1).split(',').map(p => p.trim().replace(/^["']|["']$/g, '')).filter(p => p);
          }
        } else {
          // 逗号分隔的字符串
          paramList = trimmed.split(',').map(p => p.trim()).filter(p => p);
        }
      } else if (Array.isArray(parameters)) {
        paramList = parameters.map(p => String(p).trim()).filter(p => p);
      }

      // 如果处理后仍为空数组,返回所有数据
      if (paramList.length === 0) {
        return {
          is_error: false,
          content: JSON.stringify({
            boardName,
            parameters: boardData,
            availableParameters: Object.keys(boardData)
          }, null, 2),
          metadata: {
            boardName,
            parameterCount: Object.keys(boardData).length,
            availableParameters: Object.keys(boardData)
          }
        };
      }

      // 提取指定的参数 - 支持模糊匹配和忽略大小写
      const extractedParams: Record<string, any> = {};
      const missingParams: string[] = [];
      const availableKeys = Object.keys(boardData);

      for (const param of paramList) {
        const paramLower = param.toLowerCase();
        let found = false;

        // 1. 精确匹配（忽略大小写）
        const exactMatch = availableKeys.find(key => key.toLowerCase() === paramLower);
        if (exactMatch) {
          extractedParams[exactMatch] = boardData[exactMatch];
          found = true;
          continue;
        }

        // 2. 模糊匹配（部分匹配）
        const fuzzyMatches = availableKeys.filter(key => key.toLowerCase().includes(paramLower));
        if (fuzzyMatches.length > 0) {
          // 如果有多个匹配,全部返回
          fuzzyMatches.forEach(key => {
            extractedParams[key] = boardData[key];
          });
          found = true;
          continue;
        }

        // 3. 未找到匹配
        if (!found) {
          missingParams.push(param);
        }
      }

      // // 去掉换行和多余空格
      // for (const key in extractedParams) {
      //   if (typeof extractedParams[key] === 'string') {
      //     extractedParams[key] = extractedParams[key].replace(/\s+/g, ' ').trim();
      //   }
      // }

      const result: any = {
        boardName,
        parameters: extractedParams,
        // availableParameters: Object.keys(boardData)
      };

      // 如果有缺失的参数,添加警告信息
      if (missingParams.length > 0) {
        result.warning = `以下参数在board.json中不存在: ${missingParams.join(', ')}`;
      }

      // 去掉json中的多余空格和换行
      let contentData = JSON.stringify(result, null, 2);
      contentData = contentData.replace(/\s+/g, ' ').trim();

      return {
        is_error: false,
        content: contentData,
        metadata: {
          boardName,
          parameterCount: Object.keys(extractedParams).length,
          missingParams: missingParams.length > 0 ? missingParams : undefined
        }
      };

    } catch (error) {
      return {
        is_error: true,
        content: JSON.stringify({
          error: '读取开发板参数时出错',
          message: error.message
        }, null, 2)
      };
    }
  }
};
