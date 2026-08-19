import { resolveFeedbackContentOnTypeChange } from './feedback-dialog-state';

describe('FeedbackDialogComponent feedback type changes', () => {
  it('preserves entered content when the feedback type changes', () => {
    const content = '用户已经填写的反馈正文';
    const getLibraryIssueContent = jasmine.createSpy().and.returnValue('库问题模板');

    for (const feedbackType of ['bug', 'build&upload', 'library', 'other', 'feature']) {
      expect(resolveFeedbackContentOnTypeChange(feedbackType, content, getLibraryIssueContent))
        .toBe(content);
    }

    expect(getLibraryIssueContent).not.toHaveBeenCalled();
  });

  it('creates the library issue template only when the content is empty', () => {
    expect(resolveFeedbackContentOnTypeChange('library', '   ', () => '库问题模板'))
      .toBe('库问题模板');
  });
});
