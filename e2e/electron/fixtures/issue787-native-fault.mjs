/** Controlled failure in the actual loader of this suite-owned renderer. */
export async function failIssue787RuntimeOnce(page, project) {
  return page.evaluate(async expected => {
    const component = window.ng.getComponent(document.querySelector('app-blockly-editor'))
    const service = component.blocklyService, projectService = component._projectService
    if (projectService.currentProjectPath !== expected) throw Error('Unexpected project during native fault')
    const original = service.loadProjectDocumentSettled
    let fired = false, caught
    service.loadProjectDocumentSettled = async function (document, ...args) {
      service.loadProjectDocumentSettled = original
      const partial = structuredClone(document)
      partial.pages.find(page => page.id === partial.activePageId).content.blocks.blocks =
        partial.pages.find(page => page.id === partial.activePageId).content.blocks.blocks.slice(0, 1180)
      await original.call(this, partial, ...args)
      fired = true
      throw Error('ISSUE787_OWNED_PARTIAL_NATIVE_REBUILD')
    }
    try {
      await projectService.rebuildLibraryRuntime({ projectPath: expected, packageJson: projectService.currentPackageData,
        libraryNames: [...service.loadedLibraryInfos.values()].map(item => item.packageName) })
    } catch (error) { caught = { code: error.code, message: error.message } }
    finally { service.loadProjectDocumentSettled = original }
    return { fired, caught, blocked: service.isWorkspaceEditBlocked(), ready: service.generatorRuntime.isReady() }
  }, project)
}
