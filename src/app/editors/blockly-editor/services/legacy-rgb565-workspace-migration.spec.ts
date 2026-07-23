import {
  migrateLegacyRgb565SerializedBlocks,
  migrateLegacyRgb565WorkspaceSerialization,
} from './legacy-rgb565-workspace-migration';

describe('migrateLegacyRgb565WorkspaceSerialization', () => {
  const rgb565Value = {
    version: 1,
    format: 'rgb565',
    encoding: 'rgb565-be-base64',
    width: 2,
    height: 1,
    fps: 10,
    maxFrames: 1,
    frames: ['+AAH4A=='],
  };
  const rgb332Value = {
    version: 1,
    format: 'rgb332',
    encoding: 'rgb332-base64',
    width: 2,
    height: 1,
    fps: 10,
    maxFrames: 1,
    frames: ['/wA='],
  };

  function workspace(...blocks: unknown[]) {
    return { blocks: { languageVersion: 0, blocks } };
  }

  function asset(type: string, value: unknown) {
    return { type, fields: { CUSTOM_ANIMATION: value } };
  }

  function staticText(value: string) {
    return { shadow: { type: 'text', fields: { TEXT: value } } };
  }

  it('migrates object and string raw assets through block, shadow, nested input, and next links', () => {
    const original = workspace({
      type: 'controls_if',
      inputs: {
        DO0: {
          block: {
            type: 'seeed_gfx_play_animation',
            inputs: {
              ANIMATION: { block: asset('seeed_gfx_animation', rgb565Value) },
            },
            next: {
              block: {
                type: 'tftscr_draw_animation_frame',
                inputs: {
                  ANIMATION: {
                    shadow: asset('tftscr_animation', JSON.stringify(rgb332Value)),
                  },
                },
              },
            },
          },
        },
      },
    });
    const before = JSON.stringify(original);

    const migrated: any = migrateLegacyRgb565WorkspaceSerialization(original);
    const play = migrated.blocks.blocks[0].inputs.DO0.block;
    const draw = play.next.block;

    expect(play.type).toBe('seeed_gfx_play_rgb565_animation');
    expect(play.inputs.ANIMATION.block.type).toBe('seeed_gfx_rgb565_animation');
    expect(draw.type).toBe('tftscr_draw_rgb565_animation_frame');
    expect(draw.inputs.ANIMATION.shadow.type).toBe('tftscr_rgb565_animation');
    expect(JSON.stringify(original)).toBe(before);
  });

  it('migrates play, draw, and frame-count parents only from their effective migrated input', () => {
    const original = workspace(
      {
        type: 'seeed_gfx_animation_frame_count',
        inputs: { ANIMATION: { shadow: asset('seeed_gfx_animation', rgb565Value) } },
      },
      {
        type: 'tftscr_play_animation',
        inputs: { ANIMATION: { block: asset('tftscr_animation', rgb332Value) } },
      },
      {
        type: 'seeed_gfx_play_animation',
        inputs: {
          ANIMATION: {
            block: asset('seeed_gfx_animation', {
              version: 4,
              format: 'aani',
              encoding: 'base64',
              extension: '.aani',
              data: 'QUFOSQ==',
            }),
            shadow: asset('seeed_gfx_animation', rgb565Value),
          },
        },
      },
    );

    const migrated: any = migrateLegacyRgb565WorkspaceSerialization(original);
    expect(migrated.blocks.blocks[0].type).toBe('seeed_gfx_rgb565_animation_frame_count');
    expect(migrated.blocks.blocks[1].type).toBe('tftscr_play_rgb565_animation');
    expect(migrated.blocks.blocks[2].type).toBe('seeed_gfx_play_animation');
    expect(migrated.blocks.blocks[2].inputs.ANIMATION.block.type).toBe('seeed_gfx_animation');
    expect(migrated.blocks.blocks[2].inputs.ANIMATION.shadow.type).toBe('seeed_gfx_rgb565_animation');
  });

  it('leaves valid AANI v4 assets and parents untouched', () => {
    const original = workspace({
      type: 'tftscr_animation_frame_count',
      inputs: {
        ANIMATION: {
          block: asset('tftscr_animation', {
            version: 4,
            format: 'aani',
            encoding: 'base64',
            extension: '.aani',
            data: 'QUFOSQ==',
            width: 1,
            height: 1,
            frameCount: 1,
            durationTicks: '1000',
            timescale: 1000000,
          }),
        },
      },
    });

    const migrated = migrateLegacyRgb565WorkspaceSerialization(original);
    expect(migrated).toBe(original);
  });

  it('leaves malformed v1 envelopes untouched', () => {
    const original = workspace(
      asset('seeed_gfx_animation', { ...rgb565Value, encoding: 'rgb332-base64' }),
      asset('seeed_gfx_animation', { ...rgb565Value, frames: 'not-an-array' }),
      asset('tftscr_animation', '{bad json'),
      asset('tftscr_animation', { ...rgb332Value, version: 2 }),
    );

    expect(migrateLegacyRgb565WorkspaceSerialization(original)).toBe(original);
  });

  it('is idempotent', () => {
    const original = workspace({
      type: 'seeed_gfx_draw_animation_frame',
      inputs: { ANIMATION: { block: asset('seeed_gfx_animation', rgb565Value) } },
    });
    const once = migrateLegacyRgb565WorkspaceSerialization(original);
    const twice = migrateLegacyRgb565WorkspaceSerialization(once);

    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });

  it('migrates the uniquely named historical Seeed SD block', () => {
    const original = workspace({
      type: 'seeed_gfx_play_sd_video',
      inputs: { FILENAME: staticText('legacy.rgb565v') },
    });

    const migrated: any = migrateLegacyRgb565WorkspaceSerialization(original);
    expect(migrated.blocks.blocks[0].type).toBe('seeed_gfx_play_sd_rgb565_legacy_video');
  });

  it('migrates historical TFT TF shape and explicit rgb565v files', () => {
    const original = workspace(
      {
        type: 'tftscr_play_tf_animation',
        inputs: {
          FILENAME: staticText('legacy.bin'),
          BUFFER_KB: { shadow: { type: 'math_number', fields: { NUM: 48 } } },
        },
      },
      {
        type: 'tftscr_play_tf_animation',
        inputs: {
          X: { shadow: { type: 'math_number', fields: { NUM: 0 } } },
          Y: { shadow: { type: 'math_number', fields: { NUM: 0 } } },
          FILENAME: staticText('/video.RGB565V'),
          START_FRAME: { shadow: { type: 'math_number', fields: { NUM: 0 } } },
          FRAME_COUNT: { shadow: { type: 'math_number', fields: { NUM: 0 } } },
        },
      },
    );

    const migrated: any = migrateLegacyRgb565WorkspaceSerialization(original);
    expect(migrated.blocks.blocks.map((block: any) => block.type)).toEqual([
      'tftscr_play_tf_rgb565_legacy_video',
      'tftscr_play_tf_rgb565_video',
    ]);
  });

  it('does not migrate an explicitly named current AANI TF block, even with sparse inputs', () => {
    const original = workspace({
      type: 'tftscr_play_tf_animation',
      inputs: { FILENAME: staticText('/current.aani') },
    });

    expect(migrateLegacyRgb565WorkspaceSerialization(original)).toBe(original);
  });

  it('does not guess the format of a sparse TF block with a dynamic filename', () => {
    const original = workspace({
      type: 'tftscr_play_tf_animation',
      inputs: {
        FILENAME: {
          block: {
            type: 'variables_get',
            fields: { VAR: { id: 'file-variable' } },
          },
        },
        BUFFER_KB: { shadow: { type: 'math_number', fields: { NUM: 8 } } },
      },
    });

    expect(migrateLegacyRgb565WorkspaceSerialization(original)).toBe(original);
  });

  it('supports the compact serialization form with a direct top-level blocks array', () => {
    const original = { blocks: [asset('seeed_gfx_animation', rgb565Value)] };
    const migrated: any = migrateLegacyRgb565WorkspaceSerialization(original);
    expect(migrated.blocks[0].type).toBe('seeed_gfx_rgb565_animation');
  });

  it('migrates standalone shared-procedure block arrays without mutating them', () => {
    const original = [{
      type: 'procedures_defnoreturn',
      inputs: {
        STACK: {
          block: {
            type: 'tftscr_play_animation',
            inputs: { ANIMATION: { block: asset('tftscr_animation', rgb565Value) } },
          },
        },
      },
    }];

    const migrated: any[] = migrateLegacyRgb565SerializedBlocks(original);
    expect(migrated[0].inputs.STACK.block.type).toBe('tftscr_play_rgb565_animation');
    expect(original[0].inputs.STACK.block.type).toBe('tftscr_play_animation');
  });
});
