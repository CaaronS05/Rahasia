import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import anchorPkg from "@coral-xyz/anchor";

const {
    BorshInstructionCoder,
    BN,
} = anchorPkg as any;
import { loadDiscoveryConfig } from "./core/config.ts";
import { fetchStandardTransaction, sleep } from "./core/rpc.ts";
import { loadMeteoraIdl, LOCAL_IDL_PATH } from "./core/meteora-idl.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "./core/transaction-normalizer.ts";
import {
    decodeLpInstruction,
    classifyInstructionCategory,
    type DecodedLpInstruction,
} from "./core/lp-instruction-decoder.ts";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const DEFAULT_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";
const DEFAULT_RPC_DELAY_MS = 250;

interface StrategyInstructionRecord {
    signature: string;
    createdAt: string;
    instruction: string;
    category: string;
    source: "top-level" | "inner";
    parentInstructionIndex: number | null;
    instructionIndex: number;
    decodeStatus: "SUCCESS" | "FAILED";
    reason?: string | null;
    decodedArgs: any;
}

interface StrategyOutput {
    wallet: string;
    pool: string;
    position: string;
    generatedAt: string;
    signatureCount: number;
    decodedInstructionCount: number;
    decodeFailureCount: number;
    instructions: StrategyInstructionRecord[];
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

    // BN / bigint -> decimal string
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

    // PublicKey -> base58 string
    if (typeof val === "object" && typeof val.toBase58 === "function") {
        return val.toBase58();
    }

    // Arrays -> recursive map
    if (Array.isArray(val)) {
        return val.map(serializeAnchorValue);
    }

    // Buffer or Uint8Array -> number array
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
        return Array.from(val);
    }

    // Primitive values
    if (
        typeof val === "number" ||
        typeof val === "boolean" ||
        typeof val === "string"
    ) {
        return val;
    }

    // Nested objects
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

    // 1. Validate WALDISC-2 verification input file
    const verificationFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "verification",
        `${positionAddress}.json`
    );

    if (!fs.existsSync(verificationFilePath)) {
        throw new Error(
            `Verification proof file not found: ${verificationFilePath}. Please run waldisc-2-verify-one-position first.`
        );
    }

    let verificationData: any;
    try {
        const rawContent = fs.readFileSync(verificationFilePath, "utf8");
        verificationData = JSON.parse(rawContent);
    } catch (err: any) {
        throw new Error(
            `Failed to parse verification file ${verificationFilePath}: ${err.message}`
        );
    }

    if (
        verificationData.allTransactionsFetched !== true ||
        verificationData.allEventsVerified !== true
    ) {
        throw new Error(
            `Verification proof at ${verificationFilePath} is incomplete (allTransactionsFetched: ${verificationData.allTransactionsFetched}, allEventsVerified: ${verificationData.allEventsVerified}). Position must be fully verified before strategy argument decoding.`
        );
    }

    const poolAddress = verificationData.pool;
    if (!poolAddress) {
        throw new Error(
            `Pool address missing in verification file: ${verificationFilePath}`
        );
    }

    // 2. Extract and deduplicate event transaction signatures
    const results = Array.isArray(verificationData.results)
        ? verificationData.results
        : [];

    const sigToCreatedAt = new Map<string, string>();
    const uniqueSignatures: string[] = [];
    const seenSigs = new Set<string>();

    for (const res of results) {
        const sig = String(res.signature || "").trim();
        if (sig) {
            if (!sigToCreatedAt.has(sig) && res.createdAt) {
                sigToCreatedAt.set(sig, String(res.createdAt));
            }
            if (!seenSigs.has(sig)) {
                seenSigs.add(sig);
                uniqueSignatures.push(sig);
            }
        }
    }

    if (uniqueSignatures.length === 0) {
        throw new Error(
            `Zero transaction signatures found in verification file: ${verificationFilePath}`
        );
    }

    // 3. Configure mandatory Alchemy Archival RPC
    const alchemyRpcUrl = process.env.ALCHEMY_RPC_URL?.trim();
    if (!alchemyRpcUrl) {
        throw new Error(
            "ALCHEMY_RPC_URL is required for WALDISC-2 strategy argument decoding"
        );
    }

    const config = loadDiscoveryConfig({
        rpcUrl: alchemyRpcUrl,
        heliusApiKey: "",
    });

    // 4. Fetch transactions sequentially via Standard RPC getTransaction
    const fetchedTransactions = new Map<string, any>();
    const failedTransactions = new Map<string, string>();

    for (let i = 0; i < uniqueSignatures.length; i++) {
        const sig = uniqueSignatures[i];
        try {
            const tx = await fetchStandardTransaction(config, sig);
            if (!tx) {
                failedTransactions.set(
                    sig,
                    "Transaction not found on RPC (null response)"
                );
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

    // 5. Load Meteora DLMM IDL and Anchor BorshInstructionCoder
    const idlBundle = await loadMeteoraIdl(config.meteoraDlmmProgramId);

    if (!fs.existsSync(LOCAL_IDL_PATH)) {
        throw new Error(`Meteora IDL file not found at ${LOCAL_IDL_PATH}`);
    }

    const idlJson = JSON.parse(fs.readFileSync(LOCAL_IDL_PATH, "utf8"));
    const coder = new BorshInstructionCoder(idlJson);

    // 6. Decode and extract strategy instruction arguments
    const strategyInstructions: StrategyInstructionRecord[] = [];
    let decodedInstructionCount = 0;
    let decodeFailureCount = 0;

    for (const sig of uniqueSignatures) {
        const tx = fetchedTransactions.get(sig);
        if (!tx) {
            continue;
        }

        const createdAt =
            sigToCreatedAt.get(sig) ||
            (tx.blockTime
                ? new Date(tx.blockTime * 1000).toISOString()
                : new Date().toISOString());

        const normalizedIxs = normalizeTransactionInstructions(tx);

        // Identify standard accepted LP instructions for this position & pool
        const standardAcceptedForPosition = new Set<NormalizedInstruction>();
        const standardDecodedMap = new Map<
            NormalizedInstruction,
            DecodedLpInstruction
        >();

        for (const ix of normalizedIxs) {
            if (ix.programId !== config.meteoraDlmmProgramId) {
                continue;
            }

            const decoded = decodeLpInstruction(
                ix,
                poolAddress,
                config.meteoraDlmmProgramId,
                idlBundle.instructionMap,
                idlBundle.eventMap
            );

            if (
                decoded.status === "ACCEPTED" &&
                decoded.position === positionAddress
            ) {
                standardAcceptedForPosition.add(ix);
                standardDecodedMap.set(ix, decoded);
            }
        }

        // Identify close_position_if_empty corroborated by transaction context
        const closeIfEmptyForPosition = new Set<NormalizedInstruction>();
        const hasCorroboratingPoolInstruction =
            standardAcceptedForPosition.size > 0;

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

            if (idlIx && idlIx.name === "close_position_if_empty") {
                const flatAccounts = idlIx.flatAccounts || [];
                let posAccount: string | null = null;

                for (let a = 0; a < flatAccounts.length; a++) {
                    if (flatAccounts[a].name === "position") {
                        posAccount = ix.accounts[a] ?? null;
                        break;
                    }
                }

                if (
                    posAccount === positionAddress &&
                    hasCorroboratingPoolInstruction
                ) {
                    closeIfEmptyForPosition.add(ix);
                }
            }
        }

        // Process accepted instructions in execution order
        for (const ix of normalizedIxs) {
            let isRelevant = false;
            let instructionName = "unknown";
            let category = "unknown";

            if (standardAcceptedForPosition.has(ix)) {
                isRelevant = true;
                const decoded = standardDecodedMap.get(ix)!;
                instructionName = decoded.instructionName || "unknown";
                category =
                    decoded.category ||
                    classifyInstructionCategory(instructionName) ||
                    "unknown";
            } else if (closeIfEmptyForPosition.has(ix)) {
                isRelevant = true;
                instructionName = "close_position_if_empty";
                category = "close";
            }

            if (!isRelevant) {
                continue;
            }

            let rawBuffer: Buffer;
            try {
                rawBuffer = Buffer.from(bs58.decode(ix.data));
            } catch (err: any) {
                decodeFailureCount++;
                strategyInstructions.push({
                    signature: sig,
                    createdAt,
                    instruction: instructionName,
                    category,
                    source: ix.source,
                    parentInstructionIndex: ix.parentIndex,
                    instructionIndex: ix.instructionIndex,
                    decodeStatus: "FAILED",
                    reason: `Failed to base58 decode instruction data: ${err.message}`,
                    decodedArgs: null,
                });
                continue;
            }

            try {
                const decodedAnchor = coder.decode(rawBuffer);
                if (!decodedAnchor) {
                    decodeFailureCount++;
                    strategyInstructions.push({
                        signature: sig,
                        createdAt,
                        instruction: instructionName,
                        category,
                        source: ix.source,
                        parentInstructionIndex: ix.parentIndex,
                        instructionIndex: ix.instructionIndex,
                        decodeStatus: "FAILED",
                        reason: "IDL coder returned null: no matching discriminator found in IDL",
                        decodedArgs: null,
                    });
                } else {
                    decodedInstructionCount++;
                    const serializedArgs = serializeAnchorValue(
                        decodedAnchor.data
                    );
                    strategyInstructions.push({
                        signature: sig,
                        createdAt,
                        instruction: decodedAnchor.name || instructionName,
                        category,
                        source: ix.source,
                        parentInstructionIndex: ix.parentIndex,
                        instructionIndex: ix.instructionIndex,
                        decodeStatus: "SUCCESS",
                        decodedArgs: serializedArgs,
                    });
                }
            } catch (err: any) {
                decodeFailureCount++;
                strategyInstructions.push({
                    signature: sig,
                    createdAt,
                    instruction: instructionName,
                    category,
                    source: ix.source,
                    parentInstructionIndex: ix.parentIndex,
                    instructionIndex: ix.instructionIndex,
                    decodeStatus: "FAILED",
                    reason: `IDL coder decode exception: ${err.message || String(err)}`,
                    decodedArgs: null,
                });
            }
        }
    }

    // 7. Write output JSON
    const outputFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy",
        `${positionAddress}.json`
    );

    const outputData: StrategyOutput = {
        wallet: walletAddress,
        pool: poolAddress,
        position: positionAddress,
        generatedAt: new Date().toISOString(),
        signatureCount: uniqueSignatures.length,
        decodedInstructionCount,
        decodeFailureCount,
        instructions: strategyInstructions,
    };

    atomicWriteJson(outputFilePath, outputData);

    // 8. Terminal output
    console.log("========================================");
    console.log("WALDISC-2 STEP 1C.1 — STRATEGY ARGUMENT PROOF");
    console.log("========================================");
    console.log(`Wallet              : ${walletAddress}`);
    console.log(`Pool                : ${poolAddress}`);
    console.log(`Position            : ${positionAddress}`);
    console.log(`Unique Signatures   : ${uniqueSignatures.length}`);
    console.log(`Meteora Instructions: ${strategyInstructions.length}`);
    console.log(`Arguments Decoded   : ${decodedInstructionCount}`);
    console.log(`Decode Failures     : ${decodeFailureCount}`);
    console.log(`Output File         : ${outputFilePath}`);
    console.log("========================================\n");

    console.table(
        strategyInstructions.map((item) => ({
            instruction: item.instruction,
            category: item.category,
            signature:
                item.signature.length > 20
                    ? `${item.signature.slice(0, 10)}...${item.signature.slice(-8)}`
                    : item.signature,
            source: item.source,
            decodeStatus: item.decodeStatus,
        }))
    );
}

main().catch((err) => {
    console.error(
        `\n[FATAL ERROR] Strategy argument decoding failed: ${err.message}`
    );
    process.exit(1);
});
