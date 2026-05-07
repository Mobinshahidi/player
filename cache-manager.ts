import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, statSync } from "fs";

export type CacheState =
  | "idle"
  | "buffering"
  | "downloading"
  | "complete"
  | "retrying"
  | "error";

export interface CacheManagerOptions {
  connectTimeoutSec: number;
  userAgent: string;
  disableRange: boolean;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  prefetchMaxAttempts?: number;
}

interface Slot {
  url: string;
  localPath: string;
  totalBytes: number;
  proc: ChildProcess | null;
  state: CacheState;
  attempt: number;
  killed: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export class CacheManager extends EventEmitter {
  private slots: (Slot | null)[] = [null, null];
  private baseDelay: number;
  private maxDelay: number;
  private prefetchMax: number;

  constructor(private opts: CacheManagerOptions) {
    super();
    this.baseDelay = opts.baseRetryDelayMs ?? 2000;
    this.maxDelay = opts.maxRetryDelayMs ?? 60000;
    this.prefetchMax = opts.prefetchMaxAttempts ?? 10;
  }

  async startCurrent(
    episodeUrl: string,
    localPath: string,
    resumeFrom: number,
    minBufferBytes: number,
    onComplete: () => void,
  ): Promise<{ localPath: string; bufferReady: Promise<void> }> {
    this.killSlot(0);
    const diskBytes = fileSize(localPath);
    const startOffset = diskBytes > 0 ? Math.max(resumeFrom, diskBytes) : 0;

    const slot: Slot = {
      url: episodeUrl,
      localPath,
      totalBytes: 0,
      proc: null,
      state: "buffering",
      attempt: 0,
      killed: false,
      retryTimer: null,
    };
    this.slots[0] = slot;

    this.emit("state", "buffering", 0);

    // HEAD request to learn total size (best-effort)
    this.headRequest(episodeUrl).then((total) => {
      if (slot.killed) return;
      slot.totalBytes = total;
      const cur = fileSize(localPath);
      if (total > 0 && cur >= total) {
        slot.state = "complete";
        this.emit("state", "complete", 0);
        onComplete();
        return;
      }
      this.spawnCurl(slot, startOffset, 0, onComplete);
    });

    const bufferReady = this.waitForBuffer(localPath, minBufferBytes);
    return { localPath, bufferReady };
  }

  startPrefetch(episodeUrl: string, localPath: string): void {
    this.killSlot(1);
    const diskBytes = fileSize(localPath);
    const slot: Slot = {
      url: episodeUrl,
      localPath,
      totalBytes: 0,
      proc: null,
      state: "downloading",
      attempt: 0,
      killed: false,
      retryTimer: null,
    };
    this.slots[1] = slot;

    this.headRequest(episodeUrl).then((total) => {
      if (slot.killed) return;
      slot.totalBytes = total;
      if (total > 0 && diskBytes >= total) {
        slot.state = "complete";
        this.emit("state", "complete", 1);
        return;
      }
      this.spawnCurl(slot, diskBytes, 1, () => {
        slot.state = "complete";
        this.emit("state", "complete", 1);
      });
    });
  }

  currentOffset(slotIndex = 0): number {
    const slot = this.slots[slotIndex];
    if (!slot) return 0;
    return fileSize(slot.localPath);
  }

  killAll(): void {
    this.killSlot(0);
    this.killSlot(1);
  }

  private killSlot(index: number): void {
    const slot = this.slots[index];
    if (!slot) return;
    slot.killed = true;
    if (slot.retryTimer) clearTimeout(slot.retryTimer);
    try {
      slot.proc?.kill();
    } catch {}
    this.slots[index] = null;
  }

  private spawnCurl(
    slot: Slot,
    offset: number,
    slotIndex: number,
    onComplete: () => void,
  ): void {
    if (slot.killed) return;
    slot.state = slot.attempt === 0 ? "downloading" : "retrying";
    this.emit("state", slot.state, slotIndex);

    const args = [
      "-L",
      "-k",
      "--silent",
      "--show-error",
      "--connect-timeout",
      String(this.opts.connectTimeoutSec),
      "-A",
      this.opts.userAgent,
      "-o",
      slot.localPath,
    ];
    if (offset > 0 && !this.opts.disableRange) args.push("-C", String(offset));
    args.push(slot.url);

    const proc = spawn("curl", args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    });
    slot.proc = proc;

    proc.stderr?.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes("end of response with")) {
        this.emit("error", `[cache] curl: ${msg}`, slotIndex);
      }
    });

    const progressPoll = setInterval(() => {
      if (slot.killed) {
        clearInterval(progressPoll);
        return;
      }
      this.emit("progress", fileSize(slot.localPath), slot.totalBytes, slotIndex);
    }, 2000);

    proc.on("exit", (code) => {
      clearInterval(progressPoll);
      if (slot.killed) return;
      if (code === 0) {
        slot.state = "complete";
        this.emit("state", "complete", slotIndex);
        onComplete();
        return;
      }
      const retriable = new Set([6, 7, 18, 28, 35, 56]);
      if (retriable.has(code ?? -1)) {
        slot.attempt++;
        if (slotIndex === 1 && slot.attempt > this.prefetchMax) {
          slot.state = "error";
          this.emit("state", "error", slotIndex);
          return;
        }
        const delay = Math.min(
          this.baseDelay * 2 ** (slot.attempt - 1),
          this.maxDelay,
        );
        this.emit(
          "error",
          `[cache] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${slot.attempt})`,
          slotIndex,
        );
        slot.state = "retrying";
        this.emit("state", "retrying", slotIndex);
        slot.retryTimer = setTimeout(() => {
          if (slot.killed) return;
          this.spawnCurl(slot, fileSize(slot.localPath), slotIndex, onComplete);
        }, delay);
        return;
      }
      slot.state = "error";
      this.emit("state", "error", slotIndex);
      this.emit("error", `[cache] curl exited ${code} — not retrying`, slotIndex);
      onComplete();
    });
  }

  private async headRequest(url: string): Promise<number> {
    try {
      const r = await fetch(url, { method: "HEAD" });
      const cl = r.headers.get("content-length");
      return cl ? parseInt(cl, 10) : 0;
    } catch {
      return 0;
    }
  }

  private waitForBuffer(localPath: string, minBytes: number): Promise<void> {
    return new Promise((resolve) => {
      if (existsSync(localPath) && fileSize(localPath) >= minBytes) {
        resolve();
        return;
      }
      let elapsed = 0;
      const iv = setInterval(() => {
        elapsed += 200;
        if (fileSize(localPath) >= minBytes) {
          clearInterval(iv);
          resolve();
          return;
        }
        if (elapsed >= 60_000) {
          clearInterval(iv);
          resolve();
        }
      }, 200);
    });
  }
}
