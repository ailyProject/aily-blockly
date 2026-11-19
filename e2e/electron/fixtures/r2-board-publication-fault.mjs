/** Passive, exact-project HTTP terminal observer. Authentication, command,
 * handler and original native facts remain unchanged; only verified ACKs drop. */
export function installR2BoardPublicationFault(_electron, config) {
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
  const same = (a, b) =>
    typeof a === "string" &&
    typeof b === "string" &&
    path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
  const input = config.input;
  if (
    process.pid !== config.pid ||
    process.env.AILY_APPDATA_PATH !== config.appData ||
    !path.isAbsolute(config.project) ||
    !/[/\\]aily-project[/\\]dev-tests[/\\]/i.test(config.project) ||
    !same(fs.realpathSync(config.project), config.project) ||
    !Number.isSafeInteger(config.port) ||
    !Array.isArray(config.expectedDocument?.pages) ||
    !config.previousGeneration ||
    input?.kind !== "board-config" ||
    Object.keys(input).sort().join(",") !== "configKey,configValue,kind" ||
    typeof input.configKey !== "string" ||
    !input.configKey ||
    typeof input.configValue !== "string" ||
    (config.observationOnly &&
      (!/^pub2-[a-f0-9-]{36}$/i.test(config.requestId ?? "") ||
        !Number.isSafeInteger(config.originalTargetPid)))
  )
    throw Error(
      "Board fault requires the exact owned project, input and executor",
    );
  if (globalThis.__ailyR2BoardPublicationFault)
    throw Error("Do not install another board fault");
  const servers = process
    ._getActiveHandles()
    .filter(
      (server) =>
        server instanceof http.Server && server.address()?.port === config.port,
    );
  if (servers.length !== 1)
    return { available: false, reason: "exact_owned_cli_server_unavailable" };
  const server = servers[0],
    originalEmit = server.emit;
  const state = {
    available: true,
    armed: !config.observationOnly,
    requestId: config.requestId ?? null,
    input,
    commands: [],
    terminals: [],
    drops: 0,
    failures: [],
    unverifiedTerminalReplies: [],
    delegatedResponses: 0,
    responseMetadata: [],
    discoveryInspections: [],
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
      throw Error("Nonphysical project");
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
        [before, after].some(
          (item) =>
            item.ino !== value.ino ||
            item.birthtimeNs !== value.birthtimeNs ||
            (item.dev !== 0n && item.dev !== value.dev),
        )
      )
        throw Error("Physical project changed during FD capture");
      return {
        dev: String(value.dev),
        ino: String(value.ino),
        birthtimeNs: String(value.birthtimeNs),
      };
    } finally {
      fs.closeSync(fd);
    }
  };
  const saved = (name) => {
    const file = path.join(config.project, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("Unowned publication file: " + name);
    return fs.readFileSync(file);
  };
  const verify = (body, command) => {
    // The original board route returns its actual small publication facts, not
    // a project_save status envelope. Never synthesize saveReceipt/observation
    // from that ACK. The following readonly status has the full durable shape.
    const direct = command.operation === "set_board_config" && body?.saveReceipt === undefined;
    const receipt = body?.saveReceipt,
      result = direct ? body : body?.result ?? body;
    if (direct) {
      if (!body?.projectionReceipt && body?.publication?.status !== "COMMITTED") return null;
    } else if (receipt?.state !== "completed") return null;
    const projection = result.projectionReceipt,
      binding = projection?.output?.binding,
      observation = direct ? result.environment : body.publicationObservation;
    if (
      body.ok !== true ||
      result.ok !== true ||
      !same(result.project, config.project) ||
      (!direct && (receipt.version !== 2 ||
        receipt.requestId !== state.requestId ||
        receipt.operation !== "project_save" ||
        !same(receipt.project, config.project) ||
        canonical(receipt.input) !== canonical(input))) ||
      !["set_board_config", "project_save"].includes(result.operation) ||
      result.projectSaved !== true ||
      result.partial === true ||
      result.publication?.status !== "COMMITTED" ||
      result.requiresReload === true ||
      projection?.version !== 2 ||
      projection.requestId !== state.requestId ||
      projection.persisted !== true ||
      projection.validation?.ok !== true ||
      projection.validation.scope !== "generation-projection" ||
      !binding ||
      canonical(projection.base) !== canonical(binding) ||
      binding.generation === config.previousGeneration ||
      result.generation !== binding.generation ||
      result.publication.generation !== binding.generation ||
      !same(binding.scope?.projectKey, config.project) ||
      binding.scope.pageId !== config.expectedDocument.activePageId ||
      result.absPersistence?.verified !== true ||
      result.finalValidation?.ok !== true
    )
      throw Error("Board terminal differs from its exact original publication");
    if (
      command.operation === "set_board_config" &&
      (result.config_key !== input.configKey ||
        String(result.new_value) !== input.configValue)
    )
      throw Error("Board ACK differs from its requested config value");
    if (
      observation?.version !== 1 ||
      observation.current !== true ||
      (direct ? (result.persisted !== true || result.candidateApplied !== false ||
        observation.status !== "completed" || observation.candidateApplied !== false ||
        !same(observation.project, config.project)) :
        (observation.durable !== true || observation.requestId !== state.requestId ||
          observation.operation !== "project_save")) ||
      observation.executor?.hostPid !==
        (config.originalTargetPid ?? config.pid) ||
      observation.observer?.hostPid !== config.pid ||
      !same(observation.attachment?.root, config.project) ||
      canonical(observation.attachment?.identity) !== canonical(physical())
    )
      throw Error(
        "Board publication executor, observer or physical attachment changed",
      );
    if (direct) {
      for (const [key, file] of [
        ["package", "package.json"], ["lock", "package-lock.json"], ["npmrc", ".npmrc"],
        ["shrinkwrap", "npm-shrinkwrap.json"], ["yarn", "yarn.lock"],
      ]) {
        const exists = fs.existsSync(path.join(config.project, file));
        if (observation.hashes?.[key] !== (exists ? hash(saved(file)) : null))
          throw Error("Board environment physical input mismatch: " + key);
      }
    }
    for (const [name, key] of [
      ["project.abi", "abiHash"],
      ["project.abs", "absHash"],
      ["project.abs.map.json", "mapHash"],
    ])
      if (hash(saved(name)) !== binding[key])
        throw Error("Board publication physical output mismatch: " + name);
    if (
      canonical(JSON.parse(saved("project.abi"))) !==
      canonical(config.expectedDocument)
    )
      throw Error("Board publication lost complete GUI C");
    const map = JSON.parse(saved("project.abs.map.json")),
      pointerBytes = saved(".aily/abs-sync/committed.json"),
      pointer = JSON.parse(pointerBytes);
    if (
      map.generation !== binding.generation ||
      map.baseAbsHash !== binding.absHash ||
      pointer.schemaVersion !== 1 ||
      pointer.generation !== binding.generation ||
      !/^[A-Za-z0-9_-]{1,96}$/.test(binding.generation) ||
      pointer.hash !==
        hash(saved(".aily/abs-sync/baselines/" + binding.generation + ".json"))
    )
      throw Error("Board publication lacks its exact committed generation");
    const manifest = JSON.parse(saved("package.json"));
    if (String(manifest.projectConfig?.[input.configKey]) !== input.configValue)
      throw Error("Actual board configuration was not saved");
    return {
      requestId: state.requestId,
      input,
      binding,
      generation: binding.generation,
      attachment: observation.attachment,
      originalExecutor: observation.executor,
      observer: observation.observer,
      committedHash: hash(pointerBytes),
      completeGuiCVerified: true,
      responseShape: direct ? "original-board-publication" : "durable-publication-status",
    };
  };
  const hook = function (event, ...args) {
    if (event !== "request") return originalEmit.call(this, event, ...args);
    const [request, response] = args;
    if (request.method !== "POST" || request.url !== "/command")
      return originalEmit.call(this, event, ...args);
    let command,
      inspection,
      size = 0,
      chunks = [];
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
      const save = body.params?.saveRequest,
        operation = body.operation;
      if (body.action === "blockly-live-operation" && operation === "app_info") {
        inspection = { operation, at: Date.now(), requestBytes: size };
        state.discoveryInspections.push(inspection);
      }
      if (
        body.action !== "blockly-live-operation" ||
        !same(body.path, config.project) ||
        ![
          "set_board_config",
          "project_save_status",
          "project_publication_status",
        ].includes(operation) ||
        save?.version !== 2 ||
        save.operation !== "project_save" ||
        !/^pub2-[a-f0-9-]{36}$/i.test(save.requestId ?? "")
      )
        return;
      if (canonical(save.input) !== canonical(input)) {
        state.failures.push({ code: "board-input-changed" });
        return;
      }
      if (operation === "set_board_config") {
        if (config.observationOnly)
          state.failures.push({ code: "cold-reader-repeated-board-mutation" });
        if (
          body.params.config_key !== input.configKey ||
          String(body.params.config_value) !== input.configValue
        )
          state.failures.push({ code: "wire-board-config-changed" });
        state.requestId ??= save.requestId;
      }
      if (state.requestId !== save.requestId) {
        state.failures.push({ code: "original-board-request-changed" });
        return;
      }
      if (
        operation === "project_publication_status" &&
        body.params.originalTargetPid !==
          (config.originalTargetPid ?? config.pid)
      )
        state.failures.push({ code: "original-board-executor-changed" });
      command = {
        operation,
        requestId: save.requestId,
        input: save.input,
        at: Date.now(),
        requestBytes: size,
        requestHash: hash(Buffer.concat(chunks)),
        dropped: false,
      };
      state.commands.push(command);
    });
    const originalEnd = response.end;
    response.end = function (...endArgs) {
      if (!command) {
        if (inspection) {
          inspection.responseAt = Date.now();
          inspection.statusCode = response.statusCode;
          const raw = endArgs[0];
          if ((typeof raw === "string" || Buffer.isBuffer(raw)) && Buffer.byteLength(raw) <= 8 * 1024 * 1024) {
            inspection.responseBytes = Buffer.byteLength(raw);
            inspection.responseHash = hash(raw);
            try {
              const value = JSON.parse(raw);
              inspection.ok = value.ok;
              inspection.operation = value.operation ?? "app_info";
              inspection.code = value.code ?? value.errorCode ?? null;
              inspection.developmentMode = value.settings?.developmentMode ?? null;
            } catch { inspection.json = false; }
          }
          inspection.delegatedUnchanged = true;
        }
        return originalEnd.apply(this, endArgs);
      }
      let body, terminal;
      try {
        const raw = endArgs[0];
        if (typeof raw === "string" || Buffer.isBuffer(raw)) {
          if (Buffer.byteLength(raw) > 8 * 1024 * 1024)
            throw Error("Board terminal exceeds test transport bound");
          body = JSON.parse(raw);
          terminal = verify(body, command);
        }
      } catch (error) {
        state.failures.push({
          code: "board-terminal-unverified",
          message: error.message,
        });
      }
      state.responseMetadata.push({ operation: command.operation, requestId: command.requestId,
        statusCode: response.statusCode, bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
        resultKeys: body?.result && typeof body.result === "object" ? Object.keys(body.result) : [],
        hasSaveReceipt: !!body?.saveReceipt, hasProjectionReceipt: !!body?.projectionReceipt,
        hasPublicationObservation: !!body?.publicationObservation,
        projectionRequestId: body?.projectionReceipt?.requestId ?? body?.result?.projectionReceipt?.requestId ?? null,
        verified: !!terminal });
      if (!terminal && (body?.saveReceipt?.state === "completed" || body?.publication?.status === "COMMITTED"))
        state.unverifiedTerminalReplies.push({
          requestId: body.saveReceipt?.requestId ?? body.projectionReceipt?.requestId,
          keys: Object.keys(body.result ?? body),
        });
      if (terminal)
        state.terminals.push({
          ...terminal,
          at: Date.now(),
          responseHash: hash(endArgs[0]),
        });
      if (terminal && state.armed) {
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
  globalThis.__ailyR2BoardPublicationFault = {
    snapshot: () => JSON.parse(JSON.stringify(state)),
    restore: () => {
      if (server.emit !== hook) throw Error("Board fault ownership changed");
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
