/** Passive test-only observer in the owned real Electron main process. It
 * never changes auth, request bodies, handlers, receipts or project files.
 * Only a complete, independently checked state publication ACK is dropped. */
export function installR2StateObservationFault(_electron, config) {
  if (typeof config === "string") config = JSON.parse(config);
  const process = globalThis.process;
  if (
    typeof process?.getBuiltinModule !== "function" ||
    typeof process._getActiveHandles !== "function"
  )
    return {
      available: false,
      reason: "native_http_server_observer_unavailable",
    };
  const fs = process.getBuiltinModule("fs"),
    path = process.getBuiltinModule("path");
  const http = process.getBuiltinModule("http"),
    crypto = process.getBuiltinModule("crypto");
  const { Buffer } = process.getBuiltinModule("buffer");
  const same = (left, right) =>
    typeof left === "string" &&
    typeof right === "string" &&
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  const canonical = (value) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  const hash = (bytes) =>
    "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
  if (
    process.pid !== config.pid ||
    process.env.AILY_APPDATA_PATH !== config.appData ||
    !path.isAbsolute(config.project) ||
    !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project) ||
    !same(fs.realpathSync(config.project), config.project) ||
    !Number.isSafeInteger(config.port) ||
    !Array.isArray(config.expectedDocument?.pages) ||
    !config.previousGeneration ||
    !/^sha256:[a-f0-9]{64}$/.test(config.inputAbiHash) ||
    (!config.observationOnly && config.originalState !== undefined) ||
    (config.observationOnly &&
      (!config.originalState ||
        !Number.isSafeInteger(config.originalTargetPid)))
  )
    throw Error(
      "State fault requires the exact owned project, original state input and host",
    );
  if (globalThis.__ailyR2StateObservationFault)
    throw Error("Do not install another state fault");
  const servers = process
    ._getActiveHandles()
    .filter(
      (value) =>
        value instanceof http.Server && value.address()?.port === config.port,
    );
  if (servers.length !== 1)
    return { available: false, reason: "exact_owned_cli_server_unavailable" };
  const server = servers[0],
    originalEmit = server.emit;
  const state = {
    available: true,
    armed: !config.observationOnly,
    state: config.originalState ?? null,
    requestId: config.originalState?.requestId ?? null,
    nativeRequestId: config.originalState
      ? "pub2-" + config.originalState.requestId
      : null,
    commands: [],
    terminals: [],
    drops: 0,
    delegatedResponses: 0,
    failures: [],
    unverifiedTerminalReplies: [],
    authenticatedHandlerReplaced: false,
    discoveryRewritten: false,
  };
  const physical = () => {
    const before = fs.lstatSync(config.project, { bigint: true });
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !same(fs.realpathSync(config.project), config.project)
    )
      throw Error("Owned project is not a physical directory");
    const fd = fs.openSync(
      config.project,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    try {
      const value = fs.fstatSync(fd, { bigint: true }),
        after = fs.lstatSync(config.project, { bigint: true });
      if (
        !value.isDirectory() ||
        !after.isDirectory() ||
        after.isSymbolicLink() ||
        !same(fs.realpathSync(config.project), config.project) ||
        before.ino !== value.ino ||
        before.birthtimeNs !== value.birthtimeNs ||
        after.ino !== value.ino ||
        after.birthtimeNs !== value.birthtimeNs ||
        (before.dev !== 0n && before.dev !== value.dev) ||
        (after.dev !== 0n && after.dev !== value.dev)
      )
        throw Error("Owned physical project changed during FD capture");
      return {
        dev: String(value.dev),
        ino: String(value.ino),
        birthtimeNs: String(value.birthtimeNs),
      };
    } finally {
      fs.closeSync(fd);
    }
  };
  const savedFile = (name) => {
    const file = path.join(config.project, name),
      stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
      throw Error("Publication file is not an owned regular file: " + name);
    const bytes = fs.readFileSync(file),
      after = fs.lstatSync(file, { bigint: true });
    if (
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs
    )
      throw Error("Publication file changed while reading: " + name);
    return bytes;
  };
  const verify = (body) => {
    const receipt = body?.saveReceipt,
      result = body?.result ?? body;
    if (receipt?.state !== "completed") return null;
    const raw = state.state,
      nativeId = state.nativeRequestId,
      observation = body.publicationObservation;
    const blockState = result.receipt,
      binding = blockState?.output?.binding,
      projection = result.projectionReceipt;
    const normalized = config.project.replace(/\\/g, "/").replace(/\/+$/, "");
    const projectKey =
      /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
        ? normalized.toLowerCase()
        : normalized;
    const digest = hash(
      canonical({
        version: 2,
        project: projectKey,
        operation: "blocks_set_state",
        request: raw,
      }),
    );
    if (
      !raw ||
      body.ok !== true ||
      result.ok !== true ||
      result.operation !== "blocks_set_state" ||
      !same(result.project, config.project) ||
      result.publication?.status !== "COMMITTED" ||
      result.requiresReload !== false ||
      receipt.version !== 2 ||
      receipt.requestId !== nativeId ||
      receipt.operation !== "blocks_set_state" ||
      !same(receipt.project, config.project) ||
      body.statePublication?.version !== 1 ||
      body.statePublication.requestId !== raw.requestId ||
      body.statePublication.nativeRequestId !== nativeId ||
      body.statePublication.inputDigest !== digest ||
      blockState?.version !== 2 ||
      blockState.action !== "update" ||
      blockState.requestId !== raw.requestId ||
      blockState.expectedGeneration !== raw.expectedGeneration ||
      blockState.expectedCanvas !== raw.expectedCanvas ||
      canonical(blockState.changes) !== canonical(raw.changes) ||
      blockState.inputAbiHash !== config.inputAbiHash ||
      !binding ||
      binding.generation === config.previousGeneration ||
      result.publication.generation !== binding.generation ||
      projection?.version !== 2 ||
      projection.requestId !== nativeId ||
      projection.persisted !== true ||
      projection.validation?.scope !== "generation-projection" ||
      canonical(projection.output?.binding) !== canonical(binding) ||
      result.absPersistence?.verified !== true ||
      result.finalValidation?.ok !== true ||
      !same(binding.scope?.projectKey, config.project)
    )
      throw Error(
        "Completed state reply lacks exact native/state publication facts",
      );
    if (
      observation?.version !== 1 ||
      observation.durable !== true ||
      observation.current !== true ||
      observation.requestId !== nativeId ||
      observation.operation !== "blocks_set_state" ||
      observation.executor?.hostPid !==
        (config.originalTargetPid ?? config.pid) ||
      observation.observer?.hostPid !== config.pid ||
      !same(observation.attachment?.root, config.project) ||
      canonical(observation.attachment?.identity) !== canonical(physical())
    )
      throw Error(
        "State publication has a different executor, reader or physical attachment",
      );
    for (const [name, key] of [
      ["project.abi", "abiHash"],
      ["project.abs", "absHash"],
      ["project.abs.map.json", "mapHash"],
    ])
      if (hash(savedFile(name)) !== binding[key])
        throw Error(
          "State reply differs from its current physical output: " + name,
        );
    const document = JSON.parse(savedFile("project.abi")),
      map = JSON.parse(savedFile("project.abs.map.json"));
    if (canonical(document) !== canonical(config.expectedDocument))
      throw Error(
        "The state operation changed the complete document beyond the one requested flag",
      );
    if (
      map.generation !== binding.generation ||
      map.baseAbsHash !== binding.absHash
    )
      throw Error("State map differs from its exact output");
    if (!/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation))
      throw Error("Invalid native generation identity");
    const pointerBytes = savedFile(".aily/abs-sync/committed.json"),
      pointer = JSON.parse(pointerBytes);
    if (
      pointer.schemaVersion !== 1 ||
      pointer.generation !== binding.generation ||
      pointer.hash !==
        hash(
          savedFile(".aily/abs-sync/baselines/" + binding.generation + ".json"),
        )
    )
      throw Error("State output lacks the checksum-bound committed pointer");
    return {
      requestId: raw.requestId,
      nativeRequestId: nativeId,
      inputDigest: digest,
      generation: binding.generation,
      binding,
      committedHash: hash(pointerBytes),
      originalExecutor: observation.executor,
      observer: observation.observer,
      attachment: observation.attachment,
      completeDocumentExactlyPreservedExceptRequestedFlag: true,
    };
  };
  const hook = function (event, ...args) {
    if (event !== "request") return originalEmit.call(this, event, ...args);
    const [request, response] = args;
    if (request.method !== "POST" || request.url !== "/command")
      return originalEmit.call(this, event, ...args);
    let command,
      chunks = [],
      size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size <= 1024 * 1024) chunks.push(chunk);
      else chunks = [];
    });
    request.once("end", () => {
      if (!chunks.length || size > 1024 * 1024) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks));
      } catch {
        return;
      }
      if (
        body.action !== "blockly-live-operation" ||
        !same(body.path, config.project)
      )
        return;
      const update =
        body.operation === "blocks_set_state" &&
        body.params?.action === "update";
      const observe =
        body.operation === "abs_recovery" &&
        body.params?.action === "observe_state";
      if (!update && !observe) return;
      const raw = update ? body.params : body.params.state;
      if (
        raw?.version !== 2 ||
        raw.action !== "update" ||
        !/^[a-f0-9-]{36}$/i.test(raw.requestId ?? "")
      )
        return;
      if (update && config.observationOnly)
        state.failures.push({ code: "cold-reader-repeated-state-update" });
      if (!state.requestId && update) {
        state.requestId = raw.requestId;
        state.nativeRequestId = "pub2-" + raw.requestId;
        state.state = raw;
      }
      if (
        raw.requestId !== state.requestId ||
        canonical(raw) !== canonical(state.state)
      ) {
        state.failures.push({ code: "state-original-wire-changed" });
        return;
      }
      if (
        observe &&
        body.params.originalTargetPid !==
          (config.originalTargetPid ?? config.pid)
      ) {
        state.failures.push({ code: "state-original-executor-changed" });
        return;
      }
      command = {
        operation: body.operation,
        action: body.params.action,
        requestId: raw.requestId,
        nativeRequestId: state.nativeRequestId,
        at: Date.now(),
        requestBytes: size,
        requestHash: hash(Buffer.concat(chunks)),
        dropped: false,
      };
      state.commands.push(command);
      chunks = [];
    });
    const originalEnd = response.end;
    response.end = function (...endArgs) {
      if (!command) return originalEnd.apply(this, endArgs);
      const raw = endArgs[0];
      let body, terminal;
      try {
        if (typeof raw === "string" || Buffer.isBuffer(raw)) {
          if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
            throw Error("State reply exceeds test transport bound");
          body = JSON.parse(raw);
          terminal = verify(body);
        }
      } catch (error) {
        state.failures.push({
          code: "state-reply-verification-failed",
          message: error.message,
        });
      }
      if (!terminal && body?.saveReceipt?.state === "completed")
        state.unverifiedTerminalReplies.push({
          requestId: body.saveReceipt.requestId,
          resultKeys: Object.keys(body.result ?? body),
          code: body.code ?? body.result?.code ?? null,
        });
      if (terminal)
        state.terminals.push({
          ...terminal,
          command: command.operation,
          responseHash: hash(raw),
          at: Date.now(),
        });
      if (state.armed && terminal) {
        command.dropped = true;
        state.drops++;
        response.destroy();
        command.responseDestroyed = response.destroyed === true;
        return response;
      }
      state.delegatedResponses++;
      return originalEnd.apply(this, endArgs);
    };
    return originalEmit.call(this, event, ...args);
  };
  server.emit = hook;
  globalThis.__ailyR2StateObservationFault = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => {
      if (server.emit !== hook) throw Error("State fault ownership changed");
      server.emit = originalEmit;
      return state.drops;
    },
  };
  return {
    available: true,
    port: config.port,
    observationOnly: !!config.observationOnly,
  };
}
