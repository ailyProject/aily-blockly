/** 统一云编译设置与目标元数据的解释方式，供设置、依赖准备和项目服务共同使用。 */
export type CompileBackend = 'local' | 'cloud';
// 仅用于本地模拟的默认值；桌面启动后由主进程的部署配置覆盖正式网关地址。
export const DEFAULT_CLOUD_GATEWAY_URL = 'http://127.0.0.1:4318';
export const COMPILE_SETTINGS_CHANGED_ACTION = 'compile-settings-changed';

export interface CloudBuildSettings {
  gatewayUrl: string;
  publicKey?: string;
}

/** 云编译目前仅开放国内 cn 区域的 Windows 客户端；未知环境按不开放处理。 */
export function isCloudCompilationSupported(platform: unknown, region: unknown): boolean {
  return platform === 'win32' && region === 'cn';
}

export function getCompileBackend(config: any): CompileBackend {
  return config?.compile?.backend === 'cloud' ? 'cloud' : 'local';
}

function isLoopbackGatewayUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

/** 正式网关必须使用 HTTPS，只有本机模拟服务允许 HTTP；禁止 URL 内嵌凭据。 */
function normalizeCloudGatewayUrl(value: unknown): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_CLOUD_GATEWAY_URL;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid cloud gateway URL.'); }
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackGatewayUrl(raw)))) {
    throw new Error('Cloud gateway must use HTTPS or loopback HTTP, without credentials, query, or fragment.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function getCloudBuildSettings(config: any): CloudBuildSettings {
  const publicKey = typeof config?.cloud?.publicKey === 'string' ? config.cloud.publicKey.trim() : '';
  return { gatewayUrl: normalizeCloudGatewayUrl(config?.cloud?.gatewayUrl), ...(publicKey ? { publicKey } : {}) };
}

/** 后端或服务身份改变时，使正在准备的任务和已缓存的目标元数据失效。 */
export function getCompileSettingsKey(config: any): string {
  return JSON.stringify([getCompileBackend(config), config?.cloud?.gatewayUrl || DEFAULT_CLOUD_GATEWAY_URL,
    config?.cloud?.publicKey || '']);
}

/** 云模式只保留开发板明确声明的编辑资源；SDK/编译器不安装，烧录工具按需准备。 */
export function getCloudEditorDependencies(boardPackage: any): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(boardPackage?.boardDependencies || {})) {
    if (/\/(?:sdk|compiler)-/.test(name)) continue;
    const declaration = boardPackage?.dependencyRoles?.[name] ?? boardPackage?.boardDependencyRoles?.[name];
    const roles = Array.isArray(declaration) ? declaration : declaration?.roles;
    if (Array.isArray(roles) && roles.includes('editor') && !roles.includes('compile')) result[name] = String(version);
  }
  return result;
}

export interface CloudBoardOptionValue { label?: string; properties: Record<string, string>; }
export interface CloudBoardMetadata {
  boardOptions: Record<string, { label?: string; default: string; values: Record<string, CloudBoardOptionValue> }>;
  defaults: Record<string, string>;
  rawBoardProperties?: Record<string, string>;
  pins?: any;
  variants?: Record<string, any>;
  partitionTemplates?: Record<string, string>;
}
export interface CloudBoardProfile {
  id: string;
  boardModule: string;
  boardVersion: string;
  boardDigest: string;
  profileDigest: string;
  fqbn: string;
  capabilities?: { compile?: boolean; analysis?: boolean; simulator?: boolean; delivery?: boolean };
  metadata: CloudBoardMetadata;
  [key: string]: any;
}

/** 排序对象键后生成稳定内容标识，避免 JSON 字段顺序影响开发板和资源一致性判断。 */
export function canonicalCloudJson(value: any): string {
  const canonicalize = (item: any): any => Array.isArray(item) ? item.map(canonicalize)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonicalize(item[key])])) : item;
  return JSON.stringify(canonicalize(value));
}

/** 优先比较目标固件的兼容性，避免把不同宿主机的编译器可执行文件误判为不兼容。 */
export function compatibleCloudResources(candidate: CloudBoardProfile, reference: CloudBoardProfile): boolean {
  const left = candidate['resourceIdentity'], right = reference['resourceIdentity'];
  if (left === undefined && right === undefined) return true;
  const valid = (value: any) => value?.schemaVersion === 1 && value.kind === 'native-resource-lock-v1'
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
  if (!valid(left) || !valid(right)) return false;
  const one = left.targetCompatibility, two = right.targetCompatibility;
  const target = (value: any) => value?.policy === 'esp32s3-gcc14-sdk-runtime-v1'
    && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
  if (target(one) && target(two)) return one.digest === two.digest;
  return canonicalCloudJson(left) === canonicalCloudJson(right);
}

/** 菜单、构建属性共用同一默认值顺序，用户已保存的选项拥有最高优先级。 */
export function getCloudBoardOptions(profile: CloudBoardProfile, selected: Record<string, any> = {}): Record<string, any> {
  return { ...Object.fromEntries(Object.entries(profile.metadata.boardOptions).map(([key, value]) => [key, value.default])),
    ...profile.metadata.defaults, ...selected };
}

export function isCloudBoardProfileOnline(profile: CloudBoardProfile): boolean {
  return Number.isFinite(profile?.['availability']?.onlineNodes) && profile['availability'].onlineNodes > 0;
}

export function getCloudBoardProfileFreeSlots(profile: CloudBoardProfile): number {
  return Number.isFinite(profile?.['availability']?.freeSlots) ? Math.max(0, profile['availability'].freeSlots) : 0;
}

/** 只筛选精确板包身份；跨主机分流还必须维持相同编译契约，每个任务仍锁定精确目标摘要。 */
export function selectCloudBoardProfile(
  profiles: unknown, board: Pick<CloudBoardProfile, 'boardModule' | 'boardVersion' | 'boardDigest'>,
  profileDigest?: string, compatibleWith?: CloudBoardProfile,
): CloudBoardProfile | undefined {
  const record = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
  const matches = (candidate: any): candidate is CloudBoardProfile => candidate
    && candidate.runner === 'aily-builder' && candidate.capabilities?.compile === true && candidate.metadata?.fixture !== true
    && candidate.boardModule === board.boardModule && candidate.boardVersion === board.boardVersion && candidate.boardDigest === board.boardDigest
    && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(candidate.fqbn)
    && /^[a-f0-9]{64}$/.test(candidate.profileDigest || '')
    && (candidate.digest === undefined || candidate.profileDigest === candidate.digest)
    && record(candidate.metadata?.boardOptions) && record(candidate.metadata?.defaults)
    && Object.values(candidate.metadata.boardOptions).every((declaration: any) =>
      record(declaration) && record(declaration.values) && typeof declaration.default === 'string'
      && Object.prototype.hasOwnProperty.call(declaration.values, declaration.default));
  const compatible = (candidate: CloudBoardProfile, reference: CloudBoardProfile) =>
    candidate.boardModule === reference.boardModule && candidate.boardVersion === reference.boardVersion
    && candidate.boardDigest === reference.boardDigest && candidate.fqbn === reference.fqbn && candidate['runner'] === reference['runner']
    && typeof reference['builderVersion'] === 'string' && reference['builderVersion'].length > 0
    && candidate['builderVersion'] === reference['builderVersion']
    && record(reference['toolVersions']) && Object.keys(reference['toolVersions']).length > 0
    && canonicalCloudJson(candidate['toolVersions']) === canonicalCloudJson(reference['toolVersions'])
    && compatibleCloudResources(candidate, reference) && canonicalCloudJson(candidate.metadata) === canonicalCloudJson(reference.metadata);
  return (Array.isArray(profiles) ? profiles : []).filter(matches)
    .filter(candidate => (!profileDigest || candidate.profileDigest === profileDigest)
      && (!compatibleWith || compatible(candidate, compatibleWith)))
    .sort((left, right) => Number(isCloudBoardProfileOnline(right)) - Number(isCloudBoardProfileOnline(left))
      || getCloudBoardProfileFreeSlots(right) - getCloudBoardProfileFreeSlots(left))[0];
}

/** 将网关的开发板元数据还原成 boards.txt 的平面键，复用现有开发板选项逻辑。 */
export function cloudBoardProperties(profile: CloudBoardProfile, boardName: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.metadata.rawBoardProperties || {})) {
    result[key.startsWith(boardName + '.') ? key : `${boardName}.${key}`] = String(value);
  }
  for (const [menu, declaration] of Object.entries(profile.metadata.boardOptions)) {
    for (const [option, value] of Object.entries(declaration.values)) {
      const prefix = `${boardName}.menu.${menu}.${option}`;
      result[prefix] = value.label || option;
      for (const [key, setting] of Object.entries(value.properties || {})) result[`${prefix}.${key}`] = String(setting);
    }
  }
  return result;
}
