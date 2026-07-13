import type { IHostSlashCommandProvider, ISlashCommandContribution } from 'aily-lex/browser';
import { SkillRegistry } from './skill-registry';
import { isAilyCategoryDebugEnabled } from './chat-debug-flags';

const ACTIVE_SESSION_WATCHERS = new Map<string, Set<() => void>>();
let activeSessionId: string | null = null;
let skillRegistryChangeSubscription: { dispose(): void } | null = null;

const BLOCKLY_SLASH_COMMANDS: readonly ISlashCommandContribution[] = [
  {
    name: 'fix',
    description: 'Ask the main agent to diagnose a problem and propose or apply a fix.',
    sampleRequest: '/fix explain why this test is failing',
    when: 'Use for debugging, remediation, and follow-up fix requests.',
  },
  {
    name: 'explain',
    description: 'Ask for an explanation of code, behavior, or implementation details.',
    sampleRequest: '/explain how request routing is resolved',
    when: 'Use when the goal is understanding rather than changing code.',
  },
  {
    name: 'search',
    description: 'Search the current workspace for relevant code, files, or nearby implementation context.',
    sampleRequest: '/search find where slash command metadata is produced',
    when: 'Use for project-wide discovery before deeper reading or editing.',
  },
  {
    name: 'edit',
    description: 'Ask the main agent to make a targeted code change in the current workspace.',
    sampleRequest: '/edit rename this helper to match the new contract',
    when: 'Use when the request is an explicit code modification task.',
  },
  {
    name: 'compact',
    description: 'Compact the current conversation history.',
    sampleRequest: '/compact',
    when: 'Use to summarize older conversation context and keep the session continuing with a compacted history.',
  },
];

const CHRONICLE_SLASH_COMMANDS: readonly ISlashCommandContribution[] = [
  {
    name: 'chronicle:search',
    description: 'Search indexed chat sessions by keyword, file path, issue, commit, or other prior-context reference.',
    sampleRequest: '/chronicle:search command_exec terminal test',
    when: 'Use when the user asks to search prior chat sessions. Use the chronicle skill and call session_store_sql with subcommand="search".',
  },
  {
    name: 'chronicle:standup',
    description: 'Summarize recent indexed project chat sessions into a standup-style status report.',
    sampleRequest: '/chronicle:standup summarize today',
    when: 'Use when the user asks for a project/session standup or recent work summary. Use the chronicle skill and call session_store_sql with subcommand="standup".',
  },
  {
    name: 'chronicle:tips',
    description: 'Analyze indexed chat sessions for personalized workflow tips.',
    sampleRequest: '/chronicle:tips',
    when: 'Use when the user asks for workflow tips based on prior chat usage. Use the chronicle skill and call session_store_sql with subcommand="tips".',
  },
  {
    name: 'chronicle:cost-tips',
    description: 'Analyze indexed chat sessions for token or cost reduction tips when usage data is available.',
    sampleRequest: '/chronicle:cost-tips',
    when: 'Use when the user asks for cost, quota, token, or usage optimization based on prior chat sessions. Use the chronicle skill and call session_store_sql with subcommand="cost-tips".',
  },
  {
    name: 'chronicle:improve',
    description: 'Analyze indexed chat sessions for recurring friction and suggest instruction or workflow improvements.',
    sampleRequest: '/chronicle:improve',
    when: 'Use when the user asks how to improve the agent behavior or workflow from prior chat history. Use the chronicle skill and call session_store_sql with subcommand="improve".',
  },
  {
    name: 'chronicle:reindex',
    description: 'Rebuild the local Chronicle session index from persisted chat history.',
    sampleRequest: '/chronicle:reindex force',
    when: 'Use when the user asks to reindex or rebuild chat history search. Use the chronicle skill and call session_store_sql with action="reindex" and subcommand="reindex"; set force=true when requested.',
  },
];

function normalizeSessionId(sessionId?: string | null): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }

  const normalized = sessionId.trim();
  return normalized.length > 0 ? normalized : null;
}

function ensureSkillRegistryWatcher(): void {
  if (skillRegistryChangeSubscription) {
    return;
  }

  skillRegistryChangeSubscription = SkillRegistry.onDidChange(() => {
    if (isBlocklySlashCommandTraceEnabled()) {
      console.info('[BlocklySlashCommandProvider][debug] skill registry changed', {
        activeSessionId,
        activeWatcherCount: activeSessionId ? (ACTIVE_SESSION_WATCHERS.get(activeSessionId)?.size ?? 0) : 0,
        sessionWatcherCount: ACTIVE_SESSION_WATCHERS.size,
      });
    }
    notifyActiveSessionWatchers();
  });
}

function isBlocklySlashCommandTraceEnabled(): boolean {
  return isAilyCategoryDebugEnabled('aily.chat.traceSlashCommand', [
    '__AILY_CHAT_TRACE_SLASH_COMMAND__',
    'AILY_CHAT_TRACE_SLASH_COMMAND',
  ]);
}

function notifySessionWatchers(sessionId: string | null): void {
  if (!sessionId) {
    return;
  }

  const watchers = ACTIVE_SESSION_WATCHERS.get(sessionId);
  if (!watchers || watchers.size === 0) {
    return;
  }

  for (const watcher of [...watchers]) {
    watcher();
  }
}

function notifyActiveSessionWatchers(): void {
  notifySessionWatchers(activeSessionId);
}

export function setActiveBlocklySlashCommandSession(sessionId?: string | null): void {
  const nextActiveSessionId = normalizeSessionId(sessionId);
  if (nextActiveSessionId === activeSessionId) {
    return;
  }

  if (isBlocklySlashCommandTraceEnabled()) {
    console.info('[BlocklySlashCommandProvider][debug] active session updated', {
      previousActiveSessionId: activeSessionId,
      nextActiveSessionId,
      previousWatcherCount: activeSessionId ? (ACTIVE_SESSION_WATCHERS.get(activeSessionId)?.size ?? 0) : 0,
      nextWatcherCount: nextActiveSessionId ? (ACTIVE_SESSION_WATCHERS.get(nextActiveSessionId)?.size ?? 0) : 0,
    });
  }
  activeSessionId = nextActiveSessionId;
}

export function createBlocklySlashCommandProvider(sessionId?: string | null): IHostSlashCommandProvider {
  const providerSessionId = normalizeSessionId(sessionId);

  return {
    contributeSlashCommands(): ISlashCommandContribution[] {
      const skillCommands = SkillRegistry.getAll()
        .filter(skill => skill.origin?.type !== 'url' && skill.metadata.userInvocable !== false)
        .map<ISlashCommandContribution>(skill => ({
          name: skill.metadata.name,
          description: skill.metadata.description || `Invoke the ${skill.metadata.displayName || skill.metadata.name} skill.`,
          sampleRequest: `/${skill.metadata.name} ${skill.metadata.context === 'fork' ? 'run this skill for the current task' : 'apply this skill to the current task'}`,
          when: skill.metadata.context === 'fork'
            ? `Use to run the ${skill.metadata.displayName || skill.metadata.name} skill as a forked subagent for the current task.`
            : `Use to load the ${skill.metadata.displayName || skill.metadata.name} skill before handling the current task.`,
        }));

      return [...BLOCKLY_SLASH_COMMANDS, ...CHRONICLE_SLASH_COMMANDS, ...skillCommands];
    },
    onSlashCommandsChanged(listener) {
      if (!providerSessionId) {
        return SkillRegistry.onDidChange(listener);
      }

      ensureSkillRegistryWatcher();
      let watchers = ACTIVE_SESSION_WATCHERS.get(providerSessionId);
      if (!watchers) {
        watchers = new Set<() => void>();
        ACTIVE_SESSION_WATCHERS.set(providerSessionId, watchers);
      }
      watchers.add(listener);

      return {
        dispose() {
          const sessionWatchers = ACTIVE_SESSION_WATCHERS.get(providerSessionId);
          if (!sessionWatchers) {
            return;
          }
          sessionWatchers.delete(listener);
          if (sessionWatchers.size === 0) {
            ACTIVE_SESSION_WATCHERS.delete(providerSessionId);
          }
        },
      };
    },
  };
}
