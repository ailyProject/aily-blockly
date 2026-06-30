import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import { AilyHost } from '../core/host';

export type LanguageModelSettings = Record<string, unknown>;
export type LanguageModelsSettingsByModel = Record<string, LanguageModelSettings>;

export interface LanguageModelsProviderGroup extends Record<string, unknown> {
    name: string;
    vendor: string;
    settings?: LanguageModelsSettingsByModel;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isEmptyObject(value: Record<string, unknown> | undefined): boolean {
    return !value || Object.keys(value).length === 0;
}

@Injectable({
    providedIn: 'root'
})
export class AilyChatLanguageModelsConfigService {
    private readonly configFileName = 'chatLanguageModels.json';
    private providerGroups: LanguageModelsProviderGroup[] = [];
    private loaded = false;

    private readonly providerGroupsChangedSubject = new Subject<readonly LanguageModelsProviderGroup[]>();

    readonly providerGroupsChanged$: Observable<readonly LanguageModelsProviderGroup[]> = this.providerGroupsChangedSubject.asObservable();

    constructor() {
        this.load();
    }

    get configurationFilePath(): string {
        const appDataPath = AilyHost.get().path?.getAppDataPath?.() || '';
        return AilyHost.get().path?.join(appDataPath, this.configFileName) || '';
    }

    ensureConfigurationFile(): boolean {
        const configPath = this.configurationFilePath;
        if (!configPath) {
            return false;
        }

        if (AilyHost.get().fs?.existsSync(configPath)) {
            return true;
        }

        this.ensureParentDirectory(configPath);
        AilyHost.get().fs.writeFileSync(configPath, JSON.stringify([], null, 2), 'utf-8');
        this.providerGroups = [];
        this.loaded = true;
        this.providerGroupsChangedSubject.next(this.getLanguageModelsProviderGroups());
        return true;
    }

    load(): readonly LanguageModelsProviderGroup[] {
        try {
            const configPath = this.configurationFilePath;
            if (configPath && AilyHost.get().fs?.existsSync(configPath)) {
                const content = AilyHost.get().fs.readFileSync(configPath, 'utf-8');
                const parsed = JSON.parse(content);
                this.providerGroups = this.normalizeProviderGroups(parsed);
            } else {
                this.providerGroups = [];
            }

            this.loaded = true;
        } catch (error) {
            console.error('[AilyChatLanguageModelsConfigService] 加载配置失败:', error);
            this.providerGroups = [];
            this.loaded = true;
        }

        return this.getLanguageModelsProviderGroups();
    }

    save(): boolean {
        try {
            const configPath = this.configurationFilePath;
            if (!configPath) {
                return false;
            }

            const normalizedGroups = this.normalizeProviderGroups(this.providerGroups);
            this.providerGroups = normalizedGroups;
            this.ensureParentDirectory(configPath);
            AilyHost.get().fs.writeFileSync(configPath, JSON.stringify(normalizedGroups, null, 2), 'utf-8');
            this.providerGroupsChangedSubject.next(this.getLanguageModelsProviderGroups());
            return true;
        } catch (error) {
            console.error('[AilyChatLanguageModelsConfigService] 保存配置失败:', error);
            return false;
        }
    }

    getLanguageModelsProviderGroups(): readonly LanguageModelsProviderGroup[] {
        this.ensureLoaded();
        return cloneJsonValue(this.providerGroups);
    }

    setLanguageModelsProviderGroups(groups: readonly LanguageModelsProviderGroup[]): boolean {
        this.ensureLoaded();
        this.providerGroups = this.normalizeProviderGroups(groups);
        return this.save();
    }

    addLanguageModelsProviderGroup(group: LanguageModelsProviderGroup): LanguageModelsProviderGroup | undefined {
        this.ensureLoaded();
        const normalizedGroup = this.normalizeProviderGroup(group);
        if (!normalizedGroup) {
            return undefined;
        }

        this.providerGroups = [...this.providerGroups, normalizedGroup];
        return this.save() ? cloneJsonValue(normalizedGroup) : undefined;
    }

    updateLanguageModelsProviderGroup(from: LanguageModelsProviderGroup, to: LanguageModelsProviderGroup): LanguageModelsProviderGroup | undefined {
        this.ensureLoaded();
        const index = this.findProviderGroupIndex(from);
        if (index < 0) {
            return undefined;
        }

        const normalizedGroup = this.normalizeProviderGroup(to);
        if (!normalizedGroup) {
            return undefined;
        }

        const nextGroups = [...this.providerGroups];
        nextGroups[index] = normalizedGroup;
        this.providerGroups = nextGroups;
        return this.save() ? cloneJsonValue(normalizedGroup) : undefined;
    }

    removeLanguageModelsProviderGroup(group: LanguageModelsProviderGroup): boolean {
        this.ensureLoaded();
        const index = this.findProviderGroupIndex(group);
        if (index < 0) {
            return false;
        }

        const nextGroups = [...this.providerGroups];
        nextGroups.splice(index, 1);
        this.providerGroups = nextGroups;
        return this.save();
    }

    getModelSettings(modelId: string, vendor?: string, groupName?: string): LanguageModelSettings | undefined {
        this.ensureLoaded();
        const group = this.findProviderGroupWithModelSettings(modelId, vendor, groupName);
        const settings = group?.settings?.[modelId];
        return settings ? cloneJsonValue(settings) : undefined;
    }

    setModelSettings(vendor: string, modelId: string, values: LanguageModelSettings, groupName?: string): boolean {
        this.ensureLoaded();
        if (!vendor?.trim() || !modelId?.trim()) {
            return false;
        }

        const normalizedValues = this.normalizeLanguageModelSettings(values) ?? {};
        const index = this.findProviderGroupIndexByVendorAndName(vendor, groupName)
            ?? this.findProviderGroupIndexByModelId(vendor, modelId);

        let nextGroups = [...this.providerGroups];
        let targetGroup: LanguageModelsProviderGroup;
        let targetIndex = index ?? -1;

        if (targetIndex >= 0) {
            targetGroup = cloneJsonValue(nextGroups[targetIndex]);
        } else {
            targetGroup = {
                vendor: vendor.trim(),
                name: (groupName?.trim() || vendor.trim()),
                settings: {},
            };
            nextGroups = [...nextGroups, targetGroup];
            targetIndex = nextGroups.length - 1;
        }

        const existingSettings = this.normalizeLanguageModelSettings(targetGroup.settings?.[modelId]) ?? {};
        const mergedSettings = {
            ...existingSettings,
            ...normalizedValues,
        };

        Object.keys(mergedSettings).forEach((key) => {
            if (mergedSettings[key] === undefined) {
                delete mergedSettings[key];
            }
        });

        const nextGroupSettings = {
            ...(targetGroup.settings ?? {}),
        };

        if (Object.keys(mergedSettings).length === 0) {
            delete nextGroupSettings[modelId];
        } else {
            nextGroupSettings[modelId] = mergedSettings;
        }

        if (Object.keys(nextGroupSettings).length === 0) {
            delete targetGroup.settings;
        } else {
            targetGroup.settings = nextGroupSettings;
        }

        if (!targetGroup.settings && this.shouldDropProviderGroup(targetGroup)) {
            nextGroups.splice(targetIndex, 1);
        } else {
            nextGroups[targetIndex] = targetGroup;
        }

        this.providerGroups = nextGroups;
        return this.save();
    }

    removeModelSettings(modelId: string, vendor?: string, groupName?: string): boolean {
        this.ensureLoaded();
        const group = this.findProviderGroupWithModelSettings(modelId, vendor, groupName);
        if (!group?.vendor) {
            return false;
        }

        const index = this.findProviderGroupIndex(group);
        if (index < 0) {
            return false;
        }

        const nextGroups = [...this.providerGroups];
        const nextGroup = cloneJsonValue(nextGroups[index]);
        const nextSettings = {
            ...(nextGroup.settings ?? {}),
        };

        delete nextSettings[modelId];
        if (Object.keys(nextSettings).length === 0) {
            delete nextGroup.settings;
        } else {
            nextGroup.settings = nextSettings;
        }

        if (!nextGroup.settings && this.shouldDropProviderGroup(nextGroup)) {
            nextGroups.splice(index, 1);
        } else {
            nextGroups[index] = nextGroup;
        }

        this.providerGroups = nextGroups;
        return this.save();
    }

    private ensureLoaded(): void {
        if (!this.loaded) {
            this.load();
        }
    }

    private ensureParentDirectory(filePath: string): void {
        const dirPath = AilyHost.get().path?.dirname?.(filePath);
        if (!dirPath || AilyHost.get().fs.existsSync(dirPath)) {
            return;
        }

        AilyHost.get().fs.mkdirSync(dirPath, { recursive: true });
    }

    private normalizeProviderGroups(input: unknown): LanguageModelsProviderGroup[] {
        if (!Array.isArray(input)) {
            return [];
        }

        return input
            .map(group => this.normalizeProviderGroup(group))
            .filter((group): group is LanguageModelsProviderGroup => !!group);
    }

    private normalizeProviderGroup(input: unknown): LanguageModelsProviderGroup | undefined {
        if (!isObjectRecord(input)) {
            return undefined;
        }

        const nameValue = input['name'];
        const vendorValue = input['vendor'];
        const name = typeof nameValue === 'string' ? nameValue.trim() : '';
        const vendor = typeof vendorValue === 'string' ? vendorValue.trim() : '';
        if (!name || !vendor) {
            return undefined;
        }

        const normalizedGroup: LanguageModelsProviderGroup = {
            ...cloneJsonValue(input),
            name,
            vendor,
        };

        const normalizedSettings = this.normalizeSettingsByModel(input['settings']);
        if (normalizedSettings && !isEmptyObject(normalizedSettings)) {
            normalizedGroup.settings = normalizedSettings;
        } else {
            delete normalizedGroup.settings;
        }

        return normalizedGroup;
    }

    private normalizeSettingsByModel(input: unknown): LanguageModelsSettingsByModel | undefined {
        if (!isObjectRecord(input)) {
            return undefined;
        }

        const result: LanguageModelsSettingsByModel = {};
        Object.entries(input).forEach(([modelId, value]) => {
            const normalizedValue = this.normalizeLanguageModelSettings(value);
            if (modelId && normalizedValue && !isEmptyObject(normalizedValue)) {
                result[modelId] = normalizedValue;
            }
        });

        return result;
    }

    private normalizeLanguageModelSettings(input: unknown): LanguageModelSettings | undefined {
        if (!isObjectRecord(input)) {
            return undefined;
        }

        return cloneJsonValue(input);
    }

    private findProviderGroupIndex(group: LanguageModelsProviderGroup): number {
        return this.providerGroups.findIndex(candidate => candidate.vendor === group.vendor && candidate.name === group.name);
    }

    private findProviderGroupIndexByVendorAndName(vendor: string, groupName?: string): number | undefined {
        const normalizedVendor = vendor.trim();
        const normalizedGroupName = groupName?.trim();
        const index = this.providerGroups.findIndex((candidate) => {
            if (candidate.vendor !== normalizedVendor) {
                return false;
            }

            return normalizedGroupName ? candidate.name === normalizedGroupName : true;
        });

        return index >= 0 ? index : undefined;
    }

    private findProviderGroupIndexByModelId(vendor: string, modelId: string): number | undefined {
        const index = this.providerGroups.findIndex(candidate => candidate.vendor === vendor.trim() && !!candidate.settings?.[modelId]);
        return index >= 0 ? index : undefined;
    }

    private findProviderGroupWithModelSettings(modelId: string, vendor?: string, groupName?: string): LanguageModelsProviderGroup | undefined {
        const normalizedVendor = vendor?.trim();
        const normalizedGroupName = groupName?.trim();
        return this.providerGroups.find((candidate) => {
            if (normalizedVendor && candidate.vendor !== normalizedVendor) {
                return false;
            }

            if (normalizedGroupName && candidate.name !== normalizedGroupName) {
                return false;
            }

            return !!candidate.settings?.[modelId];
        });
    }

    private shouldDropProviderGroup(group: LanguageModelsProviderGroup): boolean {
        return Object.keys(group).every((key) => key === 'vendor' || key === 'name' || key === 'settings');
    }
}