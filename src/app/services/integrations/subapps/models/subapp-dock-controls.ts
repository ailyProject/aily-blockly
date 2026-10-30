/** The Dock owns these debuggers' embedded/window launch controls. */
export function hasDockEmbeddedViewControl(toolId: string): boolean {
  return ['serial-debugger', 'mqtt-debugger', 'network-debugger'].includes(toolId);
}
