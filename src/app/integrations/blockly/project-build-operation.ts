import { BuilderService } from '@domain/build/public-api';
import { isBuildCancelled } from '@domain/build/public-api';
import type { HostToolResult } from './host-tool-result';
import type { BuildLocalFallbackControl } from '../../utils/cloud-build-progress.utils';

export async function runProjectBuild(
  builderService: BuilderService,
  input: { preprocessOnly?: boolean; clearCache?: boolean; requestId?: string; simulationDebug?: boolean; localFallback?: BuildLocalFallbackControl },
  projectPath: string,
  buildScene?: () => ReturnType<BuilderService['build']>,
): Promise<HostToolResult> {
  try {
    const result = await (buildScene ? buildScene() : builderService.build(undefined, {
      source: 'ai',
      ...(input.preprocessOnly ? { preprocessOnly: true } : {}),
      requestId: input.requestId,
      expectedProjectPath: projectPath,
      clearCache: input.clearCache,
      simulationDebug: input.simulationDebug,
      ...(input.localFallback ? { localFallback: input.localFallback } : {}),
    }));

    return {
      is_error: false,
      metadata: { buildResult: result },
      content: JSON.stringify({
        success: true,
        message: input.preprocessOnly ? '预处理成功。' : '编译成功。',
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
    const failureCode = staleSource?.code ?? buildResult?.code;

    const sourceFailure = {
      ...(typeof failureCode === 'string' ? { code: failureCode } : {}),
      ...(failureCode === 'BUILD_SOURCE_STALE' ? { sourceReason: staleSource.sourceReason } : {}),
    };

    const operation = input.preprocessOnly ? '预处理' : '编译';

    const status = error?.buildOutcome === 'not-started' ? '未开始'
      : input.preprocessOnly && error?.buildOutcome === 'unknown' ? '结果未确认' : '失败';

    return {
      is_error: true,
      metadata: { buildOutcome: error?.buildOutcome, ...sourceFailure,
        buildResult: buildResult || { state: 'error', text: error?.message || String(error), fullStdErr: error?.fullStdErr,
          buildLog: error?.buildLog, ...(error?.buildHistory ? { buildHistory: error.buildHistory } : {}) } },
      content: JSON.stringify({
        success: false,
        ...sourceFailure,
        message: `${operation}${status}: ${buildResult?.text || error?.message || String(error)}`,
      }),
    };
  }
}
