import type { PackageInfo } from '../../blockly-editor/components/lib-manager/lib-manager.service';

export interface AilyCoderLibraryContextItemV1 {
  packageName: string;
  name: string;
  description: string;
  version: string;
  author: string;
  url: string;
  keywords: string[];
  architectures: string[];
  tested: boolean;
  installed: boolean;
  installedVersion: string;
}

const AILY_LIBRARY_PACKAGE_NAME = /^@aily-project\/lib-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_LIBRARY_COUNT = 2_000;

function boundedText(value: unknown, maximum = 2_000): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function boundedStringList(value: unknown, maximum = 40): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => boundedText(item, 120))
    .filter(Boolean)
    .slice(0, maximum);
}

/**
 * Project the host Library Manager catalog into a bounded, token-free child-app snapshot.
 * Localization and board compatibility filtering happen before this projection.
 */
export function createAilyCoderLibraryContext(
  libraries: PackageInfo[] | null | undefined,
): AilyCoderLibraryContextItemV1[] {
  const output: AilyCoderLibraryContextItemV1[] = [];
  for (const library of Array.isArray(libraries) ? libraries : []) {
    if (output.length >= MAX_LIBRARY_COUNT) break;
    const packageName = boundedText(library?.name, 180);
    if (!AILY_LIBRARY_PACKAGE_NAME.test(packageName)) continue;
    const author = typeof library.author === 'string'
      ? library.author
      : library.author?.name;
    const url = boundedText(library.url || library.links?.homepage, 2_000);
    output.push({
      packageName,
      name: boundedText(library._nickname || library.nickname, 240) || packageName,
      description: boundedText(library._description || library.description),
      version: boundedText(library.version, 80),
      author: boundedText(author, 240),
      url: /^https?:\/\//i.test(url) ? url : '',
      keywords: boundedStringList([
        ...(Array.isArray(library.keywords) ? library.keywords : []),
        ...(Array.isArray(library['tags']) ? library['tags'] : []),
      ]),
      architectures: boundedStringList(library.compatibility?.core),
      tested: library.tested === true,
      installed: library.state === 'installed',
      installedVersion: library.state === 'installed' ? boundedText(library.version, 80) : '',
    });
  }
  return output;
}

/** Map the main application's language code to the Monaco/VS Code language pack id. */
export function toAilyCoderWorkbenchLocale(language: unknown): string | null {
  const normalized = boundedText(language, 40).toLowerCase().replace(/_/g, '-');
  if (!normalized || normalized === 'en' || normalized.startsWith('ar')) return null;
  if (normalized === 'zh' || normalized.startsWith('zh-cn') || normalized.includes('hans')) {
    return 'zh-hans';
  }
  if (
    normalized.startsWith('zh-hk')
    || normalized.startsWith('zh-tw')
    || normalized.includes('hant')
  ) {
    return 'zh-hant';
  }
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-br';
  return ['de', 'es', 'fr', 'ja', 'ko', 'ru'].includes(normalized) ? normalized : null;
}

/** Stable language identity used to decide whether the embedded Workbench must restart. */
export function normalizeAilyCoderHostLanguage(language: unknown): string {
  const normalized = boundedText(language, 40).toLowerCase().replace(/-/g, '_');
  return normalized || 'en';
}
