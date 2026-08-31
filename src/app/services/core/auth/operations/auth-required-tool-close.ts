export class ProtectedToolCloseError extends Error {
  constructor(toolId: string) {
    super(`Failed to close protected tool: ${toolId}`);
    this.name = 'ProtectedToolCloseError';
  }
}

export interface AuthRequiredToolCloseDependencies {
  isChildTool: (toolId: string) => boolean;
  prepareChildApp: (toolId: string) => Promise<{ ok?: unknown; message?: unknown }>;
  controlChildApp: (toolId: string) => Promise<{ ok?: unknown }>;
  forceCloseToolEverywhere: (toolId: string) => Promise<boolean>;
}

export async function closeAuthRequiredTools(
  toolIds: readonly string[],
  dependencies: AuthRequiredToolCloseDependencies,
): Promise<void> {
  for (const toolId of [...new Set(toolIds)]) {
    let closed = false;

    if (dependencies.isChildTool(toolId)) {
      const preparation = await dependencies.prepareChildApp(toolId);
      if (preparation.ok !== true) {
        throw new ProtectedToolCloseError(toolId);
      }
      const result = await dependencies.controlChildApp(toolId);
      closed = result.ok === true;
    }

    if (!closed) {
      closed = await dependencies.forceCloseToolEverywhere(toolId);
    }

    if (!closed) {
      throw new ProtectedToolCloseError(toolId);
    }
  }
}
