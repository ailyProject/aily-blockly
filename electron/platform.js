// 提供当前操作系统类型的统一判断结果。
const platform = {
  isWin32: process.platform === "win32",
  isDarwin: process.platform === "darwin",
  isLinux: process.platform === "linux",
}

// console.log("platform", process.platform, platform);

module.exports = platform;
