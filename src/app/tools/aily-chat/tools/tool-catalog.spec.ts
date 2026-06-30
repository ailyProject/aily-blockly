import { TOOL_CATALOG, getDeferredToolsListing, searchDeferredTools } from './tool-catalog';

describe('tool-catalog', () => {
  it('filters deferred listing by excluded tools', () => {
    const listing = getDeferredToolsListing('mainAgent', new Set(['create_project']));

    expect(listing).toContain('search_available_tools');
    expect(listing).not.toContain('create_project');
  });

  it('returns exact deferred tool matches', () => {
    const matches = searchDeferredTools('create_project', TOOL_CATALOG, 'mainAgent');

    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('create_project');
  });

  it('filters out agent-incompatible deferred tools', () => {
    const matches = searchDeferredTools('create_project', TOOL_CATALOG, 'schematicAgent');

    expect(matches).toEqual([]);
  });

  it('expands deferred group searches', () => {
    const matches = searchDeferredTools('项目管理', TOOL_CATALOG, 'mainAgent');
    const names = matches.map(tool => tool.name);

    expect(names).toContain('create_project');
    expect(names).toContain('reload_project');
    expect(names).toContain('switch_board');
  });

  it('keeps Blockly catalog aligned to the operation surface', () => {
    const names = new Set(TOOL_CATALOG.map(tool => tool.name));

    expect(names.has('syncAbs')).toBeTrue();
    expect(names.has('lint')).toBeTrue();
    expect(names.has('analyzeLibrary')).toBeTrue();

    expect(names.has('get_workspace_overview_tool')).toBeFalse();
    expect(names.has('analyze_library_blocks')).toBeFalse();
  });
});
