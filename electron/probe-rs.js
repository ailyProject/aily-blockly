const { ipcMain } = require("electron");
const { execFile } = require("child_process");
const path = require("path");

// 获取 probe-rs 可执行文件路径
function getProbeRsPath() {
  const childPath = process.env.AILY_CHILD_PATH || path.join(__dirname, "..", "child");
  const ext = process.platform === "win32" ? ".exe" : "";
  return path.join(childPath, "probe-rs", `probe-rs${ext}`);
}

function run(args) {
  const probeRsPath = getProbeRsPath();
  return new Promise((resolve, reject) => {
    execFile(probeRsPath, args, { encoding: "utf-8", timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject({ code: err.code, message: stderr.trim() || err.message, stdout: stdout.trim() });
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

/** 列出所有已连接的调试探针 */
async function listProbes() {
  try {
    const { stdout, stderr } = await run(["list"]);
    const output = stdout || stderr;
    const lines = output.split(/\r?\n/).filter((l) => /^\s*\[\d+\]/.test(l));
    const probes = lines.map((line) => {
      // 典型输出格式: "[0]: DAPLink CMSIS-DAP -- 0d28:0204-3:serial (CMSIS-DAP)"
      const match = line.match(
        /\[(\d+)\]:\s+(.*?)\s+--\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})(?:(?:-\d+)?:(\S+))?\s+\(([^)]+)\)/
      );
      if (match) {
        return {
          index: parseInt(match[1], 10),
          name: match[2].trim(),
          vidPid: match[3],
          serial: match[4] || null,
          shortSerial: match[4] ? match[4].substring(0, 12) : null,
          type: match[5],
        };
      }
      return { index: null, raw: line.trim() };
    });

    return { success: true, count: probes.length, probes };
  } catch (e) {
    return { success: false, error: e.message, detail: e.stdout || null };
  }
}

/** 烧录固件到目标芯片 */
async function download(firmwarePath, opts = {}) {
  if (!firmwarePath) {
    return { success: false, error: "未指定固件文件路径" };
  }

  const args = ["download", firmwarePath];

  if (opts.chip) {
    args.push("--chip", opts.chip);
  }
  if (opts.probe) {
    args.push("--probe", opts.probe);
  }
  if (opts.protocol) {
    args.push("--protocol", opts.protocol);
  }
  if (opts.speed) {
    args.push("--speed", String(opts.speed));
  }
  if (opts.format) {
    args.push("--format", opts.format);
  }
  if (opts.baseAddress) {
    args.push("--base-address", String(opts.baseAddress));
  }
  if (opts.skipBytes) {
    args.push("--skip", String(opts.skipBytes));
  }
  if (opts.verify) {
    args.push("--verify");
  }

  try {
    const { stdout, stderr } = await run(args);
    return {
      success: true,
      firmware: path.resolve(firmwarePath),
      chip: opts.chip || "auto",
      message: stdout || stderr || "烧录完成",
    };
  } catch (e) {
    return {
      success: false,
      firmware: path.resolve(firmwarePath),
      chip: opts.chip || "auto",
      error: e.message,
      detail: e.stdout || null,
    };
  }
}

function registerProbeRsHandlers(mainWindow) {
  // 列出所有已连接的调试探针
  ipcMain.handle("probe-rs-list", async () => {
    try {
      const result = await listProbes();
      return result;
    } catch (error) {
      console.error("probe-rs list probes failed:", error);
      return { success: false, error: error.message };
    }
  });

  // 烧录固件
  ipcMain.handle("probe-rs-download", async (event, options) => {
    try {
      const result = await download(options.firmwarePath, options);
      return result;
    } catch (error) {
      console.error("probe-rs download failed:", error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerProbeRsHandlers };
