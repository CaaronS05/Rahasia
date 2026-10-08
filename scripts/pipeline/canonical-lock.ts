import { constants } from "node:fs";
import { mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";

const LOCK_DIR = path.resolve("data/master");
const LOCK_FILE = path.join(LOCK_DIR, ".canonical-write.lock");
const LOCK_STALE_MS = 60_000; // 60 seconds stale cutoff
const RETRY_INTERVAL_MS = 150;
const MAX_WAIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function getErrorCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return undefined;
}

/**
 * Acquire advisory cross-process lock for canonical files.
 * Handles stale locks from crashed processes automatically.
 */
export async function acquireCanonicalLock(label = "canonical-lock"): Promise<() => Promise<void>> {
  await mkdir(LOCK_DIR, { recursive: true });
  const start = Date.now();

  while (true) {
    try {
      const handle = await open(
        LOCK_FILE,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o644
      );

      const payload = JSON.stringify({
        pid: process.pid,
        label,
        acquiredAt: new Date().toISOString(),
      });

      await handle.writeFile(payload, "utf8");
      await handle.close();

      // Release callback
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await unlink(LOCK_FILE);
        } catch {
          // Ignore if already unlinked
        }
      };
    } catch (err: unknown) {
      const code = getErrorCode(err);
      if (code !== "EEXIST") {
        throw err;
      }

      // Check if existing lock is stale
      try {
        const fileStat = await stat(LOCK_FILE);
        const ageMs = Date.now() - fileStat.mtimeMs;

        if (ageMs > LOCK_STALE_MS) {
          console.warn(`[LOCK] Stale canonical lock detected (${Math.round(ageMs / 1000)}s old). Breaking lock.`);
          try {
            await unlink(LOCK_FILE);
          } catch {
            // Sibling might have unlinked, continue loop
          }
          continue;
        }
      } catch {
        // Lockfile may have just been released by owner, continue loop
        continue;
      }

      if (Date.now() - start > MAX_WAIT_MS) {
        throw new Error(
          `[LOCK] Timeout waiting for canonical lock after ${Math.round(MAX_WAIT_MS / 1000)}s (${label})`
        );
      }

      await sleep(RETRY_INTERVAL_MS);
    }
  }
}

/**
 * Execute function within a cross-process canonical lock.
 */
export async function withCanonicalLock<T>(fn: () => Promise<T>, label = "canonical-sync"): Promise<T> {
  const release = await acquireCanonicalLock(label);
  try {
    return await fn();
  } finally {
    await release();
  }
}
