import type { IProjectContext, IChatServiceAccess } from '../core/chat-context';
import { getMainAgentHostTools, getLexRuntimeLLMConfig } from './lex-agent-bootstrap';

/** Narrow context: model config + aily config service (+ full ctx passed to getMainAgentHostTools) */
type LexRuntimeConfigContext = Pick<IProjectContext, 'currentModel'>
  & Pick<IChatServiceAccess, 'ailyChatConfigService' | 'mcpService'>;

export class LexRuntimeConfigBridge {
  constructor(private readonly ctx: LexRuntimeConfigContext) {}

  tools(): any[] {
    return getMainAgentHostTools(this.ctx);
  }

  llmConfig(): any {
    return getLexRuntimeLLMConfig(this.ctx.currentModel, this.ctx.ailyChatConfigService);
  }
}