import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { ElectronService } from './electron.service';
import { ProjectService } from './project.service';
import { NoticeOptions } from './notice.service';

// =====================================================
// 数据类型定义（与 connection-graph 子页面共享）
// =====================================================

/** 组件图片 */
export interface ComponentImage {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 引脚功能 */
export interface PinFunction {
  name: string;
  type: string;
  visible?: boolean;
  disabled?: boolean;
}

/** 组件配置中的引脚 */
export interface ConfigPin {
  id: string;
  x: number;
  y: number;
  labelX?: number;
  labelY?: number;
  layout: 'horizontal' | 'vertical';
  functions: PinFunction[];
  labelAnchor?: 'left' | 'right';
  visible?: boolean;
  disabled?: boolean;
}

/** 功能类型定义（颜色映射） */
export interface FunctionTypeDef {
  value: string;
  label: string;
  color: string;
  textColor: string;
}

/** 同库下的类似组件（来自 pinmap_catalog.json） */
export interface SimilarComponent {
  fullId: string;
  modelId: string;
  variantId: string;
  name: string;
  modelName?: string;
  pinmapFile?: string;
  /** 对应 pinmapFile 的完整配置内容 */
  data?: ComponentConfig;
}

/** 组件完整配置（来自 *_config.json 或 pinmaps/xxx.json） */
export interface ComponentConfig {
  id: string;
  name: string;
  width: number;
  height: number;
  images: ComponentImage[];
  pins: ConfigPin[];
  functionTypes: FunctionTypeDef[];
  /** 同库下的类似组件列表（来自 pinmap_catalog.json，仅 pinmapId 加载时有） */
  similarComponents?: SimilarComponent[];
}

/** 连线端点 */
export interface ConnectionEndpoint {
  ref: string;
  pinId: string;
  function: string;
}

/** 连线定义 */
export interface ConnectionDef {
  id: string;
  from: ConnectionEndpoint;
  to: ConnectionEndpoint;
  type: string;
  half?: boolean;
  label: string;
  color: string;
  note?: string;
}

/** connection_output.json 中的组件引用 */
/** 组件类型：hardware=硬件组件（有引脚）, software=软件组件（如WiFi/MQTT，无引脚） */
export type ComponentType = 'hardware' | 'software';

/** 软件组件配置（用于 WiFi/MQTT/HTTP 等云端通信库） */
export interface SoftwareComponentConfig {
  /** 软件库类型 */
  libraryType: 'wifi' | 'mqtt' | 'http' | 'tcp' | 'bluetooth' | 'other';
  /** 显示图标（Material Icons 名称或 URL） */
  icon?: string;
  /** 配置属性（动态键值对，如 MQTT 的 broker、topic 等） */
  properties?: Record<string, string | number | boolean>;
  /** 属性显示标签映射 */
  propertyLabels?: Record<string, string>;
}

export interface ConnectionComponent {
  refId: string;
  componentId: string;
  componentName: string;
  configFile?: string;
  /** 新版：pinmap 完整标识符 (如 "lib-dht:dht20:asair") */
  pinmapId?: string;
  /** 多实例索引（同一 pinmapId 的第几个实例，0-based） */
  instance?: number;
  /** 组件类型：hardware=有引脚的硬件, software=无引脚的软件组件 */
  componentType?: ComponentType;
  /** 软件组件配置（仅 componentType=software 时有效） */
  softwareConfig?: SoftwareComponentConfig;
}

/**
 * Agent 工具输入格式：组件实例声明
 * 支持两种格式：
 * 1. 字符串：pinmapId (如 "lib-dht:dht20:asair")
 * 2. 对象：带别名和标签 (如 { id: "lib-dht:dht20:asair", alias: "dht_indoor", label: "室内温湿度" })
 */
export type ComponentInstanceInput = string | {
  /** pinmapId 完整标识符 */
  id: string;
  /** 用户定义的别名（用于 refId），如 "dht_indoor" */
  alias?: string;
  /** 显示名称，如 "室内温湿度" */
  label?: string;
};

/** connection_output.json 完整格式 */
export interface ConnectionGraphData {
  version: string;
  description: string;
  components: ConnectionComponent[];
  connections: ConnectionDef[];
}

/** 传递给 iframe 子页面的完整数据包 */
export interface ConnectionGraphPayload {
  /** 组件完整配置（refId → config 映射） */
  componentConfigs: { [refId: string]: ComponentConfig };
  /** 组件引用列表 */
  components: ConnectionComponent[];
  /** 连线列表 */
  connections: ConnectionDef[];
  /** 主题 */
  theme?: 'light' | 'dark';
}

/** 引脚摘要（精简版，供 LLM 使用） */
export interface PinSummary {
  componentId: string;
  componentName: string;
  pinCount: number;
  pins: Array<{
    id: string;
    functions: Array<{ name: string; type: string }>;
  }>;
}

/** 安全检查结果 */
export interface ValidationResult {
  ruleId: string;
  level: 'error' | 'warning';
  message: string;
}

// =====================================================
// Pinmap Catalog 类型定义
// =====================================================

/** 协议类型 */
export type PinmapProtocol = 'i2c' | 'spi' | 'uart' | 'digital' | 'analog' | 'pwm' | 'other';

/** 共享 Pinmap 定义 */
export interface SharedPinmapDef {
  description: string;
  file: string;
  pins: string[];
  usedBy?: string[];
}

/** 传感器变体 */
export interface SensorVariant {
  id: string;                         // "asair", "128x64_i2c"
  name: string;                       // "Asair 原厂", "0.96\" 128x64 I2C"
  fullId: string;                     // "lib-dht:dht20:asair"

  // 元信息
  protocol?: PinmapProtocol;
  manufacturer?: string;              // "Asair", "Seeed Studio"
  resolution?: { width: number; height: number };
  voltage?: string;                   // "3.3V", "3.3V-5V"

  // Pinmap 文件
  pinmapFile?: string;                // "pinmaps/dht20.json"
  pinmapRef?: string;                 // 共享引用 "oled_i2c"
  status: 'available' | 'needs_generation';

  // UI 辅助
  isDefault?: boolean;
  previewPins?: string[];             // ["VCC", "SDA", "SCL", "GND"]
  note?: string;
}

/** 传感器/芯片型号 */
export interface SensorModel {
  id: string;                         // "dht20", "ssd1306"
  name: string;                       // "DHT20", "SSD1306 OLED"
  description?: string;               // 简要说明
  defaultVariant?: string;            // 默认变体 ID

  variants: SensorVariant[];
}

/** 目录类型 */
export type CatalogType = 'library' | 'board' | 'software';

/** 软件库元数据（用于 software 类型的 catalog） */
export interface SoftwareCatalogMeta {
  /** 软件库类型 */
  libraryType: 'wifi' | 'mqtt' | 'http' | 'tcp' | 'bluetooth' | 'other';
  /** 默认图标 */
  defaultIcon?: string;
  /** 配置属性模板（定义 LLM 需要询问用户的配置项） */
  configTemplate?: Array<{
    key: string;
    label: string;
    type: 'string' | 'number' | 'boolean';
    required?: boolean;
    defaultValue?: string | number | boolean;
    description?: string;
  }>;
}

/** Pinmap 目录文件完整结构 */
export interface PinmapCatalog {
  version: string;                    // "1.0.0"
  library: string;                    // "@aily-project/lib-dht"
  displayName: string;                // "DHT 温湿度传感器系列"
  type?: CatalogType;                 // 默认 library, 可以是 'software'
  icon?: string;                      // "thermometer" 或 URL

  models: SensorModel[];
  sharedPinmaps?: Record<string, SharedPinmapDef>;
  
  /** 软件库元数据（仅 type=software 时使用） */
  softwareMeta?: SoftwareCatalogMeta;
}

/** 库扫描结果（包含无 catalog 的库） */
export interface LibraryScanResult {
  packageSlug: string;                          // 如 "lib-dht"
  packagePath: string;                          // 完整路径
  displayName: string;                          // 显示名称
  hasPinmapCatalog: boolean;                    // 是否有 pinmap_catalog.json
  catalog?: PinmapCatalog;                      // 如果有的话
  catalogStatus: 'available' | 'missing_catalog'; // 目录状态
}

/** fullId 解析结果 */
export interface PinmapReference {
  fullId: string;
  packageSlug: string;
  modelId: string;
  variantId: string;
}

// =====================================================
// 连线类型颜色映射
// =====================================================

const CONNECTION_COLOR_MAP: Record<string, string> = {
  power: '#EF4444',
  gnd: '#000000',
  i2c: '#8B5CF6',
  spi: '#EC4899',
  uart: '#F59E0B',
  digital: '#3B82F6',
  analog: '#10B981',
  pwm: '#06B6D4',
  gpio: '#10B981',
  other: '#9CA3AF',
};

// =====================================================
// Prompt 模板
// =====================================================

const SYSTEM_PROMPT = `你是嵌入式硬件开发AI助手，擅长分析硬件组件的引脚定义并设计正确的接线方案。

你的任务是：根据用户提供的两个（或多个）硬件组件的引脚信息，分析它们之间应该如何连接，并输出标准格式的连接配置 JSON。

### 分析规则

1. **电源连接**：传感器/模块的 VCC（type: power）应连接到开发板的电源引脚（3V3 或 5V），根据模块的工作电压选择合适的电源。
2. **接地连接**：所有 GND（type: gnd）引脚必须相连。
3. **通信协议匹配**：
   - I2C：SDA 对 SDA，SCL 对 SCL（type: i2c）
   - SPI：MOSI 对 MOSI，MISO 对 MISO，SCK 对 SCK，CS 对任意可用 digital 引脚
   - UART：TX 对 RX，RX 对 TX（type: uart，注意交叉连接）
4. **数字/模拟信号**：根据传感器需求连接到对应的 digital 或 analog 引脚。
5. **每个引脚只能使用一次**，不要重复分配。
6. **优先使用专用功能引脚**，避免占用通用引脚。

### 输出格式

严格按照以下 JSON 格式输出，不要添加额外说明文字：

\`\`\`json
{
  "version": "1.0.0",
  "description": "简要描述连接方案",
  "components": [
    {
      "refId": "组件短标识（小写下划线，如 dht_indoor）",
      "componentId": "组件原始 id",
      "componentName": "组件显示名称",
      "pinmapId": "pinmap 完整标识符（如 lib-dht:dht20:asair）",
      "instance": 0
    }
  ],
  "connections": [
    {
      "id": "conn_1",
      "from": {
        "ref": "组件A的refId",
        "pinId": "引脚id",
        "function": "使用的功能名称"
      },
      "to": {
        "ref": "组件B的refId",
        "pinId": "引脚id",
        "function": "使用的功能名称"
      },
      "type": "连接类型（power/gnd/i2c/spi/uart/digital/analog/other）",
      "label": "连接的显示标签",
      "color": "连线颜色（十六进制）"
    }
  ]
}
\`\`\`

### 多实例支持

当同一种传感器需要多个实例时（如两个 DHT20）：
- 每个实例使用不同的 **refId**（如 \`dht_indoor\`、\`dht_outdoor\`）
- 相同的 **pinmapId**（如 \`lib-dht:dht20:asair\`）
- 不同的 **instance** 值（0, 1, 2...）
- 连线中的 \`from.ref\` / \`to.ref\` 使用对应的 refId

示例：
\`\`\`json
"components": [
  { "refId": "dht_indoor", "pinmapId": "lib-dht:dht20:asair", "instance": 0, "componentName": "DHT20 室内" },
  { "refId": "dht_outdoor", "pinmapId": "lib-dht:dht20:asair", "instance": 1, "componentName": "DHT20 室外" }
]
\`\`\`

### 颜色约定

| type | color |
|------|-------|
| power | #EF4444 |
| gnd | #000000 |
| i2c | #8B5CF6 |
| spi | #EC4899 |
| uart | #F59E0B |
| digital | #3B82F6 |
| analog | #10B981 |
| other | #9CA3AF |`;

const USER_PROMPT_TEMPLATE = `请分析以下硬件组件的引脚信息，生成它们之间的连接配置 JSON。

### 组件引脚信息

{{PIN_SUMMARY_JSON}}

### 要求

- 确保所有必需的连接都已建立（电源、地线、通信线）
- 仅输出 JSON，不要输出其他内容
{{EXTRA_REQUIREMENTS}}`;

// =====================================================
// 核心服务
// =====================================================

@Injectable({ providedIn: 'root' })
export class ConnectionGraphService {

  /** 缓存的 iframe penpal remote API（由 IframeComponent 设置） */
  private _iframeApi: any = null;

  /** 连线图生成进度通知流（工具 → iframe noticeService） */
  private _noticeUpdate$ = new Subject<NoticeOptions>();

  /** 外部订阅进度通知 */
  get noticeUpdate$(): Observable<NoticeOptions> {
    return this._noticeUpdate$.asObservable();
  }

  /** 工具调用时发射进度通知（由 connectionGraphTool 内部调用） */
  emitNotice(opts: NoticeOptions): void {
    // 本窗口观察者（嵌入模式）
    this._noticeUpdate$.next(opts);
    // 跨窗口：通过 IPC 通知子窗口（子窗口模式）
    if (this.electronService.isElectron && window['ipcRenderer']) {
      try {
        window['ipcRenderer'].send('iframe-message-connection-graph', {
          type: 'notice-update',
          data: opts,
        });
      } catch { /* 子窗口未打开时忽略 */ }
    }
  }

  constructor(
    private electronService: ElectronService,
    private projectService: ProjectService
  ) {
    // 监听子窗口请求保存连线图数据
    this.setupIpcListeners();
  }

  /** 设置 IPC 监听器（规范：iframe-message-connection-graph，参数 {type, data}） */
  private setupIpcListeners(): void {
    if (this.electronService.isElectron && window['ipcRenderer']) {
      window['ipcRenderer'].on('iframe-message-connection-graph', async (_event: any, payload: { type: string; data?: any }) => {
        const { type, data } = payload ?? {};
        switch (type) {
          case 'save-graph-data': {
            console.log('[ConnectionGraphService] 收到子窗口保存请求');
            const messageId = data?.messageId;
            let success = false;
            if (data && data.components && data.connections) {
              const { messageId: _m, ...toSave } = data;
              success = this.saveConnectionGraphSilent(toSave);
            }
            if (window['ipcRenderer']) {
              window['ipcRenderer'].send('iframe-message-connection-graph', {
                type: 'save-graph-data-result',
                data: { messageId, success },
              });
            }
            break;
          }
          case 'get-graph-data': {
            // 子窗口请求：data 仅有 messageId 无 payload；主窗口响应：返回 messageId + payload
            const messageId = data?.messageId;
            if (!messageId || 'payload' in (data ?? {})) break;
            try {
              const boardPackagePath = await this.projectService.getBoardPackagePath();
              const graphPayload = boardPackagePath
                ? this.buildPayload(boardPackagePath)
                : null;
              window['ipcRenderer'].send('iframe-message-connection-graph', {
                type: 'set-graph-data',
                data: { messageId, payload: graphPayload },
              });
            } catch (e) {
              console.error('[ConnectionGraphService] 实时构建 payload 失败:', e);
              window['ipcRenderer'].send('iframe-message-connection-graph', {
                type: 'set-graph-data',
                data: { messageId, payload: null },
              });
            }
            break;
          }
        }
      });
    }
  }

  // -------------------------------------------------
  // iframe API 管理
  // -------------------------------------------------

  /** 设置 iframe 的 penpal remote API（连接建立后由 IframeComponent 调用） */
  setIframeApi(api: any): void {
    this._iframeApi = api;
  }

  /** 清除 iframe API（窗口关闭时调用） */
  clearIframeApi(): void {
    this._iframeApi = null;
  }

  /** 获取当前 iframe API */
  get iframeApi(): any {
    return this._iframeApi;
  }

  /** 是否有活跃的 iframe 连接 */
  get hasActiveIframe(): boolean {
    return this._iframeApi !== null;
  }

  // -------------------------------------------------
  // 引脚摘要生成（移植自 pin_tool.js）
  // -------------------------------------------------

  /**
   * 从组件配置中提取精简的引脚摘要
   * 过滤掉 visible=false 和 disabled=true 的引脚和功能
   */
  extractPinSummary(config: ComponentConfig): PinSummary {
    const extractedPins = (config.pins || [])
      .filter(pin => pin.visible !== false && pin.disabled !== true)
      .map(pin => {
        const functions = (pin.functions || [])
          .filter(fn => fn.visible !== false && fn.disabled !== true)
          .map(fn => ({ name: fn.name.trim(), type: fn.type }));
        return { id: pin.id, functions };
      });

    return {
      componentId: config.id,
      componentName: config.name,
      pinCount: extractedPins.length,
      pins: extractedPins,
    };
  }

  /**
   * 从开发板包目录解析 pinmap 文件路径。
   * 优先使用根目录 pinmap.json（旧版），找不到时回退到 pinmap_catalog.json 中的默认变体文件。
   */
  private resolveBoardPinmapPath(boardPackagePath: string): string | null {
    // 1. 旧版：根目录 pinmap.json
    const legacyPath = this.electronService.pathJoin(boardPackagePath, 'pinmap.json');
    if (this.electronService.exists(legacyPath)) {
      return legacyPath;
    }

    // 2. 新版：pinmap_catalog.json + pinmaps/ 目录
    const catalog = this.readPinmapCatalog(boardPackagePath);
    if (!catalog || !catalog.models || catalog.models.length === 0) {
      return null;
    }

    // 取第一个 model 的默认 variant（isDefault 或第一个）
    const model = catalog.models[0];
    const variant =
      model.variants.find(v => v.isDefault) ||
      model.variants.find(v => v.status === 'available') ||
      model.variants[0];

    if (!variant?.pinmapFile) {
      return null;
    }

    const resolvedPath = this.electronService.pathJoin(boardPackagePath, variant.pinmapFile);
    return this.electronService.exists(resolvedPath) ? resolvedPath : null;
  }

  /**
   * 读取开发板 pinmap 并提取引脚摘要。
   * 支持旧版 pinmap.json 和新版 catalog + pinmaps/ 结构。
   */
  getBoardPinSummary(boardPackagePath: string): PinSummary | null {
    const pinmapPath = this.resolveBoardPinmapPath(boardPackagePath);
    if (!pinmapPath) {
      return null;
    }
    try {
      const config: ComponentConfig = JSON.parse(this.electronService.readFile(pinmapPath));
      return this.extractPinSummary(config);
    } catch (e) {
      console.error('读取开发板 pinmap 失败:', e);
      return null;
    }
  }

  /**
   * 读取开发板 pinmap 的完整配置。
   * 支持旧版 pinmap.json 和新版 catalog + pinmaps/ 结构。
   */
  getBoardConfig(boardPackagePath: string): ComponentConfig | null {
    const pinmapPath = this.resolveBoardPinmapPath(boardPackagePath);
    if (!pinmapPath) {
      return null;
    }
    try {
      return JSON.parse(this.electronService.readFile(pinmapPath));
    } catch (e) {
      console.error('读取开发板 pinmap 失败:', e);
      return null;
    }
  }

  // -------------------------------------------------
  // Pinmap Catalog 读取与解析
  // -------------------------------------------------

  /**
   * 解析 fullId 为结构化对象
   * @param fullId 完整标识符 (如 "lib-dht:dht20:asair")
   */
  parsePinmapId(fullId: string): PinmapReference {
    const parts = fullId.split(':');
    return {
      fullId,
      packageSlug: parts[0] || '',
      modelId: parts[1] || '',
      variantId: parts[2] || 'default'
    };
  }

  /**
   * 构建 fullId
   */
  buildPinmapId(packageSlug: string, modelId: string, variantId?: string): string {
    return variantId && variantId !== 'default'
      ? `${packageSlug}:${modelId}:${variantId}`
      : `${packageSlug}:${modelId}:default`;
  }

  /**
   * 解析 pinmap_catalog.json 的实际路径（兼容新旧两种位置）
   * 优先检查 pinmaps/pinmap_catalog.json（新版），回退到根目录 pinmap_catalog.json（旧版）
   * @param packagePath 库或开发板包的完整路径
   * @returns 实际存在的 catalog 文件路径，若均不存在返回 null
   */
  resolveCatalogPath(packagePath: string): string | null {
    // 新版：pinmaps/pinmap_catalog.json
    const newPath = this.electronService.pathJoin(packagePath, 'pinmaps', 'pinmap_catalog.json');
    if (this.electronService.exists(newPath)) {
      return newPath;
    }
    // 旧版：根目录 pinmap_catalog.json
    const legacyPath = this.electronService.pathJoin(packagePath, 'pinmap_catalog.json');
    if (this.electronService.exists(legacyPath)) {
      return legacyPath;
    }
    return null;
  }

  /**
   * 读取库的 pinmap_catalog.json（兼容根目录和 pinmaps/ 子目录两种位置）
   * @param packagePath 库或开发板包的完整路径
   */
  readPinmapCatalog(packagePath: string): PinmapCatalog | null {
    const catalogPath = this.resolveCatalogPath(packagePath);
    if (!catalogPath) {
      return null;
    }
    try {
      return JSON.parse(this.electronService.readFile(catalogPath));
    } catch (e) {
      console.error('读取 pinmap_catalog.json 失败:', e);
      return null;
    }
  }

  /**
   * 根据 fullId 解析 pinmap 文件的实际路径
   * @param fullId 完整标识符
   * @param packagesBasePath 包的基础路径 (包含 @aily-project 子目录)
   */
  resolvePinmapPath(fullId: string, packagesBasePath: string): string | null {
    const { packageSlug, modelId, variantId } = this.parsePinmapId(fullId);

    // 构建包路径
    const packagePath = this.electronService.pathJoin(packagesBasePath, `@aily-project`, packageSlug);
    if (!this.electronService.exists(packagePath)) {
      console.warn(`resolvePinmapPath: 包路径不存在: ${packagePath}`);
      return null;
    }

    // 读取 catalog
    const catalog = this.readPinmapCatalog(packagePath);
    if (!catalog) {
      // 无 catalog，尝试直接返回 pinmap.json (开发板兼容)
      const defaultPinmap = this.electronService.pathJoin(packagePath, 'pinmap.json');
      return this.electronService.exists(defaultPinmap) ? defaultPinmap : null;
    }

    // 查找 model
    const model = catalog.models.find(m => m.id === modelId);
    if (!model) {
      console.warn(`resolvePinmapPath: 未找到 model "${modelId}"，可用 models: ${catalog.models.map(m => m.id).join(', ')}`);
      return null;
    }

    // 查找 variant
    const variant = model.variants.find(v => v.id === variantId);
    if (!variant) {
      console.warn(`resolvePinmapPath: 未找到 variant "${variantId}"，可用 variants: ${model.variants.map(v => v.id).join(', ')}`);
      return null;
    }

    // 确定 pinmap 文件路径
    if (variant.pinmapFile) {
      return this.electronService.pathJoin(packagePath, variant.pinmapFile);
    } else if (variant.pinmapRef && catalog.sharedPinmaps?.[variant.pinmapRef]) {
      return this.electronService.pathJoin(packagePath, catalog.sharedPinmaps[variant.pinmapRef].file);
    }

    // 回退：如果 variant 没有指定 pinmapFile，尝试使用默认的 pinmap.json（开发板常见情况）
    const defaultPinmap = this.electronService.pathJoin(packagePath, 'pinmap.json');
    if (this.electronService.exists(defaultPinmap)) {
      return defaultPinmap;
    }

    return null;
  }

  /**
   * 从 pinmap_catalog.json 构建同 model 下的类似组件列表（含自身）
   * 仅读取当前 model 的 variants 数组，不遍历整个 models
   * @param packagePath 库包路径 (如 .../node_modules/@aily-project/lib-dht)
   * @param currentFullId 当前组件的 fullId（如 lib-dht:dht11:module）
   */
  private buildSimilarComponentsFromCatalog(
    packagePath: string,
    currentFullId: string
  ): SimilarComponent[] {
    const catalog = this.readPinmapCatalog(packagePath);
    if (!catalog?.models?.length) return [];

    const { packageSlug, modelId } = this.parsePinmapId(currentFullId);
    const model = catalog.models.find(m => m.id === modelId);
    if (!model?.variants?.length) return [];

    const result: SimilarComponent[] = [];
    for (const variant of model.variants) {
      const fullId = variant.fullId || this.buildPinmapId(packageSlug, model.id, variant.id);

      let pinmapFile = variant.pinmapFile;
      if (!pinmapFile && variant.pinmapRef && catalog.sharedPinmaps?.[variant.pinmapRef]) {
        pinmapFile = catalog.sharedPinmaps[variant.pinmapRef].file;
      }

      let data: ComponentConfig | undefined;
      if (pinmapFile) {
        const pinmapPath = this.electronService.pathJoin(packagePath, pinmapFile);
        data = this.readComponentConfig(pinmapPath) || undefined;
      }

      result.push({
        fullId,
        modelId: model.id,
        variantId: variant.id,
        name: variant.name,
        modelName: model.name,
        pinmapFile: pinmapFile || undefined,
        data,
      });
    }
    return result;
  }

  /**
   * 通过 fullId 加载 pinmap 配置 (ComponentConfig)
   * @param fullId 完整标识符 (如 "lib-dht:dht20:asair")
   * @param packagesBasePath 包的基础路径
   */
  loadPinmapById(fullId: string, packagesBasePath: string): ComponentConfig | null {
    const pinmapPath = this.resolvePinmapPath(fullId, packagesBasePath);
    if (!pinmapPath) {
      console.warn(`无法解析 pinmap 路径: ${fullId}`);
      return null;
    }

    return this.readComponentConfig(pinmapPath);
  }

  /**
   * 通过 fullId 加载引脚摘要
   */
  loadPinSummaryById(fullId: string, packagesBasePath: string): PinSummary | null {
    const config = this.loadPinmapById(fullId, packagesBasePath);
    return config ? this.extractPinSummary(config) : null;
  }

  /**
   * 获取指定 variant 的完整信息
   */
  getVariantByFullId(fullId: string, packagesBasePath: string): SensorVariant | null {
    const { packageSlug, modelId, variantId } = this.parsePinmapId(fullId);

    const packagePath = this.electronService.pathJoin(packagesBasePath, '@aily-project', packageSlug);
    const catalog = this.readPinmapCatalog(packagePath);
    if (!catalog) return null;

    const model = catalog.models.find(m => m.id === modelId);
    if (!model) return null;

    return model.variants.find(v => v.id === variantId) || null;
  }

  /**
   * 根据 fullId 获取库的 catalog 信息
   * @param fullId pinmap 完整标识符 (如 "lib-mqtt:default:default")
   * @param packagesBasePath 包基础路径
   * @returns catalog 或 null
   */
  getCatalogByFullId(fullId: string, packagesBasePath: string): PinmapCatalog | null {
    const { packageSlug } = this.parsePinmapId(fullId);
    const packagePath = this.electronService.pathJoin(packagesBasePath, '@aily-project', packageSlug);
    return this.readPinmapCatalog(packagePath);
  }

  /**
   * 检查 pinmapId 对应的组件是否是软件组件（无引脚）
   * @param fullId pinmap 完整标识符
   * @param packagesBasePath 包基础路径
   * @returns { isSoftware: boolean, catalog?: PinmapCatalog }
   */
  checkSoftwareComponent(fullId: string, packagesBasePath: string): { isSoftware: boolean; catalog?: PinmapCatalog } {
    const catalog = this.getCatalogByFullId(fullId, packagesBasePath);
    if (!catalog) {
      return { isSoftware: false };
    }
    return {
      isSoftware: catalog.type === 'software',
      catalog: catalog.type === 'software' ? catalog : undefined,
    };
  }

  /**
   * 扫描指定目录下所有包含 pinmap_catalog.json 的库
   * @param packagesBasePath 包基础路径 (包含 @aily-project 子目录)
   */
  scanPinmapCatalogs(packagesBasePath: string): PinmapCatalog[] {
    const catalogs: PinmapCatalog[] = [];

    // 参数类型检查
    if (typeof packagesBasePath !== 'string') {
      console.error('scanPinmapCatalogs: packagesBasePath 必须是字符串，收到:', typeof packagesBasePath, packagesBasePath);
      return catalogs;
    }

    const ailyProjectPath = this.electronService.pathJoin(packagesBasePath, '@aily-project');
    if (!this.electronService.exists(ailyProjectPath)) {
      return catalogs;
    }

    try {
      const packages = this.electronService.readDir(ailyProjectPath);
      for (const pkg of packages) {
        // 确保 pkg 是字符串
        const pkgName = typeof pkg === 'string' ? pkg : (pkg?.name || String(pkg));
        if (!pkgName) continue;
        
        const pkgPath = this.electronService.pathJoin(ailyProjectPath, pkgName);
        const catalog = this.readPinmapCatalog(pkgPath);
        if (catalog) {
          catalogs.push(catalog);
        }
      }
    } catch (e) {
      console.error('扫描 pinmap catalogs 失败:', e);
    }

    return catalogs;
  }

  /**
   * 扫描所有 lib-* 库（包括没有 pinmap_catalog.json 的）
   * @param packagesBasePath 包基础路径 (包含 @aily-project 子目录)
   * @returns 库扫描结果列表
   */
  scanAllLibraries(packagesBasePath: string): LibraryScanResult[] {
    const results: LibraryScanResult[] = [];

    // 参数类型检查
    if (typeof packagesBasePath !== 'string') {
      console.error('scanAllLibraries: packagesBasePath 必须是字符串，收到:', typeof packagesBasePath, packagesBasePath);
      return results;
    }

    const ailyProjectPath = this.electronService.pathJoin(packagesBasePath, '@aily-project');
    if (!this.electronService.exists(ailyProjectPath)) {
      return results;
    }

    try {
      const packages = this.electronService.readDir(ailyProjectPath);
      for (const pkg of packages) {
        const pkgName = typeof pkg === 'string' ? pkg : (pkg?.name || String(pkg));
        if (!pkgName) continue;

        // 只处理 lib-* 开头的库
        if (!pkgName.startsWith('lib-')) continue;

        const pkgPath = this.electronService.pathJoin(ailyProjectPath, pkgName);
        const pkgJsonPath = this.electronService.pathJoin(pkgPath, 'package.json');

        // 读取 package.json 获取显示名称
        let displayName = pkgName;
        try {
          if (this.electronService.exists(pkgJsonPath)) {
            const pkgJson = JSON.parse(this.electronService.readFile(pkgJsonPath));
            displayName = pkgJson.displayName || pkgJson.name || pkgName;
          }
        } catch (e) {
          // 忽略解析错误
        }

        // 尝试读取 pinmap_catalog.json
        const catalog = this.readPinmapCatalog(pkgPath);

        results.push({
          packageSlug: pkgName,
          packagePath: pkgPath,
          displayName: catalog?.displayName || displayName,
          hasPinmapCatalog: catalog !== null,
          catalog: catalog || undefined,
          catalogStatus: catalog ? 'available' : 'missing_catalog',
        });
      }
    } catch (e) {
      console.error('扫描 lib-* 库失败:', e);
    }

    return results;
  }

  /**
   * 获取所有可用的 pinmap fullId 列表
   * @param packagesBasePath 包基础路径
   * @param filter 可选过滤条件
   */
  getAvailablePinmapIds(
    packagesBasePath: string,
    filter?: {
      status?: 'available' | 'needs_generation';
      type?: 'library' | 'board';
      protocol?: PinmapProtocol;
    }
  ): string[] {
    const catalogs = this.scanPinmapCatalogs(packagesBasePath);
    const ids: string[] = [];

    for (const catalog of catalogs) {
      // 过滤库类型
      if (filter?.type && catalog.type !== filter.type) continue;

      for (const model of catalog.models) {
        for (const variant of model.variants) {
          // 过滤状态
          if (filter?.status && variant.status !== filter.status) continue;
          // 过滤协议
          if (filter?.protocol && variant.protocol !== filter.protocol) continue;

          ids.push(variant.fullId);
        }
      }
    }

    return ids;
  }

  /**
   * 获取指定库的所有可用传感器摘要（用于前端选择）
   */
  getSensorPickerData(packagesBasePath: string): Array<{
    library: string;
    displayName: string;
    icon?: string;
    models: Array<{
      id: string;
      name: string;
      variants: Array<{
        fullId: string;
        name: string;
        protocol?: string;
        status: string;
        isDefault?: boolean;
      }>;
    }>;
  }> {
    const catalogs = this.scanPinmapCatalogs(packagesBasePath);

    return catalogs
      .filter(c => c.type !== 'board') // 排除开发板
      .map(catalog => ({
        library: catalog.library,
        displayName: catalog.displayName,
        icon: catalog.icon,
        models: catalog.models.map(model => ({
          id: model.id,
          name: model.name,
          variants: model.variants.map(v => ({
            fullId: v.fullId,
            name: v.name,
            protocol: v.protocol,
            status: v.status,
            isDefault: v.isDefault,
          })),
        })),
      }));
  }

  /**
   * 扫描开发板包目录下的所有外设配置文件（*_config.json，排除 pinmap.json 本身）
   * @param boardPackagePath 开发板包路径
   * @returns 外设配置文件路径列表
   */
  findPeripheralConfigs(boardPackagePath: string): string[] {
    try {
      const files = this.electronService.readDir(boardPackagePath);
      return files
        .map((f: any) => typeof f === 'string' ? f : (f?.name || ''))
        .filter((f: string) =>
          f && f.endsWith('_config.json') && f !== 'pinmap.json'
        )
        .map((f: string) => this.electronService.pathJoin(boardPackagePath, f));
    } catch (e) {
      console.error('扫描外设配置失败:', e);
      return [];
    }
  }

  /**
   * 读取指定路径的组件配置
   */
  readComponentConfig(configPath: string): ComponentConfig | null {
    if (!this.electronService.exists(configPath)) {
      return null;
    }
    try {
      return JSON.parse(this.electronService.readFile(configPath));
    } catch (e) {
      console.error(`读取组件配置失败: ${configPath}`, e);
      return null;
    }
  }

  /**
   * 生成完整的引脚摘要（开发板 + 所有外设）
   * @param boardPackagePath 开发板包路径
   * @param peripheralConfigPaths 额外指定的外设配置路径（可选）
   */
  generatePinSummary(boardPackagePath: string, peripheralConfigPaths?: string[]): PinSummary[] {
    const summaries: PinSummary[] = [];

    // 1. 开发板引脚摘要
    const boardSummary = this.getBoardPinSummary(boardPackagePath);
    if (boardSummary) {
      summaries.push(boardSummary);
    }

    // 2. 外设引脚摘要
    const configPaths = peripheralConfigPaths || this.findPeripheralConfigs(boardPackagePath);
    for (const configPath of configPaths) {
      const config = this.readComponentConfig(configPath);
      if (config) {
        summaries.push(this.extractPinSummary(config));
      }
    }

    return summaries;
  }

  // -------------------------------------------------
  // Prompt 构建
  // -------------------------------------------------

  /**
   * 获取 system prompt
   */
  getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  /**
   * 构建 user prompt
   * @param pinSummaries 引脚摘要数组
   * @param extraRequirements 用户额外需求（如 "DHT20 用 3.3V 供电"）
   */
  buildUserPrompt(pinSummaries: PinSummary[], extraRequirements?: string): string {
    let prompt = USER_PROMPT_TEMPLATE
      .replace('{{PIN_SUMMARY_JSON}}', JSON.stringify(pinSummaries, null, 2));

    if (extraRequirements) {
      prompt = prompt.replace('{{EXTRA_REQUIREMENTS}}', `- ${extraRequirements}`);
    } else {
      prompt = prompt.replace('{{EXTRA_REQUIREMENTS}}', '');
    }

    return prompt;
  }

  /**
   * 构建完整的 prompt 对象（包含 system + user）
   */
  buildPrompt(boardPackagePath: string, peripheralConfigPaths?: string[], extraRequirements?: string): {
    systemPrompt: string;
    userPrompt: string;
    pinSummaries: PinSummary[];
  } {
    const pinSummaries = this.generatePinSummary(boardPackagePath, peripheralConfigPaths);
    return {
      systemPrompt: this.getSystemPrompt(),
      userPrompt: this.buildUserPrompt(pinSummaries, extraRequirements),
      pinSummaries,
    };
  }

  // -------------------------------------------------
  // 连线图数据解析与校验
  // -------------------------------------------------

  /**
   * 解析 LLM 输出的 JSON 字符串为 ConnectionGraphData
   * 支持从 markdown 代码块中提取 JSON
   */
  parseConnectionGraphJSON(raw: string): ConnectionGraphData | null {
    try {
      // 尝试从 markdown 代码块中提取 JSON
      const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim();

      const data = JSON.parse(jsonStr) as ConnectionGraphData;

      // 基本格式校验
      if (!data.version || !Array.isArray(data.components) || !Array.isArray(data.connections)) {
        console.error('连线 JSON 格式不正确：缺少必要字段');
        return null;
      }

      // 校验每条连线
      for (const conn of data.connections) {
        if (!conn.id || !conn.from || !conn.to) {
          console.error(`连线 ${conn.id || '(unknown)'} 格式不正确`);
          return null;
        }
        if (!conn.from.ref || !conn.from.pinId) {
          console.error(`连线 ${conn.id} 的 from 端点格式不正确`);
          return null;
        }
        if (!conn.to.ref || !conn.to.pinId) {
          console.error(`连线 ${conn.id} 的 to 端点格式不正确`);
          return null;
        }
        // 自动补全颜色
        if (!conn.color && conn.type) {
          conn.color = CONNECTION_COLOR_MAP[conn.type] || CONNECTION_COLOR_MAP['other'];
        }
      }

      return data;
    } catch (e) {
      console.error('解析连线 JSON 失败:', e);
      return null;
    }
  }

  // -------------------------------------------------
  // 安全检查（基础版）
  // -------------------------------------------------

  /**
   * 验证连线配置的安全性
   */
  validateConnectionGraph(data: ConnectionGraphData): ValidationResult[] {
    const results: ValidationResult[] = [];
    const { connections, components } = data;

    // 规则1：VCC 直连 GND（短路）
    for (const conn of connections) {
      const fromIsGnd = conn.from.function === 'GND' || conn.type === 'gnd';
      const toIsPower = /VCC|3V3|5V/.test(conn.to.function) || conn.type === 'power';
      const fromIsPower = /VCC|3V3|5V/.test(conn.from.function) || conn.type === 'power';
      const toIsGnd = conn.to.function === 'GND' || conn.type === 'gnd';

      if ((fromIsGnd && toIsPower) || (fromIsPower && toIsGnd)) {
        results.push({
          ruleId: 'vcc_to_gnd',
          level: 'error',
          message: `连线 ${conn.id}: GND 直连 VCC/电源，会导致短路`,
        });
      }
    }

    // 规则2：UART TX 应连 RX（交叉连接）
    for (const conn of connections) {
      if (conn.type === 'uart') {
        if (conn.from.function === 'TX' && conn.to.function === 'TX') {
          results.push({
            ruleId: 'uart_crossover',
            level: 'error',
            message: `连线 ${conn.id}: UART TX 应连接到 RX，不应 TX→TX`,
          });
        }
        if (conn.from.function === 'RX' && conn.to.function === 'RX') {
          results.push({
            ruleId: 'uart_crossover',
            level: 'error',
            message: `连线 ${conn.id}: UART RX 应连接到 TX，不应 RX→RX`,
          });
        }
      }
    }

    // 规则3：引脚冲突（同一引脚被多条非总线连线使用）
    const pinUsage = new Map<string, string[]>();
    for (const conn of connections) {
      const fromKey = `${conn.from.ref}.${conn.from.pinId}`;
      const toKey = `${conn.to.ref}.${conn.to.pinId}`;
      if (!pinUsage.has(fromKey)) pinUsage.set(fromKey, []);
      if (!pinUsage.has(toKey)) pinUsage.set(toKey, []);
      pinUsage.get(fromKey)!.push(conn.id);
      pinUsage.get(toKey)!.push(conn.id);
    }
    for (const [pin, connIds] of pinUsage) {
      if (connIds.length > 1) {
        // I2C 和 SPI 总线允许多设备共享
        const connTypes = connIds.map(id =>
          connections.find(c => c.id === id)?.type
        );
        const allBus = connTypes.every(t => t === 'i2c' || t === 'spi');
        if (!allBus) {
          results.push({
            ruleId: 'pin_conflict',
            level: 'warning',
            message: `引脚 ${pin} 被多条连线使用: ${connIds.join(', ')}`,
          });
        }
      }
    }

    // 规则4：缺少电源或接地
    const refs = new Set<string>();
    for (const conn of connections) {
      refs.add(conn.from.ref);
      refs.add(conn.to.ref);
    }
    // 排除开发板本身（通常第一个组件是开发板）
    const boardRef = components.length > 0 ? components[0].refId : '';
    for (const ref of refs) {
      if (ref === boardRef) continue;
      const hasPower = connections.some(
        c => (c.to.ref === ref && c.type === 'power') ||
             (c.from.ref === ref && c.type === 'power')
      );
      const hasGnd = connections.some(
        c => (c.to.ref === ref && c.type === 'gnd') ||
             (c.from.ref === ref && c.type === 'gnd')
      );
      if (!hasPower) {
        results.push({
          ruleId: 'missing_power',
          level: 'warning',
          message: `组件 ${ref} 缺少电源连接`,
        });
      }
      if (!hasGnd) {
        results.push({
          ruleId: 'missing_power',
          level: 'warning',
          message: `组件 ${ref} 缺少接地连接`,
        });
      }
    }

    return results;
  }

  // -------------------------------------------------
  // 数据持久化
  // -------------------------------------------------

  /**
   * 获取连线图数据文件路径
   */
  getConnectionGraphPath(projectPath?: string): string {
    const basePath = projectPath || this.projectService.currentProjectPath;
    return this.electronService.pathJoin(basePath, 'connection_output.json');
  }

  /**
   * 保存连线图数据到项目目录
   */
  saveConnectionGraph(data: ConnectionGraphData, projectPath?: string): boolean {
    try {
      const filePath = this.getConnectionGraphPath(projectPath);
      this.electronService.writeFile(filePath, JSON.stringify(data, null, 2));
      // 通知子窗口数据已更新
      this.notifyConnectionGraphUpdated(data);
      return true;
    } catch (e) {
      console.error('保存连线图数据失败:', e);
      return false;
    }
  }

  /**
   * 静默保存连线图数据（不触发 IPC 通知）
   * 用于子窗口编辑后持久化，避免循环通知
   */
  saveConnectionGraphSilent(data: ConnectionGraphData, projectPath?: string): boolean {
    try {
      const filePath = this.getConnectionGraphPath(projectPath);
      this.electronService.writeFile(filePath, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      console.error('保存连线图数据失败:', e);
      return false;
    }
  }

  /**
   * 通过 IPC 通知子窗口连线图数据已更新
   * 发送完整的 payload（包含 componentConfigs），确保子窗口能正确渲染
   */
  private async notifyConnectionGraphUpdated(data: ConnectionGraphData): Promise<void> {
    if (this.electronService.isElectron && window['ipcRenderer']) {
      try {
        // 获取 boardPackagePath 以构建完整 payload
        const boardPackagePath = await this.projectService.getBoardPackagePath();
        if (!boardPackagePath) {
          console.warn('[ConnectionGraphService] 无法获取 boardPackagePath，跳过 IPC 通知');
          return;
        }
        
        // 构建完整的 payload（包含 componentConfigs）
        const componentConfigs = this.getComponentConfigs(boardPackagePath, data);
        const payload: ConnectionGraphPayload = {
          componentConfigs,
          components: data.components,
          connections: data.connections,
          theme: 'dark',
        };
        
        window['ipcRenderer'].send('iframe-message-connection-graph', { type: 'generate-graph-updated', data: payload });
        console.log('[ConnectionGraphService] 已发送 iframe-message-connection-graph (generate-graph-updated)');
      } catch (e) {
        console.warn('[ConnectionGraphService] 发送 IPC 失败:', e);
      }
    }
  }

  /**
   * 读取已保存的连线图数据
   */
  getConnectionGraph(projectPath?: string): ConnectionGraphData | null {
    try {
      const filePath = this.getConnectionGraphPath(projectPath);
      if (!this.electronService.exists(filePath)) {
        return null;
      }
      return JSON.parse(this.electronService.readFile(filePath)) as ConnectionGraphData;
    } catch (e) {
      console.error('读取连线图数据失败:', e);
      return null;
    }
  }

  /**
   * 检查项目是否已有连线图数据
   */
  hasConnectionGraph(projectPath?: string): boolean {
    const filePath = this.getConnectionGraphPath(projectPath);
    return this.electronService.exists(filePath);
  }

  // -------------------------------------------------
  // AWS (Aily Wiring Syntax) 文件操作
  // -------------------------------------------------

  /**
   * 获取 AWS 文件路径
   */
  getAWSFilePath(projectPath?: string): string {
    const basePath = projectPath || this.projectService.currentProjectPath;
    return this.electronService.pathJoin(basePath, 'connection.aws');
  }

  /**
   * 获取 JSON 文件路径（统一使用 connection_output.json）
   */
  getJSONFilePath(projectPath?: string): string {
    // 与 getConnectionGraphPath 保持一致，统一使用同一个文件
    return this.getConnectionGraphPath(projectPath);
  }

  /**
   * 保存 AWS 源文件
   */
  saveAWSFile(awsContent: string, projectPath?: string): boolean {
    try {
      const filePath = this.getAWSFilePath(projectPath);
      this.electronService.writeFile(filePath, awsContent);
      return true;
    } catch (e) {
      console.error('保存 AWS 文件失败:', e);
      return false;
    }
  }

  /**
   * 读取 AWS 源文件
   */
  readAWSFile(projectPath?: string): string | null {
    try {
      const filePath = this.getAWSFilePath(projectPath);
      if (!this.electronService.exists(filePath)) {
        return null;
      }
      return this.electronService.readFile(filePath);
    } catch (e) {
      console.error('读取 AWS 文件失败:', e);
      return null;
    }
  }

  /**
   * 检查是否存在 AWS 文件
   */
  hasAWSFile(projectPath?: string): boolean {
    const filePath = this.getAWSFilePath(projectPath);
    return this.electronService.exists(filePath);
  }

  /**
   * 保存 AWS 编译后的 JSON 文件
   */
  saveJSONFile(data: any, projectPath?: string): boolean {
    try {
      const filePath = this.getJSONFilePath(projectPath);
      this.electronService.writeFile(filePath, JSON.stringify(data, null, 2));
      // 通知子窗口数据已更新
      this.notifyConnectionGraphUpdated(data);
      return true;
    } catch (e) {
      console.error('保存 JSON 文件失败:', e);
      return false;
    }
  }

  // -------------------------------------------------
  // 组件配置收集（供 iframe 使用）
  // -------------------------------------------------

  /**
   * 收集所有组件的完整配置，按 refId 索引
   * @param boardPackagePath 开发板包路径
   * @param connectionData 连线数据（用于确定需要哪些组件的配置）
   * @param packagesBasePath 包基础路径（用于通过 pinmapId 加载，可选）
   */
  getComponentConfigs(
    boardPackagePath: string,
    connectionData?: ConnectionGraphData,
    packagesBasePath?: string
  ): { [refId: string]: ComponentConfig } {
    const configs: { [refId: string]: ComponentConfig } = {};

    // 推断 packagesBasePath（如果未提供）
    // 假设 boardPackagePath 格式为: .../node_modules/@aily-project/board-xxx
    const inferredBasePath = packagesBasePath || this.inferPackagesBasePath(boardPackagePath);
    console.log('[getComponentConfigs] boardPackagePath:', boardPackagePath);
    console.log('[getComponentConfigs] inferredBasePath:', inferredBasePath);

    // 读取开发板配置
    const boardConfig = this.getBoardConfig(boardPackagePath);
    console.log('[getComponentConfigs] boardConfig loaded:', boardConfig ? boardConfig.name : 'null');
    if (boardConfig && connectionData) {
      // 用 connectionData 中的 refId
      const boardComponent = connectionData.components[0];
      if (boardComponent) {
        configs[boardComponent.refId] = boardConfig;
        console.log('[getComponentConfigs] added board config with refId:', boardComponent.refId);
      }
    } else if (boardConfig) {
      // 默认用 config.id 作为 refId
      configs[boardConfig.id] = boardConfig;
    }

    // 读取外设配置
    if (connectionData) {
      for (const comp of connectionData.components) {
        console.log('[getComponentConfigs] processing component:', comp.refId, 'pinmapId:', comp.pinmapId);
        if (configs[comp.refId]) {
          console.log('[getComponentConfigs] skipping (already added):', comp.refId);
          continue; // 已添加（开发板）
        }

        // 优先通过 pinmapId 加载 (新版方式)
        if (comp.pinmapId && inferredBasePath) {
          console.log('[getComponentConfigs] trying loadPinmapById:', comp.pinmapId);
          const config = this.loadPinmapById(comp.pinmapId, inferredBasePath);
          if (config) {
            // 从 pinmap_catalog.json 合并类似组件列表
            const { packageSlug } = this.parsePinmapId(comp.pinmapId);
            const packagePath = this.electronService.pathJoin(inferredBasePath, '@aily-project', packageSlug);
            const similarComponents = this.buildSimilarComponentsFromCatalog(packagePath, comp.pinmapId);
            if (similarComponents.length > 0) {
              configs[comp.refId] = { ...config, similarComponents };
            } else {
              configs[comp.refId] = config;
            }
            console.log('[getComponentConfigs] loaded via pinmapId:', comp.refId, config.name, 'similarComponents:', similarComponents.length);
            continue;
          } else {
            console.log('[getComponentConfigs] loadPinmapById returned null');
          }
        }

        // 回退：通过 configFile 字段查找 (旧版方式)
        if (comp.configFile) {
          const configPath = this.electronService.pathJoin(boardPackagePath, comp.configFile);
          console.log('[getComponentConfigs] trying configFile:', configPath);
          const config = this.readComponentConfig(configPath);
          if (config) {
            configs[comp.refId] = config;
            console.log('[getComponentConfigs] loaded via configFile:', comp.refId);
            continue;
          }
        }

        // 回退：通过 componentId 匹配目录下的配置 (旧版方式)
        console.log('[getComponentConfigs] trying componentId match for:', comp.componentId);
        const peripheralConfigs = this.findPeripheralConfigs(boardPackagePath);
        for (const path of peripheralConfigs) {
          const config = this.readComponentConfig(path);
          if (config && config.id === comp.componentId) {
            configs[comp.refId] = config;
            console.log('[getComponentConfigs] loaded via componentId match:', comp.refId);
            break;
          }
        }
        
        if (!configs[comp.refId]) {
          console.warn('[getComponentConfigs] FAILED to load config for:', comp.refId);
        }
      }
    }

    return configs;
  }

  /**
   * 从开发板包路径推断 packages 基础路径
   * @example ".../node_modules/@aily-project/board-esp32c3" → ".../node_modules"
   */
  private inferPackagesBasePath(boardPackagePath: string): string | null {
    // 查找 @aily-project 的父目录
    const ailyIdx = boardPackagePath.indexOf('@aily-project');
    if (ailyIdx === -1) return null;

    return boardPackagePath.substring(0, ailyIdx);
  }

  // -------------------------------------------------
  // 构建 Payload（供 iframe 使用）
  // -------------------------------------------------

  /**
   * 构建完整的 ConnectionGraphPayload，用于传递给 iframe 子页面
   */
  buildPayload(boardPackagePath: string, projectPath?: string): ConnectionGraphPayload | null {
    const connectionData = this.getConnectionGraph(projectPath);
    console.log('[buildPayload] projectPath:', projectPath, 'currentProjectPath:', this.projectService.currentProjectPath);
    console.log('[buildPayload] connectionData:', connectionData ? `${connectionData.connections?.length} connections` : 'null');
    if (!connectionData) {
      return null;
    }

    const componentConfigs = this.getComponentConfigs(boardPackagePath, connectionData);
    console.log('[buildPayload] componentConfigs keys:', Object.keys(componentConfigs));

    return {
      ...connectionData,
      componentConfigs,
    };
  }

  // -------------------------------------------------
  // iframe 通信辅助
  // -------------------------------------------------

  /**
   * 推送连线数据更新到 iframe（如果已打开）
   */
  async notifyIframe(data: ConnectionGraphData, boardPackagePath: string): Promise<boolean> {
    if (!this.hasActiveIframe) {
      return false;
    }
    try {
      const componentConfigs = this.getComponentConfigs(boardPackagePath, data);
      const payload: ConnectionGraphPayload = {
        componentConfigs,
        components: data.components,
        connections: data.connections,
        theme: 'dark',
      };
      await this._iframeApi.receiveData(payload);
      return true;
    } catch (e) {
      console.error('推送连线数据到 iframe 失败:', e);
      return false;
    }
  }

  /**
   * 从 iframe 获取最新的连线数据（含用户手动修改）
   */
  async getConnectionsFromIframe(): Promise<ConnectionDef[] | null> {
    if (!this.hasActiveIframe) {
      return null;
    }
    try {
      return await this._iframeApi.getConnections();
    } catch (e) {
      console.error('从 iframe 获取连线数据失败:', e);
      return null;
    }
  }

  // -------------------------------------------------
  // 工具方法
  // -------------------------------------------------

  /**
   * 获取连线类型对应的颜色
   */
  getColorForType(type: string): string {
    return CONNECTION_COLOR_MAP[type] || CONNECTION_COLOR_MAP['other'];
  }

  /**
   * 生成新的连线 ID
   */
  generateConnectionId(existing: ConnectionDef[]): string {
    const max = existing.reduce((m, c) => {
      const num = parseInt(c.id.replace('conn_', ''), 10);
      return isNaN(num) ? m : Math.max(m, num);
    }, 0);
    return `conn_${max + 1}`;
  }

  // -------------------------------------------------
  // Pinmap 生成相关方法
  // -------------------------------------------------

  /**
   * 获取库的详细信息（README、示例代码等），用于 LLM 生成 pinmap
   * @param pinmapId 完整标识符
   * @param packagesBasePath 包基础路径
   */
  getLibraryInfo(pinmapId: string, packagesBasePath: string): {
    readme?: string;
    exampleCode?: string;
    packageJson?: any;
    existingPinmaps?: string[];
  } {
    const ref = this.parsePinmapId(pinmapId);
    const packagePath = `${packagesBasePath}/@aily-project/${ref.packageSlug}`;

    const result: {
      readme?: string;
      exampleCode?: string;
      packageJson?: any;
      existingPinmaps?: string[];
    } = {};

    // 1. 读取 README.md
    const readmePath = this.electronService.pathJoin(packagePath, 'README.md');
    if (this.electronService.exists(readmePath)) {
      try {
        const content = this.electronService.readFile(readmePath);
        // 截取前 4000 字符避免过长
        result.readme = content.length > 4000 ? content.substring(0, 4000) + '\n...(已截断)' : content;
      } catch (e) {
        console.error('读取 README.md 失败:', e);
      }
    }

    // 2. 读取 package.json
    const packageJsonPath = this.electronService.pathJoin(packagePath, 'package.json');
    if (this.electronService.exists(packageJsonPath)) {
      try {
        result.packageJson = JSON.parse(this.electronService.readFile(packageJsonPath));
      } catch (e) {
        console.error('读取 package.json 失败:', e);
      }
    }

    // 3. 收集示例代码（从 examples 目录）
    const examplesDir = this.electronService.pathJoin(packagePath, 'examples');
    if (this.electronService.exists(examplesDir)) {
      try {
        const files = this.electronService.readDir(examplesDir);
        for (const file of files) {
          const fileName = typeof file === 'string' ? file : file?.name;
          if (fileName && (fileName.endsWith('.ino') || fileName.endsWith('.cpp') || fileName.endsWith('.c'))) {
            const filePath = this.electronService.pathJoin(examplesDir, fileName);
            const content = this.electronService.readFile(filePath);
            // 只取第一个示例，且截取前 2000 字符
            result.exampleCode = content.length > 2000 ? content.substring(0, 2000) + '\n...(已截断)' : content;
            break;
          }
        }
      } catch (e) {
        console.error('读取示例代码失败:', e);
      }
    }

    // 4. 列出已有的 pinmap 文件（作为参考）
    const pinmapsDir = this.electronService.pathJoin(packagePath, 'pinmaps');
    if (this.electronService.exists(pinmapsDir)) {
      try {
        const files = this.electronService.readDir(pinmapsDir);
        result.existingPinmaps = files
          .map((f: any) => typeof f === 'string' ? f : f?.name)
          .filter((f: string) => f && f.endsWith('.json'));
      } catch (e) {
        console.error('读取 pinmaps 目录失败:', e);
      }
    }

    return result;
  }

  /**
   * 获取 pinmap 生成模板（根据协议类型提供参考结构）
   * @param protocol 协议类型
   */
  getPinmapTemplate(protocol?: PinmapProtocol): ComponentConfig {
    // 通用模板结构
    const baseTemplate: ComponentConfig = {
      id: 'component_template',
      name: '传感器名称',
      width: 200,
      height: 100,
      images: [
        {
          url: '组件图片的base64编码',
          x: 0,
          y: 0,
          width: 200,
          height: 100
        }
      ],
      pins: [],
      functionTypes: [
        { value: 'power', label: '电源', color: '#EF4444', textColor: '#FFFFFF' },
        { value: 'gnd', label: '接地', color: '#000000', textColor: '#FFFFFF' },
        { value: 'digital', label: '数字', color: '#3B82F6', textColor: '#FFFFFF' },
        { value: 'analog', label: '模拟', color: '#10B981', textColor: '#FFFFFF' },
        { value: 'i2c', label: 'I2C', color: '#8B5CF6', textColor: '#FFFFFF' },
        { value: 'spi', label: 'SPI', color: '#EC4899', textColor: '#FFFFFF' },
        { value: 'uart', label: 'UART', color: '#F59E0B', textColor: '#FFFFFF' },
        { value: 'pwm', label: 'PWM', color: '#06B6D4', textColor: '#FFFFFF' }
      ]
    };

    // 根据协议类型提供示例引脚
    // 左侧引脚: labelX=-20, labelAnchor="right"; 右侧引脚: labelX=212 (width+12), labelAnchor="left"
    // labelY = y - 7
    switch (protocol) {
      case 'i2c':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'SDA', type: 'i2c' }] },
          { id: 'pin_4', x: 190, y: 50, labelX: 212, labelY: 43, labelAnchor: 'left', layout: 'horizontal', functions: [{ name: 'SCL', type: 'i2c' }] }
        ];
        break;
      case 'spi':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 30, labelX: -20, labelY: 23, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'MOSI', type: 'spi' }] },
          { id: 'pin_4', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'MISO', type: 'spi' }] },
          { id: 'pin_5', x: 190, y: 30, labelX: 212, labelY: 23, labelAnchor: 'left', layout: 'horizontal', functions: [{ name: 'SCK', type: 'spi' }] },
          { id: 'pin_6', x: 190, y: 50, labelX: 212, labelY: 43, labelAnchor: 'left', layout: 'horizontal', functions: [{ name: 'CS', type: 'digital' }] }
        ];
        break;
      case 'uart':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'TX', type: 'uart' }] },
          { id: 'pin_4', x: 190, y: 50, labelX: 212, labelY: 43, labelAnchor: 'left', layout: 'horizontal', functions: [{ name: 'RX', type: 'uart' }] }
        ];
        break;
      case 'pwm':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'SIG', type: 'pwm' }] }
        ];
        break;
      case 'digital':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'OUT', type: 'digital' }] }
        ];
        break;
      case 'analog':
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'OUT', type: 'analog' }] }
        ];
        break;
      default:
        // 通用 4 引脚模块
        baseTemplate.pins = [
          { id: 'pin_1', x: 10, y: 50, labelX: -20, labelY: 43, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
          { id: 'pin_2', x: 10, y: 70, labelX: -20, labelY: 63, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
          { id: 'pin_3', x: 10, y: 90, labelX: -20, labelY: 83, labelAnchor: 'right', layout: 'horizontal', functions: [{ name: 'DATA', type: 'digital' }] }
        ];
    }

    return baseTemplate;
  }

  /**
   * 保存 LLM 生成的 pinmap 配置到库目录
   * @param pinmapId 完整标识符
   * @param config pinmap 配置
   * @param packagesBasePath 包基础路径
   */
  savePinmapConfig(pinmapId: string, config: ComponentConfig, packagesBasePath: string): {
    success: boolean;
    filePath?: string;
    error?: string;
  } {
    try {
      const ref = this.parsePinmapId(pinmapId);
      let packagePath = `${packagesBasePath}/@aily-project/${ref.packageSlug}`;
      
      // 验证包目录存在（防止用错 packageSlug 创建无效目录）
      if (!this.electronService.exists(packagePath)) {
        // 尝试模糊匹配：在 @aily-project/ 下查找以 packageSlug 开头的库
        const ailyProjectPath = this.electronService.pathJoin(packagesBasePath, '@aily-project');
        let matched = false;
        if (this.electronService.exists(ailyProjectPath)) {
          try {
            const packages = this.electronService.readDir(ailyProjectPath);
            for (const pkg of packages) {
              const pkgName = typeof pkg === 'string' ? pkg : (pkg?.name || String(pkg));
              // 精确前缀匹配：lib-sensor → lib-sensor-xxx
              if (pkgName.startsWith(ref.packageSlug + '-') || pkgName === ref.packageSlug) {
                // 检查该包的 catalog 中是否有匹配的 modelId
                const candidatePath = this.electronService.pathJoin(ailyProjectPath, pkgName);
                const catalog = this.readPinmapCatalog(candidatePath);
                if (catalog) {
                  const hasModel = catalog.models.some(m => m.id === ref.modelId);
                  if (hasModel) {
                    packagePath = candidatePath;
                    matched = true;
                    break;
                  }
                }
                // 没有 catalog 但目录名前缀匹配，也接受（新库场景）
                if (!matched) {
                  packagePath = candidatePath;
                  matched = true;
                  // 继续搜索更精确的匹配
                }
              }
            }
          } catch (e) {
            // 目录扫描失败，继续用原始路径
          }
        }
        if (!matched) {
          // 未找到已有匹配 → 自动创建包目录（支持自定义包名场景）
          console.log(`[savePinmapConfig] 包目录 @aily-project/${ref.packageSlug} 不存在，自动创建`);
          window['fs'].mkdirSync(packagePath, { recursive: true });
        }
      }

      // 确保 pinmaps 目录存在
      const pinmapsDir = this.electronService.pathJoin(packagePath, 'pinmaps');
      if (!this.electronService.exists(pinmapsDir)) {
        // 使用 fs.mkdirSync 创建目录
        window['fs'].mkdirSync(pinmapsDir, { recursive: true });
      }

      // 生成文件名
      const fileName = `${ref.modelId}_${ref.variantId}.json`;
      const filePath = this.electronService.pathJoin(pinmapsDir, fileName);

      // 保存文件
      this.electronService.writeFile(filePath, JSON.stringify(config, null, 2));

      // 更新 catalog 状态（传入已解析的 packagePath，避免重新从 packageSlug 构建错误路径）
      const catalogUpdated = this.updateCatalogStatus(pinmapId, 'available', `pinmaps/${fileName}`, packagePath, config);
      if (!catalogUpdated) {
        console.warn('[savePinmapConfig] catalog 更新失败，但 pinmap 文件已保存');
      }

      return { success: true, filePath };
    } catch (e: any) {
      console.error('保存 pinmap 配置失败:', e);
      return { success: false, error: e.message || String(e) };
    }
  }

  /**
   * 更新或创建 pinmap_catalog.json 中的变体条目
   * @param pinmapId 完整标识符
   * @param status 状态
   * @param pinmapFile pinmap 文件路径
   * @param resolvedPackagePath 已解析的库包完整路径（由调用者传入，避免从 packageSlug 重新推导出错）
   * @param componentConfig 可选，组件配置（用于创建新条目时提取信息）
   */
  private updateCatalogStatus(
    pinmapId: string,
    status: 'available' | 'needs_generation',
    pinmapFile: string,
    resolvedPackagePath: string,
    componentConfig?: ComponentConfig
  ): boolean {
    try {
      const ref = this.parsePinmapId(pinmapId);
      const packagePath = resolvedPackagePath;
      // 兼容新旧路径：优先使用已存在的位置，新建时统一写入 pinmaps/ 子目录
      const catalogPath = this.resolveCatalogPath(packagePath)
        || this.electronService.pathJoin(packagePath, 'pinmaps', 'pinmap_catalog.json');

      let catalog: PinmapCatalog;

      // 如果 catalog 不存在，创建新的
      if (!this.electronService.exists(catalogPath)) {
        console.log('[updateCatalogStatus] 创建新的 pinmap_catalog.json');
        catalog = this.createNewCatalog(ref.packageSlug, componentConfig);
      } else {
        console.log('[updateCatalogStatus] 读取现有 catalog:', catalogPath);
        catalog = JSON.parse(this.electronService.readFile(catalogPath));
        console.log('[updateCatalogStatus] 现有 models 数量:', catalog.models?.length || 0);
        console.log('[updateCatalogStatus] 现有 model IDs:', catalog.models?.map(m => m.id).join(', ') || 'none');
      }

      // 查找或创建对应的 model
      let model = catalog.models.find(m => m.id === ref.modelId);
      if (!model) {
        console.log('[updateCatalogStatus] 未找到 model，创建新的:', ref.modelId);
        model = {
          id: ref.modelId,
          name: componentConfig?.name || ref.modelId.toUpperCase(),
          description: `${ref.packageSlug}:${ref.modelId}`,
          defaultVariant: ref.variantId,
          variants: []
        };
        catalog.models.push(model);
        console.log('[updateCatalogStatus] 新增后 models 数量:', catalog.models.length);
      } else {
        console.log('[updateCatalogStatus] 找到现有 model:', model.id);
      }

      // 查找或创建对应的 variant
      let variant = model.variants.find(v => v.id === ref.variantId);
      if (!variant) {
        console.log('[updateCatalogStatus] 创建新的 variant:', ref.variantId);
        variant = {
          id: ref.variantId,
          name: ref.variantId === 'default' ? '默认版本' : ref.variantId,
          fullId: pinmapId,
          status: status,
          pinmapFile: pinmapFile,
          isDefault: model.variants.length === 0 // 第一个变体设为默认
        };
        model.variants.push(variant);
      } else {
        // 更新现有变体
        variant.status = status;
        variant.pinmapFile = pinmapFile;
      }

      // 保存 catalog
      console.log('[updateCatalogStatus] 保存前 models 数量:', catalog.models.length, 'model IDs:', catalog.models.map(m => m.id).join(', '));
      const catalogContent = JSON.stringify(catalog, null, 2);
      this.electronService.writeFile(catalogPath, catalogContent);
      console.log('[updateCatalogStatus] catalog 已更新:', catalogPath);
      
      return true;
    } catch (e) {
      console.error('更新 catalog 状态失败:', e);
      return false;
    }
  }

  /**
   * 创建新的 pinmap_catalog.json 结构
   */
  private createNewCatalog(packageSlug: string, componentConfig?: ComponentConfig): PinmapCatalog {
    // 从 packageSlug 推断库名称
    // lib-dht -> DHT 传感器系列
    // lib-servo -> Servo 舵机系列
    const libName = packageSlug.replace('lib-', '').toUpperCase();
    
    return {
      version: '1.0.0',
      library: `@aily-project/${packageSlug}`,
      displayName: componentConfig?.name || `${libName} 系列`,
      type: 'library',
      models: []
    };
  }

  /**
   * 查找 pinmapId 对应的变体信息
   * @param pinmapId 完整标识符
   * @param packagesBasePath 包基础路径
   */
  findVariantInfo(pinmapId: string, packagesBasePath: string): SensorVariant | null {
    const ref = this.parsePinmapId(pinmapId);
    const packagePath = `${packagesBasePath}/@aily-project/${ref.packageSlug}`;
    const catalog = this.readPinmapCatalog(packagePath);
    
    if (!catalog) return null;

    for (const model of catalog.models) {
      if (model.id === ref.modelId) {
        for (const variant of model.variants) {
          if (variant.id === ref.variantId) {
            return variant;
          }
        }
      }
    }

    return null;
  }
}
