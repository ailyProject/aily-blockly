import { BuilderService } from '@domain/build/public-api';
import type { HostToolResult } from './host-tool-result';

export async function runProjectBuild(
  builderService: BuilderService,
  input: { preprocessOnly?: boolean; clearCache?: boolean },
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

    const result = await builderService.build();
    return {
      is_error: false,
      content: JSON.stringify({
        success: true,
        message: '编译成功。',
        details: result?.text || undefined,
      }),
    };
  } catch (error: any) {
    const buildResult = error?.buildResult;
    const stderr = stripAnsi(String(buildResult?.fullStdErr || ''));
    return {
      is_error: true,
      content: JSON.stringify({
        success: false,
        message: `编译失败: ${buildResult?.text || error?.message || String(error)}`,
        errors: extractCompileErrors(stderr) || stderr.trim().slice(0, 3000) || undefined,
      }),
    };
  }
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\[\d+(;\d+)*m/gu, '')
    .replace(/\[\d+(;\d+)*m/gu, '')
    .replace(/\[(?:ERROR|WARNING)\]\s*/giu, '');
}

function extractCompileErrors(stderr: string): string {
  return stderr.split('\n')
    .map((line) => line.trim())
    .filter((line) => /:\s*(?:error|warning|note|fatal error):|undefined reference|^Compilation\s+(?:failed|error)/iu.test(line))
    .join('\n')
    .slice(0, 3000);
}
