/**
 * Worker pool for parallel binary parsing
 * Manages multiple workers to process layers concurrently
 */

import type { LayerJSON } from "./types";

interface ParseTask {
  id: number;
  buffer: ArrayBuffer;
  resolve: (layer: LayerJSON) => void;
  reject: (error: Error) => void;
}

export class BinaryParserPool {
  private workers: Worker[] = [];
  private availableWorkers: Worker[] = [];
  private pendingTasks: ParseTask[] = [];
  private taskIdCounter = 0;
  private taskResolvers = new Map<
    number,
    { resolve: (layer: LayerJSON) => void; reject: (error: Error) => void }
  >();

  constructor(numWorkers: number = navigator.hardwareConcurrency || 4) {
    console.log(`[BinaryParserPool] Creating ${numWorkers} workers`);
    
    for (let i = 0; i < numWorkers; i++) {
      // In dev mode, worker is bundled separately by esbuild
      // In production (VS Code extension), use the bundled worker from dist
      const workerPath = '/dist/binaryParserWorker.js';
      const worker = new Worker(workerPath);

      worker.onmessage = (event) => this.handleWorkerMessage(event, worker);
      worker.onerror = (error) => {
        console.error(`[BinaryParserPool] Worker ${i} error:`, error);
      };

      this.workers.push(worker);
      this.availableWorkers.push(worker);
    }
  }

  /**
   * Parse binary layer data using an available worker
   * Returns a promise that resolves with the parsed LayerJSON
   */
  async parse(buffer: ArrayBuffer): Promise<LayerJSON> {
    const taskId = this.taskIdCounter++;

    return new Promise((resolve, reject) => {
      const task: ParseTask = { id: taskId, buffer, resolve, reject };

      // If worker is available, start immediately
      const worker = this.availableWorkers.pop();
      if (worker) {
        this.startTask(worker, task);
      } else {
        // Otherwise queue the task
        this.pendingTasks.push(task);
      }

      // Store resolvers for when worker responds
      this.taskResolvers.set(taskId, { resolve, reject });
    });
  }

  private startTask(worker: Worker, task: ParseTask) {
    // Send task to worker (transfer buffer for zero-copy)
    worker.postMessage(
      {
        type: "parse",
        id: task.id,
        buffer: task.buffer,
      },
      [task.buffer] // Transfer buffer ownership to worker
    );
  }

  private handleWorkerMessage(event: MessageEvent, worker: Worker) {
    const { type, id, layer, parseTime, error } = event.data;

    const resolvers = this.taskResolvers.get(id);
    if (!resolvers) {
      console.error(`[BinaryParserPool] No resolver found for task ${id}`);
      return;
    }

    this.taskResolvers.delete(id);

    if (type === "parsed") {
      if (parseTime !== undefined) {
        console.log(`[BinaryParserPool] Task ${id} parsed in ${parseTime.toFixed(2)}ms`);
      }
      resolvers.resolve(layer);
    } else if (type === "error") {
      console.error(`[BinaryParserPool] Task ${id} failed:`, error);
      resolvers.reject(new Error(error));
    }

    // Worker is now available, check for pending tasks
    const nextTask = this.pendingTasks.shift();
    if (nextTask) {
      this.startTask(worker, nextTask);
    } else {
      this.availableWorkers.push(worker);
    }
  }

  /**
   * Terminate all workers
   */
  terminate() {
    console.log("[BinaryParserPool] Terminating all workers");
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.availableWorkers = [];
    this.pendingTasks = [];
    this.taskResolvers.clear();
  }

  /**
   * Get statistics about the pool
   */
  getStats() {
    return {
      totalWorkers: this.workers.length,
      availableWorkers: this.availableWorkers.length,
      pendingTasks: this.pendingTasks.length,
      activeTasks: this.taskResolvers.size,
    };
  }
}
