import * as Blockly from 'blockly';
import 'blockly/blocks';
import * as pinyinPro from 'pinyin-pro';
import '../../src/app/editors/blockly-editor/components/blockly/blockly-native-registrations';
import '../../src/app/editors/blockly-editor/components/blockly/renderer/aily-thrasos/renderer';
import {DarkTheme, LightTheme} from '../../src/app/editors/blockly-editor/components/blockly/theme.config';
import {loadBlocklyWorkspace} from '../../src/app/editors/blockly-editor/utils/blockly-performance';
import {createProjectGenerator} from '../../src/app/editors/blockly-editor/services/blockly-generator-factory';
import {adaptArduinoTextLiterals} from '../../src/app/editors/blockly-editor/services/blockly-arduino-text-literals';
import {adaptBundledArduinoProcedureCalls} from '../../src/app/editors/blockly-editor/services/blockly-bundled-procedure-generator';
declare const AILY_RENDERER: boolean;
async function start() {
 const params = new URLSearchParams(location.search);
 const diagnostic = params.get('diagnostic') || 'baseline';
 // Deliberate ablations for causal profiling only; never installed in the host.
 const css = diagnostic === 'no-effects' ? '* {filter:none!important;backdrop-filter:none!important;box-shadow:none!important;text-shadow:none!important;animation:none!important;transition:none!important}'
  : diagnostic === 'no-foreign-object' ? 'foreignObject {display:none!important}' : '';
 if (css) {const style=document.createElement('style');style.textContent=css;document.head.appendChild(style);}
 const data=await (await fetch('capture.json')).json();
 const ws=Blockly.inject('workspace',{renderer:AILY_RENDERER?'aily-thrasos':'thrasos',theme:diagnostic==='light'?LightTheme:DarkTheme,
  media:'/media/',trashcan:true,sounds:false,zoom:{startScale:1,maxScale:1.5,minScale:0.5,scaleSpeed:1.05,wheel:true},
  grid:{spacing:20,length:2,colour:'#393939',snap:true},move:{scrollbars:true,drag:true,wheel:false}});
 const w=window as any;
 if(diagnostic==='virtual') ws.setViewportRendering(true);
 if(diagnostic==='no-has'){
  for(const sheet of Array.from(document.styleSheets)){
   try{for(let i=sheet.cssRules.length-1;i>=0;i--){if(sheet.cssRules[i].cssText.includes(':has('))sheet.deleteRule(i);}}catch{}
  }
 }
 if (diagnostic === 'inplace') {
  const layers = ws.getLayerManager();
  if(layers){layers.moveToDragLayer = () => {};layers.moveOffDragLayer = () => {};}
 }
 if (diagnostic === 'no-drag-class') {
  for (const name of ['addClass','removeClass'] as const) {
   const original=Blockly.BlockSvg.prototype[name];
   Blockly.BlockSvg.prototype[name]=function(value:string){if(value!=='blocklyDragging')return original.call(this,value);};
  }
 }
 // Keep the independent engine on the native load path. Host-specific loading
 // optimizations are measured through the real host service by the runner.
 w.loadForBenchmark=(state: object)=>{
  if (diagnostic==='host-loader') return loadBlocklyWorkspace(ws,state);
  Blockly.utils.dom.startTextWidthCache();
  try{Blockly.serialization.workspaces.load(state,ws);Blockly.renderManagement.triggerQueuedRenders(ws);}
  finally{Blockly.utils.dom.stopTextWidthCache();}
 };
 const B=Object.assign({},Blockly,{getMainWorkspace:()=>ws});
 Object.assign(w,{Blockly:B,blocklyWorkspace:ws,pinyinPro,global:window,__BLOCKLY_LIB_I18N__:{},__ailyBlockDefinitionsMap:new Map()});
 let generator:any;
 for(const step of data.steps){
  if(step.kind==='context'){
   if(!generator){generator=createProjectGenerator(step.mode);w.Arduino=generator;}
   Object.assign(Blockly.Msg,step.messages);w.boardConfig=step.boardConfig;w.packageJson=step.packageJson;
  }else if(step.kind==='messages')Object.assign(Blockly.Msg,step.value);
  else if(step.kind==='i18n')w.__BLOCKLY_LIB_I18N__[step.packageName]=step.value;
  else if(step.kind==='definitions'){
   for(const def of step.definitions){w.__ailyBlockDefinitionsMap.set(def.type,def.icon);delete Blockly.Blocks[def.type];}
   Blockly.defineBlocksWithJsonArray(step.definitions);
  }else if(step.kind==='script'){
   const s=document.createElement('script');s.textContent=step.source;document.head.appendChild(s);
   adaptArduinoTextLiterals(generator);adaptBundledArduinoProcedureCalls(generator);
  }else throw new Error(`Unknown replay step ${step.kind}`);
 }
 await new Promise(r=>setTimeout(r,100));
 const state=params.get('topology')==='expanded'?await(await fetch('expanded.json')).json():data.state;
 if (diagnostic==='split-stacks') {
  // Same real blocks/fields, different topology. This intentionally changes
  // program semantics and is a diagnostic fixture, never an optimized project.
  const pending=[...state.blocks.blocks];let roots=state.blocks.blocks.length;
  while(pending.length){const block=pending.pop();for(const input of Object.values(block.inputs||{}) as any[])if(input.block||input.shadow)pending.push(input.block||input.shadow);
   if(block.next?.block){const next=block.next.block;delete block.next;next.x=(roots%20)*500;next.y=Math.floor(roots/20)*130;roots++;state.blocks.blocks.push(next);pending.push(next);}}
 }
 const start=performance.now();Blockly.Events.disable();
 try{w.loadForBenchmark(state);}finally{Blockly.Events.enable();}
 const synchronousMs=performance.now()-start;
 if(diagnostic==='flat-svg'){
  // Architecture experiment: keep models/connections and their relativeCoords
  // intact, flatten only each root's SVG descendants. This is suitable only
  // for the measured whole-root move, not arbitrary editing or reconnection.
  const begin=performance.now();
  for(const root of ws.getTopBlocks(false)){
   const descendants=root.getDescendants(false).slice(1).map(block=>({block,xy:block.getRelativeToSurfaceXY()}));
   const fragment=document.createDocumentFragment();
   // Detach leaves first; moving whole deep subtrees repeatedly would make
   // preparation itself quadratic and hide the steady-state question.
   for(const {block} of [...descendants].reverse())fragment.prepend(block.getSvgRoot());
   root.getSvgRoot().append(fragment);
   const sync=()=>{const origin=root.getRelativeToSurfaceXY();for(const {block} of descendants){const xy=block.getRelativeToSurfaceXY(),svg=block.getSvgRoot(),transform=`translate(${xy.x-origin.x}, ${xy.y-origin.y})`;if(svg.getAttribute('transform')!==transform)svg.setAttribute('transform',transform);}};
   sync();
   // Native renderers still lay out using model parents; translate that result
   // into shallow SVG coordinates after each complete root location update.
   const update=root.updateComponentLocations;
   root.updateComponentLocations=function(origin){update.call(this,origin);sync();};
  }
  w.flatSvgPreparationMs=performance.now()-begin;
 }
 await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
 w.benchmarkLoaded={synchronousMs,paintedMs:performance.now()-start,count:ws.getAllBlocks(false).length,flatSvgPreparationMs:w.flatSvgPreparationMs};
 w.realCode=()=>generator.workspaceToCode(ws);
 document.querySelector('#status')!.textContent=`${ws.getAllBlocks(false).length} 个真实项目块 · ${Math.round(w.benchmarkLoaded.paintedMs)} ms`;
}
void start().catch(e=>{document.querySelector('#status')!.textContent=String(e);throw e;});
