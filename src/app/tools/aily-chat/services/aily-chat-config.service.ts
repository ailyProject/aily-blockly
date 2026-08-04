import { HttpClient, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Injectable, NgZone, OnDestroy, Optional } from '@angular/core';
import { Subject, Observable, Subscription } from 'rxjs';
import { distinctUntilChanged, timeout } from 'rxjs/operators';
import type { PermissionPolicy, PermissionRuleInput } from 'aily-lex/agent/common/approvalProtocol';
import packageJson from '../../../../../package.json';
import { AilyHost } from '../core/host';
import { ChatAPI } from '../core/api-endpoints';
import { AuthService } from '../../../services/auth.service';
import {
    applyAutoDiscountToBillingLabel,
    formatBillingMultiplierLabel,
    isDefaultAutoPresetSelected,
} from '../helpers/model-billing-label';
import {
    MAIN_AGENT_LEGACY_ALIAS,
    MAIN_AGENT_TYPE,
    normalizeAgentIdentifier,
    normalizeAgentIdentifiers,
    SCHEMATIC_AGENT_LEGACY_ALIAS,
    SCHEMATIC_AGENT_TYPE,
} from '../core/agent-identifiers';
import { normalizeGovernanceToolName } from '../core/tool-name-normalizer';

/**
 * 安全工作区配置项
 */
export interface WorkspaceSecurityOption {
    name: string;           // 选项标识符
    displayName: string;    // 显示名称
    enabled: boolean;       // 是否启用
}

/**
 * API密钥配置项
 */
export interface ApiKeyConfig {
    id: string;             // 配置ID
    name: string;           // 配置名称（如：OpenAI API、自定义服务等）
    baseUrl: string;        // API Base URL
    apiKey: string;         // API Key
    enabled: boolean;       // 是否启用
}

/**
 * 模型配置项
 */
export type ReasoningEffortOption = 'low' | 'medium' | 'high' | 'xhigh';
export type ProviderContextManagementMode = 'clear-thinking' | 'clear-tools' | 'clear-both';

export type ProviderContextManagementSupport =
    | {
        kind: 'responses';
        compactThresholdRatio?: number;
    }
    | {
        kind: 'anthropic';
        mode?: ProviderContextManagementMode;
        thinkingEnabled?: boolean;
        keepThinkingTurns?: number;
        keepToolUses?: number;
        toolUseTriggerInputTokens?: number;
        clearToolInputs?: boolean;
        excludeTools?: string[];
    }
    | {
        kind: string;
    };

export interface ModelPresetOption {
    id: string;
    name: string;
    model?: string;
    family?: string;
    description?: string;
    billingMultiplier?: number;
    billingLabelOverride?: string;
    billingDescription?: string;
    contextWindowTokens?: number;
    inputModalities?: ('text' | 'image')[];
    maxInputImages?: number;
    supportsReasoningEfforts?: ReasoningEffortOption[];
    availableTiers?: string[];
    requiredTier?: string;
    minimumClientVersion?: string;
    unavailableReason?: 'upgrade' | 'admin' | 'update';
    providerContextManagementSupport?: ProviderContextManagementSupport;
    enabled: boolean;
}

export interface ModelPickerCategoryOption {
    label: string;
    order: number;
}

export interface ModelPickerControlOption {
    label: string;
    featured?: boolean;
    minClientVersion?: string;
    exists: boolean;
    presetSurface?: string;
}

export interface LanguageModelConfigurationPropertySchema extends Record<string, unknown> {
    type?: string | string[];
    title?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    enumItemLabels?: string[];
    enumDescriptions?: string[];
    group?: string;
    secret?: boolean;
}

export interface LanguageModelConfigurationSchema extends Record<string, unknown> {
    type?: string;
    required?: string[];
    properties?: Record<string, LanguageModelConfigurationPropertySchema>;
}

export interface ModelConfigOption {
    model: string;          // 模型标识符
    name: string;           // 显示名称
    family: string;         // 模型家族
    speed: string;          // 速度标识
    description?: string;   // 模型描述（用于 tooltip）
    billingMultiplier?: number; // 计费倍率（用于 UI 展示）
    billingLabelOverride?: string; // 自定义计费标签（如 Auto 的动态费率）
    billingDescription?: string; // tooltip 中使用的计费说明
    contextWindowTokens?: number; // 上下文窗口长度（用于 tooltip）
    inputModalities?: ('text' | 'image')[]; // 服务端目录或自定义模型声明的输入模态
    maxInputImages?: number; // 单次请求允许的图片上限
    enabled: boolean;       // 是否在列表中显示
    isCustom?: boolean;     // 是否是自定义模型
    baseUrl?: string;       // API Base URL
    apiKey?: string;        // API Key
    apiKeyId?: string;      // 关联的API配置ID（兼容旧版本）
    presetId?: string;      // 产品预设ID（如 auto-max）
    reasoningEffort?: ReasoningEffortOption; // 请求级思考深度
    supportsReasoningEfforts?: ReasoningEffortOption[]; // 当前模型支持的思考深度集合
    languageModelsVendor?: string; // VS Code-style language model vendor
    languageModelsGroupName?: string; // VS Code-style provider group name
    configurationSchema?: LanguageModelConfigurationSchema; // VS Code-style per-model configuration schema
    providerContextManagementSupport?: ProviderContextManagementSupport; // provider-managed compaction capability from services catalog
}

interface RemoteProviderContextManagementSupportPayload {
    kind?: string | null;
    compact_threshold_ratio?: number | null;
    mode?: string | null;
    thinking_enabled?: boolean | null;
    keep_thinking_turns?: number | null;
    keep_tool_uses?: number | null;
    tool_use_trigger_input_tokens?: number | null;
    clear_tool_inputs?: boolean | null;
    exclude_tools?: string[] | null;
}

interface RemoteCatalogPayloadEntry {
    id?: string;
    canonical_id?: string;
    aliases?: string[];
    model?: string;
    display_name?: string;
    family?: string;
    description?: string;
    context_window_tokens?: number | null;
    input_modalities?: string[] | null;
    max_input_images?: number | null;
    supports_reasoning_effort?: string[];
    billing_multiplier?: number | null;
    billing_label_override?: string | null;
    billing_description?: string | null;
    language_models_vendor?: string | null;
    language_models_group_name?: string | null;
    configuration_schema?: LanguageModelConfigurationSchema | null;
    user_visible?: boolean | null;
    is_user_selectable?: boolean | null;
    available_tiers?: string[] | null;
    required_tier?: string | null;
    minimum_client_version?: string | null;
    unavailable_reason?: 'upgrade' | 'admin' | 'update' | null;
    provider_context_management_support?: RemoteProviderContextManagementSupportPayload | null;
    model_picker_category?: {
        label?: string | null;
        order?: number | null;
    } | null;
}

interface RemotePickerControlPayloadEntry {
    label?: string | null;
    featured?: boolean | null;
    min_client_version?: string | null;
    exists?: boolean | null;
    preset_surface?: string | null;
}

interface RemoteModelCatalogEntry {
    id?: string;
    canonicalId?: string;
    aliases?: string[];
    model?: string;
    displayName?: string;
    family?: string;
    description?: string;
    contextWindowTokens?: number;
    inputModalities?: ('text' | 'image')[];
    maxInputImages?: number;
    supportsReasoningEfforts?: ReasoningEffortOption[];
    billingMultiplier?: number;
    billingLabelOverride?: string;
    billingDescription?: string;
    languageModelsVendor?: string;
    languageModelsGroupName?: string;
    configurationSchema?: LanguageModelConfigurationSchema;
    userVisible?: boolean;
    isUserSelectable?: boolean;
    availableTiers?: string[];
    requiredTier?: string;
    minimumClientVersion?: string;
    unavailableReason?: 'upgrade' | 'admin' | 'update';
    providerContextManagementSupport?: ProviderContextManagementSupport;
    modelPickerCategory?: ModelPickerCategoryOption;
}

interface RemoteModelCatalog {
    models: Record<string, RemoteModelCatalogEntry>;
    modelPresets: Record<string, RemoteModelCatalogEntry>;
    userVisibleModelPresets: Record<string, RemoteModelCatalogEntry>;
    pickerControlModelPresets: Record<string, ModelPickerControlOption>;
}

interface RemoteModelCatalogMetadata {
    currentTier?: string;
    catalogVersion?: string;
    permissionsHash?: string;
    multimodalContractVersion?: string;
}

interface RemoteModelCatalogResponse {
    status?: string;
    data?: {
        models?: Record<string, RemoteCatalogPayloadEntry>;
        model_presets?: Record<string, RemoteCatalogPayloadEntry>;
        user_visible_model_presets?: Record<string, RemoteCatalogPayloadEntry>;
        picker_control_model_presets?: Record<string, RemotePickerControlPayloadEntry>;
        current_tier?: string | null;
        catalog_version?: string | null;
        permissions_hash?: string | null;
        multimodal_contract_version?: string | null;
    };
}

/**
 * 按Agent分类的工具配置
 */
export interface AgentToolsConfig {
    /** 启用的工具列表 */
    enabledTools: string[];
    /** 禁用的工具列表 */
    disabledTools: string[];
}

export interface LexTerminalPolicyConfig {
    allowList?: string[];
    denyList?: string[];
    inheritDefaultAllowList?: boolean;
}

export type ChatSessionViewerOrientationSetting = 'stacked' | 'sideBySide';

function normalizeSessionViewerOrientationSetting(value: unknown): ChatSessionViewerOrientationSetting {
    return value === 'stacked' ? 'stacked' : 'sideBySide';
}

export type WorkspacePermissionRulesByProject = Record<string, PermissionRuleInput[]>;
export type WorkspaceApprovalCombinationsByProject = Record<string, string[]>;

/**
 * Aily Chat 配置接口
 */
export interface AilyChatConfig {
    /** 是否使用自定义 API Key (兼容旧版本) */
    useCustomApiKey?: boolean;
    /** API Base URL (兼容旧版本) */
    baseUrl?: string;
    /** API Key (兼容旧版本) */
    apiKey?: string;
    /** 最大请求数 / 最大工具调用轮数（VS Code chat.agent.maxRequests 对齐） */
    maxRequests?: number;
    /** 旧字段：最大循环次数 */
    maxCount?: number;
    /** 启用的工具列表（兼容旧版本，mainAgent） */
    enabledTools?: string[];
    /** 禁用的工具列表（兼容旧版本，mainAgent） */
    disabledTools?: string[];
    /** 按Agent分类的工具配置 */
    agentTools?: {
        main?: AgentToolsConfig;
        SchematicAgent?: AgentToolsConfig;
        mainAgent?: AgentToolsConfig;
        schematicAgent?: AgentToolsConfig;
        [agentName: string]: AgentToolsConfig | undefined;
    };
    /** 是否启用本地 memory tool（对齐 chat.tools.memory.enabled）。 */
    memoryToolEnabled?: boolean;
    /** 是否启用 Aily repository memory。 */
    repositoryMemoryEnabled?: boolean;
    /** 安全工作区配置 */
    securityWorkspaces?: {
        /** 是否允许访问项目文件 */
        project?: boolean;
        /** 是否允许访问库文件 */
        library?: boolean;
    };
    /** API密钥配置列表 */
    apiKeys?: ApiKeyConfig[];
    /** 模型配置列表 */
    models?: ModelConfigOption[];
    /** Subagent 单次调用总超时（ms），默认 300000（5分钟） */
    subagentTimeout?: number;
    /** 自定义上下文窗口大小（tokens，0 表示自动检测） */
    contextWindowSize?: number;
    /** 工具结果压缩阈值比例 (0-1，占上下文窗口的百分比，默认 0.5) */
    compressionThresholdRatio?: number;
    /** LLM 摘要阈值比例 (0-1，占上下文窗口的百分比，默认 0.75) */
    summarizationThresholdRatio?: number;
    /** 默认自动保存变更（AI编辑完成后自动保留，不弹出变更面板） */
    autoSaveEdits?: boolean;
    /** session viewer 布局偏好；对齐 VS Code chat.view.sessions.orientation。 */
    sessionViewerOrientation?: ChatSessionViewerOrientationSetting;
    /** 用户级 instruction folders，扫描其中的 `*.instructions.md`。 */
    userInstructionFolders?: string[];
    /** 项目级 instruction folders，扫描其中的 `*.instructions.md`。 */
    projectInstructionFolders?: string[];
    /** 用户级 agent folders，扫描其中的 `.agent.md` / legacy `.chatmode.md`。 */
    userAgentFolders?: string[];
    /** 项目级 agent folders，扫描其中的 `.agent.md` / legacy `.chatmode.md`。 */
    projectAgentFolders?: string[];
    /** 用户级 skill folders，扫描其中的 `<skillName>/SKILL.md`。 */
    userSkillFolders?: string[];
    /** 项目级 skill folders，扫描其中的 `<skillName>/SKILL.md`。 */
    projectSkillFolders?: string[];
    /** 对齐 upstream ChatModes：若生产态已绑定 session customization item provider，则 custom agents 优先从该 source 读取。 */
    useChatSessionCustomizationsForCustomAgents?: boolean;
    /** 在 custom agent picker 中隐藏的 customAgentTarget 列表。 */
    hiddenCustomAgentTargets?: string[];
    /** 追加到 lex terminal runtime policy 的 allow list。 */
    terminalAllowList?: string[];
    /** 强制要求确认的 terminal 命令规则。 */
    terminalDenyList?: string[];
    /** 是否继承 lex 内建 innocuous terminal allow list。 */
    terminalInheritDefaultAllowList?: boolean;
    /** reviewed actions 的默认 reviewer。 */
    approvalsReviewer?: 'user' | 'auto_review';
    /** reviewed actions 的默认 approval policy。 */
    approvalPolicy?: 'on_request' | 'never';
    /** 当前工作区维度持久化的 lex permission rules。键为规范化后的 projectPath。 */
    workspacePermissionRules?: WorkspacePermissionRulesByProject;
    /** 当前工作区维度持久化的 tool+arguments approval combination keys。 */
    workspaceApprovalCombinations?: WorkspaceApprovalCombinationsByProject;
}

/**
 * 默认内置模型列表
 */
const DEFAULT_MODELS: ModelConfigOption[] = [];

const DEFAULT_MODEL_PRESET_ID = 'auto';
const USER_SELECTABLE_MODEL_PRESET_IDS = ['auto', 'auto-max', 'auto-fast'] as const;
const USER_SELECTABLE_MODEL_PRESET_ID_SET = new Set<string>(USER_SELECTABLE_MODEL_PRESET_IDS);

/**
 * 本地 core preset 仅作为远端 model catalog 不可用时的兜底。
 */
const CORE_MODEL_PRESET_OPTIONS: ModelPresetOption[] = [
    {
        id: 'auto',
        name: 'Auto',
        model: 'auto',
        family: 'auto',
        description: '在 Aily Max / Aily Fast 间自动选择；包含图片时由服务端切换到 Vision',
        contextWindowTokens: 800000,
        inputModalities: ['text', 'image'],
        maxInputImages: 10,
        supportsReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        billingLabelOverride: '10% discount',
        billingDescription: 'Auto selects the best model for your request based on capacity and performance. Auto is given a 10% discount.',
        enabled: true,
    },
    {
        id: 'auto-max',
        name: 'Aily Max',
        model: 'auto-max',
        family: 'glm',
        description: '高质量优先，适合复杂任务；响应速度相对较慢',
        billingMultiplier: 1,
        contextWindowTokens: 800000,
        inputModalities: ['text', 'image'],
        maxInputImages: 10,
        supportsReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        enabled: true,
    },
    {
        id: 'auto-fast',
        name: 'Aily Fast',
        model: 'auto-fast',
        family: 'deepseek',
        description: '响应速度优先，同时保持较为均衡的质量',
        billingMultiplier: 0.5,
        contextWindowTokens: 800000,
        inputModalities: ['text', 'image'],
        maxInputImages: 10,
        supportsReasoningEfforts: ['high', 'xhigh'],
        enabled: true,
    },
];

/** Internal response identity used only when a cached remote catalog is unavailable. */
const INTERNAL_RESPONSE_PRESET_OPTIONS: ModelPresetOption[] = [
    {
        id: 'auto-vision',
        name: 'Vision',
        model: 'auto-vision',
        family: 'glm',
        description: '支持视觉输入的产品预设',
        billingMultiplier: 1,
        contextWindowTokens: 200000,
        inputModalities: ['text', 'image'],
        maxInputImages: 10,
        supportsReasoningEfforts: ['low', 'medium', 'high'],
        enabled: false,
    },
];

/**
 * 默认API配置（空列表）
 */
const DEFAULT_API_KEYS: ApiKeyConfig[] = [];

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AilyChatConfig = {
    maxCount: 200,
    enabledTools: [],
    disabledTools: [],
    memoryToolEnabled: true,
    repositoryMemoryEnabled: false,
    securityWorkspaces: {
        project: true,
        library: true
    },
    apiKeys: DEFAULT_API_KEYS,
    models: DEFAULT_MODELS,
    contextWindowSize: 0,
    compressionThresholdRatio: 0.5,
    summarizationThresholdRatio: 0.75,
    autoSaveEdits: true,
    sessionViewerOrientation: 'sideBySide',
    userInstructionFolders: [],
    projectInstructionFolders: [],
    userAgentFolders: [],
    projectAgentFolders: [],
    userSkillFolders: [],
    projectSkillFolders: [],
    useChatSessionCustomizationsForCustomAgents: false,
    hiddenCustomAgentTargets: [],
    approvalsReviewer: 'user',
    approvalPolicy: 'on_request',
};

/**
 * Aily Chat 独立配置服务
 * 用于管理 AI 聊天功能的配置，独立于全局 ConfigService
 */
@Injectable({
    providedIn: 'root'
})
export class AilyChatConfigService implements OnDestroy {
    private config: AilyChatConfig = { ...DEFAULT_CONFIG };
    private readonly sessionToolApprovalStates = new Map<string, {
        toolNames: Set<string>;
        terminalRules: Set<string>;
        combinationKeys: Set<string>;
        allowAllTerminalCommands: boolean;
    }>();
    private configFileName = 'aily-chat-config.json';
    private readonly clientVersion = packageJson.version;
    private loaded = false;
    private remoteModelCatalog: RemoteModelCatalog = {
        models: {},
        modelPresets: {},
        userVisibleModelPresets: {},
        pickerControlModelPresets: {},
    };
    private remoteModelCatalogMetadata: RemoteModelCatalogMetadata = {};
    private remoteModelCatalogStatus: 'loading' | 'ready' | 'unavailable' = 'loading';
    private remoteModelCatalogStatusHint = '正在加载远端 model catalog...';
    private authReadySubscription?: Subscription;
    private authInitializationStateSubscription?: Subscription;
    private remoteModelCatalogRequestSubscription?: Subscription;
    private remoteModelCatalogRequestRevision = 0;
    private readonly remoteModelCatalogRequestTimeoutMs = 12000;

    /** 配置变更通知 Subject */
    private configChangedSubject = new Subject<AilyChatConfig>();
    private modelCatalogChangedSubject = new Subject<void>();

    /** 配置变更通知 Observable */
    public configChanged$: Observable<AilyChatConfig> = this.configChangedSubject.asObservable();
    public modelCatalogChanged$: Observable<void> = this.modelCatalogChangedSubject.asObservable();

    get modelCatalogStatus(): 'loading' | 'ready' | 'unavailable' {
        return this.remoteModelCatalogStatus;
    }

    get modelCatalogStatusHint(): string | undefined {
        return this.remoteModelCatalogStatusHint;
    }

    get hasRemoteModelCatalog(): boolean {
        return this.hasUsableRemoteModelCatalog();
    }

    get modelCatalogCurrentTier(): string | undefined {
        return this.remoteModelCatalogMetadata.currentTier;
    }

    get modelCatalogVersion(): string | undefined {
        return this.remoteModelCatalogMetadata.catalogVersion;
    }

    get modelCatalogPermissionsHash(): string | undefined {
        return this.remoteModelCatalogMetadata.permissionsHash;
    }

    get modelCatalogMultimodalContractVersion(): string | undefined {
        return this.remoteModelCatalogMetadata.multimodalContractVersion;
    }

    constructor(
        private http: HttpClient,
        @Optional() private authService: AuthService | null = null,
        @Optional() private ngZone: NgZone | null = null,
    ) {
        this.load();
        this.bindAuthReadyReload();
        if (AilyHost.isInitialized()) {
            this.loadRemoteModelCatalog('constructor');
        } else {
            this.setRemoteModelCatalogStatus('loading', '等待 host 初始化后自动加载模型目录...');
            console.info('[AilyChatConfigService] host 尚未初始化，延迟加载远端 model catalog');
        }
    }

    reloadRemoteModelCatalog(reason = 'manual'): void {
        this.loadRemoteModelCatalog(reason);
    }

    ngOnDestroy(): void {
        this.authReadySubscription?.unsubscribe();
        this.authReadySubscription = undefined;
        this.authInitializationStateSubscription?.unsubscribe();
        this.authInitializationStateSubscription = undefined;
        this.cancelRemoteModelCatalogRequest('service-destroyed');
    }

    private bindAuthReadyReload(): void {
        if (this.authService?.authInitializationState$) {
            this.authInitializationStateSubscription = this.authService.authInitializationState$
                .pipe(distinctUntilChanged())
                .subscribe((state) => {
                    if (state === 'authenticated' && AilyHost.isInitialized()) {
                        this.loadRemoteModelCatalog('auth_initialized');
                        return;
                    }
                    if (state === 'signed_out' || state === 'unavailable') {
                        this.cancelRemoteModelCatalogRequest(`auth-${state}`);
                        this.setRemoteModelCatalogStatus(
                            'unavailable',
                            state === 'signed_out'
                                ? '登录后可刷新远端模型目录；本地模型配置仍然可用。'
                                : '暂时无法刷新远端模型目录；继续使用上一次可用目录或本地模型配置。',
                        );
                    }
                });
        }

        if (this.authService?.authChanged$) {
            this.authReadySubscription = this.authService.authChanged$
                .subscribe(() => {
                    if (!AilyHost.isInitialized() || !this.isAuthReadyForRemoteModelCatalog()) {
                        this.cancelRemoteModelCatalogRequest('auth-unavailable');
                        this.setRemoteModelCatalogStatus(
                            'unavailable',
                            '登录后可刷新远端模型目录；本地模型配置仍然可用。',
                        );
                        return;
                    }

                    this.loadRemoteModelCatalog('auth_ready');
                });

            return;
        }

        if (this.authService?.authSnapshot$) {
            this.authReadySubscription = this.authService.authSnapshot$
                .subscribe((authSnapshot) => {
                    if (!authSnapshot || !AilyHost.isInitialized()) {
                        this.cancelRemoteModelCatalogRequest('auth-unavailable');
                        this.setRemoteModelCatalogStatus(
                            'unavailable',
                            '登录后可刷新远端模型目录；本地模型配置仍然可用。',
                        );
                        return;
                    }

                    this.loadRemoteModelCatalog('auth_ready');
                });

            return;
        }

        if (!this.authService?.isLoggedIn$) {
            return;
        }

        this.authReadySubscription = this.authService.isLoggedIn$
            .pipe(distinctUntilChanged())
            .subscribe((isLoggedIn) => {
                if (!isLoggedIn || !AilyHost.isInitialized()) {
                    this.cancelRemoteModelCatalogRequest('auth-unavailable');
                    this.setRemoteModelCatalogStatus(
                        'unavailable',
                        '登录后可刷新远端模型目录；本地模型配置仍然可用。',
                    );
                    return;
                }
                if (this.hasUsableRemoteModelCatalog()) {
                    return;
                }

                this.loadRemoteModelCatalog('auth_ready');
            });
    }

    /**
     * 获取配置文件路径
     */
    private getConfigPath(): string {
        const appDataPath = AilyHost.get().path?.getAppDataPath?.() || '';
        return AilyHost.get().path?.join(appDataPath, this.configFileName) || '';
    }

    /**
     * 加载配置
     */
    load(): void {
        try {
            const configPath = this.getConfigPath();
            if (configPath && AilyHost.get().fs?.existsSync(configPath)) {
                const content = AilyHost.get().fs.readFileSync(configPath, 'utf-8');
                const savedConfig = JSON.parse(content);
                // 合并默认配置和已保存的配置
                this.config = { ...DEFAULT_CONFIG, ...savedConfig };
            } else {
                this.config = { ...DEFAULT_CONFIG };
            }
            // 执行迁移
            this.migrateFromOldConfig();
            this.loaded = true;
        } catch (error) {
            console.error('[AilyChatConfigService] 加载配置失败:', error);
            this.config = { ...DEFAULT_CONFIG };
        }
    }

    /**
     * 保存配置
     */
    save(): boolean {
        try {
            const configPath = this.getConfigPath();
            if (configPath) {
                AilyHost.get().fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
                // 发送配置变更通知
                this.configChangedSubject.next({ ...this.config });
                return true;
            }
            return false;
        } catch (error) {
            console.error('[AilyChatConfigService] 保存配置失败:', error);
            return false;
        }
    }

    /**
     * 获取完整配置
     */
    getConfig(): AilyChatConfig {
        if (!this.loaded) {
            this.load();
        }
        return { ...this.config };
    }

    /**
     * 更新配置
     */
    updateConfig(updates: Partial<AilyChatConfig>): void {
        this.config = { ...this.config, ...updates };
        if (updates.sessionViewerOrientation !== undefined) {
            this.config.sessionViewerOrientation = normalizeSessionViewerOrientationSetting(updates.sessionViewerOrientation);
        }
        if (updates.maxRequests !== undefined) {
            this.config.maxRequests = updates.maxRequests;
            this.config.maxCount = updates.maxRequests;
            return;
        }
        if (updates.maxCount !== undefined) {
            this.config.maxRequests = updates.maxCount;
            this.config.maxCount = updates.maxCount;
            return;
        }
        this.normalizeRequestLimitConfig();
    }

    // ==================== 便捷访问方法 ====================

    /**
     * 获取是否使用自定义 API Key (兼容旧版本)
     * 如果有API配置列表且非空，或者有自定义模型，则认为使用自定义API
     */
    get useCustomApiKey(): boolean {
        // 兼容旧版本：如果旧配置存在且有值，返回true
        if (this.config.useCustomApiKey) return true;
        // 新版本：如果有API配置，返回true
        if ((this.config.apiKeys?.length ?? 0) > 0) return true;
        // 检查是否有自定义模型（带有apiKey和baseUrl）
        const hasCustomModels = this.config.models?.some(m => m.isCustom && m.apiKey && m.baseUrl) ?? false;
        return hasCustomModels;
    }

    set useCustomApiKey(value: boolean) {
        // 兼容旧版本设置
        this.config.useCustomApiKey = value;
    }

    /**
     * 获取 API Base URL (兼容旧版本)
     * 返回第一个API配置的baseUrl，用于兼容
     */
    get baseUrl(): string {
        if (this.config.apiKeys && this.config.apiKeys.length > 0) {
            return this.config.apiKeys[0].baseUrl;
        }
        return this.config.baseUrl ?? '';
    }

    set baseUrl(value: string) {
        // 兼容旧版本
        this.config.baseUrl = value;
        // 如果有API配置，也更新第一个
        if (this.config.apiKeys && this.config.apiKeys.length > 0) {
            this.config.apiKeys[0].baseUrl = value;
        }
    }

    /**
     * 获取 API Key (兼容旧版本)
     * 返回第一个API配置的apiKey，用于兼容
     */
    get apiKey(): string {
        if (this.config.apiKeys && this.config.apiKeys.length > 0) {
            return this.config.apiKeys[0].apiKey;
        }
        return this.config.apiKey ?? '';
    }

    set apiKey(value: string) {
        // 兼容旧版本
        this.config.apiKey = value;
        // 如果有API配置，也更新第一个
        if (this.config.apiKeys && this.config.apiKeys.length > 0) {
            this.config.apiKeys[0].apiKey = value;
        }
    }

    /**
     * 获取最大请求数 / 最大工具调用轮数。
     * 优先读取新字段 maxRequests，兼容旧字段 maxCount。
     */
    get maxRequests(): number {
        return this.config.maxRequests ?? this.config.maxCount ?? 200;
    }

    set maxRequests(value: number) {
        this.config.maxRequests = value;
        this.config.maxCount = value;
    }

    /**
     * 兼容旧调用点：最大循环次数。
     * 内部代理到 maxRequests。
     */
    get maxCount(): number {
        return this.maxRequests;
    }

    set maxCount(value: number) {
        this.maxRequests = value;
    }

    /**
     * 获取 subagent 单次调用总超时（ms）
     * 默认 300000（5分钟），覆盖整个多轮工具调用循环
     */
    get subagentTimeout(): number {
        return this.config.subagentTimeout ?? 300000;
    }

    set subagentTimeout(value: number) {
        this.config.subagentTimeout = value;
    }

    // ==================== 上下文预算配置 ====================

    /**
     * 获取自定义上下文窗口大小（0 表示自动检测）
     */
    get contextWindowSize(): number {
        return this.config.contextWindowSize ?? 0;
    }

    set contextWindowSize(value: number) {
        this.config.contextWindowSize = value;
    }

    /**
     * 获取工具结果压缩阈值比例
     */
    get compressionThresholdRatio(): number {
        return this.config.compressionThresholdRatio ?? 0.5;
    }

    set compressionThresholdRatio(value: number) {
        this.config.compressionThresholdRatio = Math.max(0, Math.min(1, value));
    }

    /**
     * 获取 LLM 摘要阈值比例
     */
    get summarizationThresholdRatio(): number {
        return this.config.summarizationThresholdRatio ?? 0.75;
    }

    set summarizationThresholdRatio(value: number) {
        this.config.summarizationThresholdRatio = Math.max(0, Math.min(1, value));
    }

    // ==================== 自动保存变更 ====================

    get autoSaveEdits(): boolean {
        return this.config.autoSaveEdits ?? false;
    }

    set autoSaveEdits(value: boolean) {
        this.config.autoSaveEdits = value;
    }

    get sessionViewerOrientation(): ChatSessionViewerOrientationSetting {
        return normalizeSessionViewerOrientationSetting(this.config.sessionViewerOrientation);
    }

    set sessionViewerOrientation(value: ChatSessionViewerOrientationSetting) {
        this.config.sessionViewerOrientation = normalizeSessionViewerOrientationSetting(value);
    }

    get userInstructionFolders(): string[] {
        return normalizeInstructionFolderPaths(this.config.userInstructionFolders);
    }

    set userInstructionFolders(value: string[]) {
        this.config.userInstructionFolders = normalizeInstructionFolderPaths(value);
    }

    get projectInstructionFolders(): string[] {
        return normalizeInstructionFolderPaths(this.config.projectInstructionFolders);
    }

    set projectInstructionFolders(value: string[]) {
        this.config.projectInstructionFolders = normalizeInstructionFolderPaths(value);
    }

    get userAgentFolders(): string[] {
        return normalizeAgentFolderPaths(this.config.userAgentFolders);
    }

    set userAgentFolders(value: string[]) {
        this.config.userAgentFolders = normalizeAgentFolderPaths(value);
    }

    get projectAgentFolders(): string[] {
        return normalizeAgentFolderPaths(this.config.projectAgentFolders);
    }

    set projectAgentFolders(value: string[]) {
        this.config.projectAgentFolders = normalizeAgentFolderPaths(value);
    }

    get userSkillFolders(): string[] {
        return normalizeSkillFolderPaths(this.config.userSkillFolders);
    }

    set userSkillFolders(value: string[]) {
        this.config.userSkillFolders = normalizeSkillFolderPaths(value);
    }

    get projectSkillFolders(): string[] {
        return normalizeSkillFolderPaths(this.config.projectSkillFolders);
    }

    set projectSkillFolders(value: string[]) {
        this.config.projectSkillFolders = normalizeSkillFolderPaths(value);
    }

    get useChatSessionCustomizationsForCustomAgents(): boolean {
        return this.config.useChatSessionCustomizationsForCustomAgents === true;
    }

    set useChatSessionCustomizationsForCustomAgents(value: boolean) {
        this.config.useChatSessionCustomizationsForCustomAgents = value === true;
    }

    get hiddenCustomAgentTargets(): string[] {
        return normalizeCustomAgentTargets(this.config.hiddenCustomAgentTargets);
    }

    set hiddenCustomAgentTargets(value: string[]) {
        this.config.hiddenCustomAgentTargets = normalizeCustomAgentTargets(value);
    }

    get terminalAllowList(): string[] {
        return normalizeTerminalPermissionRules(this.config.terminalAllowList);
    }

    set terminalAllowList(value: string[]) {
        this.config.terminalAllowList = normalizeTerminalPermissionRules(value);
    }

    get terminalDenyList(): string[] {
        return normalizeTerminalPermissionRules(this.config.terminalDenyList);
    }

    set terminalDenyList(value: string[]) {
        this.config.terminalDenyList = normalizeTerminalPermissionRules(value);
    }

    get terminalInheritDefaultAllowList(): boolean | undefined {
        return typeof this.config.terminalInheritDefaultAllowList === 'boolean'
            ? this.config.terminalInheritDefaultAllowList
            : undefined;
    }

    set terminalInheritDefaultAllowList(value: boolean | undefined) {
        this.config.terminalInheritDefaultAllowList = value;
    }

    get approvalsReviewer(): 'user' | 'auto_review' {
        return this.config.approvalsReviewer === 'auto_review'
            ? 'auto_review'
            : 'user';
    }

    set approvalsReviewer(value: 'user' | 'auto_review') {
        this.config.approvalsReviewer = value === 'auto_review' ? 'auto_review' : 'user';
    }

    get approvalPolicy(): 'on_request' | 'never' {
        return this.config.approvalPolicy === 'never'
            ? 'never'
            : 'on_request';
    }

    set approvalPolicy(value: 'on_request' | 'never') {
        this.config.approvalPolicy = value === 'never' ? 'never' : 'on_request';
    }

    getLexApprovalsReviewer(): 'user' | 'auto_review' {
        return this.approvalsReviewer;
    }

    getLexApprovalPolicy(): 'on_request' | 'never' {
        return this.approvalPolicy;
    }

    getLexTerminalPolicy(): LexTerminalPolicyConfig | undefined {
        const allowList = this.terminalAllowList;
        const denyList = this.terminalDenyList;
        const inheritDefaultAllowList = this.terminalInheritDefaultAllowList;

        if (allowList.length === 0 && denyList.length === 0 && inheritDefaultAllowList === undefined) {
            return undefined;
        }

        return {
            ...(allowList.length > 0 ? { allowList } : {}),
            ...(denyList.length > 0 ? { denyList } : {}),
            ...(inheritDefaultAllowList === undefined ? {} : { inheritDefaultAllowList }),
        };
    }

    getWorkspacePermissionRules(projectPath: string | null | undefined): PermissionRuleInput[] {
        const normalizedProjectPath = normalizeProjectPermissionScope(projectPath);
        if (!normalizedProjectPath) {
            return [];
        }

        return normalizePermissionRuleInputs(this.config.workspacePermissionRules?.[normalizedProjectPath]);
    }

    hasSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean {
        const normalizedToolName = normalizeApprovalStateKey(toolName);
        return !!normalizedToolName
            && this.readSessionToolApprovalState(sessionResource)?.toolNames.has(normalizedToolName) === true;
    }

    addSessionToolApprovalRule(sessionResource: string | null | undefined, toolName: string): boolean {
        const normalizedToolName = normalizeApprovalStateKey(toolName);
        if (!normalizedToolName) {
            return false;
        }

        const state = this.ensureSessionToolApprovalState(sessionResource);
        const beforeSize = state.toolNames.size;
        state.toolNames.add(normalizedToolName);
        return state.toolNames.size !== beforeSize;
    }

    getSessionTerminalApprovalRules(sessionResource: string | null | undefined): string[] {
        return [...(this.readSessionToolApprovalState(sessionResource)?.terminalRules ?? [])];
    }

    addSessionTerminalApprovalRule(sessionResource: string | null | undefined, rule: string): boolean {
        const normalizedRule = normalizeApprovalStateKey(rule);
        if (!normalizedRule) {
            return false;
        }

        const state = this.ensureSessionToolApprovalState(sessionResource);
        const beforeSize = state.terminalRules.size;
        state.terminalRules.add(normalizedRule);
        return state.terminalRules.size !== beforeSize;
    }

    hasSessionToolApprovalCombinationKey(
        sessionResource: string | null | undefined,
        combinationKey: string,
    ): boolean {
        const normalizedKey = normalizeApprovalStateKey(combinationKey);
        return !!normalizedKey
            && this.readSessionToolApprovalState(sessionResource)?.combinationKeys.has(normalizedKey) === true;
    }

    addSessionToolApprovalCombinationKey(
        sessionResource: string | null | undefined,
        combinationKey: string,
    ): boolean {
        const normalizedKey = normalizeApprovalStateKey(combinationKey);
        if (!normalizedKey) {
            return false;
        }

        const state = this.ensureSessionToolApprovalState(sessionResource);
        const beforeSize = state.combinationKeys.size;
        state.combinationKeys.add(normalizedKey);
        return state.combinationKeys.size !== beforeSize;
    }

    isSessionTerminalAutoApprovalEnabled(sessionResource: string | null | undefined): boolean {
        return this.readSessionToolApprovalState(sessionResource)?.allowAllTerminalCommands === true;
    }

    setSessionTerminalAutoApproval(sessionResource: string | null | undefined, enabled: boolean): void {
        this.ensureSessionToolApprovalState(sessionResource).allowAllTerminalCommands = enabled === true;
    }

    hasWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean {
        const normalizedToolName = normalizeGovernanceToolName(toolName);
        if (!normalizedToolName) {
            return false;
        }

        return this.getWorkspacePermissionRules(projectPath).some(rule =>
            rule.mode === 'bypassPermissions' && rule.toolName === normalizedToolName,
        );
    }

    addWorkspaceToolApprovalRule(projectPath: string | null | undefined, toolName: string): boolean {
        const normalizedProjectPath = normalizeProjectPermissionScope(projectPath);
        const normalizedToolName = normalizeGovernanceToolName(toolName);
        if (!normalizedProjectPath || !normalizedToolName) {
            return false;
        }

        const currentRules = this.getWorkspacePermissionRules(normalizedProjectPath);
        if (currentRules.some(rule => rule.mode === 'bypassPermissions' && rule.toolName === normalizedToolName)) {
            return false;
        }

        this.config.workspacePermissionRules = {
            ...normalizeWorkspacePermissionRulesByProject(this.config.workspacePermissionRules),
            [normalizedProjectPath]: [
                ...currentRules,
                { toolName: normalizedToolName, mode: 'bypassPermissions', source: 'project' },
            ],
        };
        return true;
    }

    hasWorkspaceToolApprovalCombinationKey(projectPath: string | null | undefined, combinationKey: string): boolean {
        const normalizedProjectPath = normalizeProjectPermissionScope(projectPath);
        const normalizedKey = typeof combinationKey === 'string' ? combinationKey.trim() : '';
        if (!normalizedProjectPath || !normalizedKey) {
            return false;
        }

        const combinations = this.config.workspaceApprovalCombinations?.[normalizedProjectPath] ?? [];
        return combinations.includes(normalizedKey);
    }

    addWorkspaceToolApprovalCombinationKey(projectPath: string | null | undefined, combinationKey: string): boolean {
        const normalizedProjectPath = normalizeProjectPermissionScope(projectPath);
        const normalizedKey = typeof combinationKey === 'string' ? combinationKey.trim() : '';
        if (!normalizedProjectPath || !normalizedKey) {
            return false;
        }

        const existing = this.config.workspaceApprovalCombinations?.[normalizedProjectPath] ?? [];
        if (existing.includes(normalizedKey)) {
            return false;
        }

        this.config.workspaceApprovalCombinations = {
            ...(this.config.workspaceApprovalCombinations ?? {}),
            [normalizedProjectPath]: [...existing, normalizedKey],
        };
        return true;
    }

    private readSessionToolApprovalState(sessionResource: string | null | undefined): {
        toolNames: Set<string>;
        terminalRules: Set<string>;
        combinationKeys: Set<string>;
        allowAllTerminalCommands: boolean;
    } | undefined {
        const normalizedSessionResource = normalizeApprovalStateKey(sessionResource);
        return normalizedSessionResource
            ? this.sessionToolApprovalStates.get(normalizedSessionResource)
            : undefined;
    }

    private ensureSessionToolApprovalState(sessionResource: string | null | undefined): {
        toolNames: Set<string>;
        terminalRules: Set<string>;
        combinationKeys: Set<string>;
        allowAllTerminalCommands: boolean;
    } {
        const normalizedSessionResource = normalizeApprovalStateKey(sessionResource);
        if (!normalizedSessionResource) {
            throw new Error('[AilyChat][Config] session approval requires a session resource.');
        }

        const existing = this.sessionToolApprovalStates.get(normalizedSessionResource);
        if (existing) {
            return existing;
        }

        const created = {
            toolNames: new Set<string>(),
            terminalRules: new Set<string>(),
            combinationKeys: new Set<string>(),
            allowAllTerminalCommands: false,
        };
        this.sessionToolApprovalStates.set(normalizedSessionResource, created);
        return created;
    }

    getLexPermissionPolicy(projectPath: string | null | undefined): PermissionPolicy | undefined {
        const projectRules = this.getWorkspacePermissionRules(projectPath);
        if (projectRules.length === 0) {
            return undefined;
        }

        return {
            project: projectRules,
        };
    }

    /**
     * 获取启用的工具列表
     */
    get enabledTools(): string[] {
        return normalizeConfiguredToolNames(this.config.enabledTools);
    }

    set enabledTools(value: string[]) {
        this.config.enabledTools = normalizeConfiguredToolNames(value);
    }

    /**
     * 获取禁用的工具列表
     */
    get disabledTools(): string[] {
        return normalizeConfiguredToolNames(this.config.disabledTools);
    }

    set disabledTools(value: string[]) {
        this.config.disabledTools = normalizeConfiguredToolNames(value);
    }

    get memoryToolEnabled(): boolean {
        return this.config.memoryToolEnabled !== false;
    }

    set memoryToolEnabled(value: boolean) {
        this.config.memoryToolEnabled = value !== false;
    }

    get repositoryMemoryEnabled(): boolean {
        return this.config.repositoryMemoryEnabled === true;
    }

    set repositoryMemoryEnabled(value: boolean) {
        this.config.repositoryMemoryEnabled = value === true;
    }

    /**
     * 获取指定Agent的工具配置
     * @param agentName Agent名称（如 'main' / 'SchematicAgent'，兼容旧别名）
     */
    getAgentToolsConfig(agentName: string): AgentToolsConfig {
        const canonicalAgentName = normalizeAgentIdentifier(agentName);
        const legacyAgentName = canonicalAgentName === MAIN_AGENT_TYPE
            ? MAIN_AGENT_LEGACY_ALIAS
            : canonicalAgentName === SCHEMATIC_AGENT_TYPE
                ? SCHEMATIC_AGENT_LEGACY_ALIAS
                : canonicalAgentName;

        // 优先从 agentTools 获取
        const agentConfig = this.config.agentTools?.[canonicalAgentName]
            ?? this.config.agentTools?.[legacyAgentName];
        if (agentConfig) {
            return {
                enabledTools: normalizeConfiguredToolNames(agentConfig.enabledTools),
                disabledTools: normalizeConfiguredToolNames(agentConfig.disabledTools)
            };
        }
        // 兼容旧版本：main agent 使用顶层的 enabledTools/disabledTools
        if (canonicalAgentName === MAIN_AGENT_TYPE) {
            return {
                enabledTools: normalizeConfiguredToolNames(this.config.enabledTools),
                disabledTools: normalizeConfiguredToolNames(this.config.disabledTools)
            };
        }
        // 其他Agent默认返回空配置
        return { enabledTools: [], disabledTools: [] };
    }

    /**
     * 设置指定Agent的工具配置
     * @param agentName Agent名称
     * @param config 工具配置
     */
    setAgentToolsConfig(agentName: string, config: AgentToolsConfig): void {
        const canonicalAgentName = normalizeAgentIdentifier(agentName);
        const normalizedConfig: AgentToolsConfig = {
            enabledTools: normalizeConfiguredToolNames(config.enabledTools),
            disabledTools: normalizeConfiguredToolNames(config.disabledTools),
        };
        if (!this.config.agentTools) {
            this.config.agentTools = {};
        }
        this.config.agentTools[canonicalAgentName] = normalizedConfig;
        if (canonicalAgentName === MAIN_AGENT_TYPE && this.config.agentTools[MAIN_AGENT_LEGACY_ALIAS]) {
            delete this.config.agentTools[MAIN_AGENT_LEGACY_ALIAS];
        }
        if (canonicalAgentName === SCHEMATIC_AGENT_TYPE && this.config.agentTools[SCHEMATIC_AGENT_LEGACY_ALIAS]) {
            delete this.config.agentTools[SCHEMATIC_AGENT_LEGACY_ALIAS];
        }
        // 同步更新顶层配置（兼容旧版本）
        if (canonicalAgentName === MAIN_AGENT_TYPE) {
            this.config.enabledTools = normalizedConfig.enabledTools;
            this.config.disabledTools = normalizedConfig.disabledTools;
        }
    }

    /**
     * 获取安全工作区配置
     */
    get securityWorkspaces(): { project: boolean; library: boolean } {
        return {
            project: this.config.securityWorkspaces?.project ?? true,
            library: this.config.securityWorkspaces?.library ?? true
        };
    }

    set securityWorkspaces(value: { project?: boolean; library?: boolean }) {
        this.config.securityWorkspaces = {
            project: value.project ?? true,
            library: value.library ?? true
        };
    }

    /**
     * 检查项目文件访问是否启用
     */
    isProjectAccessEnabled(): boolean {
        return this.config.securityWorkspaces?.project ?? true;
    }

    /**
     * 检查库文件访问是否启用
     */
    isLibraryAccessEnabled(): boolean {
        return this.config.securityWorkspaces?.library ?? true;
    }

    /**
     * 更新安全工作区的单个选项
     */
    setSecurityWorkspaceOption(name: 'project' | 'library', enabled: boolean): void {
        if (!this.config.securityWorkspaces) {
            this.config.securityWorkspaces = { project: true, library: true };
        }
        this.config.securityWorkspaces[name] = enabled;
    }

    /**
     * 获取工作区安全选项列表（用于设置界面）
     */
    getWorkspaceSecurityOptions(): WorkspaceSecurityOption[] {
        return [
            { 
                name: 'project', 
                displayName: '项目文件', 
                enabled: this.isProjectAccessEnabled() 
            },
            { 
                name: 'library', 
                displayName: '库文件', 
                enabled: this.isLibraryAccessEnabled() 
            }
        ];
    }

    /**
     * 从选项列表更新安全工作区配置
     */
    updateFromWorkspaceOptions(options: WorkspaceSecurityOption[]): void {
        options.forEach(opt => {
            if (opt.name === 'project' || opt.name === 'library') {
                this.setSecurityWorkspaceOption(opt.name, opt.enabled);
            }
        });
    }

    // ==================== 模型管理方法 ====================

    /**
     * 获取模型列表
     */
    get models(): ModelConfigOption[] {
        return this.buildRuntimeModels();
    }

    set models(value: ModelConfigOption[]) {
        this.config.models = this.buildPersistedModels(value);
    }

    /**
     * 获取已启用的模型列表
     * 规则：如果未启用自定义API KEY，则只返回内置模型
     * 始终在列表最前面添加 Auto 选项
     */
    getEnabledModels(): ModelConfigOption[] {
        const enabledModels = this.models.filter(m => m.enabled);
        
        // 如果未启用自定义API KEY，过滤掉自定义模型
        let resultModels: ModelConfigOption[];
        if (!this.useCustomApiKey) {
            resultModels = enabledModels.filter(m => !m.isCustom);
        } else {
            resultModels = enabledModels;
        }

        return resultModels;
    }

    getModelPresets(): ModelPresetOption[] {
        const remotePresetOptions = this.getRemoteModelPresetOptions();
        if (remotePresetOptions.length > 0) {
            return remotePresetOptions;
        }

        if (this.remoteModelCatalogStatus === 'ready') {
            return [];
        }

        return CORE_MODEL_PRESET_OPTIONS
            .filter(preset => preset.enabled)
            .map(preset => ({ ...preset }));
    }

    getUserVisibleModelPresets(): ModelPresetOption[] {
        const resolvedPresetIds = this.resolveUserVisiblePresetIds();
        if (resolvedPresetIds.length > 0) {
            return resolvedPresetIds
                .map(presetId => this.getModelPresetById(presetId))
                .filter((preset): preset is ModelPresetOption => preset !== undefined);
        }

        return [];
    }

    getModelPickerControlPresets(): Record<string, ModelPickerControlOption> {
        return Object.entries(this.remoteModelCatalog.pickerControlModelPresets)
            .reduce<Record<string, ModelPickerControlOption>>((acc, [presetId, entry]) => {
                if (USER_SELECTABLE_MODEL_PRESET_ID_SET.has(presetId)) {
                    acc[presetId] = { ...entry };
                }
                return acc;
            }, {});
    }

    getModelPickerControlPresetById(presetId: string | null | undefined): ModelPickerControlOption | undefined {
        const normalizedPresetId = normalizeUserPresetId(presetId);
        if (!normalizedPresetId) {
            return undefined;
        }

        const entry = this.remoteModelCatalog.pickerControlModelPresets[normalizedPresetId];
        return entry ? { ...entry } : undefined;
    }

    getDefaultModelPresetId(): string {
        return DEFAULT_MODEL_PRESET_ID;
    }

    normalizeUserModelPresetId(presetId: string | null | undefined): string | undefined {
        return normalizeUserPresetId(presetId);
    }

    getModelPresetById(presetId: string | null | undefined): ModelPresetOption | undefined {
        const normalizedPresetId = normalizeCatalogPresetId(presetId);
        if (!normalizedPresetId) {
            return undefined;
        }

        return this.getModelPresets().find(preset => preset.id === normalizedPresetId)
            ?? INTERNAL_RESPONSE_PRESET_OPTIONS.find(preset => preset.id === normalizedPresetId);
    }

    getModelById(modelId: string | null | undefined): ModelConfigOption | undefined {
        if (typeof modelId !== 'string' || !modelId.trim()) {
            return undefined;
        }

        const rawModel = this.getRawModelMetadataById(modelId);
        return rawModel ? this.normalizeRuntimeModel(rawModel) : undefined;
    }

    resolveRuntimeModelFromServerModelName(
        modelName: string | null | undefined,
        options?: { contextWindowTokens?: number | null },
    ): ModelConfigOption | null {
        if (typeof modelName !== 'string' || !modelName.trim()) {
            return null;
        }

        const normalizedModelName = modelName.trim();
        const contextWindowTokens = typeof options?.contextWindowTokens === 'number' && options.contextWindowTokens > 0
            ? options.contextWindowTokens
            : undefined;
        const presetMatch = this.resolvePresetDisplayModel(normalizedModelName);
        if (presetMatch) {
            return this.normalizeRuntimeModel({
                ...presetMatch,
                ...(contextWindowTokens ? { contextWindowTokens } : {}),
            });
        }

        const exactMatch = this.getModelById(normalizedModelName);
        if (exactMatch) {
            return this.normalizeRuntimeModel({
                ...exactMatch,
                ...(contextWindowTokens ? { contextWindowTokens } : {}),
            });
        }

        const lowerModelName = normalizedModelName.toLowerCase();
        const matchedModel = [...this.getEnabledModels(), ...this.models].find((model) => {
            const modelId = typeof model.model === 'string' ? model.model.trim().toLowerCase() : '';
            const displayName = typeof model.name === 'string' ? model.name.trim().toLowerCase() : '';
            return modelId === lowerModelName || displayName === lowerModelName;
        });

        if (matchedModel) {
            return this.normalizeRuntimeModel({
                ...matchedModel,
                ...(contextWindowTokens ? { contextWindowTokens } : {}),
            });
        }

        return this.normalizeRuntimeModel({
            model: normalizedModelName,
            name: normalizedModelName,
            family: '',
            speed: 'Remote',
            enabled: true,
            isCustom: false,
            ...(contextWindowTokens ? { contextWindowTokens } : {}),
        });
    }

    resolvePresetDisplayModel(presetId: string | null | undefined): ModelConfigOption | null {
        const normalizedPresetId = normalizeCatalogPresetId(presetId);
        if (!normalizedPresetId) {
            return null;
        }

        const preset = this.getModelPresetById(normalizedPresetId);
        if (!preset) {
            return null;
        }

        const resolvedModel = typeof preset.model === 'string' && preset.model.trim()
            ? this.getModelById(preset.model)
            : undefined;
        const supportsReasoningEfforts = Array.isArray(preset.supportsReasoningEfforts)
            ? [...preset.supportsReasoningEfforts]
            : this.getSupportedReasoningEfforts({ model: preset.model, family: preset.family || resolvedModel?.family || '' });
        const family = preset.family || resolvedModel?.family || 'auto';

        return {
            model: preset.id,
            name: preset.name,
            family,
            speed: 'Auto',
            description: preset.description,
            billingMultiplier: preset.billingMultiplier,
            billingLabelOverride: preset.billingLabelOverride,
            billingDescription: preset.billingDescription,
            contextWindowTokens: preset.contextWindowTokens ?? resolvedModel?.contextWindowTokens,
            inputModalities: preset.inputModalities?.length
                ? [...preset.inputModalities]
                : resolvedModel?.inputModalities,
            maxInputImages: preset.maxInputImages ?? resolvedModel?.maxInputImages,
            enabled: true,
            isCustom: false,
            presetId: preset.id,
            providerContextManagementSupport: preset.providerContextManagementSupport ?? resolvedModel?.providerContextManagementSupport,
            supportsReasoningEfforts,
            reasoningEffort: this.getDefaultReasoningEffortForModel({
                family,
                supportsReasoningEfforts,
            }),
        };
    }

    resolveSelectablePresetModel(presetId: string | null | undefined): ModelConfigOption | null {
        const normalizedPresetId = normalizeUserPresetId(presetId);
        if (!normalizedPresetId || !USER_SELECTABLE_MODEL_PRESET_ID_SET.has(normalizedPresetId)) {
            return null;
        }

        const preset = this.getModelPresetById(normalizedPresetId);
        if (!preset?.enabled) {
            return null;
        }

        return this.resolvePresetDisplayModel(normalizedPresetId);
    }

    resolvePresetModel(presetId: string | null | undefined): ModelConfigOption | null {
        return this.resolvePresetDisplayModel(presetId);
    }

    resolveSavedModel(savedModel: Partial<ModelConfigOption> | null | undefined): ModelConfigOption | null {
        if (!savedModel) {
            return null;
        }

        const normalizedSavedPresetId = resolveSavedPresetId(savedModel, this.getModelPresets());
        const savedPreset = this.getModelPresetById(normalizedSavedPresetId);
        const resolvedSavedPresetId = savedPreset?.id;

        const mergeRuntimeFields = (model: ModelConfigOption, presetId?: string): ModelConfigOption => ({
            ...model,
            presetId,
            reasoningEffort: this.resolveModelReasoningEffort(model, savedModel.reasoningEffort),
        });

        const presetModel = savedPreset?.enabled ? this.resolveSelectablePresetModel(normalizedSavedPresetId) : null;
        if (presetModel && savedPreset?.enabled) {
            return mergeRuntimeFields(presetModel, resolvedSavedPresetId ?? presetModel.presetId);
        }

        const directModel = this.getEnabledModels().find(model => model.model === savedModel.model);
        if (directModel?.isCustom) {
            return mergeRuntimeFields(directModel);
        }

        const defaultPresetModel = this.resolveSelectablePresetModel(this.getDefaultModelPresetId());
        if (defaultPresetModel) {
            return mergeRuntimeFields(defaultPresetModel, defaultPresetModel.presetId);
        }

        return null;
    }

    getSupportedReasoningEfforts(model: Partial<ModelConfigOption> | null | undefined): ReasoningEffortOption[] {
        if (!model) {
            return [];
        }

        if (Array.isArray(model.supportsReasoningEfforts) && model.supportsReasoningEfforts.length > 0) {
            return [...model.supportsReasoningEfforts];
        }

        const canonicalModel = this.resolveCanonicalModelMetadata(model);
        if (Array.isArray(canonicalModel?.supportsReasoningEfforts) && canonicalModel.supportsReasoningEfforts.length > 0) {
            return [...canonicalModel.supportsReasoningEfforts];
        }

        const family = typeof (model.family || canonicalModel?.family) === 'string'
            ? (model.family || canonicalModel?.family || '').toLowerCase()
            : '';
        if (['openai', 'deepseek', 'qwen', 'moonshot', 'yi', 'groq', 'together', 'mistral', 'openrouter'].includes(family)) {
            return ['low', 'medium', 'high', 'xhigh'];
        }
        if (['claude', 'anthropic', 'glm'].includes(family)) {
            return ['low', 'medium', 'high'];
        }

        return [];
    }

    getDefaultReasoningEffortForModel(
        model: Partial<ModelConfigOption> | null | undefined,
    ): ReasoningEffortOption | undefined {
        const supportedEfforts = this.getSupportedReasoningEfforts(model);
        if (supportedEfforts.length === 0) {
            return undefined;
        }

        if (supportedEfforts.includes('medium')) {
            return 'medium';
        }

        return supportedEfforts[0];
    }

    resolveModelReasoningEffort(
        model: Partial<ModelConfigOption> | null | undefined,
        reasoningEffort: ReasoningEffortOption | null | undefined,
    ): ReasoningEffortOption | undefined {
        if (reasoningEffort) {
            return reasoningEffort;
        }

        return this.getDefaultReasoningEffortForModel(model);
    }

    normalizeRuntimeModel(model: ModelConfigOption): ModelConfigOption {
        return {
            ...model,
            reasoningEffort: this.resolveModelReasoningEffort(model, model.reasoningEffort),
        };
    }

    getReasoningEffortLabel(reasoningEffort: ReasoningEffortOption | null | undefined): string {
        switch (reasoningEffort) {
            case 'low':
                return '低';
            case 'medium':
                return '中';
            case 'high':
                return '高';
            case 'xhigh':
                return '极高';
            default:
                return '自动';
        }
    }

    getReasoningEffortDisplayLabel(reasoningEffort: ReasoningEffortOption | null | undefined): string {
        switch (reasoningEffort) {
            case 'low':
                return 'Low';
            case 'medium':
                return 'Medium';
            case 'high':
                return 'High';
            case 'xhigh':
                return 'Max';
            default:
                return 'Auto';
        }
    }

    getReasoningEffortsSummaryLabel(efforts: readonly ReasoningEffortOption[] | null | undefined): string | undefined {
        if (!Array.isArray(efforts) || efforts.length === 0) {
            return undefined;
        }

        return efforts.map((effort) => this.getReasoningEffortDisplayLabel(effort)).join(' / ');
    }

    getModelReasoningSummaryLabel(model: Partial<ModelConfigOption> | null | undefined): string | undefined {
        return this.getReasoningEffortsSummaryLabel(this.getSupportedReasoningEfforts(model));
    }

    getModelBillingLabel(model: Partial<ModelConfigOption> | null | undefined): string | undefined {
        const autoDiscountActive = isDefaultAutoPresetSelected(model);

        if (typeof model?.billingLabelOverride === 'string' && model.billingLabelOverride.trim()) {
            return autoDiscountActive
                ? applyAutoDiscountToBillingLabel(model.billingLabelOverride)
                : model.billingLabelOverride.trim();
        }

        const canonicalModel = this.resolveCanonicalModelMetadata(model);
        if (typeof canonicalModel?.billingLabelOverride === 'string' && canonicalModel.billingLabelOverride.trim()) {
            return autoDiscountActive
                ? applyAutoDiscountToBillingLabel(canonicalModel.billingLabelOverride)
                : canonicalModel.billingLabelOverride.trim();
        }

        const multiplier = model?.billingMultiplier ?? canonicalModel?.billingMultiplier;
        if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
            return undefined;
        }

        const billingLabel = formatBillingMultiplierLabel(multiplier);
        return autoDiscountActive
            ? applyAutoDiscountToBillingLabel(billingLabel)
            : billingLabel;
    }

    getModelMenuReasoningLabel(model: Partial<ModelConfigOption> | null | undefined): string | undefined {
        const effectiveReasoningEffort = this.resolveModelReasoningEffort(model, model?.reasoningEffort);
        if (!effectiveReasoningEffort) {
            return undefined;
        }

        return this.getReasoningEffortDisplayLabel(effectiveReasoningEffort);
    }

    getModelMenuMeta(
        model: Partial<ModelConfigOption> | null | undefined,
        options?: { preferBilling?: boolean },
    ): string | undefined {
        const preferBilling = options?.preferBilling ?? false;
        const reasoningLabel = this.getModelMenuReasoningLabel(model);
        const billingLabel = this.getModelBillingLabel(model);

        if (preferBilling && billingLabel && !reasoningLabel) {
            return billingLabel;
        }

        const parts = [reasoningLabel, billingLabel].filter((part): part is string => !!part);
        if (parts.length > 0) {
            return parts.join('·');
        }

        if (model?.isCustom) {
            return 'Custom';
        }

        const contextLabel = this.getModelCapabilityContextWindowLabel(model);
        if (contextLabel && contextLabel !== '自动检测') {
            return contextLabel;
        }

        return billingLabel;
    }

    getModelCapabilitySummaryParts(
        model: Partial<ModelConfigOption> | null | undefined,
        options?: { includeBillingDescription?: boolean },
    ): string[] {
        if (!model) {
            return [];
        }

        const canonicalModel = this.resolveCanonicalModelMetadata(model);
        const parts: string[] = [];
        const contextLabel = this.getModelCapabilityContextWindowLabel(model);
        if (contextLabel && contextLabel !== '自动检测') {
            parts.push(contextLabel);
        }

        const reasoningLabel = this.getModelReasoningSummaryLabel(model);
        if (reasoningLabel) {
            parts.push(reasoningLabel);
        }

        const providerContextManagementLabel = this.getModelProviderContextManagementLabel(model);
        if (providerContextManagementLabel) {
            parts.push(providerContextManagementLabel);
        }

        const billingLabel = this.getModelBillingLabel(model);
        if (billingLabel) {
            const billingDescription = model.billingDescription || canonicalModel?.billingDescription;
            parts.push(options?.includeBillingDescription && billingDescription
                ? billingDescription
                : billingLabel);
        }

        return parts;
    }

    getModelContextWindowLabel(maxContextTokens?: number | null): string {
        const resolvedContextTokens = typeof maxContextTokens === 'number' && maxContextTokens > 0
            ? maxContextTokens
            : this.contextWindowSize;

        if (!resolvedContextTokens || resolvedContextTokens <= 0) {
            return '自动检测';
        }

        if (resolvedContextTokens >= 1000) {
            const contextK = resolvedContextTokens / 1000;
            const formatted = Number.isInteger(contextK) ? contextK.toFixed(0) : contextK.toFixed(1);
            return `${formatted}K`;
        }

        return `${resolvedContextTokens}`;
    }

    resolveModelContextWindowTokens(
        model: Partial<ModelConfigOption> | null | undefined,
    ): number | undefined {
        const contextWindowTokens = typeof model?.contextWindowTokens === 'number' && model.contextWindowTokens > 0
            ? model.contextWindowTokens
            : this.resolveCanonicalModelMetadata(model)?.contextWindowTokens;

        return typeof contextWindowTokens === 'number' && contextWindowTokens > 0
            ? contextWindowTokens
            : undefined;
    }

    getModelCapabilityContextWindowLabel(model: Partial<ModelConfigOption> | null | undefined): string {
        if (model?.isCustom) {
            return '自定义';
        }

        const contextWindowTokens = this.resolveModelContextWindowTokens(model);

        if (typeof contextWindowTokens === 'number' && contextWindowTokens > 0) {
            return this.getModelContextWindowLabel(contextWindowTokens);
        }

        return '自动检测';
    }

    resolveModelProviderContextManagementSupport(
        model: Partial<ModelConfigOption> | null | undefined,
    ): ProviderContextManagementSupport | undefined {
        if (model?.providerContextManagementSupport) {
            return model.providerContextManagementSupport;
        }

        return this.resolveCanonicalModelMetadata(model)?.providerContextManagementSupport;
    }

    getModelProviderContextManagementLabel(
        model: Partial<ModelConfigOption> | null | undefined,
    ): string | undefined {
        const support = this.resolveModelProviderContextManagementSupport(model);
        if (!support || typeof support.kind !== 'string' || !support.kind.trim()) {
            return undefined;
        }

        return '上下文管理';
    }

    getModelProviderContextManagementDetail(
        model: Partial<ModelConfigOption> | null | undefined,
    ): string | undefined {
        const support = this.resolveModelProviderContextManagementSupport(model);
        if (!support || typeof support.kind !== 'string' || !support.kind.trim()) {
            return undefined;
        }

        if (support.kind === 'responses') {
            const compactThresholdRatio = 'compactThresholdRatio' in support ? support.compactThresholdRatio : undefined;
            const thresholdRatio = typeof compactThresholdRatio === 'number'
                && Number.isFinite(compactThresholdRatio)
                && compactThresholdRatio > 0
                && compactThresholdRatio <= 1
                ? `${Math.round(compactThresholdRatio * 100)}%`
                : undefined;
            return thresholdRatio
                ? `Provider 自动管理上下文，压缩阈值 ${thresholdRatio}`
                : 'Provider 自动管理上下文';
        }

        if (support.kind === 'anthropic') {
            const mode = 'mode' in support ? support.mode : undefined;
            const modeLabel = mode === 'clear-thinking'
                ? '清理思考内容'
                : mode === 'clear-tools'
                    ? '清理工具调用'
                    : '清理思考与工具调用';
            return `Provider 上下文管理：${modeLabel}`;
        }

        return 'Provider 自动管理上下文';
    }

    private resolveCanonicalModelMetadata(
        model: Partial<ModelConfigOption> | null | undefined,
    ): ModelConfigOption | undefined {
        if (!model) {
            return undefined;
        }

        const presetId = typeof model.presetId === 'string' && model.presetId.trim()
            ? model.presetId.trim()
            : (typeof model.model === 'string' && this.getModelPresetById(model.model)
                ? model.model.trim()
                : undefined);
        if (presetId) {
            const preset = this.getModelPresetById(presetId);
            if (preset?.model) {
                const presetModel = this.getRawModelMetadataById(preset.model);
                if (presetModel) {
                    return presetModel;
                }
            }
        }

        if (typeof model.model === 'string' && model.model.trim()) {
            return this.getRawModelMetadataById(model.model);
        }

        return undefined;
    }

    private getRawModelMetadataById(modelId: string | null | undefined): ModelConfigOption | undefined {
        if (typeof modelId !== 'string' || !modelId.trim()) {
            return undefined;
        }

        const normalizedModelId = modelId.trim();
        const storedModel = this.getStoredModelEntries().find(model => model.model === normalizedModelId);
        const remoteCatalogEntry = this.remoteModelCatalog.models[normalizedModelId]
            || Object.values(this.remoteModelCatalog.models).find(model => model.model === normalizedModelId);

        if (remoteCatalogEntry) {
            const family = remoteCatalogEntry.family || storedModel?.family || '';
            return {
                model: remoteCatalogEntry.model || normalizedModelId,
                name: remoteCatalogEntry.displayName || remoteCatalogEntry.id || normalizedModelId,
                family,
                speed: storedModel?.speed || family || 'Remote',
                description: remoteCatalogEntry.description || storedModel?.description,
                billingMultiplier: remoteCatalogEntry.billingMultiplier ?? storedModel?.billingMultiplier,
                billingLabelOverride: remoteCatalogEntry.billingLabelOverride ?? storedModel?.billingLabelOverride,
                billingDescription: remoteCatalogEntry.billingDescription ?? storedModel?.billingDescription,
                languageModelsVendor: remoteCatalogEntry.languageModelsVendor ?? storedModel?.languageModelsVendor,
                languageModelsGroupName: remoteCatalogEntry.languageModelsGroupName ?? storedModel?.languageModelsGroupName,
                configurationSchema: remoteCatalogEntry.configurationSchema ?? storedModel?.configurationSchema,
                contextWindowTokens: remoteCatalogEntry.contextWindowTokens ?? storedModel?.contextWindowTokens,
                inputModalities: remoteCatalogEntry.inputModalities ?? storedModel?.inputModalities,
                maxInputImages: remoteCatalogEntry.maxInputImages ?? storedModel?.maxInputImages,
                enabled: storedModel?.enabled ?? true,
                isCustom: storedModel?.isCustom ?? false,
                baseUrl: storedModel?.baseUrl,
                apiKey: storedModel?.apiKey,
                apiKeyId: storedModel?.apiKeyId,
                providerContextManagementSupport: remoteCatalogEntry.providerContextManagementSupport ?? storedModel?.providerContextManagementSupport,
                supportsReasoningEfforts: remoteCatalogEntry.supportsReasoningEfforts?.length
                    ? [...remoteCatalogEntry.supportsReasoningEfforts]
                    : storedModel?.supportsReasoningEfforts,
                reasoningEffort: storedModel?.reasoningEffort,
            };
        }

        return storedModel ? { ...storedModel } : undefined;
    }

    buildModelTooltip(
        model: Partial<ModelConfigOption> | null | undefined,
        options?: {
            description?: string | null;
            maxContextTokens?: number | null;
        },
    ): string {
        if (!model) {
            return '';
        }

        if (model.isCustom) {
            return options?.description || model.description || '自定义模型';
        }

        const lines: string[] = [];
        const description = options?.description ?? model.description;
        if (description) {
            lines.push(description);
        }

        const canonicalModel = this.resolveCanonicalModelMetadata(model);
        const capabilityParts = this.getModelCapabilitySummaryParts({
            ...model,
            contextWindowTokens: typeof options?.maxContextTokens === 'number' && options.maxContextTokens > 0
                ? options.maxContextTokens
                : model.contextWindowTokens,
        });
        if (capabilityParts.length > 0) {
            lines.push(`能力: ${capabilityParts.join(' · ')}`);
        }

        const providerContextManagementDetail = this.getModelProviderContextManagementDetail(model);
        if (providerContextManagementDetail) {
            lines.push(providerContextManagementDetail);
        }

        const billingLabel = this.getModelBillingLabel(model);
        const billingDescription = model.billingDescription || canonicalModel?.billingDescription;
        if (billingDescription && billingDescription !== billingLabel) {
            lines.push(billingDescription);
        }

        return lines.join('\n');
    }

    private loadRemoteModelCatalog(reason = 'unspecified'): void {
        if (!this.isAuthReadyForRemoteModelCatalog()) {
            this.cancelRemoteModelCatalogRequest('auth-unavailable');
            this.setRemoteModelCatalogStatus('unavailable', '登录后可刷新远端模型目录；本地模型配置仍然可用。');
            console.info('[AilyChatConfigService] 登录态尚未就绪，延迟加载远端 model catalog', {
                url: ChatAPI.modelCatalog,
                reason,
            });
            return;
        }

        if (this.remoteModelCatalogRequestSubscription && !this.remoteModelCatalogRequestSubscription.closed) {
            console.info('[AilyChatConfigService] 复用正在进行的远端 model catalog 刷新', {
                reason,
            });
            return;
        }

        const requestRevision = ++this.remoteModelCatalogRequestRevision;
        this.setRemoteModelCatalogStatus('loading', '正在刷新远端模型目录；本地模型配置仍然可用。');
        console.info('[AilyChatConfigService] 请求远端 model catalog', {
            url: ChatAPI.modelCatalog,
            apiEndpoint: AilyHost.get().config.apiEndpoint,
            hostInitialized: AilyHost.isInitialized(),
            reason,
        });

        const requestSubscription = this.runOutsideAngular(() => this.http.get<RemoteModelCatalogResponse>(
            ChatAPI.modelCatalog,
            this.getRemoteModelCatalogRequestOptions(),
        ).pipe(
            timeout(this.remoteModelCatalogRequestTimeoutMs),
        ).subscribe({
            next: (response) => {
                if (requestRevision !== this.remoteModelCatalogRequestRevision) {
                    return;
                }
                const responseBody = response.body;
                const normalizedCatalog = this.normalizeRemoteModelCatalog(responseBody?.data);
                if (!normalizedCatalog) {
                    this.setRemoteModelCatalogStatus(
                        'unavailable',
                        `远端 model catalog 响应格式无效，继续使用上一次可用目录或本地内置模型预设。请检查 ${ChatAPI.modelCatalog}`,
                    );
                    console.warn('[AilyChatConfigService] 远端 model catalog 响应格式无效，保留当前可用模型目录', {
                        url: ChatAPI.modelCatalog,
                        status: response.status,
                        body: responseBody,
                    });
                    this.modelCatalogChangedSubject.next();
                    return;
                }

                const modelIds = Object.keys(normalizedCatalog.catalog.models);
                const presetIds = Object.keys(normalizedCatalog.catalog.modelPresets);
                console.info('[AilyChatConfigService] 远端 model catalog 响应成功', {
                    url: ChatAPI.modelCatalog,
                    status: response.status,
                    currentTier: normalizedCatalog.metadata.currentTier,
                    catalogVersion: normalizedCatalog.metadata.catalogVersion,
                    permissionsHash: normalizedCatalog.metadata.permissionsHash,
                    modelCount: modelIds.length,
                    presetCount: presetIds.length,
                });

                this.remoteModelCatalog = normalizedCatalog.catalog;
                this.remoteModelCatalogMetadata = normalizedCatalog.metadata;
                if (this.hasUsableRemoteModelCatalog(normalizedCatalog.catalog)) {
                    this.setRemoteModelCatalogStatus('ready', undefined);
                } else {
                    this.setRemoteModelCatalogStatus(
                        'unavailable',
                        `远端 model catalog 为空，暂时仅显示本地内置模型预设。请检查 ${ChatAPI.modelCatalog}`,
                    );
                    console.warn('[AilyChatConfigService] 远端 model catalog 为空，暂时仅显示本地内置模型预设', {
                        url: ChatAPI.modelCatalog,
                        status: response.status,
                        body: responseBody,
                    });
                }
                this.modelCatalogChangedSubject.next();
            },
            error: (error) => {
                if (requestRevision !== this.remoteModelCatalogRequestRevision) {
                    return;
                }
                this.remoteModelCatalogRequestSubscription = undefined;
                const isUnauthorized = error instanceof HttpErrorResponse
                    ? error.status === 401
                    : error?.status === 401;

                if (isUnauthorized) {
                    this.setRemoteModelCatalogStatus(
                        'unavailable',
                        '当前登录状态不能访问远端模型目录；本地模型配置仍然可用。',
                    );
                    console.info('[AilyChatConfigService] 远端 model catalog 返回 401，刷新已进入终态', {
                        url: ChatAPI.modelCatalog,
                        status: error?.status,
                        message: error?.message,
                        reason,
                    });
                    this.modelCatalogChangedSubject.next();
                    return;
                }

                this.setRemoteModelCatalogStatus(
                    'unavailable',
                    `暂时无法刷新远端 model catalog，将继续使用上一次可用目录或本地内置模型预设。请检查 ${ChatAPI.modelCatalog}。`,
                );
                console.warn('[AilyChatConfigService] 加载远端 model catalog 失败，保留当前可用模型目录', {
                    url: ChatAPI.modelCatalog,
                    status: error?.status,
                    message: error?.message,
                    error,
                });
                this.modelCatalogChangedSubject.next();
            },
            complete: () => {
                if (requestRevision === this.remoteModelCatalogRequestRevision) {
                    this.remoteModelCatalogRequestSubscription = undefined;
                }
            },
        }));
        this.remoteModelCatalogRequestSubscription = requestSubscription.closed
            ? undefined
            : requestSubscription;
    }

    private cancelRemoteModelCatalogRequest(reason: string): void {
        const requestSubscription = this.remoteModelCatalogRequestSubscription;
        if (!requestSubscription || requestSubscription.closed) {
            this.remoteModelCatalogRequestSubscription = undefined;
            return;
        }

        this.remoteModelCatalogRequestRevision += 1;
        this.remoteModelCatalogRequestSubscription = undefined;
        requestSubscription.unsubscribe();
        console.info('[AilyChatConfigService] 已取消远端 model catalog 请求', { reason });
    }

    private runOutsideAngular<T>(operation: () => T): T {
        return this.ngZone ? this.ngZone.runOutsideAngular(operation) : operation();
    }

    private setRemoteModelCatalogStatus(
        status: 'loading' | 'ready' | 'unavailable',
        hint: string | undefined,
    ): void {
        this.remoteModelCatalogStatus = status;
        this.remoteModelCatalogStatusHint = hint;
    }

    private isAuthReadyForRemoteModelCatalog(): boolean {
        if (!this.authService) {
            return true;
        }

        if (this.authService.authChanged$ || this.authService.authSnapshot$) {
            return !!this.authService.getAuthSnapshot();
        }

        return this.authService.isLoggedIn;
    }

    private hasUsableRemoteModelCatalog(catalog: RemoteModelCatalog = this.remoteModelCatalog): boolean {
        return Object.keys(catalog.models).length > 0
            || Object.keys(catalog.modelPresets).length > 0
            || Object.keys(catalog.userVisibleModelPresets).length > 0
            || Object.keys(catalog.pickerControlModelPresets).length > 0;
    }

    private getRemoteModelCatalogRequestOptions(): { observe: 'response'; headers?: Record<string, string> } {
        const normalizedClientVersion = typeof this.clientVersion === 'string' ? this.clientVersion.trim() : '';
        if (!normalizedClientVersion) {
            return { observe: 'response' };
        }

        return {
            observe: 'response',
            headers: {
                'X-Aily-Client-Version': normalizedClientVersion,
            },
        };
    }

    private buildRemotePresetOption(
        presetId: string,
        remotePreset: RemoteModelCatalogEntry,
    ): ModelPresetOption {
        const fallbackPreset = CORE_MODEL_PRESET_OPTIONS.find(preset => preset.id === presetId);
        const isDefaultAutoPreset = presetId === DEFAULT_MODEL_PRESET_ID;
        return {
            id: presetId,
            name: remotePreset.displayName || fallbackPreset?.name || presetId,
            model: remotePreset.model || fallbackPreset?.model,
            family: remotePreset.family || fallbackPreset?.family,
            description: remotePreset.description || fallbackPreset?.description,
            billingMultiplier: remotePreset.billingMultiplier ?? fallbackPreset?.billingMultiplier,
            billingLabelOverride: remotePreset.billingLabelOverride ?? fallbackPreset?.billingLabelOverride,
            billingDescription: remotePreset.billingDescription ?? fallbackPreset?.billingDescription,
            contextWindowTokens: remotePreset.contextWindowTokens ?? fallbackPreset?.contextWindowTokens,
            inputModalities: remotePreset.inputModalities?.length
                ? [...remotePreset.inputModalities]
                : fallbackPreset?.inputModalities,
            maxInputImages: remotePreset.maxInputImages ?? fallbackPreset?.maxInputImages,
            supportsReasoningEfforts: remotePreset.supportsReasoningEfforts?.length
                ? [...remotePreset.supportsReasoningEfforts]
                : fallbackPreset?.supportsReasoningEfforts,
            availableTiers: Array.isArray(remotePreset.availableTiers) ? [...remotePreset.availableTiers] : undefined,
            requiredTier: remotePreset.requiredTier,
            minimumClientVersion: remotePreset.minimumClientVersion,
            unavailableReason: remotePreset.unavailableReason,
            providerContextManagementSupport: remotePreset.providerContextManagementSupport,
            enabled: isDefaultAutoPreset
                ? true
                : typeof remotePreset.isUserSelectable === 'boolean'
                ? remotePreset.isUserSelectable
                : (fallbackPreset?.enabled ?? true),
        };
    }

    private normalizeRemoteModelCatalog(
        payload: RemoteModelCatalogResponse['data'] | null | undefined,
    ): { catalog: RemoteModelCatalog; metadata: RemoteModelCatalogMetadata } | null {
        if (!payload || typeof payload !== 'object') {
            return null;
        }

        return {
            catalog: {
                models: this.normalizeRemoteCatalogEntries(payload.models),
                modelPresets: this.normalizeRemotePresetEntries(payload.model_presets),
                userVisibleModelPresets: this.normalizeRemotePresetEntries(payload.user_visible_model_presets),
                pickerControlModelPresets: this.normalizeRemotePickerControlEntries(payload.picker_control_model_presets),
            },
            metadata: {
                currentTier: typeof payload.current_tier === 'string' && payload.current_tier.trim()
                    ? payload.current_tier.trim()
                    : undefined,
                catalogVersion: typeof payload.catalog_version === 'string' && payload.catalog_version.trim()
                    ? payload.catalog_version.trim()
                    : undefined,
                permissionsHash: typeof payload.permissions_hash === 'string' && payload.permissions_hash.trim()
                    ? payload.permissions_hash.trim()
                    : undefined,
                multimodalContractVersion: typeof payload.multimodal_contract_version === 'string'
                    && payload.multimodal_contract_version.trim()
                    ? payload.multimodal_contract_version.trim()
                    : undefined,
            },
        };
    }

    private resolveUserVisiblePresetIds(): string[] {
        const explicitPresetIds = this.getExplicitUserVisiblePresetIds();
        if (explicitPresetIds.length > 0) {
            const visiblePresetIds = new Set([DEFAULT_MODEL_PRESET_ID, ...explicitPresetIds]);
            return USER_SELECTABLE_MODEL_PRESET_IDS.filter(presetId => visiblePresetIds.has(presetId));
        }

        const fallbackRemotePresetIds = Object.entries(this.remoteModelCatalog.modelPresets)
            .filter(([, entry]) => entry.userVisible)
            .map(([presetId]) => presetId);
        if (fallbackRemotePresetIds.length > 0) {
            const visiblePresetIds = new Set([DEFAULT_MODEL_PRESET_ID, ...fallbackRemotePresetIds]);
            return USER_SELECTABLE_MODEL_PRESET_IDS.filter(presetId => visiblePresetIds.has(presetId));
        }

        if (this.remoteModelCatalogStatus === 'ready') {
            return [];
        }

        return CORE_MODEL_PRESET_OPTIONS
            .filter(preset => preset.enabled)
            .map(preset => preset.id);
    }

    private getExplicitUserVisiblePresetIds(): string[] {
        const explicitPresetIds = Object.keys(this.remoteModelCatalog.userVisibleModelPresets);
        if (explicitPresetIds.length > 0) {
            return explicitPresetIds;
        }

        return [];
    }

    private getRemoteModelPresetOptions(): ModelPresetOption[] {
        const mergedRemotePresetEntries = this.getMergedRemoteModelPresetEntries();
        if (Object.keys(mergedRemotePresetEntries).length === 0) {
            return [];
        }

        return Object.entries(mergedRemotePresetEntries)
            .filter(([presetId]) => !this.remoteModelCatalog.models[presetId])
            .map(([presetId, remotePreset]) => this.buildRemotePresetOption(presetId, remotePreset));
    }

    private getMergedRemoteModelPresetEntries(): Record<string, RemoteModelCatalogEntry> {
        const mergedPresetEntries: Record<string, RemoteModelCatalogEntry> = {
            ...this.remoteModelCatalog.modelPresets,
        };

        for (const [presetId, entry] of Object.entries(this.remoteModelCatalog.userVisibleModelPresets)) {
            const existingEntry = mergedPresetEntries[presetId];
            mergedPresetEntries[presetId] = existingEntry
                ? { ...existingEntry, ...entry }
                : { ...entry };
        }

        return mergedPresetEntries;
    }

    private normalizeRemotePresetEntries(
        entries: Record<string, RemoteCatalogPayloadEntry> | null | undefined,
    ): Record<string, RemoteModelCatalogEntry> {
        if (!entries || typeof entries !== 'object') {
            return {};
        }

        return Object.entries(entries).reduce<Record<string, RemoteModelCatalogEntry>>((acc, [rawId, entry]) => {
            if (!entry || typeof entry !== 'object') {
                return acc;
            }

            const normalizedId = normalizeCatalogPresetId(rawId) || rawId;
            const normalizedCanonicalId = normalizeCatalogPresetId(entry.canonical_id)
                || normalizeCatalogPresetId(entry.id)
                || normalizedId;
            const normalizedAliases = Array.isArray(entry.aliases)
                ? [...new Set(entry.aliases
                    .map(alias => normalizeCatalogPresetId(alias) || (typeof alias === 'string' ? alias.trim() : ''))
                    .filter((alias): alias is string => typeof alias === 'string' && alias.length > 0))]
                : undefined;
            acc[normalizedId] = {
                id: normalizedCanonicalId,
                canonicalId: normalizedCanonicalId,
                aliases: normalizedAliases,
                model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined,
                displayName: typeof entry.display_name === 'string' && entry.display_name.trim()
                    ? entry.display_name.trim()
                    : undefined,
                family: typeof entry.family === 'string' && entry.family.trim() ? entry.family.trim() : undefined,
                description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined,
                contextWindowTokens: typeof entry.context_window_tokens === 'number' && entry.context_window_tokens > 0
                    ? entry.context_window_tokens
                    : undefined,
                inputModalities: normalizeInputModalities(entry.input_modalities),
                maxInputImages: normalizeMaxInputImages(entry.max_input_images),
                supportsReasoningEfforts: normalizeReasoningEfforts(entry.supports_reasoning_effort),
                billingMultiplier: typeof entry.billing_multiplier === 'number' && Number.isFinite(entry.billing_multiplier)
                    ? entry.billing_multiplier
                    : undefined,
                billingLabelOverride: typeof entry.billing_label_override === 'string' && entry.billing_label_override.trim()
                    ? entry.billing_label_override.trim()
                    : undefined,
                billingDescription: typeof entry.billing_description === 'string' && entry.billing_description.trim()
                    ? entry.billing_description.trim()
                    : undefined,
                languageModelsVendor: typeof entry.language_models_vendor === 'string' && entry.language_models_vendor.trim()
                    ? entry.language_models_vendor.trim()
                    : undefined,
                languageModelsGroupName: typeof entry.language_models_group_name === 'string' && entry.language_models_group_name.trim()
                    ? entry.language_models_group_name.trim()
                    : undefined,
                configurationSchema: this.normalizeLanguageModelConfigurationSchema(entry.configuration_schema),
                userVisible: typeof entry.user_visible === 'boolean' ? entry.user_visible : undefined,
                isUserSelectable: typeof entry.is_user_selectable === 'boolean' ? entry.is_user_selectable : undefined,
                availableTiers: Array.isArray(entry.available_tiers)
                    ? entry.available_tiers.filter((tier): tier is string => typeof tier === 'string' && tier.trim().length > 0)
                    : undefined,
                requiredTier: typeof entry.required_tier === 'string' && entry.required_tier.trim()
                    ? entry.required_tier.trim()
                    : undefined,
                minimumClientVersion: typeof entry.minimum_client_version === 'string' && entry.minimum_client_version.trim()
                    ? entry.minimum_client_version.trim()
                    : undefined,
                unavailableReason: entry.unavailable_reason === 'upgrade'
                    || entry.unavailable_reason === 'admin'
                    || entry.unavailable_reason === 'update'
                    ? entry.unavailable_reason
                    : undefined,
                providerContextManagementSupport: this.normalizeProviderContextManagementSupport(entry.provider_context_management_support),
                modelPickerCategory: this.normalizeModelPickerCategory(entry.model_picker_category),
            };
            return acc;
        }, {});
    }

    private normalizeRemotePickerControlEntries(
        entries: Record<string, RemotePickerControlPayloadEntry> | null | undefined,
    ): Record<string, ModelPickerControlOption> {
        if (!entries || typeof entries !== 'object') {
            return {};
        }

        return Object.entries(entries).reduce<Record<string, ModelPickerControlOption>>((acc, [rawId, entry]) => {
            if (!entry || typeof entry !== 'object') {
                return acc;
            }

            const normalizedId = normalizeCatalogPresetId(rawId) || rawId;
            const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : normalizedId;
            acc[normalizedId] = {
                label,
                featured: typeof entry.featured === 'boolean' ? entry.featured : undefined,
                minClientVersion: typeof entry.min_client_version === 'string' && entry.min_client_version.trim()
                    ? entry.min_client_version.trim()
                    : undefined,
                exists: typeof entry.exists === 'boolean' ? entry.exists : false,
                presetSurface: typeof entry.preset_surface === 'string' && entry.preset_surface.trim()
                    ? entry.preset_surface.trim()
                    : undefined,
            };
            return acc;
        }, {});
    }

    private normalizeRemoteCatalogEntries(
        entries: Record<string, RemoteCatalogPayloadEntry> | null | undefined,
    ): Record<string, RemoteModelCatalogEntry> {
        if (!entries || typeof entries !== 'object') {
            return {};
        }

        return Object.entries(entries).reduce<Record<string, RemoteModelCatalogEntry>>((acc, [id, entry]) => {
            if (!entry || typeof entry !== 'object') {
                return acc;
            }

            acc[id] = {
                id: typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : id,
                model: typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : undefined,
                displayName: typeof entry.display_name === 'string' && entry.display_name.trim()
                    ? entry.display_name.trim()
                    : undefined,
                family: typeof entry.family === 'string' && entry.family.trim() ? entry.family.trim() : undefined,
                description: typeof entry.description === 'string' && entry.description.trim() ? entry.description.trim() : undefined,
                contextWindowTokens: typeof entry.context_window_tokens === 'number' && entry.context_window_tokens > 0
                    ? entry.context_window_tokens
                    : undefined,
                inputModalities: normalizeInputModalities(entry.input_modalities),
                maxInputImages: normalizeMaxInputImages(entry.max_input_images),
                supportsReasoningEfforts: normalizeReasoningEfforts(entry.supports_reasoning_effort),
                billingMultiplier: typeof entry.billing_multiplier === 'number' && Number.isFinite(entry.billing_multiplier)
                    ? entry.billing_multiplier
                    : undefined,
                billingLabelOverride: typeof entry.billing_label_override === 'string' && entry.billing_label_override.trim()
                    ? entry.billing_label_override.trim()
                    : undefined,
                billingDescription: typeof entry.billing_description === 'string' && entry.billing_description.trim()
                    ? entry.billing_description.trim()
                    : undefined,
                languageModelsVendor: typeof entry.language_models_vendor === 'string' && entry.language_models_vendor.trim()
                    ? entry.language_models_vendor.trim()
                    : undefined,
                languageModelsGroupName: typeof entry.language_models_group_name === 'string' && entry.language_models_group_name.trim()
                    ? entry.language_models_group_name.trim()
                    : undefined,
                configurationSchema: this.normalizeLanguageModelConfigurationSchema(entry.configuration_schema),
                providerContextManagementSupport: this.normalizeProviderContextManagementSupport(entry.provider_context_management_support),
                modelPickerCategory: this.normalizeModelPickerCategory(entry.model_picker_category),
            };
            return acc;
        }, {});
    }

    private normalizeProviderContextManagementSupport(
        value: RemoteProviderContextManagementSupportPayload | null | undefined,
    ): ProviderContextManagementSupport | undefined {
        if (!value || typeof value !== 'object' || typeof value.kind !== 'string' || !value.kind.trim()) {
            return undefined;
        }

        const kind = value.kind.trim();
        if (kind === 'responses') {
            const compactThresholdRatio = typeof value.compact_threshold_ratio === 'number'
                && Number.isFinite(value.compact_threshold_ratio)
                && value.compact_threshold_ratio > 0
                && value.compact_threshold_ratio <= 1
                ? value.compact_threshold_ratio
                : undefined;
            return compactThresholdRatio !== undefined
                ? { kind: 'responses', compactThresholdRatio }
                : { kind: 'responses' };
        }

        if (kind === 'anthropic') {
            const mode = value.mode === 'clear-thinking' || value.mode === 'clear-tools' || value.mode === 'clear-both'
                ? value.mode
                : undefined;
            const keepThinkingTurns = typeof value.keep_thinking_turns === 'number'
                && Number.isFinite(value.keep_thinking_turns)
                && value.keep_thinking_turns >= 0
                ? value.keep_thinking_turns
                : undefined;
            const keepToolUses = typeof value.keep_tool_uses === 'number'
                && Number.isFinite(value.keep_tool_uses)
                && value.keep_tool_uses >= 0
                ? value.keep_tool_uses
                : undefined;
            const toolUseTriggerInputTokens = typeof value.tool_use_trigger_input_tokens === 'number'
                && Number.isFinite(value.tool_use_trigger_input_tokens)
                && value.tool_use_trigger_input_tokens >= 0
                ? value.tool_use_trigger_input_tokens
                : undefined;
            const excludeTools = Array.isArray(value.exclude_tools)
                ? value.exclude_tools.filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0)
                : undefined;

            return {
                kind: 'anthropic',
                ...(mode ? { mode } : {}),
                ...(typeof value.thinking_enabled === 'boolean' ? { thinkingEnabled: value.thinking_enabled } : {}),
                ...(keepThinkingTurns !== undefined ? { keepThinkingTurns } : {}),
                ...(keepToolUses !== undefined ? { keepToolUses } : {}),
                ...(toolUseTriggerInputTokens !== undefined ? { toolUseTriggerInputTokens } : {}),
                ...(typeof value.clear_tool_inputs === 'boolean' ? { clearToolInputs: value.clear_tool_inputs } : {}),
                ...(excludeTools && excludeTools.length > 0 ? { excludeTools } : {}),
            };
        }

        return { kind };
    }

    private normalizeLanguageModelConfigurationSchema(
        schema: RemoteCatalogPayloadEntry['configuration_schema'],
    ): LanguageModelConfigurationSchema | undefined {
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
            return undefined;
        }

        return JSON.parse(JSON.stringify(schema)) as LanguageModelConfigurationSchema;
    }

    private normalizeModelPickerCategory(
        category: RemoteCatalogPayloadEntry['model_picker_category'],
    ): ModelPickerCategoryOption | undefined {
        if (!category || typeof category !== 'object') {
            return undefined;
        }

        const label = typeof category.label === 'string' && category.label.trim() ? category.label.trim() : '';
        if (!label) {
            return undefined;
        }

        return {
            label,
            order: typeof category.order === 'number' && Number.isFinite(category.order) ? category.order : 0,
        };
    }

    private normalizeRequestLimitConfig(): void {
        const normalized = this.config.maxRequests ?? this.config.maxCount;
        if (normalized === undefined) {
            return;
        }
        this.config.maxRequests = normalized;
        this.config.maxCount = normalized;
    }

    private buildRuntimeModels(): ModelConfigOption[] {
        const storedModels = this.getStoredModelEntries();
        const storedCustomModels = storedModels.filter(model => model.isCustom);

        if (!this.hasUsableRemoteModelCatalog()) {
            return storedCustomModels.map(model => this.normalizeRuntimeModel(model));
        }

        const storedBuiltinModels = storedModels.filter(model => !model.isCustom);
        const remoteBuiltinModels = this.buildRemoteBuiltinModels(storedBuiltinModels);

        if (remoteBuiltinModels.length === 0) {
            return storedCustomModels.map(model => this.normalizeRuntimeModel(model));
        }

        const remoteBuiltinIds = new Set(remoteBuiltinModels.map(model => model.model));
        const legacyBuiltinModels = storedBuiltinModels.filter(model => !remoteBuiltinIds.has(model.model));

        return [...remoteBuiltinModels, ...legacyBuiltinModels, ...storedCustomModels]
            .map(model => this.normalizeRuntimeModel(model));
    }

    private buildRemoteBuiltinModels(overrides: ModelConfigOption[]): ModelConfigOption[] {
        const overridesById = new Map(overrides.map(model => [model.model, model]));

        return Object.entries(this.remoteModelCatalog.models).map(([modelId, remoteModel]) => {
            const resolvedModelId = remoteModel.model || modelId;
            const override = overridesById.get(resolvedModelId);
            const family = remoteModel.family || override?.family || '';

            return {
                model: resolvedModelId,
                name: remoteModel.displayName || remoteModel.id || resolvedModelId,
                family,
                speed: override?.speed || family || 'Remote',
                description: remoteModel.description || override?.description,
                billingMultiplier: remoteModel.billingMultiplier ?? override?.billingMultiplier,
                billingLabelOverride: remoteModel.billingLabelOverride ?? override?.billingLabelOverride,
                billingDescription: remoteModel.billingDescription ?? override?.billingDescription,
                languageModelsVendor: remoteModel.languageModelsVendor ?? override?.languageModelsVendor,
                languageModelsGroupName: remoteModel.languageModelsGroupName ?? override?.languageModelsGroupName,
                configurationSchema: remoteModel.configurationSchema ?? override?.configurationSchema,
                contextWindowTokens: remoteModel.contextWindowTokens ?? override?.contextWindowTokens,
                inputModalities: remoteModel.inputModalities ?? override?.inputModalities,
                maxInputImages: remoteModel.maxInputImages ?? override?.maxInputImages,
                enabled: override?.enabled ?? true,
                isCustom: false,
                providerContextManagementSupport: remoteModel.providerContextManagementSupport ?? override?.providerContextManagementSupport,
                supportsReasoningEfforts: remoteModel.supportsReasoningEfforts?.length
                    ? [...remoteModel.supportsReasoningEfforts]
                    : override?.supportsReasoningEfforts,
                reasoningEffort: this.resolveModelReasoningEffort({
                    family,
                    supportsReasoningEfforts: remoteModel.supportsReasoningEfforts?.length
                        ? [...remoteModel.supportsReasoningEfforts]
                        : override?.supportsReasoningEfforts,
                }, override?.reasoningEffort),
            } satisfies ModelConfigOption;
        });
    }

    private buildPersistedModels(models: ModelConfigOption[] | null | undefined): ModelConfigOption[] {
        const runtimeModels = Array.isArray(models) ? models : [];
        const persistedBuiltinModels = runtimeModels
            .filter(model => !model.isCustom)
            .map(model => sanitizePersistedBuiltinModel(model));
        const persistedCustomModels = runtimeModels
            .filter(model => model.isCustom)
            .map(model => ({ ...model }));

        return [...persistedBuiltinModels, ...persistedCustomModels];
    }

    private getStoredModelEntries(): ModelConfigOption[] {
        return mergeModelsWithDefaults(this.config.models);
    }

    /**
     * 添加自定义模型
     */
    addCustomModel(model: Omit<ModelConfigOption, 'isCustom'>): void {
        const newModel: ModelConfigOption = {
            ...model,
            isCustom: true
        };
        this.models = [...this.models.filter(item => item.model !== newModel.model), newModel];
    }

    /**
     * 删除模型（只能删除自定义模型）
     */
    removeModel(modelId: string): boolean {
        const nextModels = this.models.filter(model => !(model.model === modelId && model.isCustom));
        if (nextModels.length !== this.models.length) {
            this.models = nextModels;
            return true;
        }
        return false;
    }

    /**
     * 更新模型启用状态
     */
    updateModelEnabled(modelId: string, enabled: boolean): void {
        const nextModels = this.models.map(model => model.model === modelId ? { ...model, enabled } : model);
        if (nextModels.some(model => model.model === modelId)) {
            this.models = nextModels;
        }
    }

    /**
     * 重置模型列表到默认值
     */
    resetModels(): void {
        this.config.models = [...DEFAULT_MODELS];
    }

    // ==================== API密钥管理方法 ====================

    /**
     * 获取API密钥配置列表
     */
    get apiKeys(): ApiKeyConfig[] {
        if (!this.config.apiKeys) {
            this.config.apiKeys = [...DEFAULT_API_KEYS];
        }
        return this.config.apiKeys;
    }

    set apiKeys(value: ApiKeyConfig[]) {
        this.config.apiKeys = value;
    }

    /**
     * 获取已启用的API密钥列表
     */
    getEnabledApiKeys(): ApiKeyConfig[] {
        return this.apiKeys.filter(k => k.enabled);
    }

    /**
     * 添加API密钥配置
     */
    addApiKey(apiKey: Omit<ApiKeyConfig, 'id' | 'enabled'>): ApiKeyConfig {
        const newApiKey: ApiKeyConfig = {
            ...apiKey,
            id: this.generateUniqueId(),
            enabled: true
        };
        this.apiKeys.push(newApiKey);
        return newApiKey;
    }

    /**
     * 删除API密钥配置
     * 注意：如果该API密钥有关联的模型，需要先处理关联关系
     */
    removeApiKey(apiKeyId: string): boolean {
        // 检查是否有模型关联此API密钥
        const associatedModels = this.models.filter(m => m.apiKeyId === apiKeyId);
        if (associatedModels.length > 0) {
            // 可以选择：1) 删除关联模型 2) 清空模型的API密钥关联
            // 这里选择清空关联
            associatedModels.forEach(m => {
                m.apiKeyId = undefined;
            });
        }

        const index = this.apiKeys.findIndex(k => k.id === apiKeyId);
        if (index !== -1) {
            this.apiKeys.splice(index, 1);
            return true;
        }
        return false;
    }

    /**
     * 更新API密钥配置
     */
    updateApiKey(apiKeyId: string, updates: Partial<Omit<ApiKeyConfig, 'id'>>): boolean {
        const apiKey = this.apiKeys.find(k => k.id === apiKeyId);
        if (apiKey) {
            Object.assign(apiKey, updates);
            return true;
        }
        return false;
    }

    /**
     * 切换API密钥启用状态
     */
    toggleApiKeyEnabled(apiKeyId: string): void {
        const apiKey = this.apiKeys.find(k => k.id === apiKeyId);
        if (apiKey) {
            apiKey.enabled = !apiKey.enabled;
        }
    }

    /**
     * 获取API密钥的显示名称
     */
    getApiKeyName(apiKeyId: string): string {
        const apiKey = this.apiKeys.find(k => k.id === apiKeyId);
        return apiKey ? apiKey.name : '未配置';
    }

    /**
     * 检查API密钥是否有效
     */
    isApiKeyValid(apiKeyId: string): boolean {
        const apiKey = this.apiKeys.find(k => k.id === apiKeyId);
        return !!apiKey && apiKey.enabled && !!apiKey.baseUrl && !!apiKey.apiKey;
    }

    /**
     * 为模型分配API密钥
     */
    assignApiKeyToModel(modelId: string, apiKeyId: string | null): boolean {
        const model = this.models.find(m => m.model === modelId);
        if (model) {
            model.apiKeyId = apiKeyId || undefined;
            return true;
        }
        return false;
    }

    /**
     * 生成唯一ID
     */
    private generateUniqueId(): string {
        return 'api_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /**
     * 从旧版本配置迁移
     */
    migrateFromOldConfig(): void {
        this.normalizeRequestLimitConfig();

        // 如果有旧的全局API配置且没有API列表，创建一个API配置
        if ((this.config.baseUrl || this.config.apiKey) && (!this.config.apiKeys || this.config.apiKeys.length === 0)) {
            if (this.config.baseUrl && this.config.apiKey) {
                this.addApiKey({
                    name: '默认配置',
                    baseUrl: this.config.baseUrl,
                    apiKey: this.config.apiKey
                });
            }
        }

        // 迁移旧版本的 apiKeyId 关联到新的直接配置
        if (this.config.models && this.config.apiKeys) {
            this.config.models.forEach(model => {
                if (model.apiKeyId && !model.baseUrl && !model.apiKey) {
                    const apiKey = this.config.apiKeys?.find(k => k.id === model.apiKeyId);
                    if (apiKey) {
                        model.baseUrl = apiKey.baseUrl;
                        model.apiKey = apiKey.apiKey;
                    }
                }

                if (!Array.isArray(model.supportsReasoningEfforts) || model.supportsReasoningEfforts.length === 0) {
                    const supported = this.getSupportedReasoningEfforts(model);
                    if (supported.length > 0) {
                        model.supportsReasoningEfforts = supported;
                    }
                }
            });
        }

        if (this.config.agentTools) {
            const normalizedAgentTools: Record<string, AgentToolsConfig> = {};
            for (const [agentName, agentConfig] of Object.entries(this.config.agentTools)) {
                if (!agentConfig) {
                    continue;
                }
                const canonicalAgentName = normalizeAgentIdentifier(agentName);
                if (!canonicalAgentName) {
                    continue;
                }
                normalizedAgentTools[canonicalAgentName] = {
                    enabledTools: normalizeConfiguredToolNames(agentConfig.enabledTools),
                    disabledTools: normalizeConfiguredToolNames(agentConfig.disabledTools),
                };
            }
            this.config.agentTools = normalizedAgentTools;
        }

        this.config.enabledTools = normalizeConfiguredToolNames(this.config.enabledTools);
        this.config.disabledTools = normalizeConfiguredToolNames(this.config.disabledTools);
        this.config.userSkillFolders = normalizeSkillFolderPaths(this.config.userSkillFolders);
        this.config.projectSkillFolders = normalizeSkillFolderPaths(this.config.projectSkillFolders);
        this.config.hiddenCustomAgentTargets = normalizeCustomAgentTargets(this.config.hiddenCustomAgentTargets);
    }
}

function normalizeApprovalStateKey(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeConfiguredToolNames(value: readonly string[] | undefined): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return [...new Set(value.flatMap((item) => {
        const normalizedToolName = normalizeGovernanceToolName(item);
        return normalizedToolName ? [normalizedToolName] : [];
    }))];
}

function normalizeCatalogPresetId(value: string | null | undefined): string | undefined {
    const normalizedValue = typeof value === 'string' ? value.trim() : '';
    switch (normalizedValue) {
        case 'auto':
            return 'auto';
        case 'high':
            return 'auto-max';
        case 'medium':
        case 'auto-balanced':
        case 'auto-balance':
            return 'auto';
        case 'low':
            return 'auto-fast';
        default:
            return normalizedValue || undefined;
    }
}

function normalizeUserPresetId(value: string | null | undefined): string | undefined {
    const normalizedPresetId = normalizeCatalogPresetId(value);
    return normalizedPresetId === 'auto-vision' ? DEFAULT_MODEL_PRESET_ID : normalizedPresetId;
}

function resolveSavedPresetId(
    savedModel: Partial<ModelConfigOption>,
    presets: readonly ModelPresetOption[],
): string | undefined {
    if (savedModel.presetId) {
        return normalizeUserPresetId(savedModel.presetId);
    }

    const normalizedModelPresetId = normalizeUserPresetId(savedModel.model);
    const directPreset = normalizedModelPresetId
        ? presets.find(preset => preset.id === normalizedModelPresetId)?.id
        : undefined;
    if (directPreset) {
        return directPreset;
    }

    return normalizeUserPresetId(savedModel.model);
}

function normalizeReasoningEfforts(value: string[] | null | undefined): ReasoningEffortOption[] | undefined {
    if (!Array.isArray(value) || value.length === 0) {
        return undefined;
    }

    const allowed = new Set<ReasoningEffortOption>(['low', 'medium', 'high', 'xhigh']);
    const normalized = value
        .map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
        .filter((item): item is ReasoningEffortOption => allowed.has(item as ReasoningEffortOption));

    if (normalized.length === 0) {
        return undefined;
    }

    return [...new Set(normalized)];
}

function normalizeInputModalities(value: unknown): ('text' | 'image')[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const allowed = new Set<'text' | 'image'>(['text', 'image']);
    const normalized = value
        .map(item => typeof item === 'string' ? item.trim().toLowerCase() : '')
        .filter((item): item is 'text' | 'image' => allowed.has(item as 'text' | 'image'));
    return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function normalizeMaxInputImages(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : undefined;
}

function mergeModelsWithDefaults(models: ModelConfigOption[] | null | undefined): ModelConfigOption[] {
    const savedModels = Array.isArray(models) ? models : [];
    const defaultsById = new Map(DEFAULT_MODELS.map(model => [model.model, model]));
    const mergedDefaults = DEFAULT_MODELS.map(model => ({
        ...model,
        ...(savedModels.find(savedModel => savedModel.model === model.model) || {}),
    }));

    const extraModels = savedModels.filter(model => !defaultsById.has(model.model));
    return [...mergedDefaults, ...extraModels];
}

function sanitizePersistedBuiltinModel(model: ModelConfigOption): ModelConfigOption {
    return {
        model: model.model,
        name: model.model,
        family: model.family,
        speed: model.speed,
        enabled: model.enabled,
        isCustom: false,
        reasoningEffort: model.reasoningEffort,
    };
}

function normalizeInstructionFolderPaths(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function normalizeAgentFolderPaths(value: string[] | undefined): string[] {
    return normalizeInstructionFolderPaths(value);
}

function normalizeSkillFolderPaths(value: string[] | undefined): string[] {
    return normalizeInstructionFolderPaths(value);
}

function normalizeCustomAgentTargets(value: readonly string[] | undefined): string[] {
    return normalizeAgentIdentifiers(Array.isArray(value) ? [...value] : undefined);
}

function normalizeTerminalPermissionRules(value: string[] | undefined): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function normalizeProjectPermissionScope(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.replace(/\\/g, '/').replace(/\/+$|\/+$/g, '').trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}

function normalizePermissionRuleInputs(value: PermissionRuleInput[] | undefined): PermissionRuleInput[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((item) => {
        if (!item || typeof item !== 'object' || typeof item.mode !== 'string') {
            return [];
        }

        const normalizedMode = item.mode;
        if (!['default', 'plan', 'acceptEdits', 'bypassPermissions'].includes(normalizedMode)) {
            return [];
        }

        const normalizedToolName = normalizeGovernanceToolName(item.toolName);
        const normalizedToolSource = typeof item.toolSource === 'string' ? item.toolSource.trim() : undefined;
        const normalizedSource = typeof item.source === 'string' ? item.source : undefined;

        return [{
            mode: normalizedMode,
            ...(normalizedToolName ? { toolName: normalizedToolName } : {}),
            ...(normalizedToolSource ? { toolSource: normalizedToolSource } : {}),
            ...(normalizedSource ? { source: normalizedSource } : {}),
        } satisfies PermissionRuleInput];
    });
}

function normalizeWorkspacePermissionRulesByProject(
    value: WorkspacePermissionRulesByProject | undefined,
): WorkspacePermissionRulesByProject {
    if (!value || typeof value !== 'object') {
        return {};
    }

    const normalizedEntries = Object.entries(value).flatMap(([projectPath, rules]) => {
        const normalizedProjectPath = normalizeProjectPermissionScope(projectPath);
        const normalizedRules = normalizePermissionRuleInputs(rules);
        if (!normalizedProjectPath || normalizedRules.length === 0) {
            return [];
        }
        return [[normalizedProjectPath, normalizedRules] as const];
    });

    return Object.fromEntries(normalizedEntries);
}
