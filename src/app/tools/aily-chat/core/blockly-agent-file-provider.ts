import type { AgentDefinitionFile, IHostAgentFileProvider } from 'aily-lex/browser';
import {
  createBlocklyFileCustomizationProvider,
  type BlocklyCustomizationFileSource,
  type BlocklyFileCustomizationProviderConfigSource,
} from './blockly-file-customization-provider';

export type BlocklyAgentFileSource = BlocklyCustomizationFileSource;

export interface BlocklyAgentFileProviderConfigSource extends BlocklyFileCustomizationProviderConfigSource {
  readonly userAgentFolders?: readonly string[];
  readonly projectAgentFolders?: readonly string[];
}

export interface BlocklyAgentFileProviderOptions {
  readonly source: BlocklyAgentFileSource;
  readonly projectRootPath?: string;
  readonly configSource?: BlocklyAgentFileProviderConfigSource;
}

export const DEFAULT_PROJECT_AGENT_SOURCE_FOLDERS = ['.aily/agents'] as const;
export const DEFAULT_USER_AGENT_SOURCE_FOLDERS = ['~/.aily/agents'] as const;

const LEGACY_AGENT_FILE_EXTENSION = '.chatmode.md';
const AGENT_FILE_EXTENSION = '.agent.md';

export function createBlocklyAgentFileProvider(options: BlocklyAgentFileProviderOptions): IHostAgentFileProvider {
  const provider = createBlocklyFileCustomizationProvider({
    source: options.source,
    projectRootPath: options.projectRootPath,
    configSource: options.configSource,
    defaultFolders: options.source === 'user'
      ? DEFAULT_USER_AGENT_SOURCE_FOLDERS
      : DEFAULT_PROJECT_AGENT_SOURCE_FOLDERS,
    resolveConfiguredFolders: (configSource, source) => source === 'user'
      ? configSource?.userAgentFolders
      : configSource?.projectAgentFolders,
    shouldIncludeFile: shouldIncludeAgentFile,
  });

  return {
    contributeAgentFiles(): AgentDefinitionFile[] {
      return [...provider.contributeFiles()];
    },
    ...(provider.onFilesChanged ? {
      onAgentFilesChanged(listener: () => void) {
        return provider.onFilesChanged?.(listener);
      },
    } : {}),
  };
}

function shouldIncludeAgentFile(folderPath: string, fileName: string, _source: BlocklyCustomizationFileSource): boolean {
  if (fileName.endsWith(AGENT_FILE_EXTENSION) || fileName.endsWith(LEGACY_AGENT_FILE_EXTENSION)) {
    return true;
  }

  return isCanonicalAgentFolder(folderPath) && fileName.endsWith('.md') && fileName !== 'README.md';
}

function isCanonicalAgentFolder(folderPath: string): boolean {
  const normalized = normalizeFilesystemPath(folderPath);
  return normalized.endsWith('/.aily/agents');
}

function normalizeFilesystemPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}
