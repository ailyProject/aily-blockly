import { ToolUseResult } from './tools';
import { ProjectService } from '../../../services/project.service';
import { ConnectionGraphService, PinSummary, PinmapCatalog, ComponentInstanceInput, ComponentConfig, PinmapProtocol } from '../../../services/connection-graph.service';
import { AilyHost } from '../core/host';

/**
 * 解析后的组件实例信息（内部使用）
 */
interface ParsedComponentInstance {
  /** pinmapId 完整标识符 */
  pinmapId: string;
  /** 用户定义的别名（用于 refId） */
  alias: string;
  /** 显示名称 */
  label?: string;
  /** 同一 pinmapId 的第几个实例 (0-based) */
  instance: number;
}

/**
 * generate_schematic 工具
 *
 * 读取开发板和外设的引脚信息，构建 prompt 返回给 Agent，
 * 让 Agent 根据引脚信息输出标准格式的连线 JSON。
 *
 * 支持两种方式指定组件：
 * 1. pinmapIds: 完整标识符列表 (推荐)，支持多实例（对象格式带别名）
 * 2. components: 简称列表 (旧版兼容)，如 ["dht20"]
 */
export async function generateConnectionGraphTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapIds?: ComponentInstanceInput[]; components?: string[]; requirements?: string }
): Promise<ToolUseResult> {
  try {
    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目或未安装开发板包，请先创建/打开一个项目。',
      };
    }

    // 读取开发板 pinmap（支持旧版 pinmap.json 和新版 catalog + pinmaps/ 两种结构）
    const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
    if (!boardConfig) {
      return {
        is_error: true,
        content: '开发板引脚配置不存在，无法生成连线图。请先使用 generate_pinmap + save_pinmap 为该开发板生成 pinmap 配置。',
      };
    }

    // 直接使用 currentProjectPath 构建 packagesBasePath（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    // 使用字符串模板确保类型正确
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    // 收集引脚摘要
    const pinSummaries: PinSummary[] = [];
    // 解析后的组件实例列表
    const componentInstances: ParsedComponentInstance[] = [];
    // 软件组件列表（WiFi/MQTT等，无引脚）
    const softwareComponents: Array<{
      pinmapId: string;
      alias: string;
      label?: string;
      libraryType: string;
      displayName: string;
      configTemplate?: any[];
    }> = [];
    // 加载失败的 pinmapIds（pinmap 文件不存在或无法读取）
    const failedPinmapIds: Array<{ pinmapId: string; reason: string }> = [];

    // 1. 添加开发板引脚摘要
    const boardSummary = connectionGraphService.getBoardPinSummary(boardPackagePath);
    if (boardSummary) {
      pinSummaries.push(boardSummary);
    }

    // 2. 解析 pinmapIds（支持字符串和对象两种格式）
    const loadedPinmapIds: string[] = [];
    let rawPinmapIds: ComponentInstanceInput[] = [];
    
    if (input.pinmapIds) {
      if (Array.isArray(input.pinmapIds)) {
        rawPinmapIds = input.pinmapIds;
      } else if (typeof input.pinmapIds === 'string') {
        // 尝试解析 JSON 字符串
        try {
          const parsed = JSON.parse(input.pinmapIds);
          rawPinmapIds = Array.isArray(parsed) ? parsed : [input.pinmapIds];
        } catch {
          rawPinmapIds = [input.pinmapIds];
        }
      }
    }
    
    // 统计每个 pinmapId 出现的次数（用于生成实例编号）
    const pinmapIdCountMap = new Map<string, number>();
    
    if (rawPinmapIds.length > 0 && packagesBasePath) {
      for (const item of rawPinmapIds) {
        // 解析输入项（字符串或对象）
        let pinmapId: string;
        let alias: string | undefined;
        let label: string | undefined;
        
        if (typeof item === 'string') {
          pinmapId = item;
        } else if (typeof item === 'object' && item !== null) {
          pinmapId = item.id;
          alias = item.alias;
          label = item.label;
        } else {
          continue; // 跳过无效项
        }
        
        // 计算实例编号
        const instanceIndex = pinmapIdCountMap.get(pinmapId) || 0;
        pinmapIdCountMap.set(pinmapId, instanceIndex + 1);
        
        // 生成默认别名（如果未指定）
        if (!alias) {
          const ref = connectionGraphService.parsePinmapId(pinmapId);
          alias = instanceIndex === 0 
            ? ref.modelId 
            : `${ref.modelId}_${instanceIndex + 1}`;
        }
        
        // 跳过开发板类型的 pinmapId（已在第一步通过 getBoardPinSummary 添加）
        if (pinmapId.startsWith('board-')) {
          // 开发板已通过 boardSummary 添加，跳过避免重复
          loadedPinmapIds.push(pinmapId);
          continue;
        }
        
        // 检测是否为软件组件（WiFi/MQTT等无引脚组件）
        const softwareCheck = connectionGraphService.checkSoftwareComponent(pinmapId, packagesBasePath);
        if (softwareCheck.isSoftware && softwareCheck.catalog) {
          const catalog = softwareCheck.catalog;
          softwareComponents.push({
            pinmapId,
            alias,
            label,
            libraryType: catalog.softwareMeta?.libraryType || 'other',
            displayName: catalog.displayName,
            configTemplate: catalog.softwareMeta?.configTemplate,
          });
          loadedPinmapIds.push(pinmapId);
          continue; // 软件组件不加载引脚摘要
        }
        
        // 加载引脚摘要（硬件组件）
        const summary = connectionGraphService.loadPinSummaryById(pinmapId, packagesBasePath);
        if (summary) {
          // 多实例时需要修改 componentId 使其唯一（添加别名后缀）
          const modifiedSummary: PinSummary = {
            ...summary,
            componentId: alias,  // 使用别名作为唯一标识
            componentName: label || summary.componentName,
          };
          pinSummaries.push(modifiedSummary);
          loadedPinmapIds.push(pinmapId);
          
          componentInstances.push({
            pinmapId,
            alias,
            label,
            instance: instanceIndex,
          });
        } else {
          // 记录加载失败的 pinmapId
          failedPinmapIds.push({
            pinmapId,
            reason: 'pinmap 文件不存在或无法读取。请先使用 get_project_context 确认该组件的 pinmap 状态，如果状态为 needs_generation 或 missing_catalog，需先调用 generate_pinmap + save_pinmap 生成配置。',
          });
        }
      }
    }

    // 3. 处理 components（旧版兼容 / fallback）
    const notFoundComponents: string[] = [];
    // 确保 components 是字符串数组（兼容 LLM 传入对象数组的情况）
    let componentList: string[] = [];
    if (input.components) {
      let rawComponents: any[] = [];
      if (Array.isArray(input.components)) {
        rawComponents = input.components;
      } else if (typeof input.components === 'string') {
        try {
          const parsed = JSON.parse(input.components);
          rawComponents = Array.isArray(parsed) ? parsed : [input.components];
        } catch {
          rawComponents = [input.components];
        }
      }
      for (const item of rawComponents) {
        if (typeof item === 'string') {
          // 普通字符串：直接用作组件名
          componentList.push(item);
        } else if (item && typeof item === 'object') {
          // 对象：优先取 pinmapId，其次取 componentId/componentName 用于搜索
          if (item.pinmapId && typeof item.pinmapId === 'string') {
            // 如果带完整 pinmapId，直接通过 pinmapId 路径加载，不走 catalog 搜索
            if (!loadedPinmapIds.includes(item.pinmapId) && packagesBasePath) {
              const softwareCheck = connectionGraphService.checkSoftwareComponent(item.pinmapId, packagesBasePath);
              if (softwareCheck.isSoftware && softwareCheck.catalog) {
                const catalog = softwareCheck.catalog;
                const alias = item.refId || connectionGraphService.parsePinmapId(item.pinmapId).modelId;
                softwareComponents.push({
                  pinmapId: item.pinmapId,
                  alias,
                  label: item.componentName,
                  libraryType: catalog.softwareMeta?.libraryType || 'other',
                  displayName: catalog.displayName,
                  configTemplate: catalog.softwareMeta?.configTemplate,
                });
                loadedPinmapIds.push(item.pinmapId);
              } else {
                const summary = connectionGraphService.loadPinSummaryById(item.pinmapId, packagesBasePath);
                if (summary) {
                  const alias = item.refId || connectionGraphService.parsePinmapId(item.pinmapId).modelId;
                  pinSummaries.push({ ...summary, componentId: alias, componentName: item.componentName || summary.componentName });
                  loadedPinmapIds.push(item.pinmapId);
                  componentInstances.push({ pinmapId: item.pinmapId, alias, label: item.componentName, instance: 0 });
                } else {
                  // 记录加载失败
                  failedPinmapIds.push({
                    pinmapId: item.pinmapId,
                    reason: 'pinmap 文件不存在',
                  });
                }
              }
            }
          } else {
            // 没有 pinmapId：降级使用 componentId 或 componentName 文本搜索
            const name = item.componentId || item.componentName;
            if (name && typeof name === 'string') {
              componentList.push(name);
            }
          }
        }
      }
    }
    if (componentList.length > 0 && packagesBasePath) {
      // 扫描所有 catalog 查找匹配的组件
      const catalogs = connectionGraphService.scanPinmapCatalogs(packagesBasePath);
      for (const compName of componentList) {
        const found = findComponentInCatalogs(compName, catalogs, connectionGraphService, packagesBasePath);
        if (found) {
          if (!loadedPinmapIds.includes(found.fullId)) {
            pinSummaries.push(found.summary);
            loadedPinmapIds.push(found.fullId);
          }
        } else {
          notFoundComponents.push(compName);
        }
      }
    }

    // 4. 如果没有指定任何组件，扫描已有的外设配置（旧版方式）
    if (loadedPinmapIds.length === 0) {
      const peripheralConfigs = connectionGraphService.findPeripheralConfigs(boardPackagePath);
      for (const configPath of peripheralConfigs) {
        const config = connectionGraphService.readComponentConfig(configPath);
        if (config) {
          pinSummaries.push(connectionGraphService.extractPinSummary(config));
        }
      }
    }

    // 不再返回完整的 systemPrompt/userPrompt，工具 description 已包含规则
    // LLM 根据 pinSummaries + instructions 生成连线 JSON 即可

    // 如果只有开发板，没有硬件外设（但可能有软件组件）
    if (pinSummaries.length <= 1 && softwareComponents.length === 0) {
      let message = '当前只检测到开发板的引脚配置，未发现外设配置。';
      if (failedPinmapIds.length > 0) {
        message += `\n\n⚠️ 以下 pinmapId 加载失败（pinmap 文件不存在）：`;
        for (const f of failedPinmapIds) {
          message += `\n- ${f.pinmapId}: ${f.reason}`;
        }
      }
      if (notFoundComponents.length > 0) {
        message += `\n未找到以下组件的 pinmap: ${notFoundComponents.join(', ')}`;
      }
      message += '\n\n提示：请先使用 get_project_context 工具确认组件的 pinmap 状态（status 字段），只有 status=available 的组件才可用于生成连线。';

      return {
        is_error: failedPinmapIds.length > 0,  // 如果有加载失败则标记为错误
        content: JSON.stringify({
          message,
          failedPinmapIds: failedPinmapIds.length > 0 ? failedPinmapIds : undefined,
          pinSummaries,
          loadedPinmapIds,
          componentInstances: componentInstances.length > 0 ? componentInstances : undefined,
          instructions: failedPinmapIds.length > 0
            ? '请先调用 get_project_context 确认组件状态，再使用 generate_pinmap + save_pinmap 为缺失配置的组件生成 pinmap。'
            : '请根据上面的引脚信息和用户需求，输出符合 connection_output.json 格式的连线 JSON。输出完成后，请调用 validate_schematic 工具验证连线安全性。',
        }, null, 2),
      };
    }

    // 如果只有软件组件，也允许继续（但不需要物理连线）
    if (pinSummaries.length <= 1 && softwareComponents.length > 0) {
      const softwareDetails = softwareComponents.map(sc => {
        let detail = `- ${sc.alias}: ${sc.displayName} (${sc.libraryType})`;
        if (sc.configTemplate && sc.configTemplate.length > 0) {
          const configItems = sc.configTemplate.map((ct: any) => `${ct.label}(${ct.key})`).join(', ');
          detail += `\n  需要配置: ${configItems}`;
        }
        return detail;
      }).join('\n');

      return {
        is_error: false,
        content: JSON.stringify({
          message: '检测到软件/云端通信组件（无物理引脚），不需要生成物理连线图。',
          softwareComponents,
          softwareComponentsNote: `以下软件组件将在连线图中以信息卡片形式展示：\n${softwareDetails}`,
          instructions: `请在 connection_output.json 的 components 数组中添加软件组件，设置 componentType: "software" 和 softwareConfig 字段。
示例：
{
  "refId": "${softwareComponents[0]?.alias || 'wifi'}",
  "componentId": "${softwareComponents[0]?.displayName || 'WiFi'}",
  "componentName": "${softwareComponents[0]?.label || softwareComponents[0]?.displayName || 'WiFi 模块'}",
  "pinmapId": "${softwareComponents[0]?.pinmapId || 'lib-wifi:default:default'}",
  "componentType": "software",
  "softwareConfig": {
    "libraryType": "${softwareComponents[0]?.libraryType || 'wifi'}",
    "icon": "wifi",
    "properties": {
      "ssid": "MyNetwork",
      "password": "********"
    }
  }
}

请询问用户需要配置的属性值，然后生成完整的配置。`,
        }, null, 2),
      };
    }

    // 构建多实例说明（如果有）
    let multiInstanceNote = '';
    if (componentInstances.length > 0) {
      const instanceDetails = componentInstances.map(ci => 
        `- ${ci.alias}: pinmapId="${ci.pinmapId}"${ci.label ? `, 名称="${ci.label}"` : ''}`
      ).join('\n');
      multiInstanceNote = `

### 组件实例映射
以下是组件的 refId（别名）与 pinmapId 的对应关系，在 JSON 中 from.ref / to.ref 字段使用 refId：
${instanceDetails}
`;
    }

    // 构建软件组件说明（如果有）
    let softwareComponentNote = '';
    if (softwareComponents.length > 0) {
      const softwareDetails = softwareComponents.map(sc => {
        let detail = `- ${sc.alias}: ${sc.displayName} (${sc.libraryType})`;
        if (sc.configTemplate && sc.configTemplate.length > 0) {
          const configItems = sc.configTemplate.map(ct => `${ct.label}(${ct.key})`).join(', ');
          detail += `\n  配置项: ${configItems}`;
        }
        return detail;
      }).join('\n');
      softwareComponentNote = `

### 软件组件（无物理连接）
以下组件是软件/云端通信库，不需要物理引脚连接，在连线图中以信息卡片形式展示：
${softwareDetails}

在 components 数组中，软件组件需要设置 componentType: "software" 和 softwareConfig 字段。
`;
    }

    // 构建失败组件警告
    let failedComponentsWarning = '';
    if (failedPinmapIds.length > 0) {
      failedComponentsWarning = `

### ⚠️ 以下组件的 pinmap 加载失败
${failedPinmapIds.map(f => `- ${f.pinmapId}: ${f.reason}`).join('\n')}

这些组件无法生成连线，请先调用 get_project_context 确认其状态，再使用 generate_pinmap + save_pinmap 生成配置。`;
    }

    // === 生成 AWS 格式的引脚摘要 ===
    const { generatePinmapSummary } = await import('../../../services/connection-aws');
    
    // 构建 AWS 格式的组件摘要数组
    const awsSummaryParts: string[] = [];
    
    // 从开发板包路径提取包名
    const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || 'board';
    const boardPinmapId = `${boardPkgName}:default:default`;
    
    // 添加开发板摘要
    if (boardSummary) {
      awsSummaryParts.push(generatePinmapSummary(boardSummary, 'board', boardPinmapId));
    }
    
    // 添加组件摘要
    for (const ci of componentInstances) {
      const summary = pinSummaries.find(ps => ps.componentId === ci.alias);
      if (summary) {
        awsSummaryParts.push(generatePinmapSummary(summary, ci.alias, ci.pinmapId));
      }
    }
    
    const awsPinmapSummary = awsSummaryParts.join('\n\n');

    // === 方案 A：推送预览到 iframe（板子 + 组件，无连线）===
    if (pinSummaries.length > 1) {
      try {
        const previewConfigMap = new Map<string, any>();
        const previewComponents: any[] = [];

        // 添加开发板
        if (boardConfig) {
          previewConfigMap.set('board', boardConfig);
          previewComponents.push({
            refId: 'board',
            componentId: boardConfig.id,
            componentName: boardConfig.name,
            pinmapId: boardPinmapId,
            isBoard: true,
          });
        }

        // 添加外设组件
        for (const ci of componentInstances) {
          const fullConfig = connectionGraphService.loadPinmapById(ci.pinmapId, packagesBasePath);
          if (fullConfig) {
            previewConfigMap.set(ci.alias, fullConfig);
            previewComponents.push({
              refId: ci.alias,
              componentId: fullConfig.id,
              componentName: ci.label || fullConfig.name,
              pinmapId: ci.pinmapId,
              instance: ci.instance,
            });
          }
        }

        const previewPayload = {
          componentConfigs: Object.fromEntries(previewConfigMap),
          components: previewComponents,
          connections: [],   // 空连线 — 预览模式
        };

        // 嵌入模式：直接推送
        if (connectionGraphService.hasActiveIframe) {
          await connectionGraphService.iframeApi.receiveData(previewPayload);
        }
        // 子窗口模式：通过 IPC 推送
        if (typeof window !== 'undefined' && window['ipcRenderer']) {
          window['ipcRenderer'].send('iframe-message-connection-graph', {
            type: 'generate-graph-updated',
            data: previewPayload,
          });
        }

        connectionGraphService.emitNotice?.({
          title: 'AI生成中',
          text: '硬件组件已就绪，正在生成连线方案...',
          state: 'doing',
          showProgress: false,
        });
      } catch (e) {
        // 预览推送失败不影响主流程
        console.warn('[generate_schematic] 预览推送失败:', e);
      }
    }

    const result: any = {
      awsPinmapSummary,  // AWS 格式的引脚摘要
      loadedPinmapIds,
      failedPinmapIds: failedPinmapIds.length > 0 ? failedPinmapIds : undefined,
      componentInstances: componentInstances.length > 0 ? componentInstances : undefined,
      softwareComponents: softwareComponents.length > 0 ? softwareComponents : undefined,
      notFoundComponents: notFoundComponents.length > 0 ? notFoundComponents : undefined,
    };

    // 仅当存在动态信息（多实例/软件组件/失败组件）时才添加附注
    const notes: string[] = [];
    if (multiInstanceNote) notes.push(multiInstanceNote);
    if (softwareComponentNote) notes.push(softwareComponentNote);
    if (failedComponentsWarning) notes.push(failedComponentsWarning);
    if (notes.length > 0) {
      result.notes = notes.join('\n');
    }

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `生成连线图失败: ${error.message || error}`,
    };
  }
}

/**
 * get_pinmap_summary 工具
 *
 * 获取当前项目的引脚摘要信息，供 Agent 了解可用引脚。
 * 支持通过 pinmapIds 参数指定具体的传感器变体。
 */
export async function getPinmapSummaryTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapIds?: string[] }
): Promise<ToolUseResult> {
  try {
    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目或未安装开发板包。',
      };
    }

    // 直接使用 currentProjectPath 构建 packagesBasePath（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    // 使用字符串模板确保类型正确
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;
    const pinSummaries: PinSummary[] = [];
    const loadedPinmapIds: string[] = [];

    // 1. 添加开发板引脚摘要
    const boardSummary = connectionGraphService.getBoardPinSummary(boardPackagePath);
    if (boardSummary) {
      pinSummaries.push(boardSummary);
    }

    // 2. 如果指定了 pinmapIds，加载对应的摘要
    // 确保 pinmapIds 是数组（Agent 可能传入字符串）
    let pinmapIdList: string[] = [];
    if (input.pinmapIds) {
      if (Array.isArray(input.pinmapIds)) {
        pinmapIdList = input.pinmapIds;
      } else if (typeof input.pinmapIds === 'string') {
        try {
          const parsed = JSON.parse(input.pinmapIds);
          pinmapIdList = Array.isArray(parsed) ? parsed : [input.pinmapIds];
        } catch {
          pinmapIdList = [input.pinmapIds];
        }
      }
    }
    if (pinmapIdList.length > 0 && packagesBasePath) {
      for (const fullId of pinmapIdList) {
        const summary = connectionGraphService.loadPinSummaryById(fullId, packagesBasePath);
        if (summary) {
          pinSummaries.push(summary);
          loadedPinmapIds.push(fullId);
        }
      }
    }

    if (pinSummaries.length === 0) {
      return {
        is_error: true,
        content: '未找到任何引脚配置文件（pinmap.json）。',
      };
    }

    // 同时返回已有的连线数据（如果存在）
    const existingConnections = connectionGraphService.getConnectionGraph();

    const result: any = {
      pinSummaries,
      loadedPinmapIds: loadedPinmapIds.length > 0 ? loadedPinmapIds : undefined,
    };

    if (existingConnections) {
      result.existingConnectionGraph = {
        description: existingConnections.description,
        componentCount: existingConnections.components.length,
        connectionCount: existingConnections.connections.length,
        components: existingConnections.components.map(c => ({
          refId: c.refId,
          pinmapId: c.pinmapId,
          componentId: c.componentId,
        })),
      };
    }

    // 如果没有指定 pinmapIds，提示可用的传感器
    if (!input.pinmapIds && packagesBasePath) {
      const availableIds = connectionGraphService.getAvailablePinmapIds(packagesBasePath, { status: 'available' });
      if (availableIds.length > 0) {
        result.availableSensorPinmapIds = availableIds.slice(0, 10); // 最多显示 10 个
        result.tip = '使用 get_project_context 工具可查看完整的组件目录。';
      }
    }

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取引脚摘要失败: ${error.message || error}`,
    };
  }
}

/**
 * get_project_context 工具
 *
 * 合并 get_context + get_component_catalog 的功能，一次返回项目上下文 + 组件目录。
 * 替代原先需要依次调用两个工具的两步操作。
 */
export async function getProjectContextTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { includeNeedsGeneration?: boolean }
): Promise<ToolUseResult> {
  try {
    // === Part 1: 项目上下文（来自 getContextTool 逻辑）===
    const { getContextTool } = await import('./getContextTool');
    const contextResult = await getContextTool(projectService, { info_type: 'all' });
    let contextData: any = {};
    try {
      contextData = JSON.parse(contextResult.content);
    } catch { /* ignore */ }

    // === Part 2: 组件目录（来自 getSensorPinmapCatalogTool 逻辑）===
    const catalogResult = await getSensorPinmapCatalogTool(
      connectionGraphService,
      projectService,
      { includeNeedsGeneration: input.includeNeedsGeneration, includeBoards: true }
    );
    let catalogData: any = {};
    try {
      catalogData = JSON.parse(catalogResult.content);
    } catch { /* ignore */ }

    // === 合并结果 ===
    const merged: any = {
      // 项目基本信息
      project: contextData.project,
      editingMode: contextData.editingMode,
      cppCode: contextData.cppCode,
      // 组件目录信息
      currentBoard: catalogData.currentBoard,
    };

    if (contextData.warn) {
      merged.warn = contextData.warn;
    }

    if (catalogData.catalogs) {
      merged.catalogCount = catalogData.catalogCount;
      merged.catalogs = catalogData.catalogs;
      merged.usage = catalogData.usage;
    }

    if (catalogData.softwareLibraries) {
      merged.softwareLibraries = catalogData.softwareLibraries;
      merged.softwareUsage = catalogData.softwareUsage;
    }

    if (catalogData.librariesMissingCatalog) {
      merged.librariesMissingCatalog = catalogData.librariesMissingCatalog;
      merged.missingCatalogTip = catalogData.missingCatalogTip;
    }

    if (catalogData.message) {
      merged.catalogMessage = catalogData.message;
    }

    return {
      is_error: false,
      content: JSON.stringify(merged, null, 2),
    };
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取项目上下文失败: ${error.message || error}`,
    };
  }
}

/**
 * get_component_catalog 工具
 *
 * 获取当前项目的组件目录（开发板 + 传感器库 + 软件库）。
 * 对于没有 pinmap_catalog.json 的库，也会列出并标记为 needs_catalog_generation。
 */
export async function getSensorPinmapCatalogTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { libraryFilter?: string; includeNeedsGeneration?: boolean; includeBoards?: boolean }
): Promise<ToolUseResult> {
  try {
    // 直接使用 currentProjectPath 构建路径（参考 getContextTool.ts）
    const currentProjectPath = projectService.currentProjectPath;
    if (!currentProjectPath || currentProjectPath === projectService.projectRootPath) {
      return {
        is_error: true,
        content: '当前没有打开的项目。',
      };
    }

    // node_modules 路径作为 packagesBasePath - 使用字符串拼接确保类型正确
    const packagesBasePath = `${currentProjectPath}/node_modules`;
    if (!AilyHost.get().fs.existsSync(packagesBasePath)) {
      return {
        is_error: true,
        content: '项目的 node_modules 目录不存在，请先安装依赖。',
      };
    }

    // 使用 scanAllLibraries 扫描所有 lib-* 库（包括没有 catalog 的）
    let libraryResults = connectionGraphService.scanAllLibraries(packagesBasePath);

    // 过滤库
    if (input.libraryFilter) {
      libraryResults = libraryResults.filter(lib => {
        return lib.packageSlug === input.libraryFilter ||
               lib.packageSlug === `lib-${input.libraryFilter}` ||
               `@aily-project/${lib.packageSlug}` === input.libraryFilter;
      });
    }

    // 构建输出结果
    const catalogsWithPinmap: any[] = [];  // 有 catalog 的硬件库
    let boardCatalog: any = null;  // 当前开发板的 catalog

    // 如果 includeBoards 为 true，获取当前项目的开发板 catalog
    if (input.includeBoards) {
      try {
        const boardPackagePath = await projectService.getBoardPackagePath();
        if (boardPackagePath) {
          // 读取开发板的 pinmap_catalog.json
          const catalog = connectionGraphService.readPinmapCatalog(boardPackagePath);
          if (catalog) {
            // 从包路径提取 packageSlug（如 board-xiao_esp32s3）
            const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || '';
            boardCatalog = {
              packageSlug: boardPkgName,
              displayName: catalog.displayName,
              type: 'board',
              icon: catalog.icon,
              catalogStatus: 'available',
              isCurrentBoard: true,
              models: catalog.models.map(model => ({
                id: model.id,
                name: model.name,
                description: model.description,
                defaultVariant: model.defaultVariant,
                variants: model.variants
                  .filter(v => input.includeNeedsGeneration !== false || v.status === 'available')
                  .map(v => ({
                    id: v.id,
                    name: v.name,
                    fullId: v.fullId,
                    protocol: v.protocol,
                    manufacturer: v.manufacturer,
                    status: v.status,
                    isDefault: v.isDefault,
                    previewPins: v.previewPins,
                  })),
              })).filter(m => m.variants.length > 0),
            };
          } else {
            // 开发板没有 pinmap_catalog.json，检查是否有 pinmap.json（旧版格式）
            const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
            const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || '';
            if (boardConfig) {
              boardCatalog = {
                packageSlug: boardPkgName,
                displayName: boardConfig.name || boardPkgName,
                type: 'board',
                catalogStatus: 'legacy_pinmap',
                isCurrentBoard: true,
                tip: '该开发板使用旧版 pinmap.json 格式，可直接使用。如需更新可使用 generate_pinmap 工具。',
                pinmapId: `${boardPkgName}:default:default`,
              };
            } else {
              // 开发板既没有 catalog 也没有 pinmap.json
              boardCatalog = {
                packageSlug: boardPkgName,
                displayName: boardPkgName,
                type: 'board',
                catalogStatus: 'missing',
                isCurrentBoard: true,
                tip: `当前开发板缺少 pinmap 配置，使用 generate_pinmap 工具生成配置，pinmapId 格式：${boardPkgName}:{modelId}:default`,
              };
            }
          }
        }
      } catch (e) {
        console.error('获取开发板 catalog 失败:', e);
      }
    }
    const softwareLibraries: any[] = [];   // 软件类型的库（WiFi/MQTT等）
    const librariesMissingCatalog: any[] = [];  // 没有 catalog 的库

    for (const lib of libraryResults) {
      if (lib.hasPinmapCatalog && lib.catalog) {
        // 有 pinmap_catalog.json 的库
        const catalog = lib.catalog;
        // 过滤开发板
        if (!input.includeBoards && catalog.type === 'board') continue;

        // 软件类型的库单独处理
        if (catalog.type === 'software') {
          softwareLibraries.push({
            packageSlug: lib.packageSlug,
            displayName: catalog.displayName,
            type: 'software',
            icon: catalog.icon || catalog.softwareMeta?.defaultIcon,
            libraryType: catalog.softwareMeta?.libraryType || 'other',
            configTemplate: catalog.softwareMeta?.configTemplate,
            catalogStatus: 'available',
            usage: '软件库不需要引脚连接，在连线图中显示为信息卡片',
          });
          continue;
        }

        catalogsWithPinmap.push({
          packageSlug: lib.packageSlug,
          displayName: catalog.displayName,
          type: catalog.type || 'library',
          icon: catalog.icon,
          catalogStatus: 'available',
          models: catalog.models.map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            defaultVariant: model.defaultVariant,
            variants: model.variants
              .filter(v => input.includeNeedsGeneration !== false || v.status === 'available')
              .map(v => ({
                id: v.id,
                name: v.name,
                fullId: v.fullId,
                protocol: v.protocol,
                manufacturer: v.manufacturer,
                status: v.status,
                isDefault: v.isDefault,
                previewPins: v.previewPins,
              })),
          })).filter(m => m.variants.length > 0),
        });
      } else {
        // 没有 pinmap_catalog.json 的库
        librariesMissingCatalog.push({
          packageSlug: lib.packageSlug,
          displayName: lib.displayName,
          catalogStatus: 'missing_catalog',
          tip: `使用 generate_pinmap 工具为此库生成配置，pinmapId 格式：${lib.packageSlug}:{modelId}:{variantId}`,
        });
      }
    }

    // 过滤掉没有有效 models 的 catalog
    const validCatalogs = catalogsWithPinmap.filter(c => c.models && c.models.length > 0);

    // 构建结果
    const resultContent: any = {};

    // 添加开发板 catalog（如果有）
    if (boardCatalog) {
      resultContent.currentBoard = boardCatalog;
    }

    if (validCatalogs.length > 0) {
      resultContent.catalogCount = validCatalogs.length;
      resultContent.catalogs = validCatalogs;
      resultContent.usage = '使用 fullId（如 "lib-dht:dht20:asair"）作为 generate_schematic 的 pinmapIds 参数';
    }

    if (softwareLibraries.length > 0) {
      resultContent.softwareLibraries = softwareLibraries;
      resultContent.softwareUsage = '软件库（WiFi/MQTT/HTTP等）不需要物理引脚连接。在连线图中以信息卡片形式展示，使用 packageSlug 作为 generate_schematic 的 pinmapIds 参数（格式：{packageSlug}:default:default）';
    }

    if (librariesMissingCatalog.length > 0) {
      resultContent.librariesMissingCatalog = librariesMissingCatalog;
      resultContent.missingCatalogTip = '这些库没有 pinmap_catalog.json，你可以使用 generate_pinmap 工具为它们生成 pinmap 配置';
    }

    if (validCatalogs.length === 0 && softwareLibraries.length === 0 && librariesMissingCatalog.length === 0) {
      return {
        is_error: false,
        content: JSON.stringify({
          message: '未找到已安装的 lib-* 传感器库。',
          tip: '请先安装传感器库，如 npm install @aily-project/lib-dht',
        }, null, 2),
      };
    }

    if (validCatalogs.length === 0 && softwareLibraries.length === 0 && librariesMissingCatalog.length > 0) {
      // 只有没有 catalog 的库
      resultContent.message = '已安装的库都没有 pinmap_catalog.json 配置文件';
    }

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(resultContent, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取传感器目录失败: ${error.message || error}`,
    };
  }
}

/**
 * validate_schematic 工具
 *
 * 验证连线配置的安全性，检查短路、电压不匹配、引脚冲突等问题。
 * 支持通过 aws 参数传入 AWS 格式连线，解析后验证并保存；
 * 不传参数则验证项目中已保存的连线。
 */
export async function validateConnectionGraphTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { aws?: string }
): Promise<ToolUseResult> {
  try {
    const currentProjectPath = projectService.currentProjectPath;
    if (!currentProjectPath) {
      return { is_error: true, content: '当前没有打开的项目，请先创建或打开一个项目。' };
    }

    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return { is_error: true, content: '当前项目没有配置开发板，请先选择开发板。' };
    }

    const { parseAWS, hasErrors, formatErrors, AWS_SYNTAX_REFERENCE, CONNECTION_COLORS, resolvePin } = await import('../../../services/connection-aws');

    // 1. 获取 AWS 内容
    let awsContent: string;
    if (input.aws) {
      awsContent = input.aws;
    } else if (connectionGraphService.hasAWSFile()) {
      awsContent = connectionGraphService.readAWSFile();
    } else {
      // 没有 AWS 输入，尝试验证已保存的 JSON 数据
      const existingData = connectionGraphService.getConnectionGraph();
      if (!existingData) {
        return {
          is_error: true,
          content: '没有可验证的连线数据。请先使用 generate_schematic 生成连线，然后传入 aws 参数。',
        };
      }
      const validationResults = connectionGraphService.validateConnectionGraph(existingData);
      const errors = validationResults.filter(r => r.level === 'error');
      const warnings = validationResults.filter(r => r.level === 'warning');
      return {
        is_error: false,
        content: JSON.stringify({
          valid: errors.length === 0,
          saved: false,
          summary: {
            totalConnections: existingData.connections.length,
            totalComponents: existingData.components.length,
            errors: errors.length,
            warnings: warnings.length,
          },
          issues: validationResults.length > 0 ? validationResults : undefined,
          message: errors.length === 0
            ? (warnings.length > 0
              ? `连线配置基本安全，但有 ${warnings.length} 条警告需要注意。`
              : '连线配置安全，所有检查通过。')
            : `发现 ${errors.length} 个安全问题，请修正后重新验证。`,
          tip: '用户可以点击右侧工具栏的「电路连接」按钮查看连线图。',
        }, null, 2),
      };
    }

    // 2. 解析 AWS
    const parsed = parseAWS(awsContent);
    if (hasErrors(parsed)) {
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          errors: parsed.errors,
          warnings: parsed.warnings,
          errorMessage: formatErrors(parsed),
          syntaxReference: AWS_SYNTAX_REFERENCE,
          tip: '请根据上述错误信息修正 AWS 语法后重试。',
        }, null, 2),
      };
    }

    // 3. 加载组件配置
    const packagesBasePath = `${currentProjectPath}/node_modules`;
    const configMap = new Map<string, ComponentConfig>();
    const loadErrors: Array<{ pinmapId: string; error: string; line: number }> = [];

    const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
    if (boardConfig) {
      configMap.set('board', boardConfig);
    } else {
      const usesBoardRef = parsed.connections.some(
        conn => conn.fromRef === 'board' || conn.toRef === 'board'
      );
      if (usesBoardRef) {
        return {
          is_error: true,
          content: JSON.stringify({
            success: false,
            error: '开发板引脚配置不存在',
            tip: '请先使用 generate_pinmap + save_pinmap 为当前开发板生成 pinmap 配置。',
            syntaxReference: AWS_SYNTAX_REFERENCE,
          }, null, 2),
        };
      }
    }

    for (const use of parsed.uses) {
      const config = connectionGraphService.loadPinmapById(use.pinmapId, packagesBasePath);
      if (!config) {
        if (use.pinmapId.startsWith('board:') || use.pinmapId.startsWith('board-')) {
          const bConfig = connectionGraphService.getBoardConfig(boardPackagePath);
          if (bConfig) { configMap.set(use.alias, bConfig); continue; }
        }
        loadErrors.push({ pinmapId: use.pinmapId, error: '无法加载组件配置，请检查 pinmapId 是否正确或 pinmap 文件是否存在', line: use.line });
        continue;
      }
      configMap.set(use.alias, config);
    }

    if (loadErrors.length > 0) {
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          loadErrors,
          message: '部分组件配置加载失败',
          tip: '请调用 get_project_context 确认组件状态，使用 generate_pinmap + save_pinmap 补全缺失配置后重试。',
          syntaxReference: AWS_SYNTAX_REFERENCE,
        }, null, 2),
      };
    }

    // 4. 解析引脚并构建连线
    const connections: any[] = [];
    const resolveErrors: Array<{ message: string; line: number; source: string }> = [];
    let connIndex = 1;

    for (const conn of parsed.connections) {
      const fromConfig = configMap.get(conn.fromRef);
      const toConfig = configMap.get(conn.toRef);

      if (!fromConfig) { resolveErrors.push({ message: `找不到组件 "${conn.fromRef}" 的配置`, line: conn.line, source: `${conn.fromRef}.${conn.fromPin}` }); continue; }
      if (!toConfig) { resolveErrors.push({ message: `找不到组件 "${conn.toRef}" 的配置`, line: conn.line, source: `${conn.toRef}.${conn.toPin}` }); continue; }

      const fromResolved = resolvePin(fromConfig, conn.fromPin);
      if (!fromResolved) { resolveErrors.push({ message: `在组件 "${conn.fromRef}" (${fromConfig.name}) 中找不到引脚 "${conn.fromPin}"`, line: conn.line, source: `${conn.fromRef}.${conn.fromPin}` }); continue; }

      const toResolved = resolvePin(toConfig, conn.toPin);
      if (!toResolved) { resolveErrors.push({ message: `在组件 "${conn.toRef}" (${toConfig.name}) 中找不到引脚 "${conn.toPin}"`, line: conn.line, source: `${conn.toRef}.${conn.toPin}` }); continue; }

      const connType = conn.type as keyof typeof CONNECTION_COLORS;
      const color = CONNECTION_COLORS[connType] || CONNECTION_COLORS.other;
      const label = conn.note || `${conn.type.toUpperCase()}: ${conn.fromPin} → ${conn.toPin}`;

      connections.push({
        id: `conn_${connIndex++}`,
        from: { ref: conn.fromRef, pinId: fromResolved.pinId, function: fromResolved.functionName },
        to: { ref: conn.toRef, pinId: toResolved.pinId, function: toResolved.functionName },
        type: conn.type, label, color, bus: conn.bus,
      });
    }

    if (resolveErrors.length > 0) {
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          resolveErrors,
          message: '引脚解析失败',
          tip: '请检查引脚名称是否正确。可使用 generate_schematic 获取正确的引脚名称。',
          syntaxReference: AWS_SYNTAX_REFERENCE,
        }, null, 2),
      };
    }

    // 5. 构建完整 JSON
    const description = parsed.comments.length > 0
      ? parsed.comments[0]
      : `连线方案（${parsed.uses.map(u => u.label || u.alias).join(' + ')}）`;

    const components: any[] = [];
    if (boardConfig) {
      const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || 'board';
      components.push({ refId: 'board', componentId: boardConfig.id, componentName: boardConfig.name, pinmapId: `${boardPkgName}:default:default`, isBoard: true });
    }
    for (const [index, use] of parsed.uses.entries()) {
      const config = configMap.get(use.alias)!;
      const sameTypeCount = parsed.uses.slice(0, index).filter(u => u.pinmapId === use.pinmapId).length;
      components.push({ refId: use.alias, componentId: config.id, componentName: use.label || config.name, pinmapId: use.pinmapId, instance: sameTypeCount });
    }

    const jsonData = { version: '1.0.0', description, components, connections };

    // 6. 运行安全检查
    const validationResults = connectionGraphService.validateConnectionGraph(jsonData);
    const errors = validationResults.filter(r => r.level === 'error');
    const warnings = validationResults.filter(r => r.level === 'warning');

    // 7. 保存 AWS 和 JSON
    if (input.aws) {
      connectionGraphService.saveAWSFile(awsContent);
    }
    connectionGraphService.saveJSONFile(jsonData);

    // 8. 通知 iframe 刷新（嵌入模式；子窗口模式已由 saveJSONFile → IPC 处理）
    if (connectionGraphService.hasActiveIframe) {
      try {
        await connectionGraphService.iframeApi.receiveData({
          componentConfigs: Object.fromEntries(configMap),
          components: jsonData.components,
          connections: jsonData.connections,
        });
      } catch {
        // iframe 通知失败不影响主流程
      }
    }

    // 通知完成（嵌入 + 子窗口均生效）
    connectionGraphService.emitNotice?.({
      title: 'AI生成中',
      text: '✅ 连线图已生成完成',
      state: 'done',
      setTimeout: 3000,
    });

    const result = {
      valid: errors.length === 0,
      saved: true,
      summary: {
        totalConnections: jsonData.connections.length,
        totalComponents: jsonData.components.length,
        errors: errors.length,
        warnings: warnings.length,
      },
      issues: validationResults.length > 0 ? validationResults : undefined,
      message: errors.length === 0
        ? (warnings.length > 0
          ? `连线配置基本安全，但有 ${warnings.length} 条警告需要注意。数据已保存。`
          : '连线配置安全，所有检查通过。数据已保存。')
        : `发现 ${errors.length} 个安全问题，请修正后重新验证。`,
      awsWarnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
      tip: '用户可以点击右侧工具栏的「电路连接」按钮查看连线图。',
    };

    return {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
  } catch (error: any) {
    return {
      is_error: true,
      content: `验证连线配置失败: ${error.message || error}`,
    };
  }
}
// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 在所有 catalog 中查找匹配的组件（通过简称）
 */
function findComponentInCatalogs(
  compName: string,
  catalogs: PinmapCatalog[],
  connectionGraphService: ConnectionGraphService,
  packagesBasePath: string
): { fullId: string; summary: PinSummary } | null {
  const lowerName = compName.toLowerCase();

  for (const catalog of catalogs) {
    for (const model of catalog.models) {
      // 匹配 model.id 或 model.name
      if (model.id.toLowerCase() === lowerName ||
          model.name.toLowerCase().includes(lowerName)) {
        // 找到匹配的 model，返回默认变体
        const defaultVariant = model.variants.find(v => v.isDefault) || model.variants[0];
        if (defaultVariant && defaultVariant.status === 'available') {
          const summary = connectionGraphService.loadPinSummaryById(defaultVariant.fullId, packagesBasePath);
          if (summary) {
            return { fullId: defaultVariant.fullId, summary };
          }
        }
      }
    }
  }

  return null;
}

// =============================================================================
// Pinmap 生成工具
// =============================================================================

/**
 * generate_pinmap 工具
 *
 * 为缺失 pinmap 的组件（开发板、传感器、模块等）生成配置。返回包文档、示例代码和模板，供 LLM 生成完整的 pinmap JSON。
 */
export async function generatePinmapTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapId: string; referenceSource?: 'readme' | 'example' | 'auto' }
): Promise<ToolUseResult> {
  try {
    if (!input.pinmapId) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapId。请提供目标组件的完整标识符，如 "lib-servo:sg90:default"。',
      };
    }

    const currentProjectPath = projectService.currentProjectPath;
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    if (!packagesBasePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目，无法定位组件包。',
      };
    }

    // 解析 pinmapId
    const ref = connectionGraphService.parsePinmapId(input.pinmapId);

    // 查找变体信息
    const variantInfo = connectionGraphService.findVariantInfo(input.pinmapId, packagesBasePath);
    
    // 获取库信息
    const libraryInfo = connectionGraphService.getLibraryInfo(input.pinmapId, packagesBasePath);

    // 获取协议对应的模板
    const protocol = variantInfo?.protocol || 'other';
    const template = connectionGraphService.getPinmapTemplate(protocol as PinmapProtocol);

    // // 如果已有同库的其他 pinmap，读取一个作为参考（精简版）
    // let existingPinmapExample: any = null;
    // if (libraryInfo.existingPinmaps && libraryInfo.existingPinmaps.length > 0) {
    //   const packagePath = `${packagesBasePath}/@aily-project/${ref.packageSlug}`;
    //   const exampleFileName = libraryInfo.existingPinmaps[0];
    //   const examplePath = `${packagePath}/pinmaps/${exampleFileName}`;
    //   existingPinmapExample = connectionGraphService.readComponentConfig(examplePath);
    // }

    // 构建返回结果
    const result: any = {
      targetPinmapId: input.pinmapId,
      parsedRef: ref,
      variantInfo: variantInfo ? {
        name: variantInfo.name,
        protocol: variantInfo.protocol,
        manufacturer: variantInfo.manufacturer,
        voltage: variantInfo.voltage,
        note: variantInfo.note,
      } : undefined,
    };

    // 根据 referenceSource 决定返回哪些信息
    const source = input.referenceSource || 'auto';
    
    // README 限制最大长度（约 2000 字符，避免过多 token 消耗）
    const MAX_README_LENGTH = 2000;
    if (source === 'auto' || source === 'readme') {
      if (libraryInfo.readme) {
        if (libraryInfo.readme.length > MAX_README_LENGTH) {
          result.readme = libraryInfo.readme.slice(0, MAX_README_LENGTH) + '\n\n... (内容已截断，仅显示前 2000 字符)';
        } else {
          result.readme = libraryInfo.readme;
        }
      }
    }

    // 示例代码也限制长度
    const MAX_EXAMPLE_LENGTH = 1500;
    if (source === 'auto' || source === 'example') {
      if (libraryInfo.exampleCode) {
        if (libraryInfo.exampleCode.length > MAX_EXAMPLE_LENGTH) {
          result.exampleCode = libraryInfo.exampleCode.slice(0, MAX_EXAMPLE_LENGTH) + '\n\n// ... (代码已截断)';
        } else {
          result.exampleCode = libraryInfo.exampleCode;
        }
      }
    }

    // // 只返回现有示例（移除 pinmapTemplate，因为 instructions 中已有详细规则）
    // if (existingPinmapExample) {
    //   result.existingPinmapExample = existingPinmapExample;
    // }

    // 返回模板结构（让 LLM 直接参照 JSON 结构）
    result.pinmapTemplate = template;

    // 生成简化的补充说明
    result.instructions = `根据 pinmapTemplate 结构和 readme 信息生成 pinmap 配置。

## 关键规则

1. **id**: 使用 "component_${ref.modelId}_${ref.variantId}"
2. **尺寸计算**:
   - height = max(左侧引脚数, 右侧引脚数) × 20 + 40
   - width = 根据引脚名称长度调整，通常 120-200，名称长则增大
3. **引脚位置**:
   - y 值: 首个 y≈32，间距 20
   - 左侧引脚: x≈10, labelX≈-20, labelAnchor="right"（文字右对齐到 labelX）
   - 右侧引脚: x≈width-15, labelX≈width+12, labelAnchor="left"（文字左对齐从 labelX 起）
   - labelY = y - 7
4. **images.url**: 使用可渲染图片的 base64（如 data:image/png;base64,...），不要在图片中添加文本信息
5. **images**: 必须包含这个字段及其结构，即使没有图片也要保留 images: { url: "", width: 0, height: 0 }

## 保存

生成后调用：save_pinmap(pinmapId="${input.pinmapId}", pinmapConfig={JSON})`;

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `获取 pinmap 生成信息失败: ${error.message || error}`,
    };
  }
}

/**
 * save_pinmap 工具
 *
 * 保存 LLM 生成的 pinmap 配置到库目录，并更新 catalog 状态。
 */
export async function savePinmapTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { pinmapId: string; pinmapConfig: ComponentConfig | string }
): Promise<ToolUseResult> {
  try {
    if (!input.pinmapId) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapId。',
      };
    }

    if (!input.pinmapConfig) {
      return {
        is_error: true,
        content: '缺少必需参数 pinmapConfig。请提供完整的 pinmap 配置 JSON。',
      };
    }

    const currentProjectPath = projectService.currentProjectPath;
    const packagesBasePath = currentProjectPath ? `${currentProjectPath}/node_modules` : null;

    if (!packagesBasePath) {
      return {
        is_error: true,
        content: '当前没有打开的项目，无法保存 pinmap。',
      };
    }

    // 解析 pinmapConfig（可能是字符串或对象）
    let config: ComponentConfig;
    if (typeof input.pinmapConfig === 'string') {
      try {
        config = JSON.parse(input.pinmapConfig);
      } catch (e) {
        return {
          is_error: true,
          content: 'pinmapConfig 不是有效的 JSON 格式。',
        };
      }
    } else {
      config = input.pinmapConfig;
    }

    // 基本验证
    if (!config.id || !config.name || !config.pins || !Array.isArray(config.pins)) {
      return {
        is_error: true,
        content: 'pinmapConfig 缺少必需字段（id, name, pins）。请确保配置完整。',
      };
    }

    // 保存 pinmap
    const saveResult = connectionGraphService.savePinmapConfig(input.pinmapId, config, packagesBasePath);

    if (!saveResult.success) {
      return {
        is_error: true,
        content: `保存 pinmap 失败: ${saveResult.error}`,
      };
    }

    const result = {
      success: true,
      pinmapId: input.pinmapId,
      filePath: saveResult.filePath,
      message: `Pinmap 配置已保存到 ${saveResult.filePath}，catalog 状态已更新为 "available"。`,
      tip: '现在可以在 generate_schematic 工具中使用此 pinmapId 了。',
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `保存 pinmap 失败: ${error.message || error}`,
    };
  }
}

/**
 * get_current_schematic 工具
 *
 * 读取当前项目中已保存的连线图 JSON 完整内容。
 * 用于编辑/删除/添加连线前获取当前状态。
 */
export async function getCurrentSchematicTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: {}
): Promise<ToolUseResult> {
  try {
    const data = connectionGraphService.getConnectionGraph();

    if (!data) {
      return {
        is_error: false,
        content: JSON.stringify({
          exists: false,
          message: '当前项目没有已保存的连线图。',
          tip: '请先调用 get_project_context + generate_schematic 生成连线方案。',
        }, null, 2),
      };
    }

    const result = {
      exists: true,
      description: data.description,
      summary: {
        componentCount: data.components.length,
        connectionCount: data.connections.length,
        components: data.components.map(c => ({
          refId: c.refId,
          componentName: c.componentName,
          pinmapId: c.pinmapId,
          componentType: c.componentType || 'hardware',
        })),
      },
      // 完整的连线图 JSON，供了解当前连线状态
      schematicData: data,
      editingTip: [
        '如需修改连线：基于当前 schematicData 的连线信息，编写新的 AWS 格式内容',
        '如需添加组件：先调用 generate_schematic 获取新组件的引脚摘要',
        '修改完成后：调用 validate_schematic(aws: "你的AWS内容") 验证 + 保存 + 刷新（最终步骤）',
      ],
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `读取当前连线图失败: ${error.message || error}`,
    };
  }
}

/**
 * apply_schematic 工具
 *
 * 将 AWS (Aily Wiring Syntax) 格式连线转换为 JSON 并保存。
 * 这是 AWS 工作流的核心工具。
 * 
 * 功能：
 * - 不传参数：读取项目中的 connection.aws 文件，解析并保存
 * - 传 aws 参数：直接解析传入的 AWS 内容，同时保存 .aws 和 .json
 */
export async function applySchematicTool(
  connectionGraphService: ConnectionGraphService,
  projectService: ProjectService,
  input: { aws?: string }
): Promise<ToolUseResult> {
  try {
    const currentProjectPath = projectService.currentProjectPath;
    if (!currentProjectPath) {
      return {
        is_error: true,
        content: '当前没有打开的项目，请先创建或打开一个项目。',
      };
    }

    const boardPackagePath = await projectService.getBoardPackagePath();
    if (!boardPackagePath) {
      return {
        is_error: true,
        content: '当前项目没有配置开发板，请先选择开发板。',
      };
    }

    // 导入 AWS 模块
    const { parseAWS, hasErrors, formatErrors, AWS_SYNTAX_REFERENCE, CONNECTION_COLORS, generateAWS } = await import('../../../services/connection-aws');

    let awsContent: string;
    const awsFilePath = connectionGraphService.getAWSFilePath();
    const jsonFilePath = connectionGraphService.getJSONFilePath();

    // 1. 获取 AWS 内容
    if (input.aws) {
      awsContent = input.aws;
      // 同时保存 .aws 文件
      connectionGraphService.saveAWSFile(awsContent);
    } else {
      // 从文件读取
      if (!connectionGraphService.hasAWSFile()) {
        return {
          is_error: true,
          content: JSON.stringify({
            error: '项目中没有 connection.aws 文件',
            tip: '请先使用 generate_schematic 生成连线，然后输出 AWS 格式并调用 validate_schematic(aws: "...") 验证保存。',
          }, null, 2),
        };
      }
      awsContent = connectionGraphService.readAWSFile();
    }

    // 2. 解析 AWS
    const parsed = parseAWS(awsContent);
    
    // 3. 检查解析错误
    if (hasErrors(parsed)) {
      const errorMsg = formatErrors(parsed);
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          errors: parsed.errors,
          warnings: parsed.warnings,
          errorMessage: errorMsg,
          syntaxReference: AWS_SYNTAX_REFERENCE,
          tip: '请根据上述错误信息修正 AWS 语法后重试。',
        }, null, 2),
      };
    }

    // 4. 加载组件配置
    const packagesBasePath = `${currentProjectPath}/node_modules`;
    const configMap = new Map<string, ComponentConfig>();
    const loadErrors: Array<{ pinmapId: string; error: string; line: number }> = [];

    // 预先添加开发板配置（board 是预定义别名，不需要 USE 声明）
    const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
    if (boardConfig) {
      configMap.set('board', boardConfig);
    } else {
      // 检查 AWS 中是否有使用 board.xxx 的连线
      const usesBoardRef = parsed.connections.some(
        conn => conn.fromRef === 'board' || conn.toRef === 'board'
      );
      if (usesBoardRef) {
        return {
          is_error: true,
          content: JSON.stringify({
            success: false,
            error: '开发板引脚配置不存在',
            tip: '请先使用 generate_pinmap + save_pinmap 为当前开发板生成 pinmap 配置，然后重新调用 validate_schematic。',
            syntaxReference: AWS_SYNTAX_REFERENCE,
          }, null, 2),
        };
      }
    }

    for (const use of parsed.uses) {
      const config = connectionGraphService.loadPinmapById(use.pinmapId, packagesBasePath);
      if (!config) {
        // 尝试解析为开发板
        if (use.pinmapId.startsWith('board:') || use.pinmapId.startsWith('board-')) {
          const boardConfig = connectionGraphService.getBoardConfig(boardPackagePath);
          if (boardConfig) {
            configMap.set(use.alias, boardConfig);
            continue;
          }
        }
        loadErrors.push({
          pinmapId: use.pinmapId,
          error: `无法加载组件配置，请检查 pinmapId 是否正确或 pinmap 文件是否存在`,
          line: use.line,
        });
        continue;
      }
      configMap.set(use.alias, config);
    }

    if (loadErrors.length > 0) {
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          loadErrors,
          message: '部分组件配置加载失败',
          tip: '请按以下步骤生成缺失的 pinmap 配置：\n1. 调用 get_project_context 确认组件状态\n2. 对于 status=needs_generation 的组件，调用 generate_pinmap(pinmapId: "...")\n3. 根据返回的参考信息生成 pinmap JSON\n4. 调用 save_pinmap 保存配置\n5. 重新调用 validate_schematic',
          syntaxReference: AWS_SYNTAX_REFERENCE,
        }, null, 2),
      };
    }

    // 5. 解析引脚并构建连线
    const { resolvePin } = await import('../../../services/connection-aws');
    const connections: any[] = [];
    const resolveErrors: Array<{ message: string; line: number; source: string }> = [];

    let connIndex = 1;
    for (const conn of parsed.connections) {
      const fromConfig = configMap.get(conn.fromRef);
      const toConfig = configMap.get(conn.toRef);

      if (!fromConfig) {
        resolveErrors.push({
          message: `找不到组件 "${conn.fromRef}" 的配置`,
          line: conn.line,
          source: `${conn.fromRef}.${conn.fromPin}`,
        });
        continue;
      }

      if (!toConfig) {
        resolveErrors.push({
          message: `找不到组件 "${conn.toRef}" 的配置`,
          line: conn.line,
          source: `${conn.toRef}.${conn.toPin}`,
        });
        continue;
      }

      // 解析引脚
      const fromResolved = resolvePin(fromConfig, conn.fromPin);
      if (!fromResolved) {
        resolveErrors.push({
          message: `在组件 "${conn.fromRef}" (${fromConfig.name}) 中找不到引脚 "${conn.fromPin}"`,
          line: conn.line,
          source: `${conn.fromRef}.${conn.fromPin}`,
        });
        continue;
      }

      const toResolved = resolvePin(toConfig, conn.toPin);
      if (!toResolved) {
        resolveErrors.push({
          message: `在组件 "${conn.toRef}" (${toConfig.name}) 中找不到引脚 "${conn.toPin}"`,
          line: conn.line,
          source: `${conn.toRef}.${conn.toPin}`,
        });
        continue;
      }

      // 构建连线
      const connType = conn.type as keyof typeof CONNECTION_COLORS;
      const color = CONNECTION_COLORS[connType] || CONNECTION_COLORS.other;
      const label = conn.note || `${conn.type.toUpperCase()}: ${conn.fromPin} → ${conn.toPin}`;

      connections.push({
        id: `conn_${connIndex++}`,
        from: {
          ref: conn.fromRef,
          pinId: fromResolved.pinId,
          function: fromResolved.functionName,
        },
        to: {
          ref: conn.toRef,
          pinId: toResolved.pinId,
          function: toResolved.functionName,
        },
        type: conn.type,
        label,
        color,
        bus: conn.bus,
      });
    }

    if (resolveErrors.length > 0) {
      return {
        is_error: true,
        content: JSON.stringify({
          success: false,
          resolveErrors,
          message: '引脚解析失败',
          tip: '请检查引脚名称是否正确。可使用 generate_schematic 获取正确的引脚名称。',
          syntaxReference: AWS_SYNTAX_REFERENCE,
        }, null, 2),
      };
    }

    // 6. 构建完整 JSON
    const description = parsed.comments.length > 0
      ? parsed.comments[0]
      : `连线方案（${parsed.uses.map(u => u.label || u.alias).join(' + ')}）`;

    // 先添加开发板组件
    const components: any[] = [];
    if (boardConfig) {
      // 从开发板包路径提取包名（如 board-xiao_esp32s3）
      const boardPkgName = boardPackagePath.split(/[\\/]/).pop() || 'board';
      // 对于旧版开发板（无 pinmap_catalog.json），使用 default 作为 modelId
      components.push({
        refId: 'board',
        componentId: boardConfig.id,
        componentName: boardConfig.name,
        pinmapId: `${boardPkgName}:default:default`,
        isBoard: true,
      });
    }

    // 添加 USE 声明的组件
    for (const [index, use] of parsed.uses.entries()) {
      const config = configMap.get(use.alias)!;
      const sameTypeCount = parsed.uses
        .slice(0, index)
        .filter(u => u.pinmapId === use.pinmapId)
        .length;

      components.push({
        refId: use.alias,
        componentId: config.id,
        componentName: use.label || config.name,
        pinmapId: use.pinmapId,
        instance: sameTypeCount,
      });
    }

    const jsonData = {
      version: '1.0.0',
      description,
      components,
      connections,
    };

    // 7. 执行安全校验
    const validationResult = connectionGraphService.validateConnectionGraph(jsonData);

    // 8. 保存 JSON
    connectionGraphService.saveJSONFile(jsonData);

    // 9. 同步保存 AWS（确保两个文件一致）
    if (!input.aws) {
      // 如果是从文件读取的，不需要再写
    } else {
      // 已经在步骤 1 保存过了
    }

    // 10. 通知 iframe 刷新
    if (connectionGraphService.hasActiveIframe) {
      try {
        await connectionGraphService.iframeApi.receiveData({
          componentConfigs: Object.fromEntries(configMap),
          components: jsonData.components,
          connections: jsonData.connections,
        });
      } catch (e) {
        // iframe 通知失败不影响保存结果
        console.warn('通知 iframe 刷新失败:', e);
      }
    }

    // 11. 返回结果
    const result = {
      success: true,
      message: 'AWS 解析成功，连线图已保存',
      files: {
        aws: awsFilePath,
        json: jsonFilePath,
      },
      summary: {
        componentCount: components.length,
        connectionCount: connections.length,
        components: components.map(c => ({ refId: c.refId, name: c.componentName })),
      },
      validation: validationResult,
      warnings: parsed.warnings.length > 0 ? parsed.warnings : undefined,
    };

    const toolResult: ToolUseResult = {
      is_error: false,
      content: JSON.stringify(result, null, 2),
    };
    return toolResult;
  } catch (error: any) {
    return {
      is_error: true,
      content: `apply_schematic(已废弃，转发到validate_schematic) 执行失败: ${error.message || error}`,
    };
  }
}