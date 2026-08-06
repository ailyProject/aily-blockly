# Project resource garbage collection

`ProjectResourceGcService` is the shared collector for generated files referenced by Blockly project data. It is not tied to a specific custom field or file type.

## Registering a generated file

After writing a generated file, register its project-relative path and a stable resource kind:

```ts
projectResourceGc.registerManagedFile(
  projectPath,
  'audio/0123456789abcdef0123456789abcdef.mp3',
  'field-audio-output',
);
```

Only registered files can be deleted. Managed files must be inside a project subdirectory; project-root files and resources under `.aily`, `.git`, or `node_modules` are rejected.

The shared manifest is stored at:

```text
<project>/.aily/project-resource-manifest.json
```

## Cleanup lifecycle

After a persisted project has been fully loaded, the editor passes the Project Document and other persisted JSON roots to `cleanupUnreferencedFiles`. The collector recursively finds project-relative path strings and keeps every registered file that is still referenced. An unreferenced registered file is deleted and removed from the manifest.

Cleanup runs on the next project open, not directly when a Block is deleted. This ensures that unsaved changes and Blockly undo cannot make a deleted file live again in the same editing session.

The legacy `audio/.field-audio-manifest.json` format is imported into the shared manifest and removed after a successful migration.
