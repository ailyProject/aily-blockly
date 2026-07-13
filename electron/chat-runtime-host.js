const { ipcMain, BrowserWindow, utilityProcess } = require('electron');
const {
  ChatRuntimeHostProcessService,
  channels,
} = require('./chat-runtime-host-service');
const {
  ChatRuntimeHostExecutionHostController,
  readConfiguredExecutionHostMode,
  readConfiguredRuntimeOwnerModule,
} = require('./chat-runtime-host-execution-host-controller');

const RUNTIME_HOST_BOOTSTRAP_DIAGNOSTIC_VERSION = 'non-renderer-execution-host-2026-07-03';

let registered = false;
let runtimeHostService = null;
let executionHostController = null;
let bootstrapSourceLogged = false;

function logRuntimeHostBootstrapSource() {
  if (bootstrapSourceLogged) {
    return;
  }
  bootstrapSourceLogged = true;

  const runtimeModule = readConfiguredRuntimeOwnerModule();
  console.warn('[AilyChat][RuntimeHostBootstrapSource]', JSON.stringify({
    version: RUNTIME_HOST_BOOTSTRAP_DIAGNOSTIC_VERSION,
    file: __filename,
    pid: process.pid,
    registered,
    executionHostMode: readConfiguredExecutionHostMode(),
    hasRuntimeModule: !!runtimeModule,
    runtimeModule,
    hasUtilityProcess: !!utilityProcess && typeof utilityProcess.fork === 'function',
  }));
}

function readRuntimeHostService() {
  if (!runtimeHostService) {
    runtimeHostService = new ChatRuntimeHostProcessService({ BrowserWindow });
  }
  return runtimeHostService;
}

function readExecutionHostController(service) {
  if (!executionHostController) {
    executionHostController = new ChatRuntimeHostExecutionHostController({
      runtimeHostService: service,
      utilityProcess,
      mode: readConfiguredExecutionHostMode(),
    });
  }
  return executionHostController;
}

function registerChatRuntimeHostIpc(mainWindow) {
  logRuntimeHostBootstrapSource();
  const service = readRuntimeHostService();
  service.setMainWindow(mainWindow);
  readExecutionHostController(service).start();
  if (registered) {
    return;
  }
  registered = true;

  ipcMain.handle(channels.RUNTIME_OWNER_REGISTER_CHANNEL, (event, payload = {}) => (
    service.handleRuntimeOwnerRegister(event, payload)
  ));
  ipcMain.handle(channels.RUNTIME_OWNER_UNREGISTER_CHANNEL, (event, payload = {}) => (
    service.handleRuntimeOwnerUnregister(event, payload)
  ));
  ipcMain.handle(channels.RESOURCE_HANDLER_REGISTER_CHANNEL, (event, payload = {}) => (
    service.handleResourceOperationHandlerRegister(event, payload)
  ));
  ipcMain.handle(channels.RESOURCE_HANDLER_UNREGISTER_CHANNEL, (event, payload = {}) => (
    service.handleResourceOperationHandlerUnregister(event, payload)
  ));
  ipcMain.handle(channels.HOST_COMMAND_CHANNEL, (event, payload = {}) => (
    service.handleHostCommand(event, payload)
  ));
  ipcMain.on(channels.RUNTIME_OWNER_RESPONSE_CHANNEL, (event, payload = {}) => {
    service.handleRuntimeOwnerResponse(event, payload);
  });
  ipcMain.on(channels.RUNTIME_OWNER_EVENT_CHANNEL, (event, payload = {}) => {
    void service.handleRuntimeOwnerEvent(event, payload).catch(error => {
      console.warn('[AilyChat][RuntimeHost] Ignored runtime owner IPC event:', {
        message: error && error.message ? error.message : String(error || 'Unknown runtime owner IPC event error'),
      });
    });
  });
  ipcMain.on(channels.RESOURCE_HANDLER_RESPONSE_CHANNEL, (event, payload = {}) => {
    service.handleResourceOperationHandlerResponse(event, payload);
  });
}

module.exports = {
  registerChatRuntimeHostIpc,
  channels,
};
