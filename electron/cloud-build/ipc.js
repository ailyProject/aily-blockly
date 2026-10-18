'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CloudBuildBroker } = require('./broker');
const { uploadCloudArtifact } = require('./uploader');
// 集中接收云编译 IPC，校验窗口身份并管理取消；烧录仍调用本机轻量工具。
function registerCloudBuildHandlers({ ipcMain, getOwner, canReadGateway = () => false, getGatewaySettings, querySource, getRuntimeRoot, backend, powerSaveBlocker, uploadArtifact = uploadCloudArtifact }) {
  const uploads = new Map();
  const operations = new Set();
  let currentBackend = backend === 'cloud' ? 'cloud' : 'local', backendRevision = 0;
  let shuttingDown = false, shutdownPromise;
  // Electron 防休眠能力留在控制器，任务只持有一次性的释放函数，避免相互释放。
  const acquirePowerSaveBlocker = () => {
    let id;
    try { id = powerSaveBlocker?.start('prevent-app-suspension'); } catch { return undefined; }
    if (id === undefined) return undefined;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try { powerSaveBlocker.stop(id); } catch { /* 清理异常不能覆盖编译或烧录结果。 */ }
    };
  };
  const broker = new CloudBuildBroker({ getOwner, getGatewaySettings, querySource, acquirePowerSaveBlocker });
  const assertCloudBackend = revision => {
    if (currentBackend !== 'cloud') throw Object.assign(new Error('Cloud compilation is disabled.'), { code: 'CLOUD_BUILD_DISABLED' });
    if (revision !== backendRevision) throw Object.assign(new Error('Cloud compilation settings changed.'), { code: 'BUILD_SOURCE_STALE' });
  };
  const invalidateAll = () => {
    const cancelled = broker.invalidateAll();
    for (const item of uploads.values()) item.controller.abort();
    return Promise.allSettled([cancelled, ...operations]);
  };
  const handle = async (event, payload) => {
    try {
      if (shuttingDown) throw Object.assign(new Error('Cloud build services are shutting down.'), { code: 'CLOUD_BUILD_SHUTDOWN' });
      const request = payload || {};
      const revision = backendRevision;
      if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw Object.assign(new Error('Cloud operations require an application top-level frame.'), { code: 'CLOUD_BUILD_FORBIDDEN' });
      const deploymentRead = request.action === 'health' || request.action === 'configuration';
      const owner = getOwner(event.sender);
      // 设置子窗口只有连接检查权限；提交任务、读取固件及烧录必须属于当前主页面。
      if (!owner && !(deploymentRead && canReadGateway(event.sender))) throw Object.assign(new Error('Cloud build operations require the current main window; application settings can only read deployment identity or check Gateway health.'), { code: 'CLOUD_BUILD_FORBIDDEN' });
      // 跨窗口设置保存可能早于旧页面的 IPC 到达；主进程必须拒绝关闭后的迟到任务。
      if (['compile', 'analysis', 'upload'].includes(request.action)) assertCloudBackend(revision);
      const send = progress => {
        if (!shuttingDown && revision === backendRevision && !event.sender.isDestroyed()
            && getOwner(event.sender)?.generation === owner?.generation) event.sender.send('cloud-build-progress', progress);
      };
      let result;
      if (request.action === 'health') result = await broker.health();
      else if (request.action === 'configuration') result = await broker.configuration();
      else if (request.action === 'targets') result = await broker.targets(request.settings || request, undefined, request.profileDigest, request);
      else if (request.action === 'compile' || request.action === 'analysis') {
        const stopped = () => { void broker.cancel(event.sender, request.requestId); };
        event.sender.once('destroyed', stopped);
        try { result = await broker.run(event.sender, request, send); }
        finally { event.sender.removeListener('destroyed', stopped); }
      } else if (request.action === 'cancel') result = await broker.cancel(event.sender, request.requestId);
      else if (request.action === 'artifactPath') result = await broker.artifactPath(event.sender, request.projectPath);
      else if (request.action === 'reusable') result = await broker.reusable(event.sender, request.config, request.profileDigest);
      else if (request.action === 'invalidate') {
        let root = path.resolve(request.projectPath);
        try { root = fs.realpathSync(root); } catch { /* 已删除项目也可能仍有需要取消的烧录。 */ }
        const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
        broker.invalidate(request.projectPath, event.sender);
        for (const item of uploads.values()) if (item.sender === event.sender
            && (process.platform === 'win32' ? item.root.toLowerCase() : item.root) === normalizedRoot) item.controller.abort();
        result = true;
      }
      else if (request.action === 'upload') {
        const controller = new AbortController();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId || '')) throw new Error('Invalid upload request identity.');
        const key = `${event.sender.id}:${request.requestId}`;
        if (uploads.size) throw new Error('Cloud artifact upload already running.');
        const upload = { sender: event.sender, generation: owner.generation, root: fs.realpathSync(request.projectPath), controller };
        uploads.set(key, upload);
        const stopped = () => controller.abort();
        event.sender.once('destroyed', stopped);
        const releasePowerSaveBlocker = acquirePowerSaveBlocker();
        try {
          result = await broker.withCurrentArtifact(event.sender, upload.root, async (artifact, assertCurrent) => {
            assertCloudBackend(revision);
            if (controller.signal.aborted) throw Object.assign(new Error('Cloud artifact upload cancelled.'), { code: 'CANCELLED' });
            return uploadArtifact(artifact, request, { runtimeRoot: getRuntimeRoot(), signal: controller.signal, onProgress: send, assertCurrent });
          });
        } finally {
          uploads.delete(key); event.sender.removeListener('destroyed', stopped);
          releasePowerSaveBlocker?.();
        }
      } else if (request.action === 'cancelUpload') {
        const upload = uploads.get(`${event.sender.id}:${request.requestId}`);
        upload?.controller.abort(); result = !!upload;
      } else throw new Error('Unknown cloud build operation.');
      return { ok: true, result };
    } catch (error) { return { ok: false, error: { code: error.code || 'CLOUD_BUILD_ERROR', message: error.message || String(error) } }; }
  };
  ipcMain.handle('cloud-build', (event, payload) => {
    const operation = handle(event, payload);
    if (['compile', 'analysis', 'upload'].includes(payload?.action)) {
      operations.add(operation);
      const settled = () => operations.delete(operation);
      operation.then(settled, settled);
    }
    return operation;
  });
  return {
    setBackend(value) {
      const next = value === 'cloud' ? 'cloud' : 'local';
      if (shuttingDown) return shutdownPromise;
      if (next === currentBackend) return Promise.resolve();
      // 先推进代次，阻断旧进度和迟到提交，再等待旧任务、烧录及其租约清理。
      backendRevision += 1;
      currentBackend = next;
      return invalidateAll();
    },
    invalidateOwner(sender, generation) {
      const cancelled = broker.invalidateOwner(sender, generation);
      for (const item of uploads.values()) if (item.sender === sender && item.generation === generation) item.controller.abort();
      return cancelled;
    },
    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      backendRevision += 1;
      // 远程取消有独立超时；退出还应等待本机烧录停止、租约释放和目录清理。
      shutdownPromise = invalidateAll();
      return shutdownPromise;
    },
  };
}
module.exports = { registerCloudBuildHandlers };
