'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const uploadRuntime = require('./cloud-upload-runtime');
const cloudRecipe = require('./cloud-recipe-upload');
const ciResources = require('./ci-resource-preparation');
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const { confirmBuildSource } = require(path.join(childRoot, 'scripts/build-source-capture'));
const { CloudBuildBroker } = require('./broker');
const { uploadCloudArtifact } = require('./uploader');
// 集中接收云编译 IPC，校验窗口身份并管理取消；烧录仍调用本机轻量工具。
function registerCloudBuildHandlers({ ipcMain, getOwner, canReadGateway = () => false, getGatewaySettings, getAuth, querySource, getRuntimeRoot, backend, powerSaveBlocker, uploadArtifact = uploadCloudArtifact,
  platform = process.platform, getRegion = () => process.env.AILY_REGION, prepareCloudUpload = cloudRecipe.stageCloudRecipeUpload, runCloudUpload = uploadRuntime.runCloudUpload }) {
  const uploads = new Map();
  const uploadSessions = new Map();
  const closeUploadSession = async key => {
    const session=uploadSessions.get(key);if(!session)return false;
    if(session.closing)return session.closing;
    session.closing=(async()=>{
      session.controller.abort();
      if(session.preparing)await session.preparing.catch(()=>{});
      if(session.running)await session.running.catch(error=>{if(error.cleanupConfirmed===false)throw error;});
      if(session.externalDone)await session.externalDone;
      if(session.stop)session.sender.removeListener('destroyed',session.stop);session.releasePowerSaveBlocker?.();
      try {session.lease?.release();} finally {
        try{if(session.workspace)fs.rmSync(session.workspace,{recursive:true,force:true});}finally{uploadSessions.delete(key);}
      }
      return true;
    })();
    return session.closing;
  };
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
  const broker = new CloudBuildBroker({ getOwner, getGatewaySettings, getAuth, querySource, acquirePowerSaveBlocker, getAppDataPath: () => path.dirname(getRuntimeRoot()) });
  const assertCloudSupported = () => {
    if (platform !== 'win32' || getRegion() !== 'cn') {
      throw Object.assign(new Error('Cloud compilation is currently available only on Windows in the cn region.'), { code: 'CLOUD_BUILD_UNAVAILABLE' });
    }
  };
  const assertCloudBackend = revision => {
    assertCloudSupported();
    if (currentBackend !== 'cloud') throw Object.assign(new Error('Cloud compilation is disabled.'), { code: 'CLOUD_BUILD_DISABLED' });
    if (revision !== backendRevision) throw Object.assign(new Error('Cloud compilation settings changed.'), { code: 'BUILD_SOURCE_STALE' });
  };
  const invalidateAll = () => {
    const cancelled = broker.invalidateAll();
    for (const item of uploads.values()) item.controller.abort();
    const sessions=[...uploadSessions.keys()].map(key=>closeUploadSession(key));
    return Promise.allSettled([cancelled, ...operations, ...sessions]);
  };
  const handle = async (event, payload) => {
    try {
      if (shuttingDown) throw Object.assign(new Error('Cloud build services are shutting down.'), { code: 'CLOUD_BUILD_SHUTDOWN' });
      const request = { ...payload };
      const revision = backendRevision;
      if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) throw Object.assign(new Error('Cloud operations require an application top-level frame.'), { code: 'CLOUD_BUILD_FORBIDDEN' });
      const deploymentRead = request.action === 'health' || request.action === 'configuration';
      const owner = getOwner(event.sender);
      // 设置子窗口只有连接检查权限；提交任务、读取固件及烧录必须属于当前主页面。
      if (!owner && !['finishArtifactUpload','cancelUpload'].includes(request.action) && !(deploymentRead && canReadGateway(event.sender))) throw Object.assign(new Error('Cloud build operations require the current main window; application settings can only read deployment identity or check Gateway health.'), { code: 'CLOUD_BUILD_FORBIDDEN' });
      // 以主进程平台和区域为准，旧偏好或渲染层参数不能放开云请求；初始化读取和清理仍可执行。
      if (!['configuration', 'cancel', 'cancelUpload', 'finishArtifactUpload', 'invalidate'].includes(request.action)) assertCloudSupported();
      if (['targets', 'compile', 'analysis'].includes(request.action)) request.settings = await broker.configuration();
      // 跨窗口设置保存可能早于旧页面的 IPC 到达；主进程必须拒绝关闭后的迟到任务。
      if (['preparationRequirements', 'completeCIToolPreparation', 'compile', 'analysis', 'upload', 'prepareArtifactUpload', 'assertArtifactUpload', 'beginArtifactUploadRoute','runArtifactUpload'].includes(request.action)) assertCloudBackend(revision);
      const send = progress => {
        if (!shuttingDown && revision === backendRevision && !event.sender.isDestroyed()
            && getOwner(event.sender)?.generation === owner?.generation) event.sender.send('cloud-build-progress', progress);
      };
      let result;
      if (request.action === 'health') result = await broker.health();
      else if (request.action === 'configuration') result = await broker.configuration();
      else if (request.action === 'preparationRequirements') {
        if (request.config?.sourceCapture) confirmBuildSource(request.config);
        result = request.compileAction === 'analysis' ? [] : ciResources.requirements(request.config, path.dirname(getRuntimeRoot()));
      }
      else if (request.action === 'completeCIToolPreparation') result = broker.completeCIToolPreparation(event.sender, request);
      else if (request.action === 'boardSupport') result = await broker.boardSupport(request.settings || request, request);
      else if (request.action === 'targets') result = await broker.targets(request.settings || request, undefined, request.profileDigest, request);
      else if (request.action === 'compile' || request.action === 'analysis') {
        const stopped = () => { void broker.cancel(event.sender, request.requestId); };
        event.sender.once('destroyed', stopped);
        try { result = await broker.run(event.sender, request, send); }
        finally { event.sender.removeListener('destroyed', stopped); }
      } else if (request.action === 'cancel') result = await broker.cancel(event.sender, request.requestId);
      else if (request.action === 'artifactPath') result = await broker.artifactPath(event.sender, request.projectPath);
      else if (request.action === 'artifactUploadInfo') {
        result = await broker.artifactUploadInfo(event.sender, request.projectPath);
        if(result.protocol==='cloud-recipe')result={...result,requirements:result.requirements.map(requirement=>{
          let installed=false;try{uploadRuntime.localDependencyPath(path.dirname(getRuntimeRoot()),requirement);installed=true;}catch{/* Prepare the exact Windows package through the existing dependency installer. */}
          return {...requirement,installed};
        })};
      }
      else if (request.action === 'prepareArtifactUpload') {
        if (uploads.size || uploadSessions.size) throw new Error('Cloud artifact upload already running.');
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId || '')) throw new Error('Invalid upload request identity.');
        const key=`${event.sender.id}:${request.requestId}`, controller=new AbortController();
        const session={sender:event.sender,generation:owner.generation,root:fs.realpathSync(request.projectPath),controller,revision,requestId:request.requestId};
        uploadSessions.set(key,session);
        try {
          session.lease=await broker.acquireCurrentArtifact(event.sender,session.root);
          assertCloudBackend(revision);controller.signal.throwIfAborted();
          session.workspace=fs.mkdtempSync(path.join(os.tmpdir(),'aily-cloud-local-upload-'));
          session.appDataPath=path.dirname(getRuntimeRoot());
          session.preparing=prepareCloudUpload(session.lease.record,{workspace:session.workspace,appDataPath:session.appDataPath,sourceIdentity:session.lease.identity,signal:controller.signal});
          session.staged=await session.preparing;
          await session.lease.assertCurrent();assertCloudBackend(revision);controller.signal.throwIfAborted();
          session.releasePowerSaveBlocker=acquirePowerSaveBlocker();
          session.stop=()=>{
            // Web Bluetooth belongs to this renderer context. Its destruction
            // ends GATT activity and supplies the teardown acknowledgement.
            session.externalComplete?.();void closeUploadSession(key).catch(()=>{});
          };
          controller.signal.addEventListener('abort',()=>{
            // Invalidation must reach the renderer even after backendRevision
            // changes; ordinary progress from the old backend remains hidden.
            if(!event.sender.isDestroyed())event.sender.send('cloud-build-progress',{requestId:session.requestId,stage:'upload-invalidated'});
          },{once:true});
          event.sender.once('destroyed',session.stop);
          result={requestId:session.requestId,...session.staged};
        } catch(error) {
          session.lease?.release();if(session.workspace)fs.rmSync(session.workspace,{recursive:true,force:true});uploadSessions.delete(key);throw error;
        }
      }
      else if (['assertArtifactUpload','beginArtifactUploadRoute','runArtifactUpload','finishArtifactUpload'].includes(request.action)) {
        const key=`${event.sender.id}:${request.requestId}`,session=uploadSessions.get(key);
        if(!session || (request.action !== 'finishArtifactUpload' && session.generation !== owner?.generation)) {
          if(request.action==='finishArtifactUpload')result=false;else throw new Error('Cloud upload session is no longer current.');
        } else if(request.action==='finishArtifactUpload') {
          session.externalComplete?.();
          result=await closeUploadSession(key);
        } else {
          assertCloudBackend(session.revision);session.controller.signal.throwIfAborted();await session.lease.assertCurrent();
          uploadRuntime.verifyStagedUpload(session.lease.record,session.staged);
          if(request.action==='assertArtifactUpload')result=true;
          else if(request.action==='beginArtifactUploadRoute'){
            if(request.transport!=='ble'||session.started)throw new Error('Invalid external cloud upload route.');
            session.started=true;session.externalDone=new Promise(resolve=>{session.externalComplete=resolve;});result=true;
          }
          else {
            if(session.started)throw new Error('This cloud upload session has already started.');session.started=true;
            session.running=runCloudUpload(session.lease.record,request,{workspace:session.workspace,appDataPath:session.appDataPath,staged:session.staged,signal:session.controller.signal,
              assertCurrent:session.lease.assertCurrent,markDelegated:session.lease.markDelegated,onOutput:output=>send({requestId:session.requestId,stage:'upload-output',output})});
            result=await session.running;
          }
        }
      }
      else if (request.action === 'reusable') result = await broker.reusable(event.sender, request.config, request.profileDigest);
      else if (request.action === 'invalidate') {
        let root = path.resolve(request.projectPath);
        try { root = fs.realpathSync(root); } catch { /* 已删除项目也可能仍有需要取消的烧录。 */ }
        const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
        broker.invalidate(request.projectPath, event.sender);
        for (const item of uploads.values()) if (item.sender === event.sender
            && (process.platform === 'win32' ? item.root.toLowerCase() : item.root) === normalizedRoot) item.controller.abort();
        for (const [key,item] of uploadSessions) if(item.sender===event.sender && (process.platform==='win32'?item.root.toLowerCase():item.root)===normalizedRoot)void closeUploadSession(key).catch(()=>{});
        result = true;
      }
      else if (request.action === 'upload') {
        const controller = new AbortController();
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(request.requestId || '')) throw new Error('Invalid upload request identity.');
        const key = `${event.sender.id}:${request.requestId}`;
        if (uploads.size || uploadSessions.size) throw new Error('Cloud artifact upload already running.');
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
        const session=uploadSessions.get(`${event.sender.id}:${request.requestId}`);
        upload?.controller.abort();session?.controller.abort(); result = !!(upload||session);
      } else throw new Error('Unknown cloud build operation.');
      return { ok: true, result };
    } catch (error) { return { ok: false, error: { code: error.code || 'CLOUD_BUILD_ERROR', message: error.message || String(error), ...(error.cleanupConfirmed === false ? { cleanupConfirmed: false } : {}) } }; }
  };
  ipcMain.handle('cloud-build', (event, payload) => {
    const operation = handle(event, payload);
    if (['compile', 'analysis', 'upload', 'prepareArtifactUpload','runArtifactUpload'].includes(payload?.action)) {
      operations.add(operation);
      const settled = () => operations.delete(operation);
      operation.then(settled, settled);
    }
    return operation;
  });
  return {
    invalidateAuthentication() {
      backendRevision += 1;
      return invalidateAll();
    },
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
      for (const item of uploadSessions.values()) if (item.sender === sender && item.generation === generation) item.controller.abort();
      return Promise.allSettled([cancelled,...[...uploadSessions.entries()].filter(([,item])=>item.sender===sender&&item.generation===generation).map(([key])=>closeUploadSession(key))]);
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
