import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import { loadDiscoveryConfig } from "./core/config.ts";
import { fetchStandardTransaction, sleep } from "./core/rpc.ts";
import { loadMeteoraIdl } from "./core/meteora-idl.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "./core/transaction-normalizer.ts";
import {
    decodeLpInstruction,
    type DecodedLpInstruction,
} from "./core/lp-instruction-decoder.ts";
import { resolveLpWallet } from "./core/wallet-resolver.ts";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const DEFAULT_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";
const DEFAULT_RPC_DELAY_MS = 250;

const CONFIRMED_MAPPINGS: Record<string, string> = {
    POSITION_OPEN: "initialize",
    ADD_LIQUIDITY: "add",
    REMOVE_LIQUIDITY: "remove",
    FEE_CLAIM: "claim_fee",
    POSITION_CLOSE: "close",
};

interface MatchingInstructionRecord {
    instruction: string;
    category: string;
    pool: string | null;
    position: string;
    source: "top-level" | "inner";
    parentInstructionIndex: number | null;
    instructionIndex: number;
    resolvedWallet: string | null;
    walletMatchesTarget: boolean;
    poolVerificationSource?: string;
}

interface EventVerificationResult {
    rawType: string;
    expectedCategory: string;
    signature: string;
    createdAt: string;
    transactionFetched: boolean;
    matchType: "exact" | "semantic_compatible" | "transaction_context" | null;
    matchingInstructions: MatchingInstructionRecord[];
    verified: boolean;
    reason: string | null;
}

interface PositionVerificationOutput {
    wallet: string;
    pool: string;
    position: string;
    generatedAt: string;

    fabriqEventCount: number;
    uniqueSignatureCount: number;

    transactionsFetched: number;
    transactionsFailed: number;

    eventsVerified: number;
    eventsUnverified: number;

    allTransactionsFetched: boolean;
    allEventsVerified: boolean;

    results: EventVerificationResult[];
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

async function main() {
    const args = parseCliArgs();

    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;
    const positionAddress =
        args.position || process.env.POSITION_ADDRESS || DEFAULT_POSITION;
    const rpcDelayMs = args["rpc-delay-ms"]
        ? Number(args["rpc-delay-ms"])
        : DEFAULT_RPC_DELAY_MS;

    // 1. Read existing local WALDISC-2 discovery output
    const posFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "positions.json"
    );
    const eventsFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "events.json"
    );

    let poolAddress: string | null = null;
    let positionEvents: any[] = [];

    if (fs.existsSync(posFilePath)) {
        try {
            const positionsData = JSON.parse(
                fs.readFileSync(posFilePath, "utf8")
            );
            if (Array.isArray(positionsData)) {
                const foundPos = positionsData.find(
                    (p: any) =>
                        p.position === positionAddress ||
                        p.id === positionAddress
                );
                if (foundPos) {
                    poolAddress = foundPos.pool || foundPos.poolId || null;
                    if (
                        Array.isArray(foundPos.events) &&
                        foundPos.events.length > 0
                    ) {
                        positionEvents = foundPos.events;
                    }
                }
            }
        } catch (err: any) {
            console.error(
                `Warning: Failed to parse positions.json: ${err.message}`
            );
        }
    }

    if (positionEvents.length === 0 && fs.existsSync(eventsFilePath)) {
        try {
            const eventsData = JSON.parse(
                fs.readFileSync(eventsFilePath, "utf8")
            );
            if (Array.isArray(eventsData)) {
                const matchingEvents = eventsData.filter(
                    (e: any) =>
                        e.positionId === positionAddress ||
                        e.position === positionAddress
                );
                if (matchingEvents.length > 0) {
                    positionEvents = matchingEvents;
                    if (!poolAddress) {
                        poolAddress =
                            matchingEvents[0].poolId ||
                            matchingEvents[0].pool ||
                            null;
                    }
                }
            }
        } catch (err: any) {
            console.error(
                `Warning: Failed to parse events.json: ${err.message}`
            );
        }
    }

    if (!poolAddress || positionEvents.length === 0) {
        throw new Error(
            `Selected position '${positionAddress}' was not found in local WALDISC-2 output for wallet '${walletAddress}'. Run waldisc-2-test-one-wallet first.`
        );
    }

    const signaturesWithEvents = positionEvents.filter((e: any) =>
        Boolean(e.signature)
    );
    if (signaturesWithEvents.length === 0) {
        throw new Error(
            `Selected position '${positionAddress}' has zero transaction signatures in local WALDISC-2 events.`
        );
    }

    // 2. Deduplicate signatures before calling RPC
    const uniqueSignatures: string[] = Array.from(
        new Set(
            positionEvents
                .map((e: any) => String(e.signature || "").trim())
                .filter(Boolean)
        )
    );

    // 3. Configure Alchemy Archival RPC
    const alchemyRpcUrl = process.env.ALCHEMY_RPC_URL?.trim();
    if (!alchemyRpcUrl) {
        throw new Error(
            "ALCHEMY_RPC_URL is required for WALDISC-2 historical verification"
        );
    }

    const config = loadDiscoveryConfig({
        rpcUrl: alchemyRpcUrl,
        heliusApiKey: "",
    });

    console.log("========================================");
    console.log("WALDISC-2 STEP 1A.2 — SELECTIVE ON-CHAIN POSITION VERIFICATION");
    console.log("========================================");
    console.log(`Wallet Address        : ${walletAddress}`);
    console.log(`Pool Address          : ${poolAddress}`);
    console.log(`Position Address      : ${positionAddress}`);
    console.log(`Fabriq Events Count   : ${positionEvents.length}`);
    console.log(`Unique Signatures     : ${uniqueSignatures.length}`);
    console.log(`RPC Provider          : Alchemy archival RPC`);
    console.log(`RPC Delay Between Tx  : ${rpcDelayMs} ms`);
    console.log("----------------------------------------");

    // 4. Fetch transactions sequentially via Standard RPC getTransaction
    const fetchedTransactions = new Map<string, any>();
    const failedTransactions = new Map<string, string>();

    for (let i = 0; i < uniqueSignatures.length; i++) {
        const sig = uniqueSignatures[i];
        console.log(
            `[RPC] (${i + 1}/${uniqueSignatures.length}) Fetching transaction: ${sig}...`
        );
        try {
            const tx = await fetchStandardTransaction(config, sig);
            if (!tx) {
                failedTransactions.set(
                    sig,
                    "Transaction not found on RPC (null response)"
                );
                console.log(
                    `[RPC] (${i + 1}/${uniqueSignatures.length}) Result: Not found on RPC`
                );
            } else {
                fetchedTransactions.set(sig, tx);
                console.log(
                    `[RPC] (${i + 1}/${uniqueSignatures.length}) Result: Fetched successfully`
                );
            }
        } catch (err: any) {
            failedTransactions.set(sig, err.message || String(err));
            console.error(
                `[RPC] (${i + 1}/${uniqueSignatures.length}) Result: Failed (${err.message})`
            );
        }

        if (i < uniqueSignatures.length - 1 && rpcDelayMs > 0) {
            await sleep(rpcDelayMs);
        }
    }

    // 5. Load Meteora DLMM IDL
    console.log("\n[IDL] Loading Meteora DLMM IDL...");
    const idlBundle = await loadMeteoraIdl(config.meteoraDlmmProgramId);

    // 6. Decode and verify instructions against Fabriq lifecycle events
    const results: EventVerificationResult[] = [];
    let eventsVerified = 0;
    let eventsUnverified = 0;

    for (const event of positionEvents) {
        const rawType = String(event.rawType || "");
        const expectedCategory = CONFIRMED_MAPPINGS[rawType] || null;
        const signature = String(event.signature || "").trim();
        const createdAt = String(event.createdAt || "");

        const tx = fetchedTransactions.get(signature);
        const txFetched = Boolean(tx);

        if (!txFetched) {
            eventsUnverified++;
            results.push({
                rawType,
                expectedCategory: expectedCategory || "unknown",
                signature,
                createdAt,
                transactionFetched: false,
                matchType: null,
                matchingInstructions: [],
                verified: false,
                reason: `Transaction fetch failed: ${failedTransactions.get(signature) || "not found on RPC"}`,
            });
            continue;
        }

        if (!expectedCategory) {
            eventsUnverified++;
            results.push({
                rawType,
                expectedCategory: "unknown",
                signature,
                createdAt,
                transactionFetched: true,
                matchType: null,
                matchingInstructions: [],
                verified: false,
                reason: `Unconfirmed Fabriq event type: '${rawType}'`,
            });
            continue;
        }

        // Normalize transaction instructions (top-level and inner)
        const normalizedIxs = normalizeTransactionInstructions(tx);

        // 6a. Decode standard Meteora LP instructions for the expected pool & position
        const standardAcceptedForPosition: {
            ix: NormalizedInstruction;
            decoded: DecodedLpInstruction;
        }[] = [];

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
                standardAcceptedForPosition.push({ ix, decoded });
            }
        }

        // 6b. Check for close instructions (close_position_if_empty, close_position2) for this position
        const closeVariantInstructions: {
            ix: NormalizedInstruction;
            instructionName: string;
            position: string;
            resolvedWallet: string | null;
            walletMatchesTarget: boolean;
        }[] = [];

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

            const isCloseIfEmpty = idlIx?.name === "close_position_if_empty";
            const isClosePosition2 =
                discHex === "ae5a2373ba2893e2" ||
                idlIx?.name === "close_position2";

            if (isCloseIfEmpty || isClosePosition2) {
                const instructionName = isClosePosition2
                    ? "close_position2"
                    : "close_position_if_empty";

                const flatAccounts = idlIx?.flatAccounts || [];
                let posAccount: string | null = null;
                let senderAccount: string | null = null;
                let rentReceiverAccount: string | null = null;

                for (let a = 0; a < flatAccounts.length; a++) {
                    const accDef = flatAccounts[a];
                    const accKey = ix.accounts[a] ?? null;
                    if (accDef.name === "position") {
                        posAccount = accKey;
                    } else if (accDef.name === "sender") {
                        senderAccount = accKey;
                    } else if (accDef.name === "rent_receiver") {
                        rentReceiverAccount = accKey;
                    }
                }

                if (!posAccount && ix.accounts.length > 0) {
                    posAccount = ix.accounts[0] ?? null;
                }
                if (!senderAccount && ix.accounts.length > 1) {
                    senderAccount = ix.accounts[1] ?? null;
                }
                if (!rentReceiverAccount && ix.accounts.length > 2) {
                    rentReceiverAccount = ix.accounts[2] ?? null;
                }

                if (posAccount === positionAddress) {
                    const resolvedWallet = senderAccount || rentReceiverAccount;
                    const walletMatchesTarget =
                        (senderAccount !== null && senderAccount === walletAddress) ||
                        (rentReceiverAccount !== null && rentReceiverAccount === walletAddress);

                    closeVariantInstructions.push({
                        ix,
                        instructionName,
                        position: posAccount,
                        resolvedWallet,
                        walletMatchesTarget,
                    });
                }
            }
        }

        function mapStandardInstruction(item: {
            ix: NormalizedInstruction;
            decoded: DecodedLpInstruction;
        }): MatchingInstructionRecord {
            const resolved = resolveLpWallet(item.decoded);
            const resolvedWallet = resolved?.wallet ?? null;
            const walletMatchesTarget = resolvedWallet
                ? resolvedWallet === walletAddress
                : false;

            return {
                instruction: item.decoded.instructionName || "unknown",
                category: item.decoded.category || "unknown",
                pool: item.decoded.pool || poolAddress,
                position: item.decoded.position || positionAddress,
                source: item.ix.source,
                parentInstructionIndex: item.ix.parentIndex,
                instructionIndex: item.ix.instructionIndex,
                resolvedWallet,
                walletMatchesTarget,
            };
        }

        let verified = false;
        let matchType:
            | "exact"
            | "semantic_compatible"
            | "transaction_context"
            | null = null;
        let matchingInstructions: MatchingInstructionRecord[] = [];
        let reason: string | null = null;

        // 1. Exact match check
        const exactMatches = standardAcceptedForPosition.filter(
            (item) => item.decoded.category === expectedCategory
        );

        if (exactMatches.length > 0) {
            verified = true;
            matchType = "exact";
            matchingInstructions = exactMatches.map(mapStandardInstruction);
            reason = null;
        } else if (rawType === "ADD_LIQUIDITY") {
            // 2. ADD_LIQUIDITY semantics: accept on-chain "rebalance"
            const rebalanceMatches = standardAcceptedForPosition.filter(
                (item) => item.decoded.category === "rebalance"
            );

            if (rebalanceMatches.length > 0) {
                verified = true;
                matchType = "semantic_compatible";
                matchingInstructions =
                    rebalanceMatches.map(mapStandardInstruction);
                reason =
                    "Fabriq ADD_LIQUIDITY is represented on-chain by RebalanceLiquidity";
            }
        } else if (rawType === "POSITION_CLOSE") {
            // 3. POSITION_CLOSE special cases:
            // 3a. close_position2 (confirmed on-chain variant)
            const closePos2Matches = closeVariantInstructions.filter(
                (item) =>
                    item.instructionName === "close_position2" &&
                    item.walletMatchesTarget
            );

            // 3b. close_position_if_empty with same-transaction pool corroboration
            const closeIfEmptyMatches = closeVariantInstructions.filter(
                (item) => item.instructionName === "close_position_if_empty"
            );

            if (closePos2Matches.length > 0) {
                verified = true;
                matchType = "transaction_context";
                matchingInstructions = closePos2Matches.map((item) => ({
                    instruction: item.instructionName,
                    category: "close",
                    pool: null,
                    position: item.position,
                    source: item.ix.source,
                    parentInstructionIndex: item.ix.parentIndex,
                    instructionIndex: item.ix.instructionIndex,
                    resolvedWallet: item.resolvedWallet,
                    walletMatchesTarget: item.walletMatchesTarget,
                    poolVerificationSource: "transaction_context",
                }));
                reason = "close_position2 verified via transaction context";
            } else if (
                closeIfEmptyMatches.length > 0 &&
                standardAcceptedForPosition.length > 0
            ) {
                verified = true;
                matchType = "transaction_context";
                matchingInstructions = closeIfEmptyMatches.map(
                    (item) => ({
                        instruction: item.instructionName,
                        category: "close",
                        pool: null,
                        position: item.position,
                        source: item.ix.source,
                        parentInstructionIndex: item.ix.parentIndex,
                        instructionIndex: item.ix.instructionIndex,
                        resolvedWallet: item.resolvedWallet,
                        walletMatchesTarget: item.walletMatchesTarget,
                        poolVerificationSource:
                            "same_transaction_position_instruction",
                    })
                );
                reason =
                    "close_position_if_empty verified via same-transaction pool corroboration";
            }
        }

        if (verified) {
            eventsVerified++;
            results.push({
                rawType,
                expectedCategory,
                signature,
                createdAt,
                transactionFetched: true,
                matchType,
                matchingInstructions,
                verified: true,
                reason,
            });
        } else {
            eventsUnverified++;
            const foundCategories = Array.from(
                new Set(
                    standardAcceptedForPosition.map(
                        (c) => c.decoded.category
                    )
                )
            ).filter(Boolean);

            const failReason =
                standardAcceptedForPosition.length === 0 &&
                closeVariantInstructions.length === 0
                    ? `No accepted Meteora DLMM instructions found for position '${positionAddress}' in pool '${poolAddress}'`
                    : `Category mismatch: expected '${expectedCategory}', observed [${foundCategories.join(", ")}]`;

            results.push({
                rawType,
                expectedCategory,
                signature,
                createdAt,
                transactionFetched: true,
                matchType: null,
                matchingInstructions: [],
                verified: false,
                reason: failReason,
            });
        }
    }

    // 7. Compute Pass Condition
    const allTransactionsFetched =
        uniqueSignatures.length > 0 &&
        failedTransactions.size === 0 &&
        fetchedTransactions.size === uniqueSignatures.length;

    const allEventsVerified =
        positionEvents.length > 0 && eventsVerified === positionEvents.length;

    const verificationOutput: PositionVerificationOutput = {
        wallet: walletAddress,
        pool: poolAddress,
        position: positionAddress,
        generatedAt: new Date().toISOString(),

        fabriqEventCount: positionEvents.length,
        uniqueSignatureCount: uniqueSignatures.length,

        transactionsFetched: fetchedTransactions.size,
        transactionsFailed: failedTransactions.size,

        eventsVerified,
        eventsUnverified,

        allTransactionsFetched,
        allEventsVerified,

        results,
    };

    // 8. Write verification result
    const outDir = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "verification"
    );
    const outFile = path.join(outDir, `${positionAddress}.json`);
    atomicWriteJson(outFile, verificationOutput);

    // 9. Report to console
    console.log("\n========================================");
    console.log("EVENT VERIFICATION RESULTS");
    console.log("========================================");
    console.table(
        results.map((r) => ({
            rawType: r.rawType,
            expected: r.expectedCategory,
            signature: `${r.signature.slice(0, 8)}...`,
            txFetched: r.transactionFetched ? "YES" : "NO",
            verified: r.verified ? "PASS" : "FAIL",
            matchType: r.matchType || "-",
            matchedIxs: r.matchingInstructions.length,
            reason: r.reason ? `${r.reason.slice(0, 40)}...` : "-",
        }))
    );

    console.log("\n========================================");
    console.log("VERIFICATION PROOF SUMMARY");
    console.log("========================================");
    console.log(`Fabriq Events Total   : ${positionEvents.length}`);
    console.log(`Events Verified       : ${eventsVerified}`);
    console.log(`Events Unverified     : ${eventsUnverified}`);
    console.log(`Unique Signatures     : ${uniqueSignatures.length}`);
    console.log(`Transactions Fetched  : ${fetchedTransactions.size}`);
    console.log(`Transactions Failed   : ${failedTransactions.size}`);
    console.log(
        `All Tx Fetched        : ${allTransactionsFetched ? "PASS" : "FAIL"}`
    );
    console.log(
        `All Events Verified   : ${allEventsVerified ? "PASS" : "FAIL"}`
    );
    console.log(
        `Overall Verification  : ${allTransactionsFetched && allEventsVerified ? "PASSED (VERIFIED ON-CHAIN)" : "FAILED / INCOMPLETE"}`
    );
    console.log(`Output File           : ${outFile}`);
    console.log("========================================");

    if (!allTransactionsFetched || !allEventsVerified) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("WALDISC-2 verification execution failed:", err);
    process.exit(1);
});
