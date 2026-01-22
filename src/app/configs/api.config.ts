// 模块级缓存变量，用于存储当前的服务器地址
// 这些变量可以通过 setServerUrl/setRegistryUrl 在运行时更新
let _cachedServerUrl: string | null = null;
let _cachedRegistryUrl: string | null = null;

// 从 process.env 读取初始值（如果可用）
function getInitialServerUrl(): string {
  return (typeof process !== 'undefined' && window['env'].get("AILY_API_SERVER")) 
    ? window['env'].get("AILY_API_SERVER")
    : 'https://api.aily.pro';
}

function getInitialRegistryUrl(): string {
  return (typeof process !== 'undefined' && window['env'].get("AILY_NPM_REGISTRY"))
    ? window['env'].get("AILY_NPM_REGISTRY")
    : 'https://registry.diandeng.tech';
}

// 动态获取服务器地址，优先使用缓存的值
function getServerUrl(): string {
  if (_cachedServerUrl !== null) {
    return _cachedServerUrl;
  }
  return getInitialServerUrl();
}

function getRegistryUrl(): string {
  if (_cachedRegistryUrl !== null) {
    return _cachedRegistryUrl;
  }
  return getInitialRegistryUrl();
}

/**
 * 更新 API 服务器地址（在设置页面更改后调用）
 * @param url 新的服务器地址
 */
export function setServerUrl(url: string): void {
  _cachedServerUrl = url;
}

/**
 * 更新 NPM Registry 地址（在设置页面更改后调用）
 * @param url 新的 Registry 地址
 */
export function setRegistryUrl(url: string): void {
  _cachedRegistryUrl = url;
}

// 使用 getter 动态获取 API 地址，确保每次访问都读取最新的环境变量
export const API = {
  get projectList() { return `${getRegistryUrl()}/-/verdaccio/data/packages`; },
  get projectSearch() { return `${getRegistryUrl()}/-/v1/search`; },
  // auth  
  get login() { return `${getServerUrl()}/api/v1/auth/login`; },
  get register() { return `${getServerUrl()}/api/v1/auth/register`; },
  get logout() { return `${getServerUrl()}/api/v1/auth/logout`; },
  get verifyToken() { return `${getServerUrl()}/api/v1/auth/verify`; },
  get refreshToken() { return `${getServerUrl()}/api/v1/auth/refresh`; },
  get me() { return `${getServerUrl()}/api/v1/auth/me`; },
  get changeNickname() { return `${getServerUrl()}/api/v1/auth/me/nickname`; },
  // github oauth
  get githubBrowserAuthorize() { return `${getServerUrl()}/api/v1/oauth/github/browser-authorize`; },
  get githubTokenExchange() { return `${getServerUrl()}/api/v1/oauth/github/token-exchange`; },
  // ai
  get startSession() { return `${getServerUrl()}/api/v1/start_session`; },
  get closeSession() { return `${getServerUrl()}/api/v1/close_session`; },
  get streamConnect() { return `${getServerUrl()}/api/v1/stream`; },
  get sendMessage() { return `${getServerUrl()}/api/v1/send_message`; },
  get getHistory() { return `${getServerUrl()}/api/v1/conversation_history`; },
  get stopSession() { return `${getServerUrl()}/api/v1/stop_session`; },
  get cancelTask() { return `${getServerUrl()}/api/v1/cancel_task`; },
  get generateTitle() { return `${getServerUrl()}/api/v1/generate_title`; },
  // cloud
  get cloudBase() { return `${getServerUrl()}/api/v1/cloud`; },
  get cloudSync() { return `${getServerUrl()}/api/v1/cloud/sync`; },
  get cloudProjects() { return `${getServerUrl()}/api/v1/cloud/projects`; },
  get cloudPublicProjects() { return `${getServerUrl()}/api/v1/cloud/projects/public`; },
  // feedback
  get feedback() { return `${getServerUrl()}/api/v1/feedback/submit`; },
  get feedbackImageUpload() { return `${getServerUrl()}/api/v1/feedback/upload-image`; },
  // model list
  get modelList() { return `${getServerUrl()}/api/v1/model/list`; },
  // model details
  get modelDetails() { return `${getServerUrl()}/api/v1/model`; },
  // firmware info
  get firmwareInfo() { return `${getServerUrl()}/api/v1/firmware/info`; },
  get downloadFirmware() { return `${getServerUrl()}/api/v1/firmware/download`; },
};
