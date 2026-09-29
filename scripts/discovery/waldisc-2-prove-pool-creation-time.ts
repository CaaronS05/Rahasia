import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { loadMeteoraIdl } from "./core/meteora-idl.ts";
import { normalizeTransactionInstructions, type NormalizedInstruction } from "./core/transaction-normalizer.ts";
import { rpcCall, sleep } from "./core/rpc.ts";

const METEORA_DLMM_PROGRAM_ID =
  process.env.METEORA_DLMM_PROGRAM_ID || "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

const POOL_INIT_INSTRUCTION_NAMES = new Set([
  "initialize_lb_pair",
  "initialize_lb_pair2",
  "initialize_permission_lb_pair",
  "initialize_customizable_permissionless_lb_pair",
  "initialize_customizable_permissionless_lb_pair2",
]);

interface CliOptions {
  pool: string | null;
  outputDir: string;
  pageSize: number;
  maxPages: number;
  requestDelayMs: number;
}

interface StandardSignatureInfo {
  signature: string;
  slot: number;
  err: any | null;
  memo: string | null;
  blockTime: number | null;
}

interface ProvenInitialization {
  signature: string;
  slot: number;
  blockTime: number;
  blockTimeIso: string;
  instructionName: string;
  programId: string;
  discriminatorHex: string;
  poolAccount: string;
  tokenMintX: string | null;
  tokenMintY: string | null;
  funder: string | null;
  isSuccess: boolean;
}

interface PoolCreationProofOutput {
  pool: string;
  proven: boolean;
  status: "PROVEN" | "INITIALIZATION_NOT_FOUND" | "NOT_CANONICAL_DLMM";
  verifiedAt: string;
  rpcSource: "ALCHEMY_RPC_URL";
  canonicalLegacyDLMM: boolean;
  initialization: ProvenInitialization | null;
  pagination: {
    pagesFetched: number;
    totalSignaturesScanned: number;
    oldestSignature: string | null;
  };
  notes: string;
}

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

  return {
    pool: options.pool || null,
    outputDir:
      options["output-dir"] ||
      path.resolve("data/discovery/waldisc-2/pool-creation-proof"),
    pageSize: Math.min(1000, Math.max(10, Number(options["page-size"] || 1000))),
    maxPages: Math.max(1, Number(options["max-pages"] || 200)),
    requestDelayMs: Math.max(0, Number(options["delay-ms"] || 150)),
  };
}

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath: string, data: any): void {
  ensureDirectory(path.dirname(filePath));
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

async function verifyCanonicalLegacyDLMM(
  rpcUrl: string,
  poolAddress: string
): Promise<{ isCanonical: boolean; reason: string }> {
  const legacyCachePath = path.resolve("data/pools/legacy-dlmm-pools.json");
  const legacyCache = tryReadJson(legacyCachePath);

  if (Array.isArray(legacyCache?.pools)) {
    const found = legacyCache.pools.find((p: any) => p.address === poolAddress);
    if (found) {
      return { isCanonical: true, reason: "Verified in data/pools/legacy-dlmm-pools.json" };
    }
  }

  // On-chain account check
  try {
    const accountInfo = await rpcCall<{
      value?: {
        owner: string;
        data: [string, string];
        lamports: number;
      } | null;
    }>(rpcUrl, "getAccountInfo", [
      poolAddress,
      { encoding: "base64", commitment: "confirmed" },
    ]);

    if (!accountInfo?.value) {
      return { isCanonical: false, reason: "Account does not exist on-chain" };
    }

    if (accountInfo.value.owner !== METEORA_DLMM_PROGRAM_ID) {
      return {
        isCanonical: false,
        reason: `Account owner ${accountInfo.value.owner} does not match Meteora DLMM program ${METEORA_DLMM_PROGRAM_ID}`,
      };
    }

    return { isCanonical: true, reason: "Verified on-chain account owner is Meteora DLMM" };
  } catch (err: any) {
    return { isCanonical: false, reason: `Failed on-chain account verification: ${err.message}` };
  }
}

export async function provePoolCreationTime(): Promise<PoolCreationProofOutput> {
  const { pool, outputDir, pageSize, maxPages, requestDelayMs } = parseCliArgs();

  if (!pool) {
    console.error("==================================================");
    console.error("ERROR: Missing required argument --pool");
    console.error("Usage: node --experimental-strip-types --env-file=.env scripts/discovery/waldisc-2-prove-pool-creation-time.ts --pool <POOL_ADDRESS>");
    console.error("==================================================");
    process.exit(1);
  }

  const rpcUrl = process.env.ALCHEMY_RPC_URL;
  if (!rpcUrl || !rpcUrl.startsWith("http")) {
    console.error("==================================================");
    console.error("FATAL: ALCHEMY_RPC_URL environment variable is required and must be a valid URL.");
    console.error("==================================================");
    process.exit(1);
  }

  console.log("==================================================");
  console.log("WALDISC-2 — POOL CREATION TIME PROOF");
  console.log("==================================================");
  console.log(`Pool Address     : ${pool}`);
  console.log(`RPC Source       : ALCHEMY_RPC_URL`);

  // 1. Verify Canonical Legacy DLMM
  const dlmmCheck = await verifyCanonicalLegacyDLMM(rpcUrl, pool);
  console.log(`Canonical DLMM   : ${dlmmCheck.isCanonical ? "YES" : "NO"} (${dlmmCheck.reason})`);

  if (!dlmmCheck.isCanonical) {
    const errorOutput: PoolCreationProofOutput = {
      pool,
      proven: false,
      status: "NOT_CANONICAL_DLMM",
      verifiedAt: new Date().toISOString(),
      rpcSource: "ALCHEMY_RPC_URL",
      canonicalLegacyDLMM: false,
      initialization: null,
      pagination: {
        pagesFetched: 0,
        totalSignaturesScanned: 0,
        oldestSignature: null,
      },
      notes: `Pool rejected: ${dlmmCheck.reason}. Only canonical Meteora Legacy DLMM pools are accepted.`,
    };

    const outputFile = path.join(outputDir, `${pool}.json`);
    atomicWriteJson(outputFile, errorOutput);
    console.log(`Output Saved     : ${outputFile}`);
    console.log("==================================================");
    return errorOutput;
  }

  // 2. Load IDL for instruction decoding
  const idlBundle = await loadMeteoraIdl(METEORA_DLMM_PROGRAM_ID);
  const idlMap = idlBundle.instructionMap;

  // Build discriminator mapping for pool init instructions
  const initDiscriminatorMap = new Map<string, string>();
  for (const [discHex, ixDef] of idlMap.entries()) {
    if (POOL_INIT_INSTRUCTION_NAMES.has(ixDef.name)) {
      initDiscriminatorMap.set(discHex, ixDef.name);
    }
  }

  // 3. Paginate transaction signatures backwards to genesis
  console.log("\nPaginating pool transaction history to earliest genesis...");
  let pagesFetched = 0;
  let totalSignaturesScanned = 0;
  let oldestSignatureSeen: string | null = null;
  let beforeCursor: string | undefined = undefined;

  let oldestBatch: StandardSignatureInfo[] = [];

  while (pagesFetched < maxPages) {
    pagesFetched++;
    const params: Record<string, unknown> = { limit: pageSize };
    if (beforeCursor) params.before = beforeCursor;

    const pageSigs = await rpcCall<StandardSignatureInfo[]>(
      rpcUrl,
      "getSignaturesForAddress",
      [pool, params],
      5
    );

    if (!Array.isArray(pageSigs) || pageSigs.length === 0) {
      break;
    }

    totalSignaturesScanned += pageSigs.length;
    oldestSignatureSeen = pageSigs[pageSigs.length - 1].signature;
    beforeCursor = oldestSignatureSeen;
    oldestBatch = pageSigs;

    process.stdout.write(
      `\rPage ${pagesFetched}: ${pageSigs.length} signatures (total: ${totalSignaturesScanned}, oldest: ${oldestSignatureSeen.slice(0, 16)}...)`
    );

    if (pageSigs.length < pageSize) {
      // Reached earliest transaction on-chain
      break;
    }

    if (requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }
  }

  console.log(`\nPagination complete. Scanned ${totalSignaturesScanned} signatures across ${pagesFetched} page(s).`);

  if (oldestBatch.length === 0) {
    const emptyOutput: PoolCreationProofOutput = {
      pool,
      proven: false,
      status: "INITIALIZATION_NOT_FOUND",
      verifiedAt: new Date().toISOString(),
      rpcSource: "ALCHEMY_RPC_URL",
      canonicalLegacyDLMM: true,
      initialization: null,
      pagination: {
        pagesFetched,
        totalSignaturesScanned,
        oldestSignature: oldestSignatureSeen,
      },
      notes: "No transactions found on-chain for this pool address.",
    };
    const outputFile = path.join(outputDir, `${pool}.json`);
    atomicWriteJson(outputFile, emptyOutput);
    console.log(`Output Saved     : ${outputFile}`);
    console.log("==================================================");
    return emptyOutput;
  }

  // 4. Inspect earliest transactions in ascending chronological order
  console.log("Inspecting oldest transactions for Meteora DLMM pool initialization...");
  const chronologicalCandidates = [...oldestBatch].reverse();

  let provenInit: ProvenInitialization | null = null;
  const inspectLimit = Math.min(chronologicalCandidates.length, 50);

  for (let i = 0; i < inspectLimit; i++) {
    const candidateSig = chronologicalCandidates[i];

    if (candidateSig.err !== null) {
      continue; // Must be successful transaction
    }

    if (requestDelayMs > 0) {
      await sleep(requestDelayMs);
    }

    let tx: any = null;
    try {
      tx = await rpcCall<any>(
        rpcUrl,
        "getTransaction",
        [
          candidateSig.signature,
          {
            encoding: "json",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 1,
          },
        ],
        5
      );
    } catch (err: any) {
      console.warn(`\nWarning: Failed to fetch tx ${candidateSig.signature}: ${err.message}`);
      continue;
    }

    if (!tx || tx.meta?.err !== null) {
      continue;
    }

    const blockTime = Number(tx.blockTime ?? candidateSig.blockTime ?? 0);
    if (!blockTime || blockTime <= 0) {
      continue;
    }

    const slot = Number(tx.slot ?? candidateSig.slot ?? 0);
    const normalizedIxs = normalizeTransactionInstructions(tx);

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

      // Verify the target pool is the initialized lb_pair (account 0)
      const targetPoolAccount = ix.accounts[0];
      if (targetPoolAccount !== pool) {
        continue;
      }

      // Extract token mints and funder if available
      const tokenMintX = ix.accounts[2] || null;
      const tokenMintY = ix.accounts[3] || null;
      const funder = ix.accounts[7] || ix.feePayer || null;

      provenInit = {
        signature: candidateSig.signature,
        slot,
        blockTime,
        blockTimeIso: new Date(blockTime * 1000).toISOString(),
        instructionName: matchedIxName,
        programId: METEORA_DLMM_PROGRAM_ID,
        discriminatorHex: discHex,
        poolAccount: pool,
        tokenMintX,
        tokenMintY,
        funder,
        isSuccess: true,
      };

      break;
    }

    if (provenInit) {
      break;
    }
  }

  const isProven = provenInit !== null;
  const status = isProven ? "PROVEN" : "INITIALIZATION_NOT_FOUND";

  const notes = isProven
    ? `Authoritative pool initialization verified on-chain via Alchemy RPC. Decoded instruction: ${provenInit!.instructionName}.`
    : "Pool history was paginated to the genesis transaction, but no valid Meteora DLMM pool initialization instruction was decoded. Oldest transaction without initialization cannot be assumed as pool creation.";

  const output: PoolCreationProofOutput = {
    pool,
    proven: isProven,
    status,
    verifiedAt: new Date().toISOString(),
    rpcSource: "ALCHEMY_RPC_URL",
    canonicalLegacyDLMM: true,
    initialization: provenInit,
    pagination: {
      pagesFetched,
      totalSignaturesScanned,
      oldestSignature: oldestSignatureSeen,
    },
    notes,
  };

  const outputFile = path.join(outputDir, `${pool}.json`);
  atomicWriteJson(outputFile, output);

  console.log("\n--------------------------------------------------");
  if (isProven) {
    console.log("FOUND AUTHORITATIVE POOL INITIALIZATION!");
    console.log(`Instruction      : ${provenInit!.instructionName}`);
    console.log(`Signature        : ${provenInit!.signature}`);
    console.log(`Slot             : ${provenInit!.slot}`);
    console.log(`Block Time       : ${provenInit!.blockTime} (${provenInit!.blockTimeIso})`);
    console.log(`Status           : PROVEN`);
  } else {
    console.log("INITIALIZATION NOT FOUND");
    console.log("Reason           : No valid initialize_*_lb_pair instruction in oldest transaction batch.");
    console.log(`Status           : UNPROVEN`);
  }
  console.log(`Output Saved     : ${outputFile}`);
  console.log("==================================================");

  return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-prove-pool-creation-time.ts")) {
  provePoolCreationTime().catch((err) => {
    console.error("Fatal error during pool creation time proof execution:", err);
    process.exit(1);
  });
}
