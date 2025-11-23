import type { LayerColor } from "./config";

export interface StartupTimings {
  fetchStart: number;
  parseEnd: number;
  rebuildStart: number;
  rebuildEnd: number;
  firstDraw: number;
}

export function interceptConsoleLog(target: HTMLDivElement | null, maxLines = 200) {
  if (!target) {
    return;
  }
  const originalLog = console.log.bind(console);
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    originalLog(...args);
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch (error) {
          return String(arg);
        }
      })
      .join(" ");
    lines.push(message);
    while (lines.length > maxLines) {
      lines.shift();
    }
    target.style.display = "block";
    target.textContent = lines.join("\n");
    target.scrollTop = target.scrollHeight;
  };
}

export class GpuBufferTracker {
  private wrapped = false;
  private _totalBytes = 0;
  private _bufferCount = 0;
  private bufferSizes = new WeakMap<GPUBuffer, number>();

  wrap(device: GPUDevice) {
    if (this.wrapped) {
      return;
    }
    const original = device.createBuffer.bind(device);
    device.createBuffer = ((descriptor: GPUBufferDescriptor) => {
      const buffer = original(descriptor);
      const size = descriptor.size ?? 0;
      this._totalBytes += size;
      this._bufferCount += 1;
      this.bufferSizes.set(buffer, size);
      
      // Wrap destroy to track deletions
      const originalDestroy = buffer.destroy.bind(buffer);
      buffer.destroy = () => {
        const bufferSize = this.bufferSizes.get(buffer);
        if (bufferSize !== undefined) {
          this._totalBytes -= bufferSize;
          this._bufferCount -= 1;
          this.bufferSizes.delete(buffer);
        }
        originalDestroy();
      };
      
      return buffer;
    }) as typeof device.createBuffer;
    this.wrapped = true;
  }

  get totalBytes() {
    return this._totalBytes;
  }

  get bufferCount() {
    return this._bufferCount;
  }
}

export class StatsTracker {
  private frameCount = 0;
  private lastFpsUpdate = performance.now();
  private lastStatsUpdate = 0;
  private lastFps = 0;

  constructor(
    private readonly fpsEl: HTMLSpanElement | null,
    private readonly timings: StartupTimings,
    private readonly gpuTracker: GpuBufferTracker
  ) {}

  recordFrame(timestamp: number) {
    this.frameCount += 1;
    const elapsed = timestamp - this.lastFpsUpdate;
    if (elapsed >= 1000) {
      this.lastFps = (this.frameCount * 1000) / elapsed;
      this.frameCount = 0;
      this.lastFpsUpdate = timestamp;
    }
    if (!this.timings.firstDraw) {
      this.timings.firstDraw = timestamp;
    }
  }

  forceUpdate() {
    this.update(true);
  }

  update(force = false) {
    if (!this.fpsEl) {
      return;
    }
    const now = performance.now();
    if (!force && now - this.lastStatsUpdate < 250) {
      return;
    }
    this.lastStatsUpdate = now;

    const parseDur = this.timings.parseEnd ? this.timings.parseEnd - this.timings.fetchStart : 0;
    const rebuildDur =
      this.timings.rebuildEnd && this.timings.rebuildStart
        ? this.timings.rebuildEnd - this.timings.rebuildStart
        : 0;
    const firstFrameTotal = this.timings.firstDraw ? this.timings.firstDraw - this.timings.fetchStart : 0;
    const afterParse =
      this.timings.firstDraw && this.timings.parseEnd ? this.timings.firstDraw - this.timings.parseEnd : 0;

    const lines = [
      `FPS: ${this.lastFps.toFixed(1)}`,
      `Parse: ${formatMs(parseDur)}`,
      `Rebuild: ${formatMs(rebuildDur)}`,
      `FirstFrame total: ${formatMs(firstFrameTotal)}`,
      `FirstFrame post-parse: ${formatMs(afterParse)}`,
      `GPU Buffers: ${this.gpuTracker.bufferCount} (${formatMB(this.gpuTracker.totalBytes)})`
    ];
    this.fpsEl.innerHTML = lines.join("<br/>");
  }
}

function formatMs(ms: number) {
  return ms ? `${ms.toFixed(1)} ms` : "-";
}

function formatMB(bytes: number) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

export function applyUniformColor(uniformData: Float32Array, color: LayerColor) {
  uniformData.set(color, 0);
}
