/**
 * ABS 版本控制工具
 * 
 * 提供 Blockly 代码版本管理功能
 */

import { AbsAutoSyncService, AbsVersion } from '../services/abs-auto-sync.service';

// =============================================================================
// 类型定义
// =============================================================================

interface VersionControlArgs {
  operation: 'list' | 'get' | 'rollback' | 'save';
  versionId?: string;
  description?: string;
}

interface VersionControlResult {
  is_error: boolean;
  content: string;
  metadata?: {
    operation: string;
    versions?: AbsVersion[];
    versionContent?: string;
    versionId?: string;
  };
}

// =============================================================================
// 工具处理函数
// =============================================================================

/**
 * ABS 版本控制处理
 */
export async function absVersionControlHandler(
  args: VersionControlArgs,
  absAutoSyncService: AbsAutoSyncService
): Promise<VersionControlResult> {
  const { operation, versionId, description } = args;
  
  switch (operation) {
    case 'list':
      return listVersions(absAutoSyncService);
    
    case 'get':
      if (!versionId) {
        return {
          is_error: true,
          content: '获取版本内容需要提供 versionId'
        };
      }
      return getVersionContent(versionId, absAutoSyncService);
    
    case 'rollback':
      if (!versionId) {
        return {
          is_error: true,
          content: '回滚需要提供 versionId'
        };
      }
      return rollbackToVersion(versionId, absAutoSyncService);
    
    case 'save':
      return saveVersion(description || '手动保存', absAutoSyncService);
    
    default:
      return {
        is_error: true,
        content: `未知操作: ${operation}`
      };
  }
}

/**
 * 列出所有版本
 */
function listVersions(service: AbsAutoSyncService): VersionControlResult {
  try {
    const versions = service.getVersionList();
    
    if (!versions || versions.length === 0) {
      return {
        is_error: false,
        content: '📭 暂无版本历史\n\n使用 `abs_version_control(operation: "save")` 手动保存当前版本，或等待系统自动保存。',
        metadata: {
          operation: 'list',
          versions: []
        }
      };
    }
    
    // 格式化版本列表
    let content = `## 📚 版本历史 (共 ${versions.length} 个)\n\n`;
    content += '| 版本 ID | 时间 | 描述 | 块数 | 变量数 |\n';
    content += '|---------|------|------|------|--------|\n';
    
    for (const version of versions.slice(0, 20)) {
      const time = new Date(version.timestamp).toLocaleString('zh-CN');
      content += `| \`${version.id}\` | ${time} | ${version.description} | ${version.blockCount} | ${version.variableCount} |\n`;
    }
    
    if (versions.length > 20) {
      content += `\n*...还有 ${versions.length - 20} 个更早的版本*\n`;
    }
    
    content += '\n**操作提示：**\n';
    content += '- 查看版本内容：`abs_version_control(operation: "get", versionId: "版本ID")`\n';
    content += '- 回滚到版本：`abs_version_control(operation: "rollback", versionId: "版本ID")`\n';
    
    return {
      is_error: false,
      content,
      metadata: {
        operation: 'list',
        versions
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `获取版本列表失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 获取版本内容
 */
function getVersionContent(versionId: string, service: AbsAutoSyncService): VersionControlResult {
  try {
    const content = service.getVersionContent(versionId);
    
    if (!content) {
      return {
        is_error: true,
        content: `版本 ${versionId} 不存在`
      };
    }
    
    // 预览前 50 行
    const lines = content.split('\n');
    const preview = lines.slice(0, 50).join('\n') + 
      (lines.length > 50 ? '\n... (more lines)' : '');
    
    return {
      is_error: false,
      content: `## 📄 版本 ${versionId}\n\n\`\`\`abs\n${preview}\n\`\`\`\n\n**操作提示：** 使用 \`abs_version_control(operation: "rollback", versionId: "${versionId}")\` 回滚到此版本`,
      metadata: {
        operation: 'get',
        versionId,
        versionContent: content
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `获取版本内容失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 回滚到指定版本
 */
async function rollbackToVersion(versionId: string, service: AbsAutoSyncService): Promise<VersionControlResult> {
  try {
    const success = await service.rollbackToVersion(versionId);
    
    if (!success) {
      return {
        is_error: true,
        content: `回滚到版本 ${versionId} 失败`
      };
    }
    
    return {
      is_error: false,
      content: `✅ 已回滚到版本 ${versionId}\n\n当前版本已在回滚前自动备份。Blockly 工作区已更新。`,
      metadata: {
        operation: 'rollback',
        versionId
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `回滚失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * 保存当前版本
 */
async function saveVersion(description: string, service: AbsAutoSyncService): Promise<VersionControlResult> {
  try {
    // 先导出当前工作区
    const absContent = await service.exportToAbs(false);
    
    if (!absContent) {
      return {
        is_error: true,
        content: '无法获取当前工作区内容'
      };
    }
    
    // 保存版本（强制保存，忽略时间间隔）
    const version = await service.saveVersion(absContent, description);
    
    if (!version) {
      return {
        is_error: false,
        content: '版本保存被跳过（可能是因为保存间隔太短，请稍后重试）'
      };
    }
    
    return {
      is_error: false,
      content: `✅ 版本保存成功\n\n**版本 ID:** \`${version.id}\`\n**描述:** ${version.description}\n**块数:** ${version.blockCount}\n**变量数:** ${version.variableCount}`,
      metadata: {
        operation: 'save',
        versionId: version.id
      }
    };
  } catch (error) {
    return {
      is_error: true,
      content: `保存版本失败: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
