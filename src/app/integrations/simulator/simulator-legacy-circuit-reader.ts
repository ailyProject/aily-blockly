import { bindLegacyCircuitScene } from '@aily-project/simulator-host-sdk';
import { importConnectionGraphToSceneEditorDocumentV2 } from '@aily-project/simulator-protocol/scene';
import type { SceneEditorDocumentV2, SceneJsonObject } from '@aily-project/scene-model';
import type { SimulatorProjectArtifactFilePort } from './simulator-project-artifact-callback-authority';

const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

/** Reads the original circuit editor's exact installed-package references. */
export async function readSimulatorLegacyCircuit(options: {
  projectRoot: string;
  sceneId: string;
  files: SimulatorProjectArtifactFilePort;
}, signal: AbortSignal): Promise<SceneEditorDocumentV2 | null> {
  const { files } = options;
  const projectRoot = await files.realpath(options.projectRoot, signal);
  let bytesRead = 0;

  const read = async (root: string, relative: string, optional = false): Promise<Uint8Array | null> => {
    signal.throwIfAborted();
    const candidate = files.resolve(root, relative);
    if (!inside(files, root, candidate)) throw new Error('Circuit resource escapes its package.');
    try {
      await files.lstat(candidate, signal);
      const realPath = await files.realpath(candidate, signal);
      if (!inside(files, root, realPath)) throw new Error('Circuit resource symlink escapes its package.');
      const stat = await files.lstat(realPath, signal);
      if (!stat.isFile || stat.size < 0 || bytesRead + stat.size > MAX_IMPORT_BYTES) {
        throw new Error('Circuit resource is not a bounded file.');
      }
      const bytes = await files.readFile(realPath, signal);
      bytesRead += bytes.byteLength;
      if (bytesRead > MAX_IMPORT_BYTES) throw new Error('Circuit import exceeds its size limit.');
      signal.throwIfAborted();
      return bytes;
    } catch (error) {
      if (optional && missing(error)) return null;
      throw error;
    }
  };
  const json = async (root: string, relative: string, optional = false): Promise<Record<string, unknown> | null> => {
    const bytes = await read(root, relative, optional);
    return bytes === null ? null : object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  };

  const graph = await json(projectRoot, 'connection_output.json', true);
  if (!graph) return null;
  if (!Array.isArray(graph['components']) || graph['components'].length > 2048) {
    throw new Error('Original circuit components are invalid.');
  }
  const projectPackage = await json(projectRoot, 'package.json', true);
  const dependencies = object(projectPackage?.['dependencies'] ?? {});
  const boardName = Object.keys(dependencies).find(name => name.startsWith('@aily-project/board-'));
  let legacyBoard: { instanceId: string; packageName: string } | undefined;
  const cache = new Map<string, SceneJsonObject | null>();
  const configs: Record<string, SceneJsonObject> = Object.create(null);

  for (const rawComponent of graph['components']) {
    const component = object(rawComponent);
    const refId = string(component['refId']);
    const pinmapId = string(component['pinmapId']);
    const [slug, model, variant = 'default'] = pinmapId.split(':');
    const packageSlug = pinmapId ? slug : boardName?.slice('@aily-project/'.length);
    if (!packageSlug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/.test(packageSlug)) continue;
    const board = component['isBoard'] === true
      || (!pinmapId && !!boardName && rawComponent === graph['components'][0]);
    if (board && !legacyBoard) legacyBoard = { instanceId: refId, packageName: `@aily-project/${packageSlug}` };
    const key = JSON.stringify([packageSlug, board, model, variant, string(component['configFile'])]);
    if (cache.has(key)) {
      const config = cache.get(key);
      if (config) configs[refId] = structuredClone(config);
      continue;
    }

    let packageRoot: string;
    try {
      const installedPath = files.join(projectRoot, 'node_modules', '@aily-project', packageSlug);
      await files.lstat(installedPath, signal);
      packageRoot = await files.realpath(installedPath, signal);
    } catch (error) {
      if (missing(error)) { cache.set(key, null); continue; }
      throw error;
    }
    let pinmap = board ? await json(packageRoot, 'pinmap.json', true) : null;
    let relative: string | null = null;
    if (!pinmap && !pinmapId && string(component['configFile'])) {
      relative = string(component['configFile']);
    } else if (!pinmap) {
      const catalog = await json(packageRoot, 'pinmaps/pinmap_catalog.json', true)
        ?? await json(packageRoot, 'pinmap_catalog.json', true);
      if (!catalog) relative = 'pinmap.json';
      else {
        const models = Array.isArray(catalog['models']) ? catalog['models'] : [];
        const selectedModel = board ? models.map(object)[0]
          : models.map(object).find(entry => entry['id'] === model);
        const variants = Array.isArray(selectedModel?.['variants']) ? selectedModel['variants'] : [];
        const candidates = variants.map(object);
        const selected = board
          ? candidates.find(entry => entry['isDefault'] === true)
            ?? candidates.find(entry => entry['status'] === 'available') ?? candidates[0]
          : candidates.find(entry => entry['id'] === variant);
        if (selected) {
          const shared = object(catalog['sharedPinmaps'] ?? {});
          const sharedPinmap = object(shared[string(selected['pinmapRef'])] ?? {});
          relative = string(selected['pinmapFile']) || string(sharedPinmap['file']) || 'pinmap.json';
        }
      }
    }
    if (!pinmap && relative) pinmap = await json(packageRoot, relative, true);
    if (!pinmap) { cache.set(key, null); continue; }
    if (!Array.isArray(pinmap['images']) || !Array.isArray(pinmap['pins'])) {
      throw new Error(`Invalid pinmap for ${pinmapId || refId}.`);
    }

    // Resolve package-local image bytes now; the iframe never receives filesystem paths.
    const images = [];
    for (const rawImage of pinmap['images']) {
      const image = object(rawImage);
      let url = string(image['url']);
      if (!url && packageSlug.startsWith('board-') && pinmap['images'].length === 1) {
        const bytes = await read(packageRoot, 'board.webp', true);
        if (bytes) url = imageDataUrl(bytes);
      } else if (url && !url.startsWith('data:') && !url.startsWith('https://')) {
        // The old catalog resolves file paths from its package root, as does the pinmap itself.
        const bytes = await read(packageRoot, url, true);
        url = bytes ? imageDataUrl(bytes) : '';
      }
      if (url) images.push({ ...image, url });
    }
    const pins = pinmap['pins'].map(value => {
      const pin = object(value);
      return { ...pin, layout: pin['layout'] ?? 'horizontal' };
    });
    const config = {
      ...pinmap,
      // Legacy pinmaps can place a connector beyond their declared canvas. Preserve its
      // actual coordinate and expand the bounds rather than moving or hiding that pin.
      width: Math.max(Number(pinmap['width']), ...pins.map(pin => Number(pin['x']))),
      height: Math.max(Number(pinmap['height']), ...pins.map(pin => Number(pin['y']))),
      images,
      pins,
      ...(images.length < pinmap['images'].length ? { ailyLegacyImportIssue: 'image-unavailable' } : {}),
    } as SceneJsonObject;
    configs[refId] = config;
    cache.set(key, config);
  }

  signal.throwIfAborted();
  const document = await importConnectionGraphToSceneEditorDocumentV2(graph, configs, options.sceneId);
  const bound = await bindLegacyCircuitScene(document, { board: legacyBoard });
  signal.throwIfAborted();
  return bound.document;
}

function imageDataUrl(bytes: Uint8Array): string {
  const signature = new TextDecoder('ascii').decode(bytes.slice(0, 12));
  const mime = signature.startsWith('RIFF') && signature.slice(8, 12) === 'WEBP' ? 'image/webp'
    : bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 ? 'image/png'
      : bytes[0] === 255 && bytes[1] === 216 ? 'image/jpeg'
        : new TextDecoder().decode(bytes.slice(0, 512)).trimStart().match(/^(?:<\?xml[^>]*>\s*)?<svg\b/i)
          ? 'image/svg+xml' : null;
  if (!mime) throw new Error('Unsupported circuit image format.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function inside(files: SimulatorProjectArtifactFilePort, root: string, candidate: string): boolean {
  const relative = files.relative(root, candidate).replace(/\\/g, '/');
  return relative !== '' && relative !== '..' && !relative.startsWith('../')
    && !relative.startsWith('/') && !/^[A-Za-z]:/.test(relative);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid circuit object.');
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && ['ENOENT', 'ENOTDIR'].includes(String((error as { code?: unknown }).code));
}
