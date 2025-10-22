# Development

A guide of developing `vscode-clangd` extension.

## Requirements

* VS Code
* node.js and npm

## Building and running (command line)

```bash
cd vscode-clangd
npm install
npm run compile  # it runs in watch mode, you can hit ctrl-c.
code --extensionDevelopmentPath=$PWD
```

## Building, running, and debugging (VSCode)

- ```bash
  cd vscode-clangd
  npm install
  code .
  ```
- with the `vscode-clangd` directory open in VSCode, select
  `Run => Run Without Debugging` or `Run => Start Debugging`

VSCode will recompile the sources for you before launching.
If you change dependencies in `package.json`, you should run `npm install`.

## Editing and typechecking

`npm run compile` does not actually typecheck the TypeScript code!
(It stripts type annotations and bundles it, using `esbuild`).
You can see diagnostics with `npm run check-ts`.

Using a Typescript-aware editor will show you diagnostics, provide
go-to-definition etc. VSCode works well, or any LSP-capable editor can use
[typescript-language-server](https://github.com/typescript-language-server/typescript-language-server).

# Contributing

Please follow the existing code style when contributing to the extension, we
recommend to run `npm run format` before sending a patch.

# Publish to Marketplace

To create a new release, create a commit that:

- increases the version number in `package.json` and `package-lock.json`
- updates `CHANGELOG.md` to cover changes since the last release

Our CI will recognize the commit and publish new versions to the VSCode
Marketplace and the alternative OpenVSX registry.
