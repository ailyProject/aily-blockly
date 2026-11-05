import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Private experimental artifacts only. No source file or .generated asset is
// written, no readback is suppressed, and real runtime integrity remains on.
export async function buildParamsBoundary(repo, esbuild, reorder) {
  const edits = []
  const once = (source, before, after, file) => {
    assert.equal(source.split(before).length - 1, 1, 'The experiment must match exactly one known source site: ' + file)
    edits.push({ file: path.relative(repo, file).replaceAll('\\', '/'), before, after })
    return source.replace(before, after)
  }
  const runtime = await esbuild.build({ absWorkingDir: repo,
    entryPoints: ['src/app/editors/blockly-editor/services/blockly-native-candidate.entry.ts'],
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, minify: true,
    banner: { js: 'const Promise = globalThis.Promise;' }, tsconfig: 'tsconfig.json', logLevel: 'error',
    plugins: [{ name: 'private-params-boundary-observation', setup(build) {
      build.onLoad({ filter: /blockly-(native-candidate-realm|native-abi-verification|native-semantic-diagnostic|custom-function-contract)\.ts$/ }, async args => {
        let source = (await fs.readFile(args.path, 'utf8')).replaceAll('\r\n', '\n')
        if (args.path.endsWith('blockly-native-candidate-realm.ts')) {
          source = once(source, 'const request = decodeNativeCandidateRequest(event.data);',
            'realm.__nativeParamsReproTrace = (value: unknown) => send({ phase: "load", reproTrace: value });\n    const request = decodeNativeCandidateRequest(event.data);', args.path)
          if (reorder) source = once(source,
            'construction!.prepare();\n        captureCustomFunctionRegistration(native.Blocks)?.prepareSerialization(workspace, true);',
            'captureCustomFunctionRegistration(native.Blocks)?.prepareSerialization(workspace, true);\n        construction!.prepare();', args.path)
        } else if (args.path.endsWith('blockly-native-abi-verification.ts') && reorder) source = once(source,
          'construction.prepare();\n    const customFunctions = captureCustomFunctionRegistration(native.Blocks);\n    customFunctions?.prepareSerialization(workspace, true);',
          'const customFunctions = captureCustomFunctionRegistration(native.Blocks);\n    customFunctions?.prepareSerialization(workspace, true);\n    construction.prepare();', args.path)
        else if (args.path.endsWith('blockly-native-semantic-diagnostic.ts')) source = once(source,
          'const diagnostic: AbsDiagnostic =',
          '(globalThis as any).__nativeParamsReproTrace?.({ stage: "existing-semantic-change", phase, before: JSON.parse(before), after: JSON.parse(after) });\n  const diagnostic: AbsDiagnostic =', args.path)
        else if (args.path.endsWith('blockly-custom-function-contract.ts')) source = once(source,
          'synchronize(workspace, { blocks: { blocks } });',
          'synchronize(workspace, { blocks: { blocks } });\n      (globalThis as any).__nativeParamsReproTrace?.({ stage: "existing-prepare-serialization", commitLoadedNames, definitions: blocks.map(block => ({ id: block.id, name: block.fields.FUNC_NAME, params: block.extraState.params, liveName: workspace.getBlockById(block.id)?.getFieldValue("FUNC_NAME") })), registry: realm.customFunctionRegistry });', args.path)
        return { contents: source, loader: 'ts' }
      })
    } }] })
  const bytes = runtime.outputFiles[0].contents, hash = createHash('sha256').update(bytes).digest('hex')
  const harness = await esbuild.build({ absWorkingDir: repo,
    entryPoints: ['e2e/native/fixtures/custom-function-params.harness.ts'],
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false,
    tsconfig: 'tsconfig.json', logLevel: 'error', plugins: [{ name: 'private-exact-runtime-hash', setup(build) {
      build.onLoad({ filter: /[\\/]\.generated[\\/]blockly-runtime[\\/]manifest\.json$/ }, () => ({ contents: JSON.stringify({ sha256: hash }), loader: 'json' }))
    } }] })
  return { runtime: bytes, harness: harness.outputFiles[0].contents, hash, edits }
}
