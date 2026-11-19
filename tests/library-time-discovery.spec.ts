import { searchBoardsLibrariesTool } from '../src/app/integrations/blockly/board-library-search';

describe('AI time-library discovery (#748)', () => {
  const config: any = {
    libraryIndex: [
      { name: 'lib-ntpclient', displayName: 'NTPClient', category: 'time', tags: ['ntp', 'time'] },
      { name: 'lib-core-time', displayName: '时间控制', category: 'utility', tags: ['core', 'time'] },
      { name: 'lib-led', displayName: 'LED', category: 'display', tags: ['led'] },
    ],
    libraryList: [
      { name: '@aily-project/lib-ntpclient', description: 'NTP时间同步库，用于获取网络时间', nickname_zh_cn: 'NTP客户端' },
      { name: '@aily-project/lib-core-time', description: '核心库，包含delay、millis、micros等函数' },
    ],
  };
  const search = async (params: any) => (await searchBoardsLibrariesTool.handler({ type: 'libraries', detail: 'summary', ...params }, config) as any).metadata.results;
  it('finds the existing library by Chinese purpose or API names absent from the structured index', async () => {
    expect((await search({ query: '网络时间' })).map((item: any) => item.packageName)).toEqual(['@aily-project/lib-ntpclient']);
    expect((await search({ query: 'millis' })).map((item: any) => item.packageName)).toEqual(['@aily-project/lib-core-time']);
    expect((await search({ query: 'NTP客户端' }))[0].packageName).toBe('@aily-project/lib-ntpclient');
  });
  it('treats filters.keywords as a text query and combines it with structural constraints', async () => {
    expect((await search({ filters: { keywords: '网络时间' } })).length).toBe(1);
    expect(await search({ filters: { keywords: '不存在的随机关键字' } })).toEqual([]);
    expect(await search({ filters: { keywords: 'millis', category: 'display' } })).toEqual([]);
    expect((await search({ filters: { category: 'time' } })).length).toBe(1);
  });
});
