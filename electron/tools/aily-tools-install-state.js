const fs = require("fs");

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const content = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const config = JSON.parse(content);
  return isRecord(config) ? config : {};
}

function shouldRefreshToolForAppVersion(configPath, toolKey, appVersion, options = {}) {
  const version = String(appVersion || "").trim();
  if (options.refreshEnabled === false || !configPath || !toolKey || !version) return false;
  // 旧 installed 字段只表示应用曾启动过，不能推定被云模式跳过的工具已经更新。
  try {
    return readConfig(configPath).toolVersions?.[toolKey] !== version;
  } catch (error) {
    // 配置损坏不能阻止已有工具启动；暂缓自动刷新，且不覆盖原配置。
    console.warn(`${toolKey} refresh marker could not be read:`, error);
    return false;
  }
}

function markToolRefreshedForAppVersion(configPath, toolKey, appVersion) {
  const version = String(appVersion || "").trim();
  if (!configPath || !toolKey || !version) {
    throw new Error("Config path, tool key and application version are required for the tool refresh marker");
  }

  const config = readConfig(configPath);
  if (config.toolVersions?.[toolKey] === version) {
    return false;
  }

  // 每次读取最新配置后只合并本工具的完成状态，保留其他工具与用户设置。
  config.toolVersions = { ...(isRecord(config.toolVersions) ? config.toolVersions : {}), [toolKey]: version };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return true;
}

module.exports = {
  markToolRefreshedForAppVersion,
  shouldRefreshToolForAppVersion,
};
