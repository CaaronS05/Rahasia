import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { loadMeteoraIdl } from "./core/meteora-idl.ts";
import { normalizeTransactionInstructions } from "./core/transaction-normalizer.ts";

const METEORA_DLMM_PROGRAM_ID =
  process.env.METEORA_DLMM_PROGRAM_ID || "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const POOL_INIT_INSTRUCTION_NAMES = new Set([
  "initialize_lb_pair",
  "initialize_lb_pair2",
  "initialize_permission_lb_pair",
  "initialize_customizable_permissionless_lb_pair",
  "initialize_customizable_permissionless_lb_pair2",
]);

// Alchemy 429 backoff sequence: 5s, 10s, 20s, 30s, 60s, 60s...
const BACKOFF_SCHEDULE_MS = [5000, 10000, 20000, 30000, 60000];
const TERMINAL_BACKOFF_MS = 60000;
const DEFAULT_RPC_DELAY_MS = 1000;
const DEFAULT_SAMPLE_SIZE = 3;

// Progressive search windows around created_at: ±1h, ±6h, ±24h
const WINDOW_TIERS = [
  { hours: 1, seconds: 3600 },
  { hours: 6, seconds: 6 * 3600 },
  { hours: 24, seconds: 24 * 3600 },
];

export type PoolSemanticAssessment =
  | "EXACT_MATCH"
  | "NEAR_MATCH"
  | "MATCH_WITH_OFFSET"
  | "MISMATCH"
  | "INITIALIZATION_NOT_FOUND";

export type GlobalSemanticAssessment =
  | "SEMANTICS_STRONGLY_SUPPORTED"
  | "SEMANTICS_SUPPORTED_WITH_OFFSET"
  | "SEMANTICS_INCONCLUSIVE"
  | "SEMANTICS_CONTRADICTED";

export interface PoolInitializationRecord {
  found: boolean;
  instruction: string | null;
  signature: string | null;
  blockTime: number | null;
  iso: string | null;
}

export interface PoolSemanticValidationRecord {
  pool: string;
  meteoraCreatedAt: number;
  meteoraCreatedAtIso: string;
  initialization: PoolInitializationRecord;
  deltaSeconds: number | null;
  absoluteDeltaSeconds: number | null;
  assessment: PoolSemanticAssessment;
}

export interface MeteoraCreatedAtSemanticValidationOutput {
  generatedAt: string;
  sampleSize: number;
  pools: PoolSemanticValidationRecord[];
  globalAssessment: GlobalSemanticAssessment;
}

interface CliOptions {
  auditFile: string;
  outputFile: string;
  sampleSize: number;
  rpcDelayMs: number;
}

interface GtfaResult {
  data?: any[];
  paginationToken?: string | null;
}

let nextRpcId = 1;

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = "true";
      }
    }
  }

  const rpcDelay =
    options["rpc-delay-ms"] ||
    options["pacing-ms"] ||
    options["delay-ms"] ||
    String(DEFAULT_RPC_DELAY_MS);

  return {
    auditFile:
      options["audit-file"] ||
      path.resolve("data/discovery/waldisc-2/meteora-pool-created-at-audit.json"),
    outputFile:
      options["output-file"] ||
      options.output ||
      path.resolve("data/discovery/waldisc-2/meteora-created-at-semantic-validation.json"),
    sampleSize: Math.max(1, Number(options["sample-size"] || DEFAULT_SAMPLE_SIZE)),
    rpcDelayMs: Math.max(0, Number(rpcDelay)),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirectory(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: any): void {
  ensureDirectory(filePath);
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function tryReadJson(filePath: string): any | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Global RPC Limiter shared across all request types.
 * Enforces strictly sequential execution, default delay, and global pause on 429.
 */
class GlobalAlchemyRpcLimiter {
  private minDelayMs: number;
  private lastRequestTime = 0;
  private consecutive429Count = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(minDelayMs: number) {
    this.minDelayMs = minDelayMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      while (true) {
        // Enforce minimum delay between ANY Alchemy RPC request
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < this.minDelayMs) {
          await sleep(this.minDelayMs - timeSinceLast);
        }

        try {
          this.lastRequestTime = Date.now();
          const result = await fn();
          // Reset 429 retry counter ONLY after a successful RPC response
          this.consecutive429Count = 0;
          this.lastRequestTime = Date.now();
          return result;
        } catch (err: any) {
          if (err.isMethodUnsupported) {
            // Fatal unsupported error: stop immediately, do not retry
            throw err;
          }

          const is429 =
            err.status === 429 ||
            err.code === 429 ||
            err.message?.includes("429") ||
            err.message?.includes("Rate Limit");

          if (is429) {
            const delay =
              this.consecutive429Count < BACKOFF_SCHEDULE_MS.length
                ? BACKOFF_SCHEDULE_MS[this.consecutive429Count]
                : TERMINAL_BACKOFF_MS;
            this.consecutive429Count++;

            console.warn(
              `\n[Alchemy 429 Rate Limit] Global pause for ${delay / 1000}s (retry #${this.consecutive429Count})...`
            );
            await sleep(delay);
            this.lastRequestTime = Date.now();
            continue; // Retry the exact same request
          }

          const isNetworkOr5xx =
            err.message?.includes("fetch failed") ||
            err.message?.includes("ECONNRESET") ||
            err.message?.includes("ETIMEDOUT") ||
            err.message?.includes("HTTP 5");

          if (isNetworkOr5xx) {
            const delay =
              this.consecutive429Count < BACKOFF_SCHEDULE_MS.length
                ? BACKOFF_SCHEDULE_MS[this.consecutive429Count]
                : TERMINAL_BACKOFF_MS;
            this.consecutive429Count++;

            console.warn(
              `\n[RPC Network/Server Error] ${err.message} — pausing for ${delay / 1000}s...`
            );
            await sleep(delay);
            this.lastRequestTime = Date.now();
            continue;
          }

          throw err;
        }
      }
    };

    // Serialize all requests strictly in a single queue
    const nextPromise = this.queue.then(run, run);
    this.queue = nextPromise.then(() => {}, () => {});
    return nextPromise;
  }
}

async function rawRpcPost<T>(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method,
      params,
    }),
  });

  if (response.status === 429) {
    const error: any = new Error(`HTTP 429 Too Many Requests`);
    error.status = 429;
    throw error;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const json = (await response.json()) as {
    result?: T;
    error?: { code?: number; message?: string; data?: unknown };
  };

  if (json.error) {
    const errMsg = json.error.message?.toLowerCase() || "";
    const errCode = json.error.code;

    // Check if Alchemy plan or endpoint does not support this method
    const isMethodUnsupported =
      errCode === -32601 ||
      errMsg.includes("method not found") ||
      errMsg.includes("unsupported method") ||
      errMsg.includes("plan does not support") ||
      errMsg.includes("invalid method") ||
      errMsg.includes("not supported");

    if (isMethodUnsupported) {
      console.error("\n==================================================");
      console.error("FATAL RPC ERROR: Alchemy getTransactionsForAddress is not supported!");
      console.error(`Error Code   : ${errCode}`);
      console.error(`Error Message: ${json.error.message}`);
      console.error("==================================================");
      const fatalErr: any = new Error(
        `Alchemy getTransactionsForAddress unsupported: [${errCode}] ${json.error.message}`
      );
      fatalErr.isMethodUnsupported = true;
      throw fatalErr;
    }

    if (errCode === 429 || errMsg.includes("429") || errMsg.includes("rate limit")) {
      const error: any = new Error(json.error.message || `RPC 429 Rate Limit`);
      error.status = 429;
      error.code = 429;
      throw error;
    }

    throw new Error(json.error.message || `RPC ${method} error`);
  }

  return json.result as T;
}

async function rpcCallWithAlchemyLimiter<T>(
  limiter: GlobalAlchemyRpcLimiter,
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<T> {
  return limiter.execute(() => rawRpcPost<T>(rpcUrl, method, params));
}

function decodeInitializationFromTransaction(
  txItem: any,
  pool: string,
  initDiscriminatorMap: Map<string, string>
): PoolInitializationRecord | null {
  if (!txItem) return null;

  const tx = txItem.transaction ?? txItem;
  const meta = txItem.meta ?? tx?.meta;

  // Transaction must have succeeded
  if (meta?.err !== null && meta?.err !== undefined) {
    return null;
  }

  const txBlockTime = Number(txItem.blockTime ?? tx?.blockTime ?? 0);
  if (!txBlockTime || txBlockTime <= 0) {
    return null;
  }

  const normalizedIxs = normalizeTransactionInstructions(txItem);

  for (const ix of normalizedIxs) {
    if (ix.programId !== METEORA_DLMM_PROGRAM_ID) {
      continue;
    }

    if (!ix.data || typeof ix.data !== "string") {
      continue;
    }

    let rawBuffer: Buffer;
    try {
      rawBuffer = Buffer.from(bs58.decode(ix.data));
    } catch {
      continue;
    }

    if (rawBuffer.length < 8) {
      continue;
    }

    const discHex = rawBuffer.subarray(0, 8).toString("hex");
    const matchedIxName = initDiscriminatorMap.get(discHex);

    if (!matchedIxName) {
      continue;
    }

    // Verify the requested pool / lb_pair account matches
    const isTargetPool =
      ix.accounts[0] === pool || (Array.isArray(ix.accounts) && ix.accounts.includes(pool));

    if (!isTargetPool) {
      continue;
    }

    const signature =
      ix.signature ||
      txItem.signature ||
      (Array.isArray(tx.signatures) ? tx.signatures[0] : "unknown");

    return {
      found: true,
      instruction: matchedIxName,
      signature,
      blockTime: txBlockTime,
      iso: new Date(txBlockTime * 1000).toISOString(),
    };
  }

  return null;
}

async function findInitializationViaGtfa(
  limiter: GlobalAlchemyRpcLimiter,
  rpcUrl: string,
  pool: string,
  apiCreatedAtSec: number,
  initDiscriminatorMap: Map<string, string>
): Promise<PoolInitializationRecord> {
  for (let tierIdx = 0; tierIdx < WINDOW_TIERS.length; tierIdx++) {
    const tier = WINDOW_TIERS[tierIdx];
    const windowStartUnix = apiCreatedAtSec - tier.seconds;
    const windowEndUnix = apiCreatedAtSec + tier.seconds;

    console.log(
      `Querying ±${tier.hours}h via getTransactionsForAddress [${new Date(windowStartUnix * 1000).toISOString()} to ${new Date(windowEndUnix * 1000).toISOString()}]...`
    );

    let paginationToken: string | null = null;
    let pagesQueried = 0;
    let transactionsReturned = 0;
    let foundInit: PoolInitializationRecord | null = null;

    while (true) {
      pagesQueried++;

      const options: Record<string, unknown> = {
        transactionDetails: "full",
        sortOrder: "asc",
        limit: 100,
        encoding: "json",
        maxSupportedTransactionVersion: 0,
        filters: {
          blockTime: {
            gte: windowStartUnix,
            lte: windowEndUnix,
          },
          status: "succeeded",
          tokenAccounts: "none",
        },
      };

      if (paginationToken) {
        options.paginationToken = paginationToken;
      }

      const result = await rpcCallWithAlchemyLimiter<GtfaResult>(
        limiter,
        rpcUrl,
        "getTransactionsForAddress",
        [pool, options]
      );

      const txBatch = Array.isArray(result?.data) ? result.data : [];
      transactionsReturned += txBatch.length;

      // Decode transactions in batch
      for (const txItem of txBatch) {
        const decoded = decodeInitializationFromTransaction(
          txItem,
          pool,
          initDiscriminatorMap
        );

        if (decoded) {
          foundInit = decoded;
          break;
        }
      }

      if (foundInit) {
        break;
      }

      if (result?.paginationToken) {
        paginationToken = result.paginationToken;
      } else {
        break;
      }
    }

    console.log(`Transactions returned: ${transactionsReturned}`);
    console.log(`Pages queried         : ${pagesQueried}`);

    if (foundInit) {
      const deltaSec = apiCreatedAtSec - (foundInit.blockTime ?? 0);
      console.log(`Instruction : ${foundInit.instruction}`);
      console.log(`Signature   : ${foundInit.signature}`);
      console.log(`Block Time  : ${foundInit.iso} (${foundInit.blockTime})`);
      console.log(`Delta       : ${deltaSec} seconds\n`);
      return foundInit;
    }

    if (tierIdx < WINDOW_TIERS.length - 1) {
      console.log(
        `Initialization not found. Expanding to ±${WINDOW_TIERS[tierIdx + 1].hours}h...\n`
      );
    }
  }

  return {
    found: false,
    instruction: null,
    signature: null,
    blockTime: null,
    iso: null,
  };
}

export async function runMeteoraCreatedAtSemanticValidation(): Promise<MeteoraCreatedAtSemanticValidationOutput> {
  const opts = parseCliArgs();

  console.log("==================================================");
  console.log("WALDISC-2 — METEORA CREATED_AT SEMANTIC VALIDATION");
  console.log("==================================================");

  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl || !rpcUrl.startsWith("http")) {
    console.error("FATAL: ALCHEMY_RPC_URL environment variable is required and must be a valid URL.");
    process.exit(1);
  }

  const limiter = new GlobalAlchemyRpcLimiter(opts.rpcDelayMs);

  // 1. Read existing audit file
  const auditData = tryReadJson(opts.auditFile);
  if (!auditData || !Array.isArray(auditData.pools)) {
    throw new Error(`Failed to load valid audit pools from: ${opts.auditFile}`);
  }

  // 2. Select valid pools and sort by created_at descending (newest pools first)
  const validPools = auditData.pools
    .filter((p: any) => p.status === "AVAILABLE_VALID" && (p.rawValue || p.timestamp))
    .sort((a: any, b: any) => {
      const tsA = Number(a.rawValue ?? a.timestamp ?? 0);
      const tsB = Number(b.rawValue ?? b.timestamp ?? 0);
      return tsB - tsA;
    });

  const sampledPools = validPools.slice(0, opts.sampleSize);
  console.log(`Sampled Pools        : ${sampledPools.length} (requested: ${opts.sampleSize})`);
  console.log(`RPC Source           : ALCHEMY_RPC_URL`);
  console.log(`Method               : getTransactionsForAddress (windowed)`);
  console.log(`Global RPC Delay     : ${opts.rpcDelayMs}ms\n`);

  // 3. Load Meteora IDL for pool initialization instruction discriminators
  const idlBundle = await loadMeteoraIdl(METEORA_DLMM_PROGRAM_ID);
  const idlMap = idlBundle.instructionMap;
  const initDiscriminatorMap = new Map<string, string>();
  for (const [discHex, ixDef] of idlMap.entries()) {
    if (POOL_INIT_INSTRUCTION_NAMES.has(ixDef.name)) {
      initDiscriminatorMap.set(discHex, ixDef.name);
    }
  }

  const poolRecords: PoolSemanticValidationRecord[] = [];

  for (let i = 0; i < sampledPools.length; i++) {
    const poolItem = sampledPools[i];
    const poolAddress: string = poolItem.pool;
    const rawVal = poolItem.rawValue ?? poolItem.timestamp;
    const num = typeof rawVal === "number" ? rawVal : Number(rawVal);
    const apiCreatedAtSec = Math.floor(num > 1e11 ? num / 1000 : num);
    const apiCreatedAtIso = new Date(apiCreatedAtSec * 1000).toISOString();

    console.log(`[${i + 1}/${sampledPools.length}] Pool ${poolAddress}...`);
    console.log(`Meteora created_at : ${apiCreatedAtIso} (${apiCreatedAtSec})`);

    const initResult = await findInitializationViaGtfa(
      limiter,
      rpcUrl,
      poolAddress,
      apiCreatedAtSec,
      initDiscriminatorMap
    );

    let assessment: PoolSemanticAssessment;
    let deltaSeconds: number | null = null;
    let absDelta: number | null = null;

    if (initResult.found && initResult.blockTime !== null) {
      deltaSeconds = apiCreatedAtSec - initResult.blockTime;
      absDelta = Math.abs(deltaSeconds);

      if (absDelta <= 5) {
        assessment = "EXACT_MATCH";
      } else if (absDelta <= 60) {
        assessment = "NEAR_MATCH";
      } else if (absDelta <= 3600) {
        assessment = "MATCH_WITH_OFFSET";
      } else {
        assessment = "MISMATCH";
      }
    } else {
      assessment = "INITIALIZATION_NOT_FOUND";
    }

    poolRecords.push({
      pool: poolAddress,
      meteoraCreatedAt: apiCreatedAtSec,
      meteoraCreatedAtIso: apiCreatedAtIso,
      initialization: initResult,
      deltaSeconds,
      absoluteDeltaSeconds: absDelta,
      assessment,
    });
  }

  // 4. Compute Global Assessment
  let globalAssessment: GlobalSemanticAssessment;
  if (poolRecords.some((p) => p.assessment === "MISMATCH")) {
    globalAssessment = "SEMANTICS_CONTRADICTED";
  } else if (poolRecords.some((p) => p.assessment === "INITIALIZATION_NOT_FOUND")) {
    globalAssessment = "SEMANTICS_INCONCLUSIVE";
  } else if (poolRecords.some((p) => p.assessment === "MATCH_WITH_OFFSET")) {
    globalAssessment = "SEMANTICS_SUPPORTED_WITH_OFFSET";
  } else {
    globalAssessment = "SEMANTICS_STRONGLY_SUPPORTED";
  }

  const output: MeteoraCreatedAtSemanticValidationOutput = {
    generatedAt: new Date().toISOString(),
    sampleSize: poolRecords.length,
    pools: poolRecords,
    globalAssessment,
  };

  // 5. Atomic write JSON output
  atomicWriteJson(opts.outputFile, output);

  // 6. Terminal Report
  console.log("\nWALDISC-2 — METEORA CREATED_AT SEMANTIC VALIDATION\n");
  for (let i = 0; i < poolRecords.length; i++) {
    const p = poolRecords[i];
    console.log(`Pool ${i + 1}:`);
    console.log(`Meteora created_at : ${p.meteoraCreatedAtIso} (${p.meteoraCreatedAt})`);
    console.log(
      `On-chain init      : ${p.initialization.iso ?? "NOT_FOUND"}${
        p.initialization.blockTime !== null ? ` (${p.initialization.blockTime})` : ""
      }`
    );
    console.log(`Instruction        : ${p.initialization.instruction ?? "NONE"}`);
    console.log(
      `Delta              : ${p.deltaSeconds !== null ? `${p.deltaSeconds} seconds` : "N/A"}`
    );
    console.log(`Assessment         : ${p.assessment}\n`);
  }

  console.log(`Global Assessment:\n${globalAssessment}\n`);
  console.log("IMPORTANT:\n");
  console.log(
    "created_at must NOT be promoted to production pool creation time unless\non-chain initialization semantics are successfully demonstrated."
  );
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-validate-meteora-created-at.ts")) {
  runMeteoraCreatedAtSemanticValidation().catch((err) => {
    console.error("Fatal error during Meteora created_at semantic validation:", err);
    process.exit(1);
  });
}
