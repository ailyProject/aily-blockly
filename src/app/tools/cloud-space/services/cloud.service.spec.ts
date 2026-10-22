import { firstValueFrom, of } from 'rxjs';
import { HttpHeaders, HttpResponse } from '@angular/common/http';
import { CloudService } from './cloud.service';

describe('CloudService Coder category isolation', () => {
  let service: CloudService;
  let http: { get: jasmine.Spy; post: jasmine.Spy };
  let config: { isCoderProduct: jasmine.Spy };
  let auth: { isLoggedIn: boolean };

  beforeEach(() => {
    http = { get: jasmine.createSpy('get').and.returnValue(of({})), post: jasmine.createSpy('post').and.returnValue(of({})) };
    config = { isCoderProduct: jasmine.createSpy('isCoderProduct').and.returnValue(true) };
    auth = { isLoggedIn: true };
    service = new CloudService(http as any, {} as any, {} as any, auth as any, config as any);
  });

  it('adds category to public searches while retaining pagination, ID, keyword and board', () => {
    service.getPublicProjects(2, 10, ' weather & clock ', ' example-id ', ' esp32 ');
    const [url, { params }] = http.get.calls.mostRecent().args;
    expect(url).toMatch(/\/cloud\/projects\/public$/);
    expect(Object.fromEntries(params.keys().map((key: string) => [key, params.get(key)]))).toEqual({
      page: '2', perPage: '10', keywords: 'weather & clock', id: 'example-id', board: 'esp32', category: 'coder',
    });
  });

  it('adds category to cloud and template lists in the standalone Coder product', () => {
    service.getProjects(3, 100);
    expect(http.get.calls.mostRecent().args[1].params).toEqual({ page: '3', perPage: '100', category: 'coder' });
    service.getMyTemplates(1, 20, ' esp32 ');
    expect(http.get.calls.mostRecent().args[1].params).toEqual({ page: '1', perPage: '20', board: 'esp32', category: 'coder' });
  });

  it('explicitly filters all three Blockly lists without changing the other parameters', () => {
    config.isCoderProduct.and.returnValue(false);
    service.getPublicProjects(1, 10, '');
    const params = http.get.calls.mostRecent().args[1].params;
    expect(Object.fromEntries(params.keys().map((key: string) => [key, params.get(key)]))).toEqual({
      page: '1', perPage: '10', category: 'blockly',
    });
    service.getProjects(1, 100);
    expect(http.get.calls.mostRecent().args[1].params).toEqual({ page: '1', perPage: '100', category: 'blockly' });
    service.getMyTemplates(1, 20, 'esp32');
    expect(http.get.calls.mostRecent().args[1].params).toEqual({ page: '1', perPage: '20', board: 'esp32', category: 'blockly' });
  });

  it('retains the unauthenticated template short circuit', () => {
    auth.isLoggedIn = false;
    let response: any;
    service.getMyTemplates().subscribe(value => response = value);
    expect(response.data.list).toEqual([]);
    expect(http.get).not.toHaveBeenCalled();
  });

  it('requests student projects with pagination and the current product category', () => {
    service.getStudentProjects(2, 100);
    expect(http.get.calls.mostRecent().args).toEqual([
      jasmine.stringMatching(/\/cloud\/projects\/students$/),
      { params: { page: '2', perPage: '100', category: 'coder' } },
    ]);
    config.isCoderProduct.and.returnValue(false);
    service.getStudentProjects();
    expect(http.get.calls.mostRecent().args[1].params.category).toBe('blockly');
  });

  it('uses authenticated HTTP requests for project details, downloads and private covers', () => {
    service.getProject('student-project');
    expect(http.get.calls.mostRecent().args[0]).toMatch(/\/projects\/student-project$/);
    service.downloadProject('student-project');
    expect(http.get.calls.mostRecent().args).toEqual([
      jasmine.stringMatching(/\/projects\/student-project\/download$/), { responseType: 'blob' },
    ]);
    service.getProjectImage('/files/cover.webp');
    expect(http.get.calls.mostRecent().args).toEqual([
      `${service.baseUrl}/files/cover.webp`, { responseType: 'blob' },
    ]);
  });

  it('sends the Coder upload category as a multipart field alongside projectData and pid', () => {
    const projectData = { name: 'demo', type: 'coder', entry: 'src/main.cpp' };
    service.syncProject({ pid: 'cloud-id', projectData, category: 'coder', expectedArchiveSha256: 'a'.repeat(64) });
    const [url, body] = http.post.calls.mostRecent().args;
    expect(url).toMatch(/\/cloud\/sync$/);
    expect(body.get('category')).toBe('coder');
    expect(body.get('pid')).toBe('cloud-id');
    expect(body.get('expectedArchiveSha256')).toBe('a'.repeat(64));
    expect(JSON.parse(body.get('projectData'))).toEqual(projectData);
    expect(Object.keys(projectData)).toEqual(['name', 'type', 'entry']);
  });

  it('does not relabel a Blockly upload based on the running product', () => {
    service.syncProject({ projectData: { name: 'blockly' }, category: 'blockly' });
    const body: FormData = http.post.calls.mostRecent().args[1];
    expect(body.get('category')).toBe('blockly');
    expect(JSON.parse(body.get('projectData') as string)).toEqual({ name: 'blockly' });
  });

  it('retains binary archive content in the Coder multipart upload', () => {
    const previous = { fs: window['fs'], path: window['path'] };
    try {
      window['fs'] = { readFileSync: jasmine.createSpy('readArchive').and.returnValue(new Uint8Array([0x37, 0x7a, 0xbc])) };
      window['path'] = { basename: () => 'project.7z' };
      service.syncProject({ projectData: { type: 'coder' }, category: 'coder', archive: '/demo/project.7z' });
      const archive: File = http.post.calls.mostRecent().args[1].get('archive');
      expect(archive.name).toBe('project.7z');
      expect(archive.size).toBe(3);
      expect(archive.type).toBe('application/x-7z-compressed');
      expect(window['fs'].readFileSync).toHaveBeenCalledOnceWith('/demo/project.7z', null);
    } finally {
      Object.assign(window, previous);
    }
  });

  it('reads the owner archive by UUID and binds the verified byte hash to its extracted contents', async () => {
    const blob = new Blob([new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x01])]);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), value => value.toString(16).padStart(2, '0')).join('');
    http.get.and.returnValue(of(new HttpResponse({ body: blob, headers: new HttpHeaders({ 'X-Archive-Sha256': sha256, 'X-Archive-Size': String(blob.size) }) })));
    const extract = spyOn<any>(service, 'downloadAndExtractArchive').and.resolveTo('/extracted');
    expect(await firstValueFrom(service.openVerifiedProjectArchive({ id: 42, uuid: 'project-uuid', archive_sha256: sha256 }, true)))
      .toEqual({ path: '/extracted', sha256 });
    expect(http.get.calls.mostRecent().args).toEqual([
      jasmine.stringMatching(/\/projects\/project-uuid\/archive$/),
      { responseType: 'blob', observe: 'response', params: { expectedArchiveSha256: sha256 } },
    ]);
    http.get.and.returnValue(of(new HttpResponse({ body: blob, headers: new HttpHeaders({ 'X-Archive-Sha256': '0'.repeat(64), 'X-Archive-Size': String(blob.size) }) })));
    await expectAsync(firstValueFrom(service.openVerifiedProjectArchive({ uuid: 'project-uuid' }, true))).toBeRejectedWithError('云工程归档校验失败，请重新打开');
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('keeps teacher reads on the existing download endpoint and computes a baseline from actual bytes', async () => {
    const blob = new Blob([new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])]);
    http.get.and.returnValue(of(new HttpResponse({ body: blob })));
    spyOn<any>(service, 'downloadAndExtractArchive').and.resolveTo('/student-archive');
    const result = await firstValueFrom(service.openVerifiedProjectArchive({ id: 7, uuid: 'student-uuid' }, false));
    expect(http.get.calls.mostRecent().args[0]).toMatch(/\/projects\/7\/download$/);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
