export type WorkerLoader = () => Worker

export const workerLoaders: Partial<Record<string, WorkerLoader>> = {
    TextEditorWorker: () =>
        new Worker(new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url), {
            type: 'module'
        }),
    TextMateWorker: () =>
        new Worker(
            new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
            { type: 'module' }
        ),
    OutputLinkDetectionWorker: () =>
        new Worker(
            new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
            { type: 'module' }
        ),
    LanguageDetectionWorker: () =>
        new Worker(
            new URL(
                '@codingame/monaco-vscode-language-detection-worker-service-override/worker',
                import.meta.url
            ),
            { type: 'module' }
        ),
    NotebookEditorWorker: () =>
        new Worker(
            new URL('@codingame/monaco-vscode-notebook-service-override/worker', import.meta.url),
            { type: 'module' }
        ),
    LocalFileSearchWorker: () =>
        new Worker(
            new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url),
            { type: 'module' }
        )
}