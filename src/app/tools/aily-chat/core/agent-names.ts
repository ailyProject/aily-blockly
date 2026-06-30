/**
 * Agent 名称 → emoji 映射（共享常量）
 *
 * 在 Part 流式处理、历史反序列化、Legacy 渲染三条路径中保持一致。
 */
export const AGENT_NAMES = new Map<string, string>([
  ['[to_plannerAgent]', '🤔'],
  ['[to_projectAnalysisAgent]', '🤔'],
  ['[to_projectGenerationAgent]', '🤔'],
  ['[to_boardRecommendationAgent]', '🤨'],
  ['[to_libraryRecommendationAgent]', '🤨'],
  ['[to_arduinoLibraryAnalysisAgent]', '🤔'],
  ['[to_projectCreationAgent]', '😀'],
  ['[to_blocklyGenerationAgent]', '🤔'],
  ['[to_blocklyRepairAgent]', '🤔'],
  ['[to_compilationErrorRepairAgent]', '🤔'],
  ['[to_contextAgent]', '😀'],
  ['[to_libraryInstallationAgent]', '😀'],
  ['[to_fileOperationAgent]', '😁'],
  ['[to_user]', '😉'],
  ['[to_xxx]', '🤖'],
]);
