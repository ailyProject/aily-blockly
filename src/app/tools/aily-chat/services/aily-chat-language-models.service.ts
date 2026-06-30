import { Injectable } from '@angular/core';

import {
    AilyChatConfigService,
    LanguageModelConfigurationSchema,
    ModelConfigOption,
} from './aily-chat-config.service';
import {
    AilyChatLanguageModelsConfigService,
    LanguageModelSettings,
    LanguageModelsProviderGroup,
} from './aily-chat-language-models-config.service';

export interface ResolvedLanguageModelConfigurationTarget {
    requestedModelId: string;
    resolvedModelId: string;
    vendor: string;
    groupName: string;
}

export interface LanguageModelConfigurationAction {
    id: string;
    key: string;
    label: string;
    tooltip?: string;
    checked: boolean;
    value: unknown;
}

export interface LanguageModelConfigurationActionGroup {
    id: string;
    key: string;
    label: string;
    group?: string;
    actions: LanguageModelConfigurationAction[];
}

export interface LanguageModelConfigurationUpdate {
    key: string;
    value: unknown;
}

function readStringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function getConfigurationPropertyLabel(key: string, title: unknown): string {
    if (typeof title === 'string' && title.trim()) {
        return title.trim();
    }

    return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (value) => value.toUpperCase());
}

@Injectable({
    providedIn: 'root'
})
export class AilyChatLanguageModelsService {
    constructor(
        private readonly chatConfigService: AilyChatConfigService,
        private readonly languageModelsConfigService: AilyChatLanguageModelsConfigService,
    ) {}

    get configurationFilePath(): string {
        return this.languageModelsConfigService.configurationFilePath;
    }

    prepareConfigurationFile(): string | undefined {
        return this.languageModelsConfigService.ensureConfigurationFile()
            ? this.configurationFilePath
            : undefined;
    }

    getLanguageModelsProviderGroups(): readonly LanguageModelsProviderGroup[] {
        return this.languageModelsConfigService.getLanguageModelsProviderGroups();
    }

    configureModel(modelId: string, update: LanguageModelConfigurationUpdate): boolean {
        const key = readStringValue(update?.key);
        if (!key) {
            return false;
        }

        const target = this.resolveModelConfigurationTarget(modelId);
        if (!target) {
            return false;
        }

        const propertySchema = this.getModelConfigurationSchema(target.resolvedModelId)?.properties?.[key];
        if (!propertySchema) {
            return false;
        }

        if (Array.isArray(propertySchema.enum) && propertySchema.enum.length > 0) {
            const matchedValue = propertySchema.enum.find((candidate) => areJsonValuesEqual(candidate, update.value));
            if (matchedValue === undefined) {
                return false;
            }

            return this.setModelConfiguration(modelId, { [key]: cloneJsonValue(matchedValue) });
        }

        return this.setModelConfiguration(modelId, { [key]: cloneJsonValue(update.value) });
    }

    getModelConfigurationActions(
        modelId: string,
        options?: { group?: string },
    ): readonly LanguageModelConfigurationActionGroup[] {
        const target = this.resolveModelConfigurationTarget(modelId);
        if (!target) {
            return [];
        }

        const schema = this.getModelConfigurationSchema(target.resolvedModelId);
        if (!schema?.properties) {
            return [];
        }

        const currentConfig = this.getModelConfiguration(modelId) ?? {};

        return Object.entries(schema.properties).reduce<LanguageModelConfigurationActionGroup[]>((acc, [key, propertySchema]) => {
            if (options?.group && propertySchema.group !== options.group) {
                return acc;
            }

            if (!Array.isArray(propertySchema.enum) || propertySchema.enum.length < 2) {
                return acc;
            }

            const currentValue = currentConfig[key] ?? propertySchema.default;
            const enumItemLabels = Array.isArray(propertySchema.enumItemLabels)
                ? propertySchema.enumItemLabels
                : undefined;
            const enumDescriptions = Array.isArray(propertySchema.enumDescriptions)
                ? propertySchema.enumDescriptions
                : undefined;
            const propertyLabel = getConfigurationPropertyLabel(key, propertySchema.title);

            acc.push({
                id: `configureModel.${key}`,
                key,
                label: propertyLabel,
                group: typeof propertySchema.group === 'string' && propertySchema.group.trim()
                    ? propertySchema.group.trim()
                    : undefined,
                actions: propertySchema.enum.map((value, index) => {
                    const itemLabel = enumItemLabels?.[index] ?? String(value);
                    const label = propertySchema.default !== undefined && areJsonValuesEqual(value, propertySchema.default)
                        ? `${itemLabel} (default)`
                        : itemLabel;

                    return {
                        id: `configureModel.${key}.${String(value)}`,
                        key,
                        label,
                        tooltip: typeof enumDescriptions?.[index] === 'string' && enumDescriptions[index].trim()
                            ? enumDescriptions[index].trim()
                            : undefined,
                        checked: areJsonValuesEqual(currentValue, value),
                        value: cloneJsonValue(value),
                    } satisfies LanguageModelConfigurationAction;
                }),
            });

            return acc;
        }, []);
    }

    getModelConfiguration(modelId: string): LanguageModelSettings | undefined {
        const target = this.resolveModelConfigurationTarget(modelId);
        if (!target) {
            return undefined;
        }

        const userSettings = this.languageModelsConfigService.getModelSettings(
            target.resolvedModelId,
            target.vendor,
            target.groupName,
        );
        const defaults = this.getModelConfigurationDefaults(target.resolvedModelId);

        if (!userSettings && Object.keys(defaults).length === 0) {
            return undefined;
        }

        return {
            ...defaults,
            ...(userSettings ?? {}),
        };
    }

    setModelConfiguration(modelId: string, values: LanguageModelSettings): boolean {
        const target = this.resolveModelConfigurationTarget(modelId);
        if (!target) {
            return false;
        }

        const existingSettings = this.languageModelsConfigService.getModelSettings(
            target.resolvedModelId,
            target.vendor,
            target.groupName,
        ) ?? {};
        const nextSettings: LanguageModelSettings = {
            ...existingSettings,
            ...cloneJsonValue(values),
        };

        Object.keys(nextSettings).forEach((key) => {
            if (nextSettings[key] === undefined) {
                delete nextSettings[key];
            }
        });

        const schema = this.getModelConfigurationSchema(target.resolvedModelId);
        if (schema?.properties) {
            for (const [key, propertySchema] of Object.entries(schema.properties)) {
                if (!(key in nextSettings)) {
                    continue;
                }

                if (propertySchema.default !== undefined && areJsonValuesEqual(nextSettings[key], propertySchema.default)) {
                    delete nextSettings[key];
                }
            }
        }

        if (Object.keys(nextSettings).length === 0) {
            return this.languageModelsConfigService.removeModelSettings(
                target.resolvedModelId,
                target.vendor,
                target.groupName,
            );
        }

        return this.languageModelsConfigService.setModelSettings(
            target.vendor,
            target.resolvedModelId,
            nextSettings,
            target.groupName,
        );
    }

    clearModelConfiguration(modelId: string): boolean {
        const target = this.resolveModelConfigurationTarget(modelId);
        if (!target) {
            return false;
        }

        return this.languageModelsConfigService.removeModelSettings(
            target.resolvedModelId,
            target.vendor,
            target.groupName,
        );
    }

    resolveModelConfigurationTarget(modelId: string): ResolvedLanguageModelConfigurationTarget | undefined {
        const requestedModelId = readStringValue(modelId);
        if (!requestedModelId) {
            return undefined;
        }

        const preset = this.chatConfigService.getModelPresetById(requestedModelId);
        const presetModelId = readStringValue(preset?.model);
        const resolvedModelId = presetModelId || requestedModelId;
        const runtimeModel = this.chatConfigService.getModelById(resolvedModelId)
            || (presetModelId ? this.chatConfigService.resolvePresetModel(requestedModelId) : null);

        const vendor = this.resolveVendor(runtimeModel, preset?.family);
        if (!vendor) {
            return undefined;
        }

        return {
            requestedModelId,
            resolvedModelId,
            vendor,
            groupName: this.resolveGroupName(runtimeModel),
        };
    }

    private resolveVendor(
        runtimeModel: Partial<ModelConfigOption> | null | undefined,
        fallbackFamily?: string | null,
    ): string | undefined {
        const metadata = runtimeModel as Record<string, unknown> | null | undefined;
        const explicitVendor = readStringValue(metadata?.['languageModelsVendor'])
            || readStringValue(metadata?.['vendor']);
        if (explicitVendor) {
            return explicitVendor;
        }

        const family = readStringValue(runtimeModel?.family) || readStringValue(fallbackFamily);
        if (family) {
            return family.toLowerCase();
        }

        if (runtimeModel?.isCustom) {
            return 'custom';
        }

        return undefined;
    }

    private resolveGroupName(runtimeModel: Partial<ModelConfigOption> | null | undefined): string {
        const metadata = runtimeModel as Record<string, unknown> | null | undefined;
        const explicitGroupName = readStringValue(metadata?.['languageModelsGroupName'])
            || readStringValue(metadata?.['groupName']);
        if (explicitGroupName) {
            return explicitGroupName;
        }

        if (runtimeModel?.isCustom) {
            const apiKeyId = readStringValue(runtimeModel.apiKeyId);
            if (apiKeyId) {
                return apiKeyId;
            }
        }

        return 'default';
    }

    private getModelConfigurationSchema(modelId: string): LanguageModelConfigurationSchema | undefined {
        const runtimeModel = this.chatConfigService.getModelById(modelId);
        return runtimeModel?.configurationSchema ? cloneJsonValue(runtimeModel.configurationSchema) : undefined;
    }

    private getModelConfigurationDefaults(modelId: string): LanguageModelSettings {
        const schema = this.getModelConfigurationSchema(modelId);
        if (!schema?.properties) {
            return {};
        }

        return Object.entries(schema.properties).reduce<LanguageModelSettings>((acc, [key, propertySchema]) => {
            if (propertySchema.default !== undefined) {
                acc[key] = cloneJsonValue(propertySchema.default);
            }
            return acc;
        }, {});
    }
}