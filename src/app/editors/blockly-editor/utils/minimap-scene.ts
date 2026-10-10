export interface MinimapShape {
  id: string;
  path: string;
  colour: string;
  x: number;
  y: number;
  opacity: number;
}

export interface MinimapScene {
  version: number;
  width: number;
  height: number;
  pixelRatio: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  shapes: MinimapShape[];
}

export function prepareMinimapCanvas(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  scene: MinimapScene): void {
  context.canvas.width = Math.max(1, Math.round(scene.width * scene.pixelRatio));
  context.canvas.height = Math.max(1, Math.round(scene.height * scene.pixelRatio));
  context.setTransform(scene.scale * scene.pixelRatio, 0, 0, scene.scale * scene.pixelRatio,
    scene.offsetX * scene.pixelRatio, scene.offsetY * scene.pixelRatio);
}

export function drawMinimapShape(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  shape: MinimapShape): void {
  context.save();
  context.translate(shape.x, shape.y);
  context.globalAlpha = shape.opacity;
  context.fillStyle = shape.colour;
  context.fill(new Path2D(shape.path));
  context.restore();
}
