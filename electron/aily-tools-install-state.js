const fs = require("fs");

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shouldInstallForAppVersion(config, appVersion) {
  return config?.installed !== String(appVersion || "").trim();
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const content = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  const config = JSON.parse(content);
  return isRecord(config) ? config : {};
}

function markInstalledForAppVersion(configPath, appVersion) {
  const version = String(appVersion || "").trim();
  if (!version) {
    throw new Error("Application version is required for the aily tools install marker");
  }

  const config = readConfig(configPath);
  if (config.installed === version) {
    return false;
  }

  config.installed = version;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return true;
}

module.exports = {
  markInstalledForAppVersion,
  shouldInstallForAppVersion,
};
