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
const VIEW_OWNER_STAGING = /^\.aily\/\.project-open\.lock\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/;

/** The source walker supplies a slash-separated, project-relative path. */
function isProjectCoordinationFile(relative) {
    const name = process.platform === 'win32' ? relative.toLowerCase() : relative;
    return COORDINATION_FILES.has(name) || VIEW_OWNER_STAGING.test(name);
}

module.exports = { isProjectCoordinationFile };
