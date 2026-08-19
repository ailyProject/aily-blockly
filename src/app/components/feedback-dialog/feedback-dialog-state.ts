export function resolveFeedbackContentOnTypeChange(
  type: string,
  currentContent: string,
  getLibraryIssueContent: () => string,
): string {
  if (type === 'library' && !currentContent.trim()) {
    return getLibraryIssueContent();
  }

  return currentContent;
}
