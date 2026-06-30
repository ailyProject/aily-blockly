import { Injectable } from '@angular/core';
import { createLibrarySearchIndex, searchLibraries } from '../../../../utils/fuzzy-search.utils';

export interface LibManagerTag {
  key: string;
  label: string;
}

export interface LibManagerInitialState {
  tagList: LibManagerTag[];
  displayTagList: LibManagerTag[];
  baseLibraryList: PackageInfo[];
  libraryList: PackageInfo[];
}

interface LibManagerCachedInitialState {
  cacheKey: string;
  state: LibManagerInitialState;
}

export interface PackageInfo {
  name: string;
  nickname: string;
  scope?: string;
  description?: string;
  version?: string;
  versionList?: string[];
  keywords?: string[];
  date?: string;
  author?: {
    name?: string;
  } | string;
  icon?: string;
  publisher?: any;
  maintainers?: any[];
  links?: any;
  brand?: string;
  compatibility?: {
    core?: string[];
    [key: string]: any;
  };
  fulltext?: string;
  url?: string;
  tested: boolean;
  state: 'default' | 'installed' | 'installing' | 'uninstalling' | 'error';
  example?: string;
  _nickname?: string;
  _description?: string;
  [key: string]: any;
}

@Injectable({
  providedIn: 'root',
})
export class LibManagerService {
  private static readonly PREVIEW_ITEM_COUNT = 30;
  private static readonly FOLLOWUP_CHUNK_SIZE = 120;

  private cachedInitialState: LibManagerCachedInitialState | null = null;

  getCachedInitialState(
    libraryList: PackageInfo[] | null | undefined,
    tagData: any,
    lang: string,
    displayTagCount = 10,
  ): LibManagerInitialState | null {
    const cacheKey = this.getCacheKey(libraryList, tagData, lang, displayTagCount);
    if (!this.cachedInitialState || this.cachedInitialState.cacheKey !== cacheKey) {
      return null;
    }

    return this.cloneInitialState(this.cachedInitialState.state);
  }

  async buildInitialState(
    libraryList: PackageInfo[] | null | undefined,
    tagData: any,
    lang: string,
    displayTagCount = 10,
  ): Promise<LibManagerInitialState> {
    let latestState: LibManagerInitialState | null = null;
    for await (const state of this.buildInitialStateChunks(libraryList, tagData, lang, displayTagCount)) {
      latestState = state;
    }

    return latestState || this.createEmptyInitialState(tagData, lang, displayTagCount);
  }

  async *buildInitialStateChunks(
    libraryList: PackageInfo[] | null | undefined,
    tagData: any,
    lang: string,
    displayTagCount = 10,
  ): AsyncGenerator<LibManagerInitialState> {
    const cacheKey = this.getCacheKey(libraryList, tagData, lang, displayTagCount);
    const cachedState = this.cachedInitialState?.cacheKey === cacheKey
      ? this.cachedInitialState.state
      : null;
    const tagList = cachedState
      ? this.cloneTags(cachedState.tagList)
      : this.buildLocalizedTagList(tagData, lang);
    const displayTagList = cachedState
      ? this.cloneTags(cachedState.displayTagList)
      : this.getRandomTags(tagList, displayTagCount);
    const sourceList = Array.isArray(libraryList) ? libraryList : [];
    const baseLibraryList: PackageInfo[] = [];

    await this.deferCalculation();

    if (sourceList.length === 0) {
      const emptyState: LibManagerInitialState = {
        tagList,
        displayTagList,
        baseLibraryList: [],
        libraryList: [],
      };
      this.cachePreviewState(cacheKey, emptyState);
      yield this.cloneInitialState(emptyState);
      return;
    }

    let index = 0;
    let chunkSize = LibManagerService.PREVIEW_ITEM_COUNT;

    while (index < sourceList.length) {
      const end = Math.min(index + chunkSize, sourceList.length);
      for (let itemIndex = index; itemIndex < end; itemIndex++) {
        baseLibraryList.push(this.processLibraryItem(this.cloneLibraryItem(sourceList[itemIndex])));
      }

      const state: LibManagerInitialState = {
        tagList: this.cloneTags(tagList),
        displayTagList: this.cloneTags(displayTagList),
        baseLibraryList: this.cloneLibraryList(baseLibraryList),
        libraryList: this.applyLocalization(this.cloneLibraryList(baseLibraryList), lang),
      };

      if (index === 0) {
        this.cachePreviewState(cacheKey, state);
      }

      yield state;

      index = end;
      chunkSize = LibManagerService.FOLLOWUP_CHUNK_SIZE;
      if (index < sourceList.length) {
        await this.deferCalculation();
      }
    }
  }

  async searchLibraryList(
    libraryList: PackageInfo[],
    keyword: string,
    lang: string,
  ): Promise<PackageInfo[]> {
    await this.deferCalculation();

    const localizedList = this.applyLocalization(libraryList, lang);
    const searchIndex = createLibrarySearchIndex(localizedList);
    const matchedNames = searchLibraries(searchIndex, keyword);
    const nameIndexMap = new Map<string, number>();

    matchedNames.forEach((name, index) => nameIndexMap.set(name, index));

    return localizedList
      .filter(lib => nameIndexMap.has(lib.name))
      .sort((a, b) => (nameIndexMap.get(a.name) ?? 0) - (nameIndexMap.get(b.name) ?? 0));
  }

  filterByFulltext(libraryList: PackageInfo[], keyword: string): PackageInfo[] {
    const stripped = keyword.toLowerCase().replace(/\s/g, '');
    return libraryList.filter(item => (item.fulltext || '').indexOf(stripped) !== -1);
  }

  mergeInstalledLibraries(
    libraryList: PackageInfo[],
    installedLibraries: PackageInfo[],
    includeInstalledOnlyLibraries: boolean,
  ): PackageInfo[] {
    const normalizedInstalledLibraries = this.normalizeInstalledLibraries(installedLibraries);
    const installedLibraryMap = new Map(normalizedInstalledLibraries.map(lib => [lib.name, lib]));
    const mergedLibraryList = libraryList.map(lib => {
      const installedLib = installedLibraryMap.get(lib.name);

      if (installedLib) {
        return {
          ...lib,
          ...installedLib,
        };
      }

      return {
        ...lib,
        state: 'default' as const,
      };
    });

    if (!includeInstalledOnlyLibraries) {
      return mergedLibraryList;
    }

    const knownLibraryNames = new Set(mergedLibraryList.map(lib => lib.name));
    for (const installedLib of normalizedInstalledLibraries) {
      if (knownLibraryNames.has(installedLib.name)) {
        continue;
      }

      mergedLibraryList.push({
        ...installedLib,
        versionList: installedLib.version ? [installedLib.version] : [],
      });
    }

    return mergedLibraryList;
  }

  cloneLibraryList<T = any>(list: T[] | null | undefined): T[] {
    if (!Array.isArray(list)) {
      return [];
    }

    return JSON.parse(JSON.stringify(list));
  }

  cloneInitialState(state: LibManagerInitialState): LibManagerInitialState {
    return {
      tagList: this.cloneTags(state.tagList),
      displayTagList: this.cloneTags(state.displayTagList),
      baseLibraryList: this.cloneLibraryList(state.baseLibraryList),
      libraryList: this.cloneLibraryList(state.libraryList),
    };
  }

  applyLocalization(list: PackageInfo[], lang: string): PackageInfo[] {
    for (const lib of list) {
      lib._nickname = (lang && lib[`nickname_${lang}`]) || lib.nickname || '';
      lib._description = (lang && lib[`description_${lang}`]) || lib.description || '';
    }

    return list;
  }

  private processLibraryList(libraryList: PackageInfo[]): PackageInfo[] {
    for (const item of libraryList) {
      this.processLibraryItem(item);
    }

    return libraryList;
  }

  private processLibraryItem(item: PackageInfo): PackageInfo {
    item.versionList = item.version ? [item.version] : [];
    item.state = 'default';
    item.fulltext = `${item.name}${item.nickname}${item.keywords}${item['tags']}${item.description}${item.brand}`
      .replace(/\s|aily|blockly|ailyproject/gi, '')
      .toLowerCase();
    return item;
  }

  private normalizeInstalledLibraries(installedLibraries: PackageInfo[]): PackageInfo[] {
    return (installedLibraries || []).map(item => ({
      ...item,
      state: 'installed',
      fulltext: `installed${item.name}${item.nickname}${item.keywords}${item.description}${item.brand}`
        .replace(/\s|aily|blockly/gi, '')
        .toLowerCase(),
    }));
  }

  private buildLocalizedTagList(tagsData: any, lang: string): LibManagerTag[] {
    if (!tagsData?.tags || !Array.isArray(tagsData.tags)) {
      return [];
    }

    const localizedMap = tagsData[`tags_${lang || 'en'}`] || tagsData.tags_en || {};
    return tagsData.tags.map((key: string) => ({
      key,
      label: localizedMap[key] || key,
    }));
  }

  private getRandomTags(tagList: LibManagerTag[], count: number): LibManagerTag[] {
    if (tagList.length <= count) {
      return [...tagList];
    }

    return [...tagList].sort(() => Math.random() - 0.5).slice(0, count);
  }

  private cachePreviewState(cacheKey: string, state: LibManagerInitialState): void {
    this.cachedInitialState = {
      cacheKey,
      state: {
        tagList: this.cloneTags(state.tagList),
        displayTagList: this.cloneTags(state.displayTagList),
        baseLibraryList: this.cloneLibraryList(
          state.baseLibraryList.slice(0, LibManagerService.PREVIEW_ITEM_COUNT),
        ),
        libraryList: this.cloneLibraryList(
          state.libraryList.slice(0, LibManagerService.PREVIEW_ITEM_COUNT),
        ),
      },
    };
  }

  private createEmptyInitialState(tagData: any, lang: string, displayTagCount: number): LibManagerInitialState {
    const tagList = this.buildLocalizedTagList(tagData, lang);
    return {
      tagList,
      displayTagList: this.getRandomTags(tagList, displayTagCount),
      baseLibraryList: [],
      libraryList: [],
    };
  }

  private cloneLibraryItem(item: PackageInfo): PackageInfo {
    return JSON.parse(JSON.stringify(item));
  }

  private cloneTags(tags: LibManagerTag[]): LibManagerTag[] {
    return (tags || []).map(tag => ({ ...tag }));
  }

  private getCacheKey(
    libraryList: PackageInfo[] | null | undefined,
    tagData: any,
    lang: string,
    displayTagCount: number,
  ): string {
    const libraries = Array.isArray(libraryList) ? libraryList : [];
    const tags = Array.isArray(tagData?.tags) ? tagData.tags : [];
    const firstLibraryName = libraries[0]?.name || '';
    const lastLibraryName = libraries[libraries.length - 1]?.name || '';
    const firstTag = tags[0] || '';
    const lastTag = tags[tags.length - 1] || '';

    return [
      lang || 'en',
      displayTagCount,
      libraries.length,
      firstLibraryName,
      lastLibraryName,
      tags.length,
      firstTag,
      lastTag,
    ].join('|');
  }

  private deferCalculation(): Promise<void> {
    return new Promise(resolve => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
        return;
      }

      setTimeout(resolve, 0);
    });
  }
}
