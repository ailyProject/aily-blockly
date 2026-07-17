/**
 * CLI Bridge - 本地回环命令接口
 *
 * 为外部 CLI(child/aily-blockly-cli)提供一个本地 HTTP 接口,
 * 让运行中的主程序能接收"打开/关闭/重载项目"等命令。
 *
 * 设计:
 * - 仅监听 127.0.0.1 的随机端口(回环,不对外暴露)。
 * - 启动时把 { pid, port, token } 写入发现文件
 *   ~/.aily-blockly/cli-bridge/<pid>.json,供 CLI 发现并鉴权。
 * - 每个请求需携带 token,防止同机其它进程随意调用。
 * - dev 与打包环境通用(都写同一个发现文件)。
 *
 * 该模块是纯附加能力,不改变主程序既有行为。
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const BRIDGE_VERSION = 1;

function getBridgeDir() {
  return path.join(os.homedir(), '.aily-blockly', 'cli-bridge');
}

function getDiscoveryFilePath(pid) {
  return path.join(getBridgeDir(), `${pid}.json`);
}

function safeWriteDiscoveryFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (_) {
      /* 某些平台 chmod 可能失败,忽略 */
    }
  } catch (e) {
    console.warn('[cli-bridge] 写发现文件失败:', e && e.message);
  }
}

/**
 * 启动 CLI bridge。
 *
 * @param {object} deps
 * @param {(action: string, payload: object) => Promise<object>|object} deps.handleCommand
 *        处理 open/close/reload/refresh 等动作,返回 { ok, message, project? }。
 * @param {() => object} deps.getStatus 返回当前状态 { pid, project, serve }。
 * @param {object} [deps.logger]
 * @returns {{ close: () => void, updateProject: (project: string|null) => void, getPort: () => number|null }}
 */
function startCliBridge({ handleCommand, getStatus, logger = console }) {
  const token = crypto.randomBytes(16).toString('hex');
  const pid = process.pid;
  const discoveryFile = getDiscoveryFilePath(pid);
  let currentProject = null;

  const writeDiscovery = (port) => {
    safeWriteDiscoveryFile(discoveryFile, {
      version: BRIDGE_VERSION,
      pid,
      port,
      token,
      project: currentProject,
      serve: !!(getStatus && getStatus().serve),
      updatedAt: Date.now(),
    });
  };

  const server = http.createServer((req, res) => {
    const sendJson = (statusCode, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
    };

    // 健康检查(无需 token):用于 CLI 判断实例存活
    if (req.method === 'GET' && req.url === '/ping') {
      let status = {};
      try {
        status = (getStatus && getStatus()) || {};
      } catch (_) {
        /* ignore */
      }
      sendJson(200, { ok: true, pid, ...status });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/command') {
      sendJson(404, { ok: false, message: 'Not Found' });
      return;
    }

    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        aborted = true;
        sendJson(413, { ok: false, message: 'Payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch (_) {
        sendJson(400, { ok: false, message: 'Invalid JSON body' });
        return;
      }

      if (!payload || payload.token !== token) {
        sendJson(401, { ok: false, message: 'Unauthorized (token mismatch)' });
        return;
      }

      const action = String(payload.action || '');
      if (!action) {
        sendJson(400, { ok: false, message: 'Missing action' });
        return;
      }

      if (action === 'status') {
        let status = {};
        try {
          status = (getStatus && getStatus()) || {};
        } catch (_) {
          /* ignore */
        }
        sendJson(200, { ok: true, ...status });
        return;
      }

      Promise.resolve()
        .then(() => handleCommand(action, payload))
        .then((result) => {
          const out = result || { ok: false, message: 'No result' };
          if (Object.prototype.hasOwnProperty.call(out, 'project')) {
            currentProject = out.project || null;
            writeDiscovery(server.address() ? server.address().port : 0);
          }
          sendJson(out.ok ? 200 : 400, out);
        })
        .catch((err) => {
          logger.error('[cli-bridge] 命令处理异常:', err);
          sendJson(500, { ok: false, message: err && err.message ? err.message : String(err) });
        });
    });
    req.on('error', () => {
      if (!aborted) sendJson(400, { ok: false, message: 'Request error' });
    });
  });

  server.on('error', (e) => {
    logger.warn('[cli-bridge] 服务错误:', e && e.message);
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    writeDiscovery(port);
    logger.log(`[cli-bridge] 已启动,端口 ${port},发现文件 ${discoveryFile}`);
  });

  const cleanup = () => {
    try {
      fs.unlinkSync(discoveryFile);
    } catch (_) {
      /* ignore */
    }
  };
  process.on('exit', cleanup);

  return {
    close: () => {
      cleanup();
      try {
        server.close();
      } catch (_) {
        /* ignore */
      }
    },
    updateProject: (project) => {
      currentProject = project || null;
      const addr = server.address();
      if (addr) writeDiscovery(addr.port);
    },
    getPort: () => {
      const addr = server.address();
      return addr ? addr.port : null;
    },
  };
}

module.exports = { startCliBridge, getBridgeDir };
