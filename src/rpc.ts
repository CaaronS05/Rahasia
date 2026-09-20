import type { Config } from "./types.ts";

let requestId = 1;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcError extends Error {
  code?: number;
  data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export async function rpcCall<T>(
  config: Config,
  method: string,
  params: unknown[],
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < config.requestRetries; attempt++) {
    try {
      const response = await fetch(config.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: requestId++,
          method,
          params,
        }),
      });

      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string; data?: unknown };
      };

      if (json.error) {
        throw new RpcError(
          json.error.message || `RPC ${method} failed`,
          json.error.code,
          json.error.data,
        );
      }

      return json.result as T;
    } catch (error) {
      lastError = error;
      if (error instanceof RpcError) throw error;
      const delay = Math.min(500 * 2 ** attempt, 8000);
      await sleep(delay);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(items.length, 1)) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}
