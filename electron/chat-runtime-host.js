const { ipcMain, BrowserWindow } = require('electron');
const {
  ChatRuntimeHostProcessService,
  channels,
} = require('./chat-runtime-host-service');

let registered = false;
let runtimeHostService = null;

function readRuntimeHostService() {
  if (!runtimeHostService) {
    runtimeHostService = new ChatRuntimeHostProcessService({ BrowserWindow });
  }
  return runtimeHostService;
}

function registerChatRuntimeHostIpc(mainWindow) {
  const service = readRuntimeHostService();
  service.setMainWindow(mainWindow);
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
    service.handleRuntimeOwnerEvent(event, payload);
  });
  ipcMain.on(channels.RESOURCE_HANDLER_RESPONSE_CHANNEL, (event, payload = {}) => {
    service.handleResourceOperationHandlerResponse(event, payload);
  });
}

function setChatRuntimeOwnerWindow(runtimeOwnerWindow) {
  readRuntimeHostService().setRuntimeOwnerWindow(runtimeOwnerWindow);
}

module.exports = {
  registerChatRuntimeHostIpc,
  setChatRuntimeOwnerWindow,
  channels,
};
