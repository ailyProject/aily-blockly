/** Test-only transport observer for one normal desktop. Run through app.evaluate.
 * Authentication, dispatch, receipts and recovery remain production operations.
 * Only a verified response is disconnected or held; no outcome is manufactured. */
export function installNativeProgramTransportFault(electron, configuration) {
  const process = globalThis.process;
  const config = typeof configuration === 'string' ? JSON.parse(configuration) : configuration;
  const fs = process.getBuiltinModule('fs'), path = process.getBuiltinModule('path');
  const http = process.getBuiltinModule('http'), os = process.getBuiltinModule('os');
  const crypto = process.getBuiltinModule('crypto'), { Buffer } = process.getBuiltinModule('buffer');
  const hash = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  const same = (a, b) => typeof a === 'string' && typeof b === 'string'
    && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const canonical = value => JSON.stringify((function sorted(v) {
    return Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
  })(value));
  const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  const requestId = value => typeof value === 'string' && /^[A-Za-z0-9-]{16,80}$/.test(value);
  const validRef = ref => ref?.version === 1 && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(ref.id)
    && /^[a-f0-9]{64}$/.test(ref.revisionHash)
    && Object.keys(ref).every(key => ['version', 'id', 'revisionHash'].includes(key));
  const home = os.homedir(), normalAppData = path.join(home, 'AppData/Local/aily-project');
  const allowedParent = path.join(home, 'Documents/aily-project/copied-hantai-20261115');
  const normalRuntimeAppData = () => {
    if (process.env.AILY_APPDATA_PATH === undefined) return true;
    try {
      return same(fs.realpathSync.native(process.env.AILY_APPDATA_PATH), fs.realpathSync.native(config.appData));
    } catch { return false; }
  };
  if (process.platform !== 'win32' || process.pid !== config?.pid || !electron?.app?.isPackaged
    || !same(electron.app.getPath('home'), home) || !normalRuntimeAppData()
    || process.env.AILY_REPAIR_BOOTSTRAP !== undefined || process.env.AILY_REPAIR_READONLY_NPM_PREFIX !== undefined
    || process.env.AILY_MAIN_APPDATA_PATH !== undefined || !same(config.appData, normalAppData)
    || !same(config.allowedParent, allowedParent) || !path.isAbsolute(config.expectedProjectRoot ?? '')
    || !inside(allowedParent, config.expectedProjectRoot) || !same(config.project, config.expectedProjectRoot)
    || !Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535
    || !['loss', 'drift', 'stop', 'resume'].includes(config.mode)
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.caseId ?? '')
    || ['drift', 'stop'].includes(config.mode) && (typeof config.draftMarker !== 'string'
      || !config.draftMarker.trim() || config.draftMarker.length > 160 || /[\r\n\0]/.test(config.draftMarker))
    || config.originalRequestId !== undefined && !requestId(config.originalRequestId))
    throw Error('Transport fault requires the exact owned packaged normal desktop and project.');
  if (globalThis.__ailyNativeProgramTransportFault) throw Error('A native program transport observer already exists.');
  const directory = file => {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(fs.realpathSync.native(file), file))
      throw Error('Transport fault storage must use physical directories.');
    return stat;
  };
  directory(normalAppData); directory(allowedParent); directory(config.project);
  const attachment = () => {
    const before = directory(config.project), fd = fs.openSync(config.project, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true }), after = directory(config.project);
      if (!opened.isDirectory() || [before, after].some(stat => stat.ino !== opened.ino
        || stat.birthtimeNs !== opened.birthtimeNs || stat.dev !== 0n && stat.dev !== opened.dev))
        throw Error('The owned physical project changed during observation.');
      return { version: 1, root: config.project,
        identity: { dev: String(opened.dev), ino: String(opened.ino), birthtimeNs: String(opened.birthtimeNs) } };
    } finally { fs.closeSync(fd); }
  };
  const projectAttachment = attachment();
  const checkOwner = () => {
    if (process.pid !== config.pid || canonical(attachment()) !== canonical(projectAttachment))
      throw Error('The transport fault no longer owns its physical project.');
  };
  const stamp = stat => [stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
  const sameFile = (observed, opened) => observed.isFile() && !observed.isSymbolicLink() && observed.nlink === 1n
    && opened.isFile() && opened.nlink === 1n && String(opened.dev) === projectAttachment.identity.dev
    && (observed.dev === 0n || observed.dev === opened.dev)
    && ['ino', 'birthtimeNs', 'size', 'mtimeNs', 'ctimeNs'].every(key => observed[key] === opened[key]);
  const read = (relative, optional = false) => {
    checkOwner();
    const filename = path.resolve(config.project, relative);
    if (!inside(config.project, filename)) throw Error('Fault observation escaped its project.');
    for (let parent = path.dirname(filename); !same(parent, config.project); parent = path.dirname(parent)) directory(parent);
    let before;
    try { before = fs.lstatSync(filename, { bigint: true }); }
    catch (error) { if (optional && error.code === 'ENOENT') return { relative, bytes: null, hash: null, stamp: null }; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 128n * 1024n * 1024n)
      throw Error('Fault observation requires a regular unlinked bounded file.');
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!sameFile(before, opened)) throw Error('Observed file changed before read.');
      const bytes = fs.readFileSync(fd);
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened)
        || !sameFile(fs.lstatSync(filename, { bigint: true }), opened)) throw Error('Observed file changed during read.');
      return { relative, bytes, hash: hash(bytes), stamp: stamp(before), mode: Number(before.mode) };
    } finally { fs.closeSync(fd); }
  };
  const mirrorNames = ['project.abi', 'project.abs', 'project.abs.map.json'];
  const program = () => [...mirrorNames, '.aily/abs-sync/committed.json', '.aily/abs-sync/prepared.json']
    .map(name => read(name, name.endsWith('/prepared.json')));
  const assertProgram = expected => {
    const current = program();
    if (current.some((file, i) => file.hash !== expected[i].hash || file.stamp !== expected[i].stamp))
      throw Error('The observed three files or publication pointer changed before fault injection.');
  };
  const verifyOutput = body => {
    checkOwner();
    const binding = body.receipt?.output?.binding;
    if (!binding || !/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation) || !same(body.project, config.project)
      || !same(binding.scope?.projectKey, config.project) || typeof binding.scope?.pageId !== 'string'
      || ![binding.abiHash, binding.absHash, binding.mapHash].every(digest)
      || body.publication?.generation !== binding.generation || body.requiresReload !== false)
      throw Error('The real response does not identify the exact project generation.');
    const files = program();
    if (files[4].bytes !== null || mirrorNames.some((_, i) => files[i].hash !== binding[['abiHash', 'absHash', 'mapHash'][i]]))
      throw Error('The real response differs from its complete committed mirrors.');
    const pointer = JSON.parse(files[3].bytes), map = JSON.parse(files[2].bytes);
    const baseline = read(`.aily/abs-sync/baselines/${binding.generation}.json`);
    if (pointer.schemaVersion !== 1 || pointer.generation !== binding.generation || pointer.hash !== baseline.hash
      || map.generation !== binding.generation || map.baseAbsHash !== binding.absHash)
      throw Error('The real response has no checksum-bound current COMMITTED pointer.');
    return { binding, files, pointerHash: files[3].hash };
  };
  const journal = (id, ref, binding) => {
    const index = read(`.aily/abs-sync/recoveries/request-${hash(id).slice(7)}.json`), parsed = JSON.parse(index.bytes);
    if (parsed.version !== 1 || parsed.requestId !== id || !same(parsed.project, config.project)
      || !/^[a-f0-9-]{36}$/.test(parsed.operationId) || !digest(parsed.snapshotHash)) throw Error('Original request index is invalid.');
    const prefix = '.aily/abs-sync/recoveries/', operationId = parsed.operationId;
    const snapshot = read(`${prefix}operation-${operationId}.json`), value = JSON.parse(snapshot.bytes);
    const staged = read(`${prefix}application-${operationId}.json`), stage = JSON.parse(staged.bytes);
    const proof = read(`${prefix}application-commit-${operationId}.json`), commit = JSON.parse(proof.bytes);
    const final = read(`${prefix}application-result-${operationId}.json`, true);
    if (snapshot.hash !== parsed.snapshotHash || value.application?.requestId !== id
      || canonical(value.application?.validation?.workingCandidate) !== canonical(ref)
      || stage.validation?.requestId !== id || canonical(stage.validation?.workingCandidate) !== canonical(ref)
      || canonical(stage.outcome?.evidence?.binding) !== canonical(binding)
      || commit.operationId !== operationId || !same(commit.project, config.project) || commit.stageHash !== staged.hash
      || commit.committedHash !== read('.aily/abs-sync/committed.json').hash)
      throw Error('The original application journal does not bind the real response.');
    return Object.fromEntries([index, snapshot, staged, proof, final].map(file => [file.relative, file.hash]));
  };
  const servers = process._getActiveHandles().filter(value => value instanceof http.Server && value.address()?.port === config.port);
  if (servers.length !== 1) throw Error('The exact owned CLI HTTP server is unavailable.');
  const server = servers[0], originalEmit = server.emit;
  const state = { version: 1, available: true, mode: config.mode, caseId: config.caseId, project: config.project,
    normalAppData: config.appData, pid: process.pid, port: config.port, originalRequestId: config.originalRequestId ?? null,
    originalRef: null, original: null, commands: [], failures: [], attempted: false, drops: 0, injected: false,
    driftWritten: false, drift: null, backup: null, heldRecovery: false, recoveryRequestId: null,
    recovery: null, releasedRecovery: false, restored: false, authenticatedHandlerReplaced: false,
    discoveryRewritten: false, receiptFabricated: false };
  const fail = (code, error) => {
    if (state.failures.length < 64) state.failures.push({ code, message: String(error?.message ?? error).slice(0, 500), at: Date.now() });
  };
  const writeNew = (filename, bytes, mode = 0o600) => {
    checkOwner();
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const addDrift = proof => {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(proof.files[1].bytes);
    if (source.includes(config.draftMarker)) throw Error('The unique draft marker already exists.');
    const lines = source.split(/(?<=\n)/), setup = [];
    for (let i = 0; i < lines.length; i++)
      if (/^arduino_setup\(\)(?:[ \t]+@protect:\{[^\r\n]*\})?[ \t]*\r?\n?$/.test(lines[i])) setup.push(i);
    if (setup.length !== 1) throw Error('Expected one actual setup root in the committed ABS.');
    const matches = [];
    for (let i = setup[0] + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) break;
      const match = /^([ \t]+)serial_begin\(Serial,[ \t]*"9600"\)[ \t]*(\r?\n)?$/.exec(lines[i]);
      if (match) matches.push({ i, indent: match[1], newline: match[2] ?? (source.includes('\r\n') ? '\r\n' : '\n') });
    }
    if (matches.length !== 1) throw Error('Expected exactly one setup serial_begin(Serial, "9600") anchor.');
    const anchor = matches[0], newline = anchor.newline;
    if (!lines[anchor.i].endsWith('\n')) lines[anchor.i] += newline;
    lines.splice(anchor.i + 1, 0, `${anchor.indent}note_comment(${JSON.stringify(config.draftMarker)})${newline}`);
    const next = Buffer.from(lines.join(''), 'utf8'), backupDirectory = path.join(config.project, '.aily/backup/desktop-exception-' + config.caseId);
    for (const segment of ['.aily', '.aily/backup']) {
      const folder = path.join(config.project, segment);
      try { fs.mkdirSync(folder); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      directory(folder);
    }
    fs.mkdirSync(backupDirectory); directory(backupDirectory);
    assertProgram(proof.files);
    for (const file of proof.files.slice(0, 3)) writeNew(path.join(backupDirectory, file.relative), file.bytes);
    const manifest = { version: 1, project: config.project, attachment: projectAttachment, originalRequestId: state.originalRequestId,
      ref: state.originalRef, binding: proof.binding, files: Object.fromEntries(proof.files.map(file => [file.relative, file.hash])),
      draftMarker: config.draftMarker, afterAbsHash: hash(next), journal: state.original.journal };
    writeNew(path.join(backupDirectory, 'manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
    state.backup = { directory: backupDirectory, manifestHash: read(path.relative(config.project, path.join(backupDirectory, 'manifest.json'))).hash,
      files: proof.files.slice(0, 3).map(file => ({ path: path.join(backupDirectory, file.relative), hash: file.hash, bytes: file.bytes.length })) };
    const lockPath = path.join(config.project, '.aily/project-files.write.lock'), token = crypto.randomUUID();
    const owner = JSON.stringify({ pid: process.pid, token }), fd = fs.openSync(lockPath, 'wx', 0o600);
    let lockIdentity, temporary;
    try {
      fs.writeFileSync(fd, owner); fs.fsyncSync(fd); lockIdentity = fs.fstatSync(fd, { bigint: true });
      const guard = () => {
        checkOwner(); directory(path.dirname(lockPath)); directory(backupDirectory);
        if (!sameFile(fs.lstatSync(lockPath, { bigint: true }), lockIdentity) || fs.readFileSync(lockPath, 'utf8') !== owner)
          throw Error('The exact test publication lock changed.');
      };
      guard(); assertProgram(proof.files);
      temporary = path.join(config.project, `.project.abs.${crypto.randomUUID()}.tmp`);
      writeNew(temporary, next, proof.files[1].mode & 0o777);
      guard(); assertProgram(proof.files);
      fs.renameSync(temporary, path.join(config.project, 'project.abs')); temporary = undefined;
      state.driftWritten = true;
      guard();
      const after = program();
      if (after[1].hash !== hash(next) || after.some((file, i) => i !== 1 && (file.hash !== proof.files[i].hash || file.stamp !== proof.files[i].stamp)))
        throw Error('Post-injection program CAS changed outside the exact ABS draft.');
      state.drift = { marker: config.draftMarker, beforeAbsHash: proof.files[1].hash, afterAbsHash: after[1].hash,
        bytes: after[1].bytes.length, attachment: projectAttachment, pointerUnchanged: true, abiUnchanged: true, mapUnchanged: true };
    } finally {
      if (temporary && fs.existsSync(temporary) && hash(fs.readFileSync(temporary)) === hash(next)) fs.unlinkSync(temporary);
      const ours = lockIdentity && sameFile(fs.lstatSync(lockPath, { bigint: true }), lockIdentity) && fs.readFileSync(lockPath, 'utf8') === owner;
      fs.closeSync(fd);
      if (ours) fs.unlinkSync(lockPath);
      else throw Error('Preserved a changed test lock; no unrelated lock was removed.');
    }
  };
  let releaseHeld;
  const hook = function (event, ...args) {
    if (event !== 'request') return originalEmit.call(this, event, ...args);
    const [request, response] = args;
    if (request.method !== 'POST' || request.url !== '/command') return originalEmit.call(this, event, ...args);
    let command, chunks = [], size = 0;
    request.on('data', chunk => { size += chunk.length; if (size <= 1024 * 1024) chunks.push(Buffer.from(chunk)); else chunks = []; });
    request.once('end', () => {
      if (!chunks.length || size > 1024 * 1024) return;
      let payload; try { payload = JSON.parse(Buffer.concat(chunks)); } catch { return; }
      if (!same(payload.path, config.project)) return;
      const params = payload.params ?? {}, id = params.requestId ?? params.validation?.requestId;
      command = { at: Date.now(), cliAction: payload.action ?? null, operation: payload.operation ?? payload.action ?? null,
        action: params.action ?? null, requestId: typeof id === 'string' ? id : null,
        ref: validRef(params.validation?.workingCandidate) ? params.validation.workingCandidate
          : validRef(params.observation?.sourceRef) ? params.observation.sourceRef : null,
        requestHash: hash(Buffer.concat(chunks)), status: 'pending', dropped: false, held: false };
      if (state.commands.length < 512) state.commands.push(command); else fail('command-log-limit', 'Project CLI request log exceeded its bound.');
      if (command.operation === 'abs_apply' && id === state.originalRequestId) fail('original-apply-redispatched', 'The original application request was dispatched again.');
    });
    const originalEnd = response.end;
    response.end = function (...endArgs) {
      if (!command) return originalEnd.apply(this, endArgs);
      const raw = endArgs[0];
      let body;
      try {
        if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) throw Error('The real CLI response did not end with a JSON body.');
        body = JSON.parse(raw);
        Object.assign(command, { completedAt: Date.now(), status: 'responded', httpStatus: response.statusCode,
          ok: body.ok === true, code: body.code ?? body.errorCode ?? null, responseHash: hash(raw),
          publication: body.publication?.status ?? null, generation: body.publication?.generation ?? null,
          candidateApplied: typeof body.candidateApplied === 'boolean' ? body.candidateApplied : null });
        const apply = command.cliAction === 'blockly-live-operation' && command.operation === 'abs_apply';
        if (config.mode !== 'resume' && !state.attempted && apply && body.ok === true && body.publication?.status === 'COMMITTED') {
          state.attempted = true;
          const ref = body.receipt?.workingCandidate, id = body.receipt?.requestId;
          if (body.operation !== 'abs_apply' || body.receipt?.version !== 2 || !requestId(id) || id !== command.requestId
            || !validRef(ref) || canonical(ref) !== canonical(command.ref) || body.receipt.validation?.ok !== true
            || body.receipt.validation.scope !== 'complete-generation') throw Error('The actual apply receipt does not bind the exact requested candidate.');
          const proof = verifyOutput(body), journals = journal(id, ref, proof.binding);
          state.originalRequestId = id; state.originalRef = ref;
          state.original = { requestId: id, ref, responseHash: hash(raw), binding: proof.binding,
            pointerHash: proof.pointerHash, journal: journals, observedAt: Date.now() };
          if (state.commands.filter(value => value.operation === 'abs_apply' && value.requestId === id).length !== 1)
            throw Error('The first committed application was dispatched more than once.');
          if (['drift', 'stop'].includes(config.mode)) addDrift(proof); else assertProgram(proof.files);
          state.injected = true; state.drops = 1; command.dropped = true; command.status = 'dropped-after-real-commit';
          response.destroy(); return response;
        }
        if (config.mode === 'stop' && state.injected && !state.heldRecovery && command.operation === 'abs_recovery'
          && command.action === 'reconcile_program' && body.ok === true && body.publication?.status === 'COMMITTED') {
          const receipt = body.receipt;
          if (body.operation !== 'abs_recovery' || receipt?.version !== 2 || receipt.action !== 'reconcile_program'
            || receipt.requestId !== command.requestId || body.candidateApplied !== false)
            throw Error('The recovery ACK does not bind its real original request.');
          const proof = verifyOutput(body), archiveRef = body.recoveryArchive;
          if (archiveRef?.key !== `recoveries/${proof.binding.generation}.json` || !digest(archiveRef.hash))
            throw Error('The recovery ACK has no exact generation archive.');
          const archiveFile = read('.aily/abs-sync/' + archiveRef.key), archive = JSON.parse(archiveFile.bytes), origin = archive.programDrift;
          if (archiveFile.hash !== archiveRef.hash || archive.generation !== proof.binding.generation
            || origin?.originalRequestId !== state.originalRequestId || canonical(origin.sourceRef) !== canonical(state.originalRef)
            || canonical(origin.attachment) !== canonical(projectAttachment) || !Number.isSafeInteger(origin.workingRevision)
            || origin.expected?.absHash !== state.drift?.afterAbsHash || hash(archive.disk?.abs ?? '') !== state.drift?.afterAbsHash
            || origin.expected?.abiHash !== state.original.binding.abiHash || origin.expected?.mapHash !== state.original.binding.mapHash
            || origin.expected?.committedHash !== state.original.pointerHash || origin.expected?.preparedHash !== null
            || hash(archive.disk?.abi ?? '') !== state.original.binding.abiHash || hash(archive.disk?.map ?? '') !== state.original.binding.mapHash
            || hash(archive.committed?.pointer ?? '') !== state.original.pointerHash)
            throw Error('The recovery archive does not preserve this exact injected program and source lineage.');
          state.heldRecovery = true; state.recoveryRequestId = command.requestId;
          state.recovery = { requestId: command.requestId, responseHash: hash(raw), binding: proof.binding,
            archive: { key: archiveRef.key, hash: archiveRef.hash }, pointerHash: proof.pointerHash, committedAt: Date.now() };
          command.held = true; command.status = 'held-after-real-recovery-commit';
          releaseHeld = () => { state.releasedRecovery = true; return originalEnd.apply(response, endArgs); };
          return response;
        }
      } catch (error) { fail('unverified-real-response-or-injection', error); }
      return originalEnd.apply(this, endArgs);
    };
    return originalEmit.call(this, event, ...args);
  };
  server.emit = hook;
  globalThis.__ailyNativeProgramTransportFault = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => {
      if (server.emit !== hook) throw Error('Native transport observer ownership changed; no foreign hook was replaced.');
      server.emit = originalEmit; state.restored = true; releaseHeld?.();
    }
  };
  return { available: true, mode: config.mode, caseId: config.caseId, pid: process.pid, port: config.port };
}
