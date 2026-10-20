'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const gzip = promisify(require('node:zlib').gzip);
const protocol = require('./protocol');
const inputManifest = require('./input-manifest');
const { captureSnapshot, captureIdentity } = require('./snapshot');
const { collectCloudArtifacts, removeOwnedDirectory } = require('./artifact-store');
const childRoot = process.env.AILY_CHILD_PATH || path.resolve(__dirname, '..', '..', 'child');
const { confirmBuildSource } = require(path.join(childRoot, 'scripts/build-source-capture'));
const { acquireBuildWorkspace } = require(path.join(childRoot, 'scripts/build-workspace-lease'));

// 默认部署仅由本代理使用，保留 provider 注入用于本地模拟；正式网关始终固定签名公钥。
function deploymentSettings(environment = process.env) {
  const defaultGatewayUrl = 'https://134.175.61.54';
  const defaultPublicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6cyEcuUSYKvLP261cICDWmV263f/qf56iUGnvuw1s18=\n-----END PUBLIC KEY-----\n';
  const configuredUrl = environment.AILY_CLOUD_BUILD_GATEWAY_URL || defaultGatewayUrl;
  let production = false;
  try { production = new URL(configuredUrl).toString().replace(/\/+$/u, '') === defaultGatewayUrl; }
  catch { /* 无效部署地址由请求入口统一拒绝。 */ }
  return { gatewayUrl: configuredUrl, publicKey: environment.AILY_CLOUD_BUILD_PUBLIC_KEY || (production ? defaultPublicKey : undefined) };
}

function gatewayUrl(value) {
  let url;
  try { url = new URL(value || 'http://127.0.0.1:4318'); }
  catch { throw protocol.error('GATEWAY_INVALID', 'Invalid cloud gateway URL.'); }
  const local = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)
      || (!local && url.protocol !== 'https:')) throw protocol.error('GATEWAY_INVALID', 'Use HTTPS or a loopback development gateway.');
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return { url: url.toString().replace(/\/$/u, ''), local };
}
const abortFault = () => protocol.error('CANCELLED', 'Cloud build cancelled.');
const CLIENT_INPUT_METRICS = ['captureMs', 'identityMs', 'manifestPrepareMs', 'manifestResolveMs', 'blobUploadMs', 'commitMs', 'encodingMs',
  'rawBytes', 'uniqueBytes', 'uploadedBytes', 'transferredBytes', 'reusedBytes', 'fileCount', 'blobCount', 'libraryCount', 'libraryHits', 'encodedFiles'];
function clientInputMetrics(value) {
  return Object.fromEntries(CLIENT_INPUT_METRICS.filter(key => Number.isFinite(value?.[key]) && value[key] >= 0 && value[key] <= Number.MAX_SAFE_INTEGER)
    .map(key => [key, value[key]]));
}
function trustedGateway(settings, caps) {
  if (caps?.protocolVersion !== 1 || typeof caps.publicKey !== 'string' || !caps.publicKey.trim()) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway cloud build protocol is unsupported.');
  const connection = gatewayUrl(settings.gatewayUrl);
  if (!settings.publicKey && !connection.local) throw protocol.error('GATEWAY_UNTRUSTED', 'Pin the gateway signing public key before compiling remotely.');
  const publicKey = settings.publicKey || caps.publicKey;
  if (typeof publicKey !== 'string' || caps.publicKey.trim() !== publicKey.trim()) throw protocol.error('SIGNATURE_INVALID', 'Gateway signing key differs from the configured key.');
  try { if (crypto.createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw new Error('Wrong key type.'); }
  catch { throw protocol.error('SIGNATURE_INVALID', 'Gateway requires a valid Ed25519 signing public key.'); }
  return publicKey;
}
function retainedBuildConfig(config) {
  return Object.fromEntries(['currentProjectPath', 'boardModule', 'code', 'projectMacros', 'partitionFilePath', 'sourceCapture']
    .filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}
function supportedRequest(input) {
  if ((input.action && !['compile', 'analysis'].includes(input.action)) || (input.recordProjectDelivery !== undefined && input.recordProjectDelivery !== false)
      || (input.config?.recordProjectDelivery !== undefined && input.config.recordProjectDelivery !== false) || input.graph !== undefined || input.config?.graph !== undefined
      || (input.graphSemanticRevision !== undefined && input.graphSemanticRevision !== '')
      || (input.config?.graphSemanticRevision !== undefined && input.config.graphSemanticRevision !== '')) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Cloud graph and project delivery are not supported.');
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || abortFault());
    const stop = () => { clearTimeout(timer); reject(signal.reason || abortFault()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}
async function boundedBytes(response, limit, onBytes) {
  const announced = Number(response.headers.get('content-length'));
  if (announced > limit) throw protocol.error('ARTIFACT_INVALID', 'Cloud response exceeds its byte budget.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw protocol.error('ARTIFACT_INVALID', 'Cloud response exceeds its byte budget.');
    chunks.push(Buffer.from(chunk));
    onBytes?.(size);
  }
  return Buffer.concat(chunks);
}
// 云编译主进程代理：确认当前源码、按内容上传、提交和跟踪任务，再验签下载并发布产物。
// 页面代次、项目身份和源码摘要共同约束结果，避免切换项目后复用错误固件。
class CloudBuildBroker {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.getOwner = options.getOwner || (() => ({ generation: 1 }));
    this.querySource = options.querySource;
    this.acquirePowerSaveBlocker = options.acquirePowerSaveBlocker;
    this.pollIntervalMs = options.pollIntervalMs || 3000;
    // 优先使用网关长轮询及时更新；不支持时，运行任务每秒查询、排队任务每三秒查询。
    // 显式间隔用于统一覆盖普通轮询频率。
    this.activePollIntervalMs = options.activePollIntervalMs ?? (options.pollIntervalMs ? undefined : 1000);
    this.initialPollIntervalMs = options.initialPollIntervalMs ?? (options.pollIntervalMs ? undefined : 0);
    this.statusWaitMs = options.statusWaitMs ?? 15000;
    this.requestTimeoutMs = options.requestTimeoutMs || 20000;
    this.cancelTimeoutMs = Math.max(1, Math.min(this.requestTimeoutMs, options.cancelTimeoutMs ?? 3000));
    this.healthTimeoutMs = options.healthTimeoutMs || 5000;
    this.getGatewaySettings = options.getGatewaySettings || deploymentSettings;
    this.deadlineMs = options.deadlineMs || 20 * 60 * 1000;
    this.artifactRetryDelayMs = options.artifactRetryDelayMs ?? 250;
    this.retention = options.retention || {};
    this.requests = new Map(); this.active = new Map(); this.artifactUsers = new Map(); this.catalogCapabilities = new Map();
  }
  async request(settings, endpoint, body, signal, bodyOptions = {}) {
    // 普通用户匿名请求云编译；仍限定网关来源、禁止重定向，并限制请求时间和响应体积。
    const destination = gatewayUrl(settings.gatewayUrl);
    const resolved = new URL(`${destination.url}${endpoint}`);
    if (resolved.origin !== new URL(destination.url).origin) throw protocol.error('GATEWAY_INVALID', 'Cloud URL escaped its gateway.');
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let payload = body === undefined ? undefined : JSON.stringify(body);
    const uncompressedBytes = payload === undefined ? 0 : Buffer.byteLength(payload);
    if (/^\/api\/v1\/build\/inputs(?:\/|$)/u.test(endpoint) && bodyOptions.gzip === true && payload !== undefined && uncompressedBytes >= 64 * 1024) {
      signal?.throwIfAborted();
      const compressed = await gzip(payload, { level: 1 });
      if (compressed.length < Buffer.byteLength(payload)) { payload = compressed; headers['Content-Encoding'] = 'gzip'; }
    }
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(Math.min(this.requestTimeoutMs, bodyOptions.timeoutMs || this.requestTimeoutMs));
    let response;
    try { response = await this.fetch(resolved, { method: body === undefined ? 'GET' : 'POST', headers,
      body: payload, credentials: 'omit', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      bodyOptions.onPayload?.({ transferredBytes: payload === undefined ? 0 : Buffer.byteLength(payload), uncompressedBytes }); }
    catch (error) {
      if (signal?.aborted) throw signal.reason || abortFault();
      if (timeout.aborted) throw protocol.error('GATEWAY_TIMEOUT', 'Gateway request timed out.');
      throw Object.assign(protocol.error('GATEWAY_UNREACHABLE', 'Could not connect to the cloud gateway.'), { cause: error });
    }
    let bytes;
    try { bytes = await boundedBytes(response, bodyOptions.maxResponseBytes || 192 * 1024 * 1024); }
    catch (error) {
      if (signal?.aborted) throw signal.reason || abortFault();
      if (timeout.aborted) throw protocol.error('GATEWAY_TIMEOUT', 'Gateway response timed out.');
      if (error.code === 'ARTIFACT_INVALID') throw error;
      throw Object.assign(protocol.error('GATEWAY_UNREACHABLE', 'Gateway response was interrupted.'), { cause: error });
    }
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw Object.assign(protocol.error(response.ok ? 'PROTOCOL_UNSUPPORTED' : 'GATEWAY_HTTP_ERROR',
      response.ok ? 'Gateway returned an invalid JSON response.' : `Gateway request failed (${response.status}).`), { httpStatus: response.status }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid JSON object.'), { httpStatus: response.status });
    }
    if (!response.ok) throw Object.assign(protocol.error(value.error?.code || value.code || 'GATEWAY_ERROR', value.error?.message || value.message || `Gateway request failed (${response.status}).`), { httpStatus: response.status });
    return value;
  }
  capabilities(settings, signal) { return this.request(settings, '/api/v1/build/capabilities', undefined, signal); }
  async boardSupport(settings, selector, signal) {
    const { boardModule, boardVersion } = selector;
    if (typeof boardModule !== 'string' || boardModule.length > 256
        || !/^@[^/\\]+\/(?:board|coder)-[A-Za-z0-9_.-]+$/u.test(boardModule) || /[\x00-\x1f]/u.test(boardModule)
        || typeof boardVersion !== 'string' || !boardVersion || boardVersion.length > 256 || /[\x00-\x1f]/u.test(boardVersion)) {
      throw protocol.error('TARGET_UNSUPPORTED', 'Invalid board support selector.');
    }
    const query = new URLSearchParams({ boardModule, boardVersion });
    const support = await this.request(settings, `/api/v1/build/board-support?${query}`, undefined, signal,
      { maxResponseBytes: 1024 * 1024 });
    if (support.boardModule !== boardModule || support.boardVersion !== boardVersion
        || typeof support.supported !== 'boolean' || typeof support.available !== 'boolean') {
      throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid board support response.');
    }
    return support;
  }
  assertBoardSupported(support) {
    const { boardModule, boardVersion } = support;
    // 离线时接口也会返回 supported:false；保留原因，避免误报为永久不支持。
    // supported:true 时仍由精确目标和队列处理容量，不能把忙碌误判为不支持。
    if (!support.supported) {
      const [code, message] = support.reason === 'not_enabled'
        ? ['CLOUD_BOARD_NOT_ENABLED', 'Cloud compilation is not enabled for this board version.']
        : support.reason === 'offline'
          ? ['CLOUD_BOARD_OFFLINE', 'The cloud compiler for this board is offline. Please try again later.']
          : ['CLOUD_BOARD_UNSUPPORTED', 'This board version does not support cloud compilation.'];
      throw protocol.error(code, `${message} (${boardModule}@${boardVersion})`);
    }
  }
  async uploadSnapshot(record, caps) {
    // 新协议先按库内容键和文件哈希协商，只上传缺失字节；旧网关仍支持完整快照。
    const snapshot = record.snapshot, metrics = record.inputMetrics;
    const gzipSupported = Array.isArray(caps.inputContentEncodings) && caps.inputContentEncodings.includes('gzip');
    const bodyOptions = { gzip: gzipSupported, onPayload: value => {
      metrics.transferredBytes += value.transferredBytes;
    } };
    const unique = new Map(snapshot.files.map(file => [file.sha256, file.sizeBytes]));
    metrics.rawBytes = snapshot.files.reduce((sum, file) => sum + file.sizeBytes, 0);
    metrics.uniqueBytes = [...unique.values()].reduce((sum, value) => sum + value, 0);
    metrics.fileCount = snapshot.files.length; metrics.blobCount = unique.size; metrics.libraryCount = snapshot.libraries.length;
    const supported = caps.inputTransport?.version === 2 && caps.inputTransport.manifestFirst === true
      && caps.inputTransport.libraryContentKey === 'sha256-relative-tree-v1';
    record.inputTransportVersion = supported ? 2 : 1;
    if (!supported) {
      const started = performance.now();
      try {
        const uploaded = await this.request(record.settings, '/api/v1/build/inputs', snapshot, record.controller.signal, bodyOptions);
        metrics.uploadedBytes += metrics.rawBytes; metrics.reusedBytes = 0;
        return uploaded;
      } finally { metrics.blobUploadMs += performance.now() - started; }
    }
    const prepareStarted = performance.now();
    const manifest = inputManifest.toManifest(snapshot);
    metrics.manifestPrepareMs += performance.now() - prepareStarted;
    const uploadedHashes = record.uploadedInputHashes ||= new Set();
    const validateIdentity = value => {
      if (!value || value.inputDigest !== snapshot.inputDigest) throw protocol.error('INPUT_DIGEST_MISMATCH', 'Gateway sealed different build inputs.');
      return value;
    };
    const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
    for (let repair = 0; ; repair++) {
      let resolved; const resolveStarted = performance.now();
      try { resolved = validateIdentity(await this.request(record.settings, '/api/v1/build/inputs/resolve', manifest, record.controller.signal, bodyOptions)); }
      finally { metrics.manifestResolveMs += performance.now() - resolveStarted; }
      if (!Array.isArray(resolved.missing)) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid missing-content inventory.');
      const files = inputManifest.blobRecords(snapshot, resolved.missing);
      metrics.libraryHits = Array.isArray(resolved.libraryHits) ? new Set(resolved.libraryHits.filter(hit => hit?.hit === true
        && manifest.libraryKeys.some(library => library.name === hit.name && library.root === hit.root && library.key === hit.key)).map(hit => hit.root)).size : 0;
      if (resolved.snapshotId !== null && resolved.snapshotId !== undefined) {
        if (!safeId(resolved.snapshotId) || files.length || resolved.uploadId !== null) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid sealed input reference.');
        metrics.reusedBytes = Math.max(0, metrics.rawBytes - [...uploadedHashes].reduce((sum, hash) => sum + unique.get(hash), 0));
        this.progress(record, { stage: 'uploading', progress: 100 });
        return resolved;
      }
      if (!safeId(resolved.uploadId) || !files.length) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid input upload session.');
      const batches = []; let batch = [], batchBytes = 0;
      for (const file of files) {
        if (batch.length && batchBytes + file.sizeBytes > 8 * 1024 * 1024) { batches.push(batch); batch = []; batchBytes = 0; }
        batch.push(file); batchBytes += file.sizeBytes;
        if (batchBytes >= 8 * 1024 * 1024) { batches.push(batch); batch = []; batchBytes = 0; }
      }
      if (batch.length) batches.push(batch);
      const group = new AbortController(), signal = AbortSignal.any([record.controller.signal, group.signal]);
      const missingBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
      let cursor = 0, completedBytes = 0, completedFiles = 0, failure;
      const uploadStarted = performance.now();
      const worker = async () => {
        while (cursor < batches.length && !signal.aborted) {
          const selected = batches[cursor++];
          try {
            await this.request(record.settings, `/api/v1/build/inputs/uploads/${resolved.uploadId}/blobs`, { files: selected }, signal, bodyOptions);
            for (const file of selected) { uploadedHashes.add(file.sha256); metrics.uploadedBytes += file.sizeBytes; completedBytes += file.sizeBytes; completedFiles++; }
            this.progress(record, { stage: 'uploading', progress: Math.floor(100 * (missingBytes ? completedBytes / missingBytes : completedFiles / files.length)) });
          } catch (error) { failure ||= error; group.abort(failure); }
        }
      };
      try { await Promise.allSettled(Array.from({ length: Math.min(2, batches.length) }, worker)); }
      finally { metrics.blobUploadMs += performance.now() - uploadStarted; }
      if (failure) throw failure;
      record.controller.signal.throwIfAborted();
      metrics.reusedBytes = Math.max(0, metrics.rawBytes - [...uploadedHashes].reduce((sum, hash) => sum + unique.get(hash), 0));
      const commitStarted = performance.now();
      try {
        const committed = validateIdentity(await this.request(record.settings, `/api/v1/build/inputs/uploads/${resolved.uploadId}/commit`, { inputDigest: snapshot.inputDigest }, record.controller.signal, bodyOptions));
        if (!safeId(committed.snapshotId)) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid sealed input reference.');
        return committed;
      } catch (error) {
        if (repair !== 0 || error.code !== 'INPUT_BLOBS_MISSING' || error.httpStatus !== 409 || record.controller.signal.aborted) throw error;
      } finally { metrics.commitMs += performance.now() - commitStarted; }
    }
  }
  async configuration() {
    // 网关地址和签名公钥来自应用部署，设置页面不能自行指定服务器。
    const configured = await this.getGatewaySettings();
    if (typeof configured?.gatewayUrl !== 'string' || !configured.gatewayUrl.trim()) {
      throw protocol.error('GATEWAY_INVALID', 'Cloud gateway deployment is not configured.');
    }
    return { gatewayUrl: gatewayUrl(configured.gatewayUrl).url,
      publicKey: typeof configured.publicKey === 'string' ? configured.publicKey.trim() : undefined };
  }
  async health() {
    const settings = await this.configuration();
    const capabilities = await this.request(settings, '/api/v1/build/capabilities', undefined, undefined,
      { timeoutMs: this.healthTimeoutMs, maxResponseBytes: 64 * 1024 });
    const publicKey = trustedGateway(settings, capabilities);
    if (capabilities.schemaVersion !== 1 || capabilities.signatureAlgorithm !== 'Ed25519') {
      throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway cloud build schema or signature algorithm is unsupported.');
    }
    // 网关可连接且签名身份可信即可启用，节点忙碌或离线不等于网关故障。
    return { healthy: true, settings: { gatewayUrl: settings.gatewayUrl, publicKey: publicKey.trim() } };
  }
  targets(settings, signal, profileDigest, selector = {}) {
    if (profileDigest !== undefined && (typeof profileDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(profileDigest))) throw protocol.error('TARGET_UNSUPPORTED', 'Invalid target profile digest.');
    const params = new URLSearchParams();
    if (profileDigest !== undefined) params.set('profileDigest', profileDigest);
    const boardKeys = ['boardModule', 'boardVersion', 'boardDigest'];
    const selected = boardKeys.filter(key => selector[key] !== undefined);
    if (selected.length && selected.length !== boardKeys.length) throw protocol.error('TARGET_UNSUPPORTED', 'Board target selectors must include module, version and content digest.');
    for (const key of ['boardModule', 'boardVersion', 'boardDigest']) if (selector[key] !== undefined) {
      const value = selector[key];
      if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f]/u.test(value)
          || (key === 'boardDigest' && !/^[a-f0-9]{64}$/u.test(value))
          || (key === 'boardModule' && !/^@[^/\\]+\/(?:board|coder)-[A-Za-z0-9_.-]+$/u.test(value))) throw protocol.error('TARGET_UNSUPPORTED', 'Invalid board target selector.');
      params.set(key, value);
    }
    const query = params.size ? `?${params}` : '';
    if (!Object.keys(selector).some(key => ['boardModule', 'boardVersion', 'boardDigest'].includes(key) && selector[key] !== undefined)) {
      return this.request(settings, '/api/v1/build/targets' + query, undefined, signal);
    }
    return (async () => {
      // 先按板包名称和已安装版本检查支持，再保留内容摘要及编译环境的精确匹配。
      this.assertBoardSupported(await this.boardSupport(settings, selector, signal));
      // 旧网关可能拒绝未知筛选参数，先协商能力，再选择服务端或本地筛选。
      const key = gatewayUrl(settings.gatewayUrl).url;
      let cached = this.catalogCapabilities.get(key);
      if (!cached || cached.expiresAt <= Date.now()) {
        const promise = this.capabilities(settings);
        cached = { promise, expiresAt: Date.now() + 30000 }; this.catalogCapabilities.set(key, cached);
        promise.catch(() => { if (this.catalogCapabilities.get(key) === cached) this.catalogCapabilities.delete(key); });
        while (this.catalogCapabilities.size > 16) this.catalogCapabilities.delete(this.catalogCapabilities.keys().next().value);
      }
      const caps = await cached.promise;
      signal?.throwIfAborted();
      const endpoint = caps.targetLookupByBoard === true ? '/api/v1/build/targets' + query
        : '/api/v1/build/targets' + (profileDigest ? `?profileDigest=${profileDigest}` : '');
      const catalog = await this.request(settings, endpoint, undefined, signal);
      if (!Array.isArray(catalog.profiles)) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid target catalog.');
      return { ...catalog, profiles: catalog.profiles.filter(profile => ['boardModule', 'boardVersion', 'boardDigest'].every(key => selector[key] === undefined || profile[key] === selector[key])) };
    })();
  }
  owner(sender) {
    const owner = this.getOwner(sender);
    if (!owner || sender?.isDestroyed?.()) throw protocol.error('BUILD_OWNER_EXPIRED', 'The current application owner is unavailable.');
    return owner;
  }
  async assertCurrent(record, config = record.config) {
    // 编译前后及烧录前复核页面、编辑器和实际文件，源码变化时禁止发布或复用旧产物。
    if (Number.isFinite(record.startedAt) && Date.now() - record.startedAt >= this.deadlineMs && !record.controller.signal.aborted) {
      record.controller.abort(protocol.error('BUILD_TIMEOUT', 'Cloud task exceeded its client deadline.'));
    }
    if (record.controller.signal.aborted) throw record.controller.signal.reason || abortFault();
    const owner = this.owner(record.sender);
    if (owner.generation !== record.generation || (this.requests.get(record.requestId) !== record && this.active.get(record.root) !== record)) throw protocol.error('BUILD_OWNER_EXPIRED', 'Build owner changed.');
    if (config.sourceCapture) confirmBuildSource(config);
    if (this.querySource) {
      const answer = await this.querySource(record.root, record.controller.signal);
      const source = answer?.source;
      if (answer?.ok !== true || !source || fs.realpathSync(source.projectPath) !== record.root || source.boardModule !== record.config.boardModule
          || (record.activationId && source.activationId !== record.activationId) || (source.mode === 'coder' && source.saved !== true)) {
        throw protocol.error('BUILD_SOURCE_STALE', 'The active project/editor changed during the cloud build.');
      }
      const captured = record.config.sourceCapture?.workspace;
      if (captured && ['scope', 'documentSha256', 'revision', 'runtimeRevision', 'pageId'].some(key => source.workspace?.[key] !== captured[key])) {
        throw protocol.error('BUILD_SOURCE_STALE', 'Blockly document or generator revision changed.');
      }
      record.activationId ||= source.activationId;
    }
    if (record.snapshot) {
      const identityStarted = performance.now();
      let identity;
      try { identity = captureIdentity(config, record.profile); }
      finally { if (record.inputMetrics) record.inputMetrics.identityMs += performance.now() - identityStarted; }
      if (identity.inputDigest !== record.snapshot.inputDigest) throw protocol.error('BUILD_SOURCE_STALE', 'Project source, libraries, macros or board options changed.');
    }
    if (Number.isFinite(record.startedAt) && Date.now() - record.startedAt >= this.deadlineMs && !record.controller.signal.aborted) {
      record.controller.abort(protocol.error('BUILD_TIMEOUT', 'Cloud task exceeded its client deadline.'));
    }
    if (record.controller.signal.aborted) throw record.controller.signal.reason || abortFault();
    if (this.owner(record.sender).generation !== record.generation
        || (this.requests.get(record.requestId) !== record && this.active.get(record.root) !== record)) throw protocol.error('BUILD_OWNER_EXPIRED', 'Build owner changed during source verification.');
  }
  progress(record, event) {
    if (!record.controller.signal.aborted && this.requests.get(record.requestId) === record) record.onProgress?.({ requestId: record.requestId, jobId: record.jobId,
      ...event });
  }
  async run(sender, input, onProgress) {
    supportedRequest(input);
    const owner = this.owner(sender);
    // 请求 ID 由页面持有并用于取消；主进程不能生成页面不知道、销毁时也无法取消的备用 ID。
    const requestId = input.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId) || this.requests.has(requestId)) throw protocol.error('BUILD_BUSY', 'Cloud build request is invalid or already running.');
    const root = fs.realpathSync(input.config?.currentProjectPath);
    if ([...this.requests.values()].some(item => item.root === root)) throw protocol.error('BUILD_BUSY', 'This project already has a cloud task.');
    const record = { requestId, root, sender, generation: owner.generation, config: input.config,
      settings: { ...(input.settings || {}) }, controller: new AbortController(), logsController: new AbortController(), onProgress, startedAt: Date.now(),
      inputMetrics: { captureMs: 0, identityMs: 0, encodingMs: 0, encodedFiles: 0,
        manifestPrepareMs: 0, manifestResolveMs: 0, blobUploadMs: 0, commitMs: 0,
        rawBytes: 0, uniqueBytes: 0, transferredBytes: 0, uploadedBytes: 0, reusedBytes: 0, libraryHits: 0 } };
    // Keep the previous directory alive while checking this request, but revoke
    // its upload authority immediately. Only fresh inputs and a live target can
    // restore it; a failed/cancelled request must not retain the old authority.
    const previous = this.active.get(root);
    const releasePrevious = previous ? this.protectArtifact(previous) : undefined;
    this.requests.set(requestId, record); this.active.delete(root);
    const deadline = setTimeout(() => record.controller.abort(protocol.error('BUILD_TIMEOUT', 'Cloud task exceeded its client deadline.')), this.deadlineMs);
    deadline.unref?.();
    let releasePowerSaveBlocker;
    try {
      // 每个任务只持有自己申请的防休眠释放函数，不影响其他任务。
      try { releasePowerSaveBlocker = this.acquirePowerSaveBlocker?.(); }
      catch { /* 防休眠不可用时仍允许编译。 */ }
      this.progress(record, { stage: 'preparing', progress: 0 });
      await this.assertCurrent(record);
      const boardRoot = path.join(root, 'node_modules', record.config.boardModule);
      const boardPackage = JSON.parse(fs.readFileSync(path.join(boardRoot, 'package.json'), 'utf8'));
      const identity = protocol.boardDigest(boardPackage, JSON.parse(fs.readFileSync(path.join(boardRoot, 'board.json'), 'utf8')));
      const discovery = new AbortController(), discoverySignal = AbortSignal.any([record.controller.signal, discovery.signal]);
      let caps, catalog;
      try {
        [caps, catalog] = await Promise.all([this.capabilities(record.settings, discoverySignal),
          this.targets(record.settings, discoverySignal, input.profileDigest, {
            boardModule: record.config.boardModule, boardVersion: boardPackage.version, boardDigest: identity,
          })]);
      } catch (error) { discovery.abort(error); throw error; }
      record.publicKey = trustedGateway(record.settings, caps);
      record.profile = catalog.profiles?.find(profile => (profile.digest || profile.profileDigest) === input.profileDigest
        && profile.boardModule === record.config.boardModule && profile.boardVersion === boardPackage.version && profile.boardDigest === identity && profile.runner === 'aily-builder'
        && profile.metadata?.fixture !== true && (input.action === 'analysis' || profile.capabilities?.compile === true));
      if (!record.profile) throw protocol.error('TARGET_UNSUPPORTED', 'No matching verified Arduino compiler node is available.');
      if (input.action === 'analysis' && record.profile.capabilities?.analysis !== true) throw protocol.error('PROTOCOL_UNSUPPORTED', 'This compiler profile does not support cloud preprocessing yet.');
      this.progress(record, { stage: 'capturing', progress: 0 });
      const captureStarted = performance.now();
      try { record.snapshot = captureSnapshot(record.config, record.profile, { onEncode: metrics => {
        record.inputMetrics.encodingMs += metrics.durationMs; record.inputMetrics.encodedFiles++;
      } }); }
      finally { record.inputMetrics.captureMs += performance.now() - captureStarted; }
      await this.assertCurrent(record);
      if (previous) {
        const reused = await this.reuseCompletedResult(record, previous, input.action || 'compile');
        if (reused) return reused;
        await this.assertCurrent(record);
      }
      this.progress(record, { stage: 'uploading', progress: 0 });
      const uploaded = await this.uploadSnapshot(record, caps);
      if (uploaded.inputDigest !== record.snapshot.inputDigest) throw protocol.error('INPUT_DIGEST_MISMATCH', 'Gateway sealed different build inputs.');
      record.postBody = { requestId, snapshotId: uploaded.snapshotId, profileDigest: record.profile.digest || record.profile.profileDigest,
        action: input.action || 'compile', clientInputMetrics: clientInputMetrics(record.inputMetrics) };
      let created;
      for (let repair = 0; ; repair++) {
        record.posted = true;
        try {
          created = await this.request(record.settings, '/api/v1/build/jobs', record.postBody, record.controller.signal);
          break;
        }
        catch (error) {
          if (error.code !== 'INPUT_BLOBS_MISSING' || error.httpStatus !== 409 || record.inputTransportVersion !== 2) throw error;
          // 入队前确认缺少输入并未创建任务；补传失败时，取消逻辑不能反而重放出新任务。
          record.posted = false;
          if (repair !== 0 || record.controller.signal.aborted) throw error;
          await this.assertCurrent(record);
          const replenished = await this.uploadSnapshot(record, caps);
          if (replenished.snapshotId !== record.postBody.snapshotId) throw protocol.error('INPUT_DIGEST_MISMATCH', 'Gateway changed an idempotent input identity.');
        }
      }
      record.jobId = created.jobId;
      if (typeof record.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(record.jobId)) throw protocol.error('PROTOCOL_UNSUPPORTED', 'Gateway returned an invalid task identity.');
      record.snapshot = { inputDigest: record.snapshot.inputDigest, boardDigest: record.snapshot.boardDigest, boardVersion: record.snapshot.boardVersion };
      this.progress(record, { stage: 'queued', progress: 0 });
      let lastSeq = 0;
      let logRequest;
      const pullLogs = advertisedLastSeq => {
        if (logRequest) return logRequest;
        if (Number.isSafeInteger(advertisedLastSeq) && advertisedLastSeq >= 0 && advertisedLastSeq <= lastSeq) return;
        // 运行期间异步读取，不阻塞状态刷新；失败返回前等待末尾诊断。
        logRequest = this.request(record.settings, `/api/v1/build/jobs/${record.jobId}/logs?afterSeq=${lastSeq}`, undefined,
          AbortSignal.any([record.controller.signal, record.logsController.signal])).then(logs => {
          for (const line of logs.logs || logs.entries || []) {
            if (line.seq > lastSeq) { lastSeq = line.seq; this.progress(record, { log: line.message || line.text || line.data?.message || '', stream: line.stream || line.data?.stream || 'stdout' }); }
          }
        }).catch(() => { /* 日志失败不改变任务状态和签名产物的可信性。 */ })
          .finally(() => { logRequest = undefined; });
        return logRequest;
      };
      const waitBudget = caps.statusWait?.version === 1 && Number.isSafeInteger(caps.statusWait.maxWaitMs)
        ? Math.min(Math.max(0, this.statusWaitMs), caps.statusWait.maxWaitMs, this.requestTimeoutMs - 2000) : 0;
      let statusWaiting = waitBudget > 0, observedVersion, observedSeq;
      let delay = this.initialPollIntervalMs ?? this.pollIntervalMs;
      for (;;) {
        if (delay > 0) await wait(delay, record.controller.signal);
        record.controller.signal.throwIfAborted();
        if (this.owner(record.sender).generation !== record.generation) throw protocol.error('BUILD_OWNER_EXPIRED', 'Build owner changed.');
        if (Date.now() - record.startedAt > this.deadlineMs) throw protocol.error('BUILD_TIMEOUT', 'Cloud task exceeded its client deadline.');
        let status;
        const canWait = statusWaiting && Number.isSafeInteger(observedVersion) && observedVersion >= 1
          && Number.isSafeInteger(observedSeq) && observedSeq >= 0;
        const cursor = canWait ? `?afterVersion=${observedVersion}&afterSeq=${observedSeq}&waitMs=${waitBudget}` : '';
        const statusStarted = performance.now();
        try {
          status = await this.request(record.settings, `/api/v1/build/jobs/${record.jobId}${cursor}`, undefined, record.controller.signal);
          const unchanged = status.stateVersion === observedVersion && status.lastSeq === observedSeq;
          // 代理忽略等待参数或网关等待容量不足时，退回普通轮询，防止高频空转。
          if (canWait && unchanged && performance.now() - statusStarted < waitBudget / 2) statusWaiting = false;
          observedVersion = status.stateVersion; observedSeq = status.lastSeq;
          delay = statusWaiting && Number.isSafeInteger(observedVersion) && Number.isSafeInteger(observedSeq)
            ? Math.max(0, 150 - (performance.now() - statusStarted))
            : ['preparing', 'resources', 'analyzing', 'compiling', 'finalizing'].includes(status.stage || status.status)
            ? this.activePollIntervalMs ?? this.pollIntervalMs : this.pollIntervalMs;
        }
        catch (error) {
          if (canWait && !record.controller.signal.aborted && [400, 404, 405, 429, 501].includes(error.httpStatus)) {
            statusWaiting = false; delay = this.activePollIntervalMs ?? this.pollIntervalMs; continue;
          }
          if (record.controller.signal.aborted || (error.httpStatus && error.httpStatus < 500 && error.httpStatus !== 429)) throw error;
          delay = Math.min(Math.max(delay, this.pollIntervalMs) * 2, 60000); this.progress(record, { stage: 'reconnecting' }); continue;
        }
        record.attempt = status.attempt;
        this.progress(record, { stage: status.stage || status.status, progress: status.progress ?? status.stageProgress ?? 0, status: status.status, attempt: status.attempt });
        pullLogs(status.lastSeq);
        if (['failed', 'cancelled', 'timed_out'].includes(status.status)) {
          // 状态可能先于日志请求完成。按终态游标补齐分页，避免 finally
          // 取消尚未返回的编译器错误；日志不可用/不前进时仍返回原始失败。
          if (status.status !== 'cancelled') {
            let previousSeq;
            do {
              previousSeq = lastSeq;
              await pullLogs(status.lastSeq);
            } while (!record.controller.signal.aborted && lastSeq > previousSeq
              && (!Number.isSafeInteger(status.lastSeq) || lastSeq < status.lastSeq));
          }
          throw protocol.error(status.error?.code || 'COMPILE_ERROR', status.error?.message || 'Cloud compilation failed.');
        }
        if (status.status === 'succeeded') break;
      }
      await this.assertCurrent(record);
      this.progress(record, { stage: 'downloading', progress: 0 });
      const result = await this.request(record.settings, `/api/v1/build/jobs/${record.jobId}/result`, undefined, record.controller.signal);
      await this.importResult(record, result);
      this.progress(record, { stage: 'complete', progress: 100 });
      return { success: true, state: 'done', text: 'Cloud compilation complete.', jobId: record.jobId, inputDigest: record.snapshot.inputDigest,
        artifactPath: this.active.get(root)?.directory };
    } catch (error) {
      await this.cancelRemote(record).catch(() => {});
      throw record.controller.signal.aborted ? record.controller.signal.reason || abortFault() : error;
    } finally {
      clearTimeout(deadline);
      try { if (typeof releasePowerSaveBlocker === 'function') releasePowerSaveBlocker(); }
      catch { /* 防休眠清理异常不能覆盖编译结果或原始错误。 */ }
      record.logsController.abort();
      if (this.requests.get(requestId) === record) this.requests.delete(requestId);
      releasePrevious?.();
      this.collectArtifacts(root);
    }
  }
  async reuseCompletedResult(record, previous, action) {
    if (action !== 'compile' || !previous || previous.sender !== record.sender
        || previous.generation !== record.generation || previous.controller.signal.aborted
        || previous.activationId !== record.activationId
        || previous.gatewayUrl !== gatewayUrl(record.settings.gatewayUrl).url
        || previous.publicKey.trim() !== record.publicKey.trim()
        || previous.manifest.action !== action
        || previous.manifest.profileDigest !== (record.profile.digest || record.profile.profileDigest)
        || previous.snapshot.inputDigest !== record.snapshot.inputDigest) return null;
    let lease;
    try {
      lease = this.acquireArtifactLease(previous);
      if (fs.realpathSync(previous.directory) !== previous.directory || fs.lstatSync(previous.directory).isSymbolicLink()) return null;
      await this.assertCurrent(record); lease.assertOwned();
      protocol.verifyManifest(previous.manifest, previous.signature, record.publicKey);
      for (const artifact of previous.manifest.artifacts) {
        const filename = path.join(previous.directory, ...artifact.path.split('/'));
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename
            || stat.size !== artifact.sizeBytes || protocol.sha256(fs.readFileSync(filename)) !== artifact.sha256) return null;
      }
      // No awaits after the byte checks: only the freshly checked request can
      // regain upload authority. A disk-only receipt never grants permission.
      lease.assertOwned();
    } catch { return null; } // Missing/corrupt/unavailable output falls back to a real build.
    finally { lease?.release(); }
    this.active.set(record.root, { ...previous, config: retainedBuildConfig(record.config),
      activationId: record.activationId, controller: new AbortController(), profile: record.profile });
    this.progress(record, { stage: 'complete', progress: 100, reused: true });
    // This is the original completed job, not a newly executed cloud task.
    return { success: true, state: 'done', reused: true, text: 'Reused verified cloud build result.',
      jobId: previous.manifest.jobId, inputDigest: record.snapshot.inputDigest, artifactPath: previous.directory };
  }
  async cancelRemote(record) {
    if (!record.jobId && !record.posted) return;
    if (!record.cancelPromise) record.cancelPromise = (async () => {
      // 提交结果不明确时，使用同一请求 ID 幂等找回任务再取消；整个过程共享有限等待预算。
      const controller = new AbortController();
      let stop;
      const aborted = new Promise((resolve, reject) => {
        stop = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', stop, { once: true });
      });
      const timer = setTimeout(() => controller.abort(protocol.error('GATEWAY_TIMEOUT', 'Remote cancellation timed out.')), this.cancelTimeoutMs);
      const cleanup = (async () => {
        if (!record.jobId && record.posted && record.postBody) {
          const created = await this.request(record.settings, '/api/v1/build/jobs', record.postBody, controller.signal);
          record.jobId = created.jobId;
        }
        if (record.jobId) return this.request(record.settings, `/api/v1/build/jobs/${record.jobId}/cancel`, {}, controller.signal);
      })();
      try { return await Promise.race([cleanup, aborted]); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); }
    })();
    return record.cancelPromise;
  }
  async cancel(sender, requestId) {
    const record = this.requests.get(requestId);
    if (!record || record.sender !== sender) return false;
    record.controller.abort(abortFault());
    await this.cancelRemote(record).catch(() => {});
    return true;
  }
  async importResult(record, result) {
    const manifest = result.manifest;
    protocol.verifyManifest(manifest, result.signature, record.publicKey);
    if (manifest.kind !== 'aily-cloud-build-result' || manifest.schemaVersion !== 1 || manifest.jobId !== record.jobId
        || manifest.inputDigest !== record.snapshot.inputDigest || manifest.profileDigest !== (record.profile.digest || record.profile.profileDigest)
        || manifest.boardDigest !== record.snapshot.boardDigest || manifest.boardModule !== record.config.boardModule
        || manifest.boardVersion !== record.snapshot.boardVersion || manifest.action !== record.postBody.action || manifest.runner !== 'aily-builder'
        || !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1 || manifest.attempt !== record.attempt
        || manifest.fixture === true || !Array.isArray(manifest.artifacts) || !manifest.artifacts.length || manifest.artifacts.length > 128) {
      throw protocol.error('ARTIFACT_INVALID', 'Cloud result does not match this build request.');
    }
    // 下载前核验完整签名清单及引用，禁止冲突路径、额外文件和跨来源下载。
    if (!Array.isArray(result.artifacts) || result.artifacts.length !== manifest.artifacts.length) throw protocol.error('ARTIFACT_INVALID', 'Invalid artifact download inventory.');
    const references = new Map();
    for (const downloadable of result.artifacts) {
      if (!downloadable || typeof downloadable.artifactId !== 'string' || references.has(downloadable.artifactId)) throw protocol.error('ARTIFACT_INVALID', 'Duplicate or missing artifact download reference.');
      references.set(downloadable.artifactId, downloadable);
    }
    const seen = new Set(), ids = new Set(); let total = 0;
    const base = gatewayUrl(record.settings.gatewayUrl).url;
    const downloads = manifest.artifacts.map(artifact => {
      protocol.validateRelativePath(artifact?.path);
      const normalized = artifact.path.toLowerCase();
      if (seen.has(normalized) || ['aily-cloud-result.json', 'aily-cloud-import.json'].includes(normalized.split('/')[0])
          || typeof artifact.artifactId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/u.test(artifact.artifactId) || ids.has(artifact.artifactId)
          || typeof artifact.role !== 'string' || !artifact.role.length || artifact.role.length > 256 || /[\x00-\x1f]/u.test(artifact.role)
          || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1 || (total += artifact.sizeBytes) > 64 * 1024 * 1024
          || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw protocol.error('ARTIFACT_INVALID', 'Invalid cloud artifact inventory.');
      seen.add(normalized); ids.add(artifact.artifactId);
      const downloadable = references.get(artifact.artifactId);
      if (!downloadable || downloadable.path !== artifact.path || downloadable.sizeBytes !== artifact.sizeBytes
          || downloadable.sha256 !== artifact.sha256 || typeof downloadable.downloadUrl !== 'string') throw protocol.error('ARTIFACT_INVALID', 'Artifact download reference is missing or mismatched.');
      let url;
      try { url = new URL(downloadable.downloadUrl, base); } catch { throw protocol.error('ARTIFACT_INVALID', 'Invalid artifact download URL.'); }
      if (url.origin !== new URL(base).origin || url.username || url.password || !url.pathname.startsWith('/api/v1/build/artifacts/')) throw protocol.error('ARTIFACT_INVALID', 'Unapproved artifact download origin.');
      return { artifact, url };
    });
    for (const filename of seen) {
      const parts = filename.split('/'); parts.pop();
      while (parts.length) {
        if (seen.has(parts.join('/'))) throw protocol.error('ARTIFACT_INVALID', 'Artifact file paths overlap.');
        parts.pop();
      }
    }
    const temporary = path.join(record.root, '.temp');
    fs.mkdirSync(temporary, { recursive: true });
    if (fs.realpathSync(temporary) !== temporary || fs.lstatSync(temporary).isSymbolicLink()) throw protocol.error('UNSAFE_PATH', 'Cloud import temporary directory is linked.');
    const staging = path.join(temporary, `cloud-import-${crypto.randomUUID()}`);
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'aily-cloud-import.json'), JSON.stringify({ schemaVersion: 1, kind: 'aily-cloud-owned-directory', pid: process.pid }), { flag: 'wx' });
    record.staging = staging;
    let published;
    try {
      const group = new AbortController();
      const receivedByArtifact = new Map(); let receivedTotal = 0, lastPercent = -1, lastPublishedAt = 0;
      const downloadProgress = (artifact, bytes) => {
        const previous = receivedByArtifact.get(artifact.artifactId) || 0;
        // 重试收到的相同字节不能重复累计下载进度。
        const received = Math.max(previous, Math.min(bytes, artifact.sizeBytes));
        receivedByArtifact.set(artifact.artifactId, received); receivedTotal += received - previous;
        const percent = Math.floor(receivedTotal * 100 / total), now = Date.now();
        if (percent !== lastPercent && (lastPercent < 0 || percent === 100 || now - lastPublishedAt >= 100)) {
          lastPercent = percent; lastPublishedAt = now;
          this.progress(record, { stage: 'downloading', progress: percent });
        }
      };
      let cursor = 0, downloadFailure;
      const worker = async () => {
        while (cursor < downloads.length && !group.signal.aborted) {
          const { artifact, url } = downloads[cursor++];
          try {
            const bytes = await this.downloadArtifact(record, artifact, url, group.signal,
              received => downloadProgress(artifact, received));
            const filename = path.join(staging, ...artifact.path.split('/'));
            fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes, { flag: 'wx' });
          } catch (error) {
            downloadFailure ||= error;
            group.abort(downloadFailure);
            throw error;
          }
        }
      };
      // 等待所有并行下载结束后才能清理暂存区或发布文件，避免取消后的写入竞态。
      await Promise.allSettled(Array.from({ length: Math.min(4, downloads.length) }, worker));
      if (downloadFailure) throw downloadFailure;
      await this.assertCurrent(record);
      this.progress(record, { stage: 'verifying', progress: 100 });
      const lease = acquireBuildWorkspace(record.root, 'publish');
      try {
        await this.assertCurrent(record); lease.assertOwned();
        const directory = path.join(record.root, '.build', 'cloud');
        fs.mkdirSync(directory, { recursive: true });
        if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw protocol.error('UNSAFE_PATH', 'Cloud artifact directory is linked.');
        published = path.join(directory, `${record.jobId}-${crypto.randomUUID()}`);
        fs.writeFileSync(path.join(staging, 'aily-cloud-result.json'), JSON.stringify({ manifest, signature: result.signature }));
        fs.renameSync(staging, published);
        // 已验证产物的复用和烧录权限只保存在当前进程内，不额外写入无读取方的磁盘指针。
        const config = retainedBuildConfig(record.config);
        this.active.set(record.root, { root: record.root, sender: record.sender, generation: record.generation, activationId: record.activationId,
          config, controller: new AbortController(), profile: record.profile, publicKey: record.publicKey,
          gatewayUrl: gatewayUrl(record.settings.gatewayUrl).url,
          snapshot: { inputDigest: record.snapshot.inputDigest, boardDigest: record.snapshot.boardDigest, boardVersion: record.snapshot.boardVersion },
          directory: published, manifest, signature: result.signature });
        this.trimCompletedRecords();
        this.collectArtifacts(record.root, lease);
      } finally { lease.release(); }
    } catch (error) { if (published) { try { removeOwnedDirectory(record.root, published); } catch { /* 不确定归属的路径保留现场。 */ } } throw error; }
    finally {
      try { if (fs.existsSync(staging)) removeOwnedDirectory(record.root, staging); } catch { /* 暂存路径被替换时不能跟随链接清理。 */ }
      delete record.staging;
    }
  }
  async downloadArtifact(record, artifact, url, groupSignal, onBytes) {
    const shared = AbortSignal.any([record.controller.signal, groupSignal]);
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs), signal = AbortSignal.any([shared, timeout]);
      try {
        signal.throwIfAborted();
        const response = await this.fetch(url, { credentials: 'omit', redirect: 'error', signal });
        if (!response.ok) throw Object.assign(protocol.error('ARTIFACT_DOWNLOAD_FAILED', 'Artifact download failed.'), { httpStatus: response.status });
        const bytes = await boundedBytes(response, artifact.sizeBytes, onBytes);
        signal.throwIfAborted();
        if (bytes.length !== artifact.sizeBytes || protocol.sha256(bytes) !== artifact.sha256) throw protocol.error('ARTIFACT_INVALID', 'Artifact bytes failed integrity verification.');
        return bytes;
      } catch (error) {
        if (shared.aborted) throw shared.reason || abortFault();
        const transient = timeout.aborted || error instanceof TypeError || ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(error.code)
          || error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500;
        if (!transient || attempt >= 2) throw error;
        await wait(this.artifactRetryDelayMs * 2 ** attempt, shared);
      }
    }
  }
  protectArtifact(record) {
    this.artifactUsers.set(record.directory, (this.artifactUsers.get(record.directory) || 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const count = this.artifactUsers.get(record.directory) - 1;
      if (count) this.artifactUsers.set(record.directory, count); else this.artifactUsers.delete(record.directory);
      this.collectArtifacts(record.root);
    };
  }
  acquireArtifactLease(record) { return acquireBuildWorkspace(record.root, 'verify'); }
  collectArtifacts(root, lease) {
    try {
      const protectedDirectories = [...this.active.values()].filter(item => item.root === root).map(item => item.directory);
      for (const item of this.requests.values()) if (item.root === root && item.staging) protectedDirectories.push(item.staging);
      protectedDirectories.push(...this.artifactUsers.keys());
      return collectCloudArtifacts(root, { protectedDirectories, retention: this.retention, lease });
    } catch { return []; } // 工作区忙碌或路径归属不明确时延后清理。
  }
  trimCompletedRecords() {
    let bytes = [...this.active.values()].reduce((sum, item) => sum + Buffer.byteLength(item.config.code || ''), 0);
    const newestRoot = [...this.active.keys()].at(-1);
    for (const [root, record] of this.active) {
      if (this.active.size <= 1 || (this.active.size <= 16 && bytes <= 32 * 1024 * 1024)) break;
      if (root === newestRoot || this.artifactUsers.has(record.directory)) continue;
      record.controller.abort(abortFault()); this.active.delete(root); bytes -= Buffer.byteLength(record.config.code || ''); this.collectArtifacts(root);
    }
  }
  async artifactPath(sender, projectPath, config) {
    this.owner(sender);
    const root = fs.realpathSync(projectPath), record = this.active.get(root);
    if (!record || record.sender !== sender) return null;
    // 复用权限只存在于当前进程的活动记录，磁盘上残留的结果文件不能自动恢复烧录权限。
    await this.assertCurrent(record, config);
    if (fs.realpathSync(record.directory) !== record.directory || fs.lstatSync(record.directory).isSymbolicLink()) throw protocol.error('UNSAFE_PATH', 'Active artifact directory changed.');
    return record.directory;
  }
  async reusable(sender, config, profileDigest) {
    const root = fs.realpathSync(config.currentProjectPath), record = this.active.get(root);
    if (!record || record.sender !== sender || config.code !== record.config.code || config.boardModule !== record.config.boardModule
        || (profileDigest !== undefined && profileDigest !== record.manifest.profileDigest)) return false;
    try {
      if (protocol.canonicalJson(config.sourceCapture?.workspace || null) !== protocol.canonicalJson(record.config.sourceCapture?.workspace || null)) return false;
      if (!await this.artifactPath(sender, root, config)) return false;
      protocol.verifyManifest(record.manifest, record.signature, record.publicKey);
      for (const artifact of record.manifest.artifacts) {
        const filename = path.join(record.directory, ...artifact.path.split('/'));
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== filename || stat.size !== artifact.sizeBytes || protocol.sha256(fs.readFileSync(filename)) !== artifact.sha256) return false;
      }
      return true;
    } catch { return false; }
  }
  async withCurrentArtifact(sender, projectPath, consume) {
    const owner = this.owner(sender), root = fs.realpathSync(projectPath), record = this.active.get(root);
    if (!record || record.sender !== sender || record.generation !== owner.generation) {
      throw protocol.error('BUILD_SOURCE_STALE', 'Cloud artifact is not current.');
    }
    // 统一在任务层持有产物和工作区租约，控制器不读取或修改内部活动记录。
    const workspaceLease = this.acquireArtifactLease(record);
    let releaseArtifact;
    try {
      releaseArtifact = this.protectArtifact(record);
      if (!await this.reusable(sender, record.config)) throw protocol.error('BUILD_SOURCE_STALE', 'Cloud artifact is not current.');
      return await consume(record, () => this.assertCurrent(record));
    } finally {
      try { workspaceLease.release(); } finally { releaseArtifact?.(); }
    }
  }
  invalidate(projectPath, sender) {
    try {
      const root = fs.realpathSync(projectPath), generation = sender ? this.owner(sender).generation : undefined;
      const matches = record => record.root === root && (!sender || (record.sender === sender && record.generation === generation));
      const active = this.active.get(root);
      if (active && matches(active)) { active.controller.abort(abortFault()); this.active.delete(root); }
      for (const record of this.requests.values()) if (matches(record)) {
        record.controller.abort(abortFault()); this.requests.delete(record.requestId); void this.cancelRemote(record).catch(() => {});
      }
      this.collectArtifacts(root);
    } catch { /* 项目已不存在或页面已失效，无需继续撤销。 */ }
  }
  invalidateOwner(sender, generation) {
    const roots = new Set(), cancelled = [];
    for (const [root, record] of this.active) if (record.sender === sender && record.generation === generation) {
      roots.add(root); record.controller.abort(protocol.error('BUILD_OWNER_EXPIRED', 'Build owner changed.')); this.active.delete(root);
    }
    for (const record of this.requests.values()) if (record.sender === sender && record.generation === generation) {
      roots.add(record.root); record.controller.abort(protocol.error('BUILD_OWNER_EXPIRED', 'Build owner changed.'));
      this.requests.delete(record.requestId); cancelled.push(this.cancelRemote(record));
    }
    for (const root of roots) this.collectArtifacts(root);
    return Promise.allSettled(cancelled);
  }
  invalidateAll() {
    const roots = new Set(this.active.keys()), cancelled = [];
    for (const record of this.active.values()) record.controller.abort(abortFault());
    this.active.clear();
    for (const record of this.requests.values()) {
      roots.add(record.root);
      record.controller.abort(abortFault()); this.requests.delete(record.requestId); cancelled.push(this.cancelRemote(record));
    }
    for (const root of roots) this.collectArtifacts(root);
    return Promise.allSettled(cancelled);
  }
}
module.exports = { CloudBuildBroker };
