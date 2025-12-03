// Debug module - debugging and testing utilities
export { DebugOverlay, DEBUG_SHOW_COORDS } from "./DebugOverlay";
export { interceptConsoleLog, GpuBufferTracker, StatsTracker, applyUniformColor } from "./debug";
export type { StartupTimings } from "./debug";
export { setupDevConsole, setupVSCodeConsoleForwarding } from "./devConsole";
