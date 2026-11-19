'use strict';

// These exact project-relative paths hold host ownership, not build source.
// This is not a directory-copy filter: ABS recovery records and all other
// resources beneath .aily still belong to the strict source boundary.
const COORDINATION_FILES = new Set([
    '.aily/build-workspace.guard',
    '.aily/project-view.guard',
    '.aily/project-open.lock',
    '.aily/project-files.write.lock',
]);

/** The source walker supplies a slash-separated, project-relative path. */
function isProjectCoordinationFile(relative) {
    return COORDINATION_FILES.has(process.platform === 'win32' ? relative.toLowerCase() : relative);
}

module.exports = { isProjectCoordinationFile };
