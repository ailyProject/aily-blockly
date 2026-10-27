import { assertProjectRecoveryFilesCurrent, captureProjectRecoveryFiles } from './project-recovery-files';

describe('recovery source byte preservation', () => {
  const project = '/isolated-source', names = ['project.abi', 'project.abs', 'project.abs.map.json'];
  let files: Map<string, Uint8Array>, native: any;
  beforeEach(() => {
    files = new Map(names.map(name => [`${project}/${name}`, new TextEncoder().encode(name)]));
    native = { existsSync: name => files.has(name), readFileBuffer: name => Uint8Array.from(files.get(name)!),
      readFileSync: () => { throw new Error('Do not use lossy text reads.'); } };
  });
  it('archives invalid UTF-8 exactly without treating it as a missing file', async () => {
    const original = Uint8Array.of(0xff, 0xfe, 0x41); files.set(project + '/project.abs', original);
    const capture = await captureProjectRecoveryFiles(project, names, () => {}, native);
    expect(capture.files['project.abs']).toBeNull();
    expect(capture.rawFiles['project.abs']).toEqual(jasmine.objectContaining({ encoding: 'base64', bytes: 3, contents: '//5B' }));
    expect(capture.rawFiles['project.abs']!.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(() => assertProjectRecoveryFilesCurrent(project, capture, native)).not.toThrow();
    expect(files.get(project + '/project.abs')).toEqual(original);
  });
  it('preserves UTF-8 BOM, Unicode and empty files without duplicate payloads', async () => {
    const text = '\ufeff界😀\r\n'; files.set(project + '/project.abs', new TextEncoder().encode(text));
    files.set(project + '/project.abs.map.json', new Uint8Array());
    const capture = await captureProjectRecoveryFiles(project, names, () => {}, native);
    expect(capture.files['project.abs']).toBe(text);
    expect(capture.rawFiles['project.abs']!.contents).toBeUndefined();
    expect(capture.files['project.abs.map.json']).toBe('');
    expect(capture.rawFiles['project.abs.map.json']!.bytes).toBe(0);
    expect(() => assertProjectRecoveryFilesCurrent(project, capture, native)).not.toThrow();
  });
  it('detects changed or disappeared raw bytes rather than rebinding the capture', async () => {
    const capture = await captureProjectRecoveryFiles(project, names, () => {}, native);
    files.set(project + '/project.abs', Uint8Array.of(0xff));
    expect(() => assertProjectRecoveryFilesCurrent(project, capture, native)).toThrowError(/changed/);
    files.delete(project + '/project.abi');
    expect(() => assertProjectRecoveryFilesCurrent(project, capture, native)).toThrowError(/changed/);
  });
  it('checks the context before and after asynchronous hashing', async () => {
    let reads = 0;
    await expectAsync(captureProjectRecoveryFiles(project, names, () => {
      if (++reads > 1) throw new Error('project replaced');
    }, native)).toBeRejectedWithError(/replaced/);
    expect(reads).toBe(2);
  });
});
