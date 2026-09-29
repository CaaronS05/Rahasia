import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import anchorPkg from "@coral-xyz/anchor";
import { loadDiscoveryConfig } from "./core/config.ts";
import { fetchStandardTransaction, sleep } from "./core/rpc.ts";
import { loadMeteoraIdl, LOCAL_IDL_PATH } from "./core/meteora-idl.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "./core/transaction-normalizer.ts";

const { BorshInstructionCoder, BN } = anchorPkg as any;

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const DEFAULT_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";
const DEFAULT_RPC_DELAY_MS = 250;

interface AuditInstructionRecord {
    signature: string;
    instruction: string;
    source: "top-level" | "inner";
    parentInstructionIndex: number | null;
    instructionIndex: number;
    expectedPosition: string;
    actualPosition: string | null;
    positionMatchesExpected: boolean;
    expectedPool: string;
    actualPool: string | null;
    poolMatchesExpected: boolean;
    decodedArgs: any;
}

interface AuditOutput {
    wallet: string;
    expectedPosition: string;
    expectedPool: string;
    generatedAt: string;
    signatureCount: number;
    instructionCount: number;
    matchingPositionCount: number;
    mismatchedPositionCount: number;
    matchingPoolCount: number;
    instructions: AuditInstructionRecord[];
}

function parseCliArgs(): Record<string, string> {
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

    return options;
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function serializeAnchorValue(val: any): any {
    if (val === null || val === undefined) {
        return null;
    }

    if (typeof val === "bigint") {
        return val.toString(10);
    }
    if (
        typeof val === "object" &&
        (BN.isBN(val) ||
            val.constructor?.name === "BN" ||
            (typeof val.toString === "function" && typeof val.isNeg === "function"))
    ) {
        return val.toString(10);
    }

    if (typeof val === "object" && typeof val.toBase58 === "function") {
        return val.toBase58();
    }

    if (Array.isArray(val)) {
        return val.map(serializeAnchorValue);
    }

    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
        return Array.from(val);
    }

    if (
        typeof val === "number" ||
        typeof val === "boolean" ||
        typeof val === "string"
    ) {
        return val;
    }

    if (typeof val === "object") {
        const result: Record<string, any> = {};
        for (const [key, value] of Object.entries(val)) {
            result[key] = serializeAnchorValue(value);
        }
        return result;
    }

    return String(val);
}

async function main() {
    const args = parseCliArgs();

    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;
    const positionAddress =
        args.position || process.env.POSITION_ADDRESS || DEFAULT_POSITION;
    const rpcDelayMs = args["rpc-delay-ms"]
        ? Number(args["rpc-delay-ms"])
        : DEFAULT_RPC_DELAY_MS;

    // 1. Read existing Step 1C.1 strategy file
    const strategyFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy",
        `${positionAddress}.json`
    );

    if (!fs.existsSync(strategyFilePath)) {
        throw new Error(
            `Strategy file not found: ${strategyFilePath}. Run waldisc-2-decode-one-position-strategy first.`
        );
    }

    let strategyData: any;
    try {
        const rawContent = fs.readFileSync(strategyFilePath, "utf8");
        strategyData = JSON.parse(rawContent);
    } catch (err: any) {
        throw new Error(
            `Failed to parse strategy file ${strategyFilePath}: ${err.message}`
        );
    }

    const expectedPool = strategyData.pool;
    if (!expectedPool) {
        throw new Error(
            `Pool address missing from strategy file: ${strategyFilePath}`
        );
    }
    const expectedPosition = positionAddress;

    // 2. Extract and deduplicate signatures
    const rawInstructions = Array.isArray(strategyData.instructions)
        ? strategyData.instructions
        : [];

    const uniqueSignatures: string[] = [];
    const seenSigs = new Set<string>();

    for (const ix of rawInstructions) {
        const sig = String(ix.signature || "").trim();
        if (sig && !seenSigs.has(sig)) {
            seenSigs.add(sig);
            uniqueSignatures.push(sig);
        }
    }

    if (uniqueSignatures.length === 0) {
        throw new Error(
            `No signatures found in strategy file: ${strategyFilePath}`
        );
    }

    // 3. Configure Alchemy RPC
    const alchemyRpcUrl = process.env.ALCHEMY_RPC_URL?.trim();
    if (!alchemyRpcUrl) {
        throw new Error(
            "ALCHEMY_RPC_URL is required for WALDISC-2 position attribution audit"
        );
    }

    const config = loadDiscoveryConfig({
        rpcUrl: alchemyRpcUrl,
        heliusApiKey: "",
    });

    // 4. Fetch transactions
    const fetchedTransactions = new Map<string, any>();
    const failedTransactions = new Map<string, string>();

    for (let i = 0; i < uniqueSignatures.length; i++) {
        const sig = uniqueSignatures[i];
        try {
            const tx = await fetchStandardTransaction(config, sig);
            if (!tx) {
                failedTransactions.set(sig, "Transaction not found on RPC (null response)");
            } else {
                fetchedTransactions.set(sig, tx);
            }
        } catch (err: any) {
            failedTransactions.set(sig, err.message || String(err));
        }

        if (i < uniqueSignatures.length - 1 && rpcDelayMs > 0) {
            await sleep(rpcDelayMs);
        }
    }

    // 5. Load IDL and Borsh coder
    const idlBundle = await loadMeteoraIdl(config.meteoraDlmmProgramId);

    if (!fs.existsSync(LOCAL_IDL_PATH)) {
        throw new Error(`Meteora IDL file not found at ${LOCAL_IDL_PATH}`);
    }

    const idlJson = JSON.parse(fs.readFileSync(LOCAL_IDL_PATH, "utf8"));
    const coder = new BorshInstructionCoder(idlJson);

    // 6. Audit all Meteora instructions in those transactions
    const auditedInstructions: AuditInstructionRecord[] = [];
    let matchingPositionCount = 0;
    let mismatchedPositionCount = 0;
    let matchingPoolCount = 0;

    for (const sig of uniqueSignatures) {
        const tx = fetchedTransactions.get(sig);
        if (!tx) continue;

        const normalizedIxs = normalizeTransactionInstructions(tx);

        for (const ix of normalizedIxs) {
            if (ix.programId !== config.meteoraDlmmProgramId || !ix.data) {
                continue;
            }

            let rawBuffer: Buffer;
            try {
                rawBuffer = Buffer.from(bs58.decode(ix.data));
            } catch {
                continue;
            }

            if (rawBuffer.length < 8) continue;
            const discHex = rawBuffer.subarray(0, 8).toString("hex");
            const idlIx = idlBundle.instructionMap.get(discHex);

            if (!idlIx) {
                continue;
            }

            const instructionName = idlIx.name;

            // Map accounts directly using IDL flatAccounts definition
            const mappedAccounts: Record<string, string> = {};
            const flatAccounts = idlIx.flatAccounts || [];

            for (let a = 0; a < flatAccounts.length; a++) {
                const accDef = flatAccounts[a];
                const accKey = ix.accounts[a] ?? null;
                if (accKey) {
                    mappedAccounts[accDef.name] = accKey;
                }
            }

            // Extract direct position account: position or position_v2
            const actualPosition =
                mappedAccounts["position"] ||
                mappedAccounts["position_v2"] ||
                null;

            const positionMatchesExpected =
                actualPosition !== null && actualPosition === expectedPosition;

            if (positionMatchesExpected) {
                matchingPositionCount++;
            } else {
                mismatchedPositionCount++;
            }

            // Extract direct pool account: lb_pair or pool
            const actualPool =
                mappedAccounts["lb_pair"] ||
                mappedAccounts["pool"] ||
                null;

            const poolMatchesExpected =
                actualPool !== null && actualPool === expectedPool;

            if (poolMatchesExpected) {
                matchingPoolCount++;
            }

            // Decode args
            let decodedArgs: any = {};
            try {
                const decodedAnchor = coder.decode(rawBuffer);
                if (decodedAnchor) {
                    decodedArgs = serializeAnchorValue(decodedAnchor.data);
                }
            } catch (err: any) {
                decodedArgs = { _decodeError: err.message };
            }

            auditedInstructions.push({
                signature: sig,
                instruction: instructionName,
                source: ix.source,
                parentInstructionIndex: ix.parentIndex,
                instructionIndex: ix.instructionIndex,
                expectedPosition,
                actualPosition,
                positionMatchesExpected,
                expectedPool,
                actualPool,
                poolMatchesExpected,
                decodedArgs,
            });
        }
    }

    // 7. Write output JSON
    const outputFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy-audit",
        `${positionAddress}.json`
    );

    const outputData: AuditOutput = {
        wallet: walletAddress,
        expectedPosition,
        expectedPool,
        generatedAt: new Date().toISOString(),
        signatureCount: uniqueSignatures.length,
        instructionCount: auditedInstructions.length,
        matchingPositionCount,
        mismatchedPositionCount,
        matchingPoolCount,
        instructions: auditedInstructions,
    };

    atomicWriteJson(outputFilePath, outputData);

    // 8. Terminal Output
    console.log("========================================");
    console.log("WALDISC-2 STEP 1C.2A — POSITION ATTRIBUTION AUDIT");
    console.log("========================================");
    console.log(`Wallet                  : ${walletAddress}`);
    console.log(`Expected Position       : ${expectedPosition}`);
    console.log(`Expected Pool           : ${expectedPool}`);
    console.log(`Unique Signatures       : ${uniqueSignatures.length}`);
    console.log(`Meteora Instructions    : ${auditedInstructions.length}`);
    console.log(`Position Matches        : ${matchingPositionCount}`);
    console.log(`Position Mismatches     : ${mismatchedPositionCount}`);
    console.log(`Pool Matches            : ${matchingPoolCount}`);
    console.log(`Output File             : ${outputFilePath}`);
    console.log("========================================\n");

    console.table(
        auditedInstructions.map((item) => ({
            instruction: item.instruction,
            signature: `${item.signature.slice(0, 8)}...${item.signature.slice(-8)}`,
            actualPosition: item.actualPosition
                ? `${item.actualPosition.slice(0, 8)}...${item.actualPosition.slice(-6)}`
                : "(none)",
            positionMatch: item.positionMatchesExpected ? "MATCH" : "MISMATCH",
            actualPool: item.actualPool
                ? `${item.actualPool.slice(0, 8)}...${item.actualPool.slice(-6)}`
                : "(none)",
            poolMatch: item.actualPool
                ? item.poolMatchesExpected
                    ? "MATCH"
                    : "MISMATCH"
                : "N/A",
        }))
    );
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Position attribution audit failed: ${err.message}`);
    process.exit(1);
});
