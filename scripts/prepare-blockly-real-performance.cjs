const fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const {execFileSync}=require('node:child_process');
const esbuild=createRequire(require.resolve('@angular/build/package.json'))('esbuild');
const root=path.resolve(__dirname,'..');
const output=path.join(root,'e2e/.artifacts/blockly-real-project-2026-09-28');
(async()=>{
 if(!fs.existsSync(path.join(output,'capture.json')))throw new Error('Run the real-project capture test first.');
 const official=path.join(output,'official');fs.mkdirSync(official,{recursive:true});
 const archive=path.join(official,'blockly-13.3.0.tgz');
 if(!fs.existsSync(archive)){
  const previous=path.join(root,'e2e/.artifacts/blockly-performance-2026-09-28/official/blockly-13.3.0.tgz');
  if(fs.existsSync(previous))fs.copyFileSync(previous,archive);
  else execFileSync('npm',['pack','blockly@13.3.0','--ignore-scripts','--pack-destination',official],{stdio:'inherit'});
 }
 execFileSync('tar',['-xzf',archive,'-C',official]);
 for(const variant of ['official','aily','aily-ui']){
  await esbuild.build({entryPoints:[path.join(root,'e2e/performance/real-standalone.ts')],bundle:true,minify:true,format:'esm',platform:'browser',target:'es2022',
   alias:variant==='official'?{blockly:path.join(official,'package')}:undefined,
   define:{AILY_RENDERER:String(variant==='aily-ui')},outfile:path.join(output,variant+'.js')});
  fs.writeFileSync(path.join(output,variant+'.html'),`<!doctype html><html lang="zh"><meta charset="utf-8"><title>真实项目 Blockly 13 · ${variant}</title><link rel="stylesheet" href="/fonts/fontawesome6/css/all.min.css"><style>html,body{margin:0;background:#262626;color:#eee;font:14px system-ui;height:100%}header{height:44px;display:flex;gap:24px;align-items:center;padding:0 20px}a{color:#98cfff}#workspace{position:absolute;inset:44px 0 0}</style><header><strong>project_aug30a · ${variant}</strong><a href="?topology=original">原始项目</a><a href="?topology=expanded">8k+ 真实块</a><span id="status">加载真实库与项目…</span></header><div id="workspace"></div><script type="module" src="${variant}.js"></script></html>`);
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
