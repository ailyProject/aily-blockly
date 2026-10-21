const { contextBridge } = require('electron');
const { replaceProjectText, PROJECT_FILE_PUBLICATION_VERSION } = require('../../../electron/project-file-writer');
const { copyProjectDirectory } = require('../../../electron/project-file-copy');
contextBridge.exposeInMainWorld('projectFiles', { projectFilePublicationVersion: PROJECT_FILE_PUBLICATION_VERSION,
  replaceProjectText: (request, guard) => replaceProjectText(request, guard),
  copyProjectDirectory: (source, destination) => copyProjectDirectory(source, destination) });
