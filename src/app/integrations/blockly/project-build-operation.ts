import { BuilderService } from '@domain/build/public-api';
import { isBuildCancelled } from '@domain/build/public-api';
import type { HostToolResult } from './host-tool-result';

export async function runProjectBuild(
  builderService: BuilderService,
  input: { preprocessOnly?: boolean; clearCache?: boolean; requestId?: string; simulationDebug?: boolean },
  projectPath: string,
  buildScene?: () => ReturnType<BuilderService['build']>,
): Promise<HostToolResult> {
  try {
    if (input.preprocessOnly) {
      if (input.clearCache) await builderService.triggerPreprocessWithCacheClear(projectPath, 'host_live_operation');
      else builderService.triggerPreprocess('host_live_operation');

      return {
        is_error: false,
        content: JSON.stringify({
          success: true,
          message: '预编译已触发；该操作异步执行。',
        }),
      };
    }

    const result = await (buildScene ? buildScene() : builderService.build(undefined, {
      source: 'ai',
      requestId: input.requestId,
      expectedProjectPath: projectPath,
      clearCache: input.clearCache,
      simulationDebug: input.simulationDebug,
    }));

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

    const staleSource = buildResult?.code === 'BUILD_SOURCE_STALE' ? buildResult : error;

    const sourceFailure = staleSource?.code === 'BUILD_SOURCE_STALE'
      ? { code: staleSource.code, sourceReason: staleSource.sourceReason }
      : {};

    return {
      is_error: true,
      metadata: { buildOutcome: error?.buildOutcome, ...sourceFailure,
        buildResult: buildResult || { state: 'error', text: error?.message || String(error), fullStdErr: error?.fullStdErr, buildLog: error?.buildLog } },
      content: JSON.stringify({
        success: false,
        ...sourceFailure,
        message: `${error?.buildOutcome === 'not-started' ? '编译未开始' : '编译失败'}: ${buildResult?.text || error?.message || String(error)}`,
      }),
    };
  }
}
