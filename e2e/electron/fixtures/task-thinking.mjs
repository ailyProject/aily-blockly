/** Session setup may cycle through several levels before a user submits. Keep
 * the selected state at submission and every subsequent change as task facts. */
export function taskThinking(entries, startedAt) {
  const changes = (entries ?? []).filter(entry => entry.type === 'thinking_level_change')
    .map(entry => ({ level: entry.thinkingLevel,
      at: typeof entry.timestamp === 'number' ? entry.timestamp : Date.parse(entry.timestamp) }))
  const timestampsComplete = Number.isFinite(startedAt) && changes.every(change => Number.isFinite(change.at))
  const atStart = timestampsComplete ? changes.filter(change => change.at <= startedAt).at(-1) : undefined
  const during = timestampsComplete ? changes.filter(change => change.at > startedAt) : []
  return { atStart: atStart ?? null, during,
    levels: [...new Set([...(atStart ? [atStart.level] : []), ...during.map(change => change.level)])],
    complete: timestampsComplete && typeof atStart?.level === 'string'
      && during.every(change => typeof change.level === 'string'),
    sessionLevels: [...new Set(changes.map(change => change.level))] }
}
