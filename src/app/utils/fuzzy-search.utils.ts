/**
 * 模糊搜索工具函数
 * 提供基于 Orama 的全文搜索和基于 Dice 系数的字符串相似度计算
 */

import { create, insert, search, type AnyOrama } from '@orama/orama';
import { createTokenizer as createMandarinTokenizer } from '@orama/tokenizers/mandarin';

/**
 * 获取字符串的 bigrams 集合
 */
export function getBigrams(str: string): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < str.length - 1; i++) {
    bigrams.add(str.substring(i, i + 2));
  }
  return bigrams;
}

/**
 * 计算两个字符串的相似度（Dice系数 + 包含关系）
 */
export function calculateSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  // 包含关系检查
  if (str1.includes(str2) || str2.includes(str1)) {
    const shorter = str1.length < str2.length ? str1 : str2;
    const longer = str1.length < str2.length ? str2 : str1;
    return shorter.length / longer.length * 0.8 + 0.2;
  }

  // 单字符在 bigram 模型下无法形成有效比较，直接视为不相似
  if (str1.length < 2 || str2.length < 2) {
    return 0;
  }

  // Dice 系数计算
  const bigrams1 = getBigrams(str1);
  const bigrams2 = getBigrams(str2);

  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) {
      intersection++;
    }
  }

  return (2 * intersection) / (bigrams1.size + bigrams2.size);
}

/**
 * 提取查询字符串中的关键词
 * 例如: "@aily-project/lib-oled-ssd1306" => ["aily", "project", "lib", "oled", "ssd1306"]
 */
export function extractKeywords(query: string): string[] {
  if (!query) return [];

  // 移除常见的前缀/后缀
  let cleaned = query
    .replace(/@aily-project\//gi, '')  // 移除包前缀
    .replace(/^lib-/gi, '')             // 移除lib-前缀
    .replace(/\s+/g, ' ')               // 合并空格
    .trim();

  // 按多种分隔符分割：连字符、下划线、空格等
  const keywords = cleaned.split(/[-_\s\/]+/)
    .filter(kw => kw.length >= 2)  // 过滤太短的词
    .map(kw => kw.toLowerCase());

  return [...new Set(keywords)];  // 去重
}

// ===================== Orama 搜索引擎 =====================

const LIBRARY_SCHEMA = {
  name: 'string',
  nickname: 'string',
  keywords: 'string',
  tags: 'string',
  aliases: 'string',
  description: 'string',
  brand: 'string',
  author: 'string',
  fulltext: 'string',
} as const;

export interface LibrarySearchDoc {
  name: string;
  nickname: string;
  keywords: string;
  tags: string;
  aliases: string;
  description: string;
  brand: string;
  author: string;
  fulltext: string;
}

const LIBRARY_FIELD_WEIGHTS: Array<[keyof LibrarySearchDoc, number]> = [
  ['name', 12],
  ['nickname', 10],
  ['keywords', 7],
  ['tags', 5],
  ['brand', 3],
  ['author', 2],
  ['description', 1],
];

function normalizeSearchText(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/@aily-project\//g, '')
    .replace(/ailyproject|aily|blockly/g, '')
    .replace(/[\s_\-/]+/g, '');
}

function extractSearchAliases(value: string): string[] {
  if (!value) {
    return [];
  }

  const aliases = new Set<string>();
  const alphaNumericRuns = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];

  for (const run of alphaNumericRuns) {
    if (run.length >= 2) {
      aliases.add(run);
    }

    // 为字母数字串生成所有长度 >= 3 的后缀，以便支持内部子串匹配
    // 例如 "mfrc522" => "frc522" / "rc522" / "c522" / "522"
    // 这样查询 "RC522" 也能命中包名 "MFRC522"
    for (let i = 1; i <= run.length - 3; i++) {
      aliases.add(run.substring(i));
    }

    for (const alphaPart of run.match(/[a-z]{2,}/g) ?? []) {
      aliases.add(alphaPart);
    }

    for (const numericPart of run.match(/\d{2,}/g) ?? []) {
      aliases.add(numericPart);
    }
  }

  return [...aliases];
}

function buildSearchAliases(fields: Array<string | undefined>): string {
  const aliases = new Set<string>();

  for (const field of fields) {
    for (const alias of extractSearchAliases(field || '')) {
      aliases.add(alias);
    }
  }

  return [...aliases].join(' ');
}

function buildLibrarySearchAliases(lib: Partial<LibrarySearchDoc>): string {
  return buildSearchAliases([lib.name, lib.nickname, lib.keywords, lib.tags, lib.description, lib.brand, lib.author]);
}

function getTokenMatchScore(value: string, queryTokens: string[]): number {
  if (!value || queryTokens.length === 0) {
    return 0;
  }

  const valueTokens = extractKeywords(value);
  if (valueTokens.length === 0) {
    return 0;
  }

  const tokenSet = new Set(valueTokens);
  let score = 0;

  for (const token of queryTokens) {
    if (tokenSet.has(token)) {
      score += 180;
      continue;
    }

    if (valueTokens.some(valueToken => valueToken.startsWith(token))) {
      score += 90;
    }
  }

  return score;
}

function getFieldMatchScore(fieldValue: string, normalizedTerm: string, queryTokens: string[]): number {
  if (!fieldValue || !normalizedTerm) {
    return 0;
  }

  const normalizedValue = normalizeSearchText(fieldValue);
  if (!normalizedValue) {
    return 0;
  }

  if (normalizedValue === normalizedTerm) {
    return 1200;
  }

  let score = 0;
  const termCoverage = normalizedTerm.length / Math.max(normalizedValue.length, 1);

  if (normalizedValue.startsWith(normalizedTerm)) {
    score += 900 + termCoverage * 100;
  } else if (normalizedValue.includes(normalizedTerm)) {
    score += 600 + termCoverage * 80;
  }

  score += getTokenMatchScore(fieldValue, queryTokens);
  score += calculateSimilarity(normalizedValue, normalizedTerm) * 120;

  return score;
}

function rerankLibraryHits(hits: any[], term: string): any[] {
  const normalizedTerm = normalizeSearchText(term);
  const queryTokens = extractKeywords(term);

  return hits
    .map((hit, index) => {
      const document = hit.document as LibrarySearchDoc;
      const rankScore = LIBRARY_FIELD_WEIGHTS.reduce((total, [field, weight]) => {
        return total + getFieldMatchScore(document[field], normalizedTerm, queryTokens) * weight;
      }, 0);

      return { hit, index, rankScore };
    })
    .sort((left, right) => {
      if (right.rankScore !== left.rankScore) {
        return right.rankScore - left.rankScore;
      }
      return left.index - right.index;
    })
    .map(item => item.hit);
}

/**
 * 创建 Orama 搜索引擎实例，索引库列表
 */
export function createLibrarySearchIndex(libraries: any[]): AnyOrama {
  const db = create({ schema: LIBRARY_SCHEMA, components: { tokenizer: createMandarinTokenizer() } });

  for (const lib of libraries) {
    const nickname = lib._nickname || lib.nickname || '';
    const keywords = Array.isArray(lib.keywords) ? lib.keywords.join(' ') : (lib.keywords || '');
    const tags = Array.isArray(lib.tags) ? lib.tags.join(' ') : (lib.tags || '');
    const description = lib._description || lib.description || '';
    const brand = lib.brand || '';
    const author = (typeof lib.author === 'string' ? lib.author : lib.author?.name) || '';

    insert(db, {
      name: lib.name || '',
      nickname,
      keywords,
      tags,
      aliases: buildLibrarySearchAliases({
        name: lib.name || '',
        nickname,
        keywords,
        tags,
        description,
        brand,
        author,
        fulltext: lib.fulltext || '',
      }),
      description,
      brand,
      author,
      fulltext: lib.fulltext || '',
    });
  }

  return db;
}

/**
 * 使用 Orama 执行模糊搜索，返回匹配的库名称列表（按相关度排序）
 */
export function searchLibraries(db: AnyOrama, term: string, limit: number = 500): string[] {
  const normalizedTerm = normalizeSearchText(term);
  const lowerTerm = (term || '').toLowerCase();
  const results = search(db, {
    term: lowerTerm,
    properties: ['name', 'nickname', 'keywords', 'tags', 'aliases', 'description', 'brand', 'author'],
    tolerance: normalizedTerm.length <= 2 ? 0 : normalizedTerm.length <= 5 ? 1 : 2,
    boost: {
      name: 3,
      nickname: 2.5,
      keywords: 2,
      tags: 1.5,
      aliases: 1.75,
      description: 0.5,
      brand: 0.5,
      author: 0.5,
    },
    limit,
  }) as any;

  return rerankLibraryHits(results.hits, term).map((hit: any) => hit.document.name as string);
}

// ===================== 开发板搜索 =====================

const BOARD_SCHEMA = {
  name: 'string',
  nickname: 'string',
  brand: 'string',
  description: 'string',
  keywords: 'string',
  type: 'string',
  aliases: 'string',
} as const;

interface BoardSearchDoc {
  name: string;
  nickname: string;
  brand: string;
  description: string;
  keywords: string;
  type: string;
  aliases: string;
}

const BOARD_FIELD_WEIGHTS: Array<[keyof BoardSearchDoc, number]> = [
  ['name', 12],
  ['nickname', 10],
  ['keywords', 7],
  ['type', 5],
  ['aliases', 4],
  ['brand', 3],
  ['description', 1],
];

function buildBoardSearchAliases(board: Partial<BoardSearchDoc>): string {
  return buildSearchAliases([board.name, board.nickname, board.brand, board.description, board.keywords, board.type]);
}

function rerankBoardHits(hits: any[], term: string): any[] {
  const normalizedTerm = normalizeSearchText(term);
  const queryTokens = extractKeywords(term);

  return hits
    .map((hit, index) => {
      const document = hit.document as BoardSearchDoc;
      const rankScore = BOARD_FIELD_WEIGHTS.reduce((total, [field, weight]) => {
        return total + getFieldMatchScore(document[field], normalizedTerm, queryTokens) * weight;
      }, 0);

      return { hit, index, rankScore };
    })
    .sort((left, right) => {
      if (right.rankScore !== left.rankScore) {
        return right.rankScore - left.rankScore;
      }
      return left.index - right.index;
    })
    .map(item => item.hit);
}

/**
 * 创建 Orama 搜索引擎实例，索引开发板列表
 */
export function createBoardSearchIndex(boards: any[]): AnyOrama {
  const db = create({ schema: BOARD_SCHEMA, components: { tokenizer: createMandarinTokenizer() } });

  for (const board of boards) {
    const nickname = board._nickname || board.nickname || '';
    const brand = board.brand || '';
    const description = board._description || board.description || '';
    const keywords = Array.isArray(board.keywords) ? board.keywords.join(' ') : (board.keywords || '');
    const type = board.type || '';

    insert(db, {
      name: board.name || '',
      nickname,
      brand,
      description,
      keywords,
      type,
      aliases: buildBoardSearchAliases({
        name: board.name || '',
        nickname,
        brand,
        description,
        keywords,
        type,
        aliases: '',
      }),
    });
  }

  return db;
}

/**
 * 使用 Orama 执行开发板模糊搜索，返回匹配的开发板名称列表（按相关度排序）
 */
export function searchBoards(db: AnyOrama, term: string, limit: number = 500): string[] {
  const normalizedTerm = normalizeSearchText(term);
  const lowerTerm = (term || '').toLowerCase();
  const results = search(db, {
    term: lowerTerm,
    properties: ['name', 'nickname', 'brand', 'description', 'keywords', 'type', 'aliases'],
    tolerance: normalizedTerm.length <= 2 ? 0 : normalizedTerm.length <= 5 ? 1 : 2,
    boost: {
      name: 3,
      nickname: 3,
      brand: 2,
      keywords: 1.5,
      type: 1,
      aliases: 1.5,
      description: 0.5,
    },
    limit,
  }) as any;

  return rerankBoardHits(results.hits, term).map((hit: any) => hit.document.name as string);
}
