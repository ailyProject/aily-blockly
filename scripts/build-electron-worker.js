const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const workspaceRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(workspaceRoot, 'electron', 'chat-runtime-lex-execution-runtime.mjs');
const outputFile = path.join(workspaceRoot, 'electron', 'chat-runtime-lex-execution-runtime.bundle.mjs');

async function main() {
  if (!fs.existsSync(entryPoint)) {
    throw new Error(`Missing Lex execution-host runtime module: ${entryPoint}`);
  }

  await esbuild.build({
    entryPoints: [entryPoint],
    outfile: outputFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
  });

  const outputSize = fs.statSync(outputFile).size;
  console.log(`[AilyChat] Worker runtime bundle ready: ${path.relative(workspaceRoot, outputFile)} (${outputSize} bytes)`);
}

main().catch((error) => {
  console.error('[AilyChat] Failed to build worker runtime bundle:', error);
  process.exit(1);
});
