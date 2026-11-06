import { BuilderService } from '@domain/build/public-api';
import { isBuildCancelled } from '@domain/build/public-api';
import type { HostToolResult } from './host-tool-result';

export async function runProjectBuild(
  builderService: BuilderService,
  input: { preprocessOnly?: boolean; clearCache?: boolean; requestId?: string },
  projectPath: string,
): Promise<HostToolResult> {
  try {
    if (input.clearCache) await builderService.clearBuildCache(projectPath);
    if (input.preprocessOnly) {
      builderService.triggerPreprocess('host_live_operation');
      return {
        is_error: false,
        content: JSON.stringify({
          success: true,
          message: '预编译已触发；该操作异步执行。',
        }),
      };
    }

    const result = await builderService.build(undefined, { source: 'ai', requestId: input.requestId });
    return {
      is_error: false,
      metadata: { buildResult: result },
      content: JSON.stringify({
        success: true,
        message: '编译成功。',
      }),
    };
  } catch (error: any) {
    const buildResult = error?.buildResult;
    if (isBuildCancelled(buildResult) || isBuildCancelled(error)) {
      const cancelled = buildResult || error;
      return {
        is_error: true,
        metadata: { buildOutcome: 'cancelled', code: 'BUILD_CANCELLED', buildResult: cancelled },
        content: JSON.stringify({ success: false, ...cancelled }),
      };
    }
    return {
      is_error: true,
      metadata: { buildOutcome: error?.buildOutcome,
        buildResult: buildResult || { state: 'error', text: error?.message || String(error), fullStdErr: error?.fullStdErr, buildLog: error?.buildLog } },
      content: JSON.stringify({
        success: false,
        message: `${error?.buildOutcome === 'not-started' ? '编译未开始' : '编译失败'}: ${buildResult?.text || error?.message || String(error)}`,
      }),
    };
  }
}
