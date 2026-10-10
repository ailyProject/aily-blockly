import { drawMinimapShape, prepareMinimapCanvas, type MinimapScene } from './minimap-scene';

let canvas: OffscreenCanvas | null = null;
addEventListener('message', (event: MessageEvent<{canvas?: OffscreenCanvas; scene?: MinimapScene}>) => {
  if (event.data.canvas) canvas = event.data.canvas;
  const scene = event.data.scene;
  const context = canvas?.getContext('2d');
  if (!scene || !context) return;
  prepareMinimapCanvas(context, scene);
  for (const shape of scene.shapes) drawMinimapShape(context, shape);
  postMessage({version: scene.version, shapes: scene.shapes.length});
});
