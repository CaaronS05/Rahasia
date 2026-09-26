import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { loadDiscoveryConfig, type DiscoveryConfig } from "./config.ts";
import {
    fetchGtfaPage,
    fetchStandardSignatures,
    fetchStandardTransaction,
    fetchMultipleAccounts,
    mapConcurrent,
} from "./rpc.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "./transaction-normalizer.ts";
import { loadMeteoraIdl, type MeteoraIdlBundle } from "./meteora-idl.ts";
import {
    decodeLpInstruction,
    type DecodedLpInstruction,
    type UnknownDiscriminatorClassification,
} from "./lp-instruction-decoder.ts";
import { resolveLpWallet, type ResolvedWalletResult } from "./wallet-resolver.ts";

export type VerificationStatus =
    | "MATCH"
    | "OWNER_MISMATCH"
    | "POOL_MISMATCH"
    | "NON_METEORA_ACCOUNT"
    | "DELETED_OR_CLOSED"
    | "LEGACY_POSITION"
    | "UNKNOWN_ACCOUNT"
    | "NOT_CHECKED";

export interface LpEventRecord {
    signature: string;
    slot: number;
    blockTime: number;
    timestamp: string;
    source: "top-level" | "inner";
    parentInstructionIndex: number | null;
    instructionIndex: number;
    programId: string;
    instruction: string;
    category: string;
    pool: string;
    position: string | null;
    wallet: string;
    walletAccountName: string;
    walletResolutionMethod: "idl_signer";
    verification: {
        status: VerificationStatus;
        onchainPool: string | null;
        onchainOwner: string | null;
    };
}

export interface DiscoveredWalletRecord {
    owner: string;
    firstSeenAt: string;
    lastSeenAt: string;
    lpInstructionCount: number;
    categories: string[];
    positions: string[];
    signatures: string[];
    evidenceCount: number;
}

export interface RejectedSampleRecord {
    signature: string;
    source: "top-level" | "inner";
    instructionIndex: number;
    instructionName: string | null;
    reason: string;
}

export interface UnknownDiscriminatorRecord {
    discriminatorHex: string;
    classification: UnknownDiscriminatorClassification;
    count: number;
    sources: {
        topLevel: number;
        inner: number;
    };
    sampleSignatures: string[];
    sampleAccountCounts: number[];
    sampleDataLengths: number[];
    innerEvents?: Record<string, number>;
    isSuspectedLpInstruction: boolean;
    explanation: string;
}

export interface PoolDiscoverySummary {
    step: "WALDISC-1";
    generatedAt: string;
    pool: {
        address: string;
        name: string;
        binStep: number;
        pairType: number;
        tvl: number;
        volume24h: number;
        fees24h: number;
    };
    scan: {
        mode: string;
        startTime: string;
        endTime: string;
        days: number;
        pagesFetched: number;
        transactionsFetched: number;
        transactionLimit: number;
        transactionLimitReached: boolean;
        historyWindowComplete: boolean;
        meteoraInstructionsDecoded: number;
        lpInstructionsAccepted: number;
        nonLpInstructionsRejected: number;
        wrongPoolInstructionsRejected: number;
        unknownDiscriminatorTotalCount: number;
        unknownDiscriminatorUniqueCount: number;
        unknownDiscriminators: {
            total: number;
            unique: number;
            idlEvent: number;
            anchorInternal: number;
            unexplained: number;
        };
        walletResolvedEvents: number;
        unresolvedEvents: number;
        uniqueWallets: number;
        uniquePositions: number;
        verificationMatchCount: number;
        verificationMismatchCount: number;
        deletedOrClosedCount: number;
        legacyPositionCount: number;
        nonMeteoraAccountCount: number;
        unknownAccountCount: number;
    };
    rejectedSamples: RejectedSampleRecord[];
}

export interface ScanPoolHistoryOptions {
    poolAddress: string;
    days?: number;
    endTime?: number;
    maxTransactions?: number;
    scanMode?: "auto" | "gtfa" | "standard";
    configOverrides?: Partial<DiscoveryConfig>;
    onLog?: (message: string) => void;
}

export interface ScanPoolHistoryResult {
    summary: PoolDiscoverySummary;
    wallets: DiscoveredWalletRecord[];
    events: LpEventRecord[];
    rejectedSamples: RejectedSampleRecord[];
    unknownDiscriminators: UnknownDiscriminatorRecord[];
    outputDirectory: string;
}


function anchorDiscriminator(accountName: string): Buffer {
    return crypto
        .createHash("sha256")
        .update(`account:${accountName}`)
        .digest()
        .subarray(0, 8);
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

export async function scanPoolHistory(
    options: ScanPoolHistoryOptions
): Promise<ScanPoolHistoryResult> {
    const log = options.onLog || ((msg: string) => console.log(msg));
    const config = loadDiscoveryConfig({
        ...options.configOverrides,
        ...(options.scanMode ? { scanMode: options.scanMode } : {}),
        ...(options.maxTransactions !== undefined
            ? { maxTransactions: options.maxTransactions }
            : {}),
    });

    const poolAddress = options.poolAddress;
    const days = Math.max(1, options.days ?? Number(process.env.SCAN_DAYS || 7));
    const maxTransactions = config.maxTransactions;

    // 1. Verify pool exists in Legacy cache
    const cachePath = path.resolve("data/pools/legacy-dlmm-pools.json");
    if (!fs.existsSync(cachePath)) {
        throw new Error(`Legacy pool cache not found at: ${cachePath}`);
    }

    const cacheJson = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const poolData = Array.isArray(cacheJson.pools)
        ? cacheJson.pools.find((p: any) => p.address === poolAddress)
        : null;

    if (!poolData) {
        throw new Error(
            `Pool ${poolAddress} does not exist in legacy pool cache ${cachePath}`
        );
    }

    if (poolData.pairType !== 0) {
        throw new Error(
            `Pool ${poolAddress} has pairType=${poolData.pairType} (expected 0 for Legacy DLMM)`
        );
    }

    const endTime =
        options.endTime ?? Math.floor(Date.now() / 1000);

    const startTime = endTime - days * 86400;

    log(`[SCAN] Target Pool: ${poolAddress} (${poolData.name})`);
    log(`[SCAN] Window: ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()} (${days} days)`);

    // 2. Load IDL
    log("[SCAN] Loading official Meteora DLMM IDL...");
    const idlBundle = await loadMeteoraIdl(config.meteoraDlmmProgramId);

    // 3. Historical Transaction Retrieval
    const rawTransactions: any[] = [];
    let pagesFetched = 0;
    let effectiveMode = config.scanMode;
    let paginationExhausted = false;

    const useGtfa =
        config.scanMode === "gtfa" ||
        (config.scanMode === "auto" && Boolean(config.heliusApiKey));

    if (useGtfa) {
        effectiveMode = "gtfa";
        log("[SCAN] Using Helius getTransactionsForAddress (gTFA)...");
        let paginationToken: string | undefined;

        try {
            while (true) {
                pagesFetched++;
                const limit =
                    maxTransactions > 0
                        ? Math.min(
                              config.gtfaPageSize,
                              maxTransactions - rawTransactions.length
                          )
                        : config.gtfaPageSize;

                if (limit <= 0) break;

                const pageResult = await fetchGtfaPage(
                    config,
                    poolAddress,
                    startTime,
                    endTime,
                    limit,
                    paginationToken
                );

                const count = pageResult.data.length;
                rawTransactions.push(...pageResult.data);
                log(`[gTFA] Page ${pagesFetched}: fetched ${count} txs (total: ${rawTransactions.length})`);

                if (!pageResult.paginationToken || count === 0) {
                    paginationExhausted = true;
                    break;
                }

                if (maxTransactions > 0 && rawTransactions.length >= maxTransactions) {
                    break;
                }
                paginationToken = pageResult.paginationToken;
            }
        } catch (gtfaErr) {
            if (config.scanMode === "auto") {
                log(`[SCAN] gTFA failed (${(gtfaErr as any).message}), falling back to standard RPC...`);
                effectiveMode = "standard";
                rawTransactions.length = 0;
                pagesFetched = 0;
                paginationExhausted = false;
            } else {
                throw gtfaErr;
            }
        }
    }

    if (effectiveMode === "standard") {
        log("[SCAN] Using Standard RPC (getSignaturesForAddress + getTransaction)...");
        let beforeSignature: string | undefined;

        while (true) {
            pagesFetched++;
            const sigLimit = config.signaturePageSize;
            const sigs = await fetchStandardSignatures(
                config,
                poolAddress,
                sigLimit,
                beforeSignature
            );

            if (sigs.length === 0) {
                paginationExhausted = true;
                break;
            }

            const inRangeSigs = sigs.filter((s) => {
                if (s.err != null || s.blockTime == null) return false;
                return s.blockTime >= startTime && s.blockTime <= endTime;
            });

            const remaining =
                maxTransactions > 0
                    ? Math.max(0, maxTransactions - rawTransactions.length)
                    : inRangeSigs.length;

            const targetSigs =
                maxTransactions > 0 ? inRangeSigs.slice(0, remaining) : inRangeSigs;

            log(`[standard] Page ${pagesFetched}: ${sigs.length} sigs, ${targetSigs.length} in range`);

            const fetchedTxs = await mapConcurrent(
                targetSigs,
                config.getTxConcurrency,
                async (sigInfo) => {
                    try {
                        return await fetchStandardTransaction(config, sigInfo.signature);
                    } catch (fetchErr) {
                        log(`[standard] Failed to fetch tx ${sigInfo.signature}: ${fetchErr}`);
                        return null;
                    }
                }
            );

            for (const tx of fetchedTxs) {
                if (tx) rawTransactions.push(tx);
            }

            const oldest = sigs[sigs.length - 1];
            if (
                (oldest.blockTime != null && oldest.blockTime < startTime) ||
                sigs.length < sigLimit
            ) {
                paginationExhausted = true;
                break;
            }

            if (maxTransactions > 0 && rawTransactions.length >= maxTransactions) {
                break;
            }
            beforeSignature = oldest.signature;
        }
    }

    const transactionLimitReached =
        maxTransactions > 0 &&
        rawTransactions.length >= maxTransactions &&
        !paginationExhausted;
    const historyWindowComplete = paginationExhausted;

    log(`[SCAN] Total raw transactions retrieved: ${rawTransactions.length}`);
    log(`[SCAN] Scan cap stats: limit=${maxTransactions}, limitReached=${transactionLimitReached}, windowComplete=${historyWindowComplete}`);

    // 4. Normalize & Decode instructions
    let meteoraInstructionsDecoded = 0;
    let lpInstructionsAccepted = 0;
    let nonLpInstructionsRejected = 0;
    let wrongPoolInstructionsRejected = 0;
    let unknownDiscriminators = 0;
    let walletResolvedEvents = 0;
    let unresolvedEvents = 0;

    const acceptedEvents: LpEventRecord[] = [];
    const rejectedSamples: RejectedSampleRecord[] = [];

    const unknownHistogram = new Map<string, UnknownDiscriminatorRecord>();

    for (const rawTx of rawTransactions) {
        const normalizedList = normalizeTransactionInstructions(rawTx);

        for (const ix of normalizedList) {
            if (ix.programId !== config.meteoraDlmmProgramId) {
                continue;
            }

            meteoraInstructionsDecoded++;
            const decoded = decodeLpInstruction(
                ix,
                poolAddress,
                config.meteoraDlmmProgramId,
                idlBundle.instructionMap,
                idlBundle.eventMap
            );

            if (decoded.status === "UNKNOWN_DISCRIMINATOR") {
                unknownDiscriminators++;
                const discHex = decoded.discriminatorHex || "unknown";
                let entry = unknownHistogram.get(discHex);
                if (!entry) {
                    const classification: UnknownDiscriminatorClassification =
                        decoded.unknownClassification?.classification ||
                        "UNKNOWN_REAL_INSTRUCTION";
                    const explanation =
                        decoded.unknownClassification?.explanation ||
                        "Unknown instruction discriminator";
                    entry = {
                        discriminatorHex: discHex,
                        classification,
                        count: 0,
                        sources: { topLevel: 0, inner: 0 },
                        sampleSignatures: [],
                        sampleAccountCounts: [],
                        sampleDataLengths: [],
                        innerEvents: {},
                        isSuspectedLpInstruction: Boolean(
                            decoded.unknownClassification?.isSuspectedLpInstruction
                        ),
                        explanation,
                    };
                    unknownHistogram.set(discHex, entry);
                }
                entry.count++;
                if (ix.source === "top-level") {
                    entry.sources.topLevel++;
                } else {
                    entry.sources.inner++;
                }
                if (entry.sampleSignatures.length < 5) {
                    entry.sampleSignatures.push(ix.signature);
                    entry.sampleAccountCounts.push(ix.accounts.length);
                    entry.sampleDataLengths.push(
                        decoded.rawBuffer ? decoded.rawBuffer.length : 0
                    );
                }
                if (
                    entry.classification === "ANCHOR_EVENT_CPI_OR_INTERNAL" &&
                    decoded.unknownClassification?.eventName
                ) {
                    const ev = decoded.unknownClassification.eventName;
                    if (!entry.innerEvents) entry.innerEvents = {};
                    entry.innerEvents[ev] = (entry.innerEvents[ev] || 0) + 1;
                }
            } else if (decoded.status === "NON_LP_INSTRUCTION") {
                nonLpInstructionsRejected++;
                if (rejectedSamples.length < 10) {
                    rejectedSamples.push({
                        signature: ix.signature,
                        source: ix.source,
                        instructionIndex: ix.instructionIndex,
                        instructionName: decoded.instructionName,
                        reason: decoded.rejectReason || "Non-LP instruction",
                    });
                }
            } else if (decoded.status === "WRONG_POOL") {
                wrongPoolInstructionsRejected++;
                if (rejectedSamples.length < 10) {
                    rejectedSamples.push({
                        signature: ix.signature,
                        source: ix.source,
                        instructionIndex: ix.instructionIndex,
                        instructionName: decoded.instructionName,
                        reason: decoded.rejectReason || "Wrong pool",
                    });
                }
            } else if (decoded.status === "ACCEPTED") {
                lpInstructionsAccepted++;

                const walletResolution = resolveLpWallet(decoded);
                if (!walletResolution) {
                    unresolvedEvents++;
                    continue;
                }

                walletResolvedEvents++;
                const timestamp = ix.blockTime
                    ? new Date(ix.blockTime * 1000).toISOString()
                    : new Date().toISOString();

                acceptedEvents.push({
                    signature: ix.signature,
                    slot: ix.slot,
                    blockTime: ix.blockTime,
                    timestamp,
                    source: ix.source,
                    parentInstructionIndex: ix.parentIndex,
                    instructionIndex: ix.instructionIndex,
                    programId: ix.programId,
                    instruction: decoded.instructionName!,
                    category: decoded.category!,
                    pool: decoded.pool!,
                    position: decoded.position,
                    wallet: walletResolution.wallet,
                    walletAccountName: walletResolution.walletAccountName,
                    walletResolutionMethod: walletResolution.walletResolutionMethod,
                    verification: {
                        status: "NOT_CHECKED",
                        onchainPool: null,
                        onchainOwner: null,
                    },
                });
            }
        }
    }

    let idlEventCount = 0;
    let anchorInternalCount = 0;
    let unexplainedCount = 0;

    for (const entry of unknownHistogram.values()) {
        if (entry.classification === "IDL_EVENT_DISCRIMINATOR") {
            idlEventCount += entry.count;
        } else if (entry.classification === "ANCHOR_EVENT_CPI_OR_INTERNAL") {
            anchorInternalCount += entry.count;
        } else {
            unexplainedCount += entry.count;
        }
    }

    const unknownRecords: UnknownDiscriminatorRecord[] = Array.from(
        unknownHistogram.values()
    ).sort((a, b) => b.count - a.count);

    log(`[SCAN] Meteora Instructions Decoded: ${meteoraInstructionsDecoded}`);
    log(`[SCAN] Accepted LP Instructions: ${lpInstructionsAccepted}`);
    log(`[SCAN] Resolved Wallet Events: ${walletResolvedEvents}`);
    log(`[SCAN] Non-LP Rejected: ${nonLpInstructionsRejected}`);
    log(`[SCAN] Wrong-Pool Rejected: ${wrongPoolInstructionsRejected}`);
    log(`[SCAN] Unknown Discriminators Total: ${unknownDiscriminators} (Unique: ${unknownRecords.length})`);
    log(`[SCAN] Unknown breakdown: IDL Events=${idlEventCount}, Anchor/Internal=${anchorInternalCount}, Unexplained=${unexplainedCount}`);

    // 5. On-Chain Verification of Positions
    const uniquePositions = Array.from(
        new Set(
            acceptedEvents
                .map((e) => e.position)
                .filter((p): p is string => Boolean(p))
        )
    );

    log(`[SCAN] Verifying ${uniquePositions.length} unique positions on-chain...`);

    const positionAccounts = await fetchMultipleAccounts(
        config.rpcUrl,
        uniquePositions,
        config.requestRetries
    );

    const positionV2Disc = anchorDiscriminator("PositionV2");
    const positionDisc = anchorDiscriminator("Position");

    const positionStatusMap = new Map<
        string,
        {
            status: VerificationStatus;
            onchainPool: string | null;
            onchainOwner: string | null;
        }
    >();

    let verificationMatchCount = 0;
    let verificationMismatchCount = 0;
    let deletedOrClosedCount = 0;
    let legacyPositionCount = 0;
    let nonMeteoraAccountCount = 0;
    let unknownAccountCount = 0;

    for (let i = 0; i < uniquePositions.length; i++) {
        const posAddr = uniquePositions[i];
        const account = positionAccounts[i];

        if (!account || !account.data || !account.data[0]) {
            deletedOrClosedCount++;
            positionStatusMap.set(posAddr, {
                status: "DELETED_OR_CLOSED",
                onchainPool: null,
                onchainOwner: null,
            });
            continue;
        }

        // Section 5: Harden PositionV2 Verification — verify account.owner === METEORA_DLMM_PROGRAM_ID
        if (account.owner !== config.meteoraDlmmProgramId) {
            nonMeteoraAccountCount++;
            verificationMismatchCount++;
            positionStatusMap.set(posAddr, {
                status: "NON_METEORA_ACCOUNT",
                onchainPool: null,
                onchainOwner: null,
            });
            continue;
        }

        const dataBuffer = Buffer.from(account.data[0], "base64");

        if (dataBuffer.length < 8) {
            unknownAccountCount++;
            positionStatusMap.set(posAddr, {
                status: "UNKNOWN_ACCOUNT",
                onchainPool: null,
                onchainOwner: null,
            });
            continue;
        }

        const disc = dataBuffer.subarray(0, 8);

        if (disc.equals(positionDisc)) {
            legacyPositionCount++;
            positionStatusMap.set(posAddr, {
                status: "LEGACY_POSITION",
                onchainPool: null,
                onchainOwner: null,
            });
            continue;
        }

        if (!disc.equals(positionV2Disc) || dataBuffer.length < 72) {
            unknownAccountCount++;
            positionStatusMap.set(posAddr, {
                status: "UNKNOWN_ACCOUNT",
                onchainPool: null,
                onchainOwner: null,
            });
            continue;
        }

        const onchainPool = new PublicKey(dataBuffer.subarray(8, 40)).toBase58();
        const onchainOwner = new PublicKey(dataBuffer.subarray(40, 72)).toBase58();

        let status: VerificationStatus;
        if (onchainPool !== poolAddress) {
            status = "POOL_MISMATCH";
            verificationMismatchCount++;
        } else {
            status = "MATCH";
        }

        positionStatusMap.set(posAddr, {
            status,
            onchainPool,
            onchainOwner,
        });
    }

    // Attach verification results to accepted events
    for (const event of acceptedEvents) {
        if (!event.position) {
            event.verification = {
                status: "NOT_CHECKED",
                onchainPool: null,
                onchainOwner: null,
            };
            continue;
        }

        const posInfo = positionStatusMap.get(event.position);
        if (!posInfo) {
            event.verification = {
                status: "NOT_CHECKED",
                onchainPool: null,
                onchainOwner: null,
            };
            continue;
        }

        if (posInfo.status === "MATCH") {
            if (posInfo.onchainOwner === event.wallet) {
                event.verification = {
                    status: "MATCH",
                    onchainPool: posInfo.onchainPool,
                    onchainOwner: posInfo.onchainOwner,
                };
                verificationMatchCount++;
            } else {
                event.verification = {
                    status: "OWNER_MISMATCH",
                    onchainPool: posInfo.onchainPool,
                    onchainOwner: posInfo.onchainOwner,
                };
                verificationMismatchCount++;
            }
        } else {
            event.verification = {
                status: posInfo.status,
                onchainPool: posInfo.onchainPool,
                onchainOwner: posInfo.onchainOwner,
            };
        }
    }

    // 6. Aggregate Unique Wallets
    const walletMap = new Map<
        string,
        {
            owner: string;
            firstSeenAt: string;
            lastSeenAt: string;
            lpInstructionCount: number;
            categories: Set<string>;
            positions: Set<string>;
            signatures: Set<string>;
            evidenceCount: number;
        }
    >();

    for (const event of acceptedEvents) {
        let entry = walletMap.get(event.wallet);
        if (!entry) {
            entry = {
                owner: event.wallet,
                firstSeenAt: event.timestamp,
                lastSeenAt: event.timestamp,
                lpInstructionCount: 0,
                categories: new Set(),
                positions: new Set(),
                signatures: new Set(),
                evidenceCount: 0,
            };
            walletMap.set(event.wallet, entry);
        }

        if (event.timestamp < entry.firstSeenAt) {
            entry.firstSeenAt = event.timestamp;
        }
        if (event.timestamp > entry.lastSeenAt) {
            entry.lastSeenAt = event.timestamp;
        }

        entry.lpInstructionCount++;
        entry.evidenceCount++;
        entry.categories.add(event.category);
        if (event.position) entry.positions.add(event.position);
        entry.signatures.add(event.signature);
    }

    const uniqueWallets: DiscoveredWalletRecord[] = Array.from(walletMap.values()).map(
        (w) => ({
            owner: w.owner,
            firstSeenAt: w.firstSeenAt,
            lastSeenAt: w.lastSeenAt,
            lpInstructionCount: w.lpInstructionCount,
            categories: Array.from(w.categories),
            positions: Array.from(w.positions),
            signatures: Array.from(w.signatures),
            evidenceCount: w.evidenceCount,
        })
    );

    // Sort wallets by evidenceCount descending
    uniqueWallets.sort((a, b) => b.evidenceCount - a.evidenceCount);

    // 7. Generate Summary
    const summary: PoolDiscoverySummary = {
        step: "WALDISC-1",
        generatedAt: new Date().toISOString(),
        pool: {
            address: poolAddress,
            name: poolData.name,
            binStep: poolData.binStep,
            pairType: poolData.pairType,
            tvl: poolData.tvl,
            volume24h: poolData.volume?.["24h"] || 0,
            fees24h: poolData.fees?.["24h"] || 0,
        },
        scan: {
            mode: effectiveMode,
            startTime: new Date(startTime * 1000).toISOString(),
            endTime: new Date(endTime * 1000).toISOString(),
            days,
            pagesFetched,
            transactionsFetched: rawTransactions.length,
            transactionLimit: maxTransactions,
            transactionLimitReached,
            historyWindowComplete,
            meteoraInstructionsDecoded,
            lpInstructionsAccepted,
            nonLpInstructionsRejected,
            wrongPoolInstructionsRejected,
            unknownDiscriminatorTotalCount: unknownDiscriminators,
            unknownDiscriminatorUniqueCount: unknownRecords.length,
            unknownDiscriminators: {
                total: unknownDiscriminators,
                unique: unknownRecords.length,
                idlEvent: idlEventCount,
                anchorInternal: anchorInternalCount,
                unexplained: unexplainedCount,
            },
            walletResolvedEvents,
            unresolvedEvents,
            uniqueWallets: uniqueWallets.length,
            uniquePositions: uniquePositions.length,
            verificationMatchCount,
            verificationMismatchCount,
            deletedOrClosedCount,
            legacyPositionCount,
            nonMeteoraAccountCount,
            unknownAccountCount,
        },
        rejectedSamples,
    };

    // 8. Atomic Output Generation
    const outputDir = path.resolve("data/discovery/waldisc-1", poolAddress);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const summaryPath = path.join(outputDir, "summary.json");
    const walletsPath = path.join(outputDir, "wallets.json");
    const eventsPath = path.join(outputDir, "lp-events.json");
    const unknownsPath = path.join(outputDir, "unknown-discriminators.json");

    atomicWriteJson(summaryPath, summary);
    atomicWriteJson(walletsPath, uniqueWallets);
    atomicWriteJson(eventsPath, acceptedEvents);
    atomicWriteJson(unknownsPath, unknownRecords);

    log(`[SAVE] Output saved to: ${outputDir}`);
    log(`[SAVE] summary.json (${summary.scan.uniqueWallets} unique wallets, ${summary.scan.walletResolvedEvents} resolved events)`);
    log(`[SAVE] unknown-discriminators.json (${unknownRecords.length} unique discriminator families)`);

    return {
        summary,
        wallets: uniqueWallets,
        events: acceptedEvents,
        rejectedSamples,
        unknownDiscriminators: unknownRecords,
        outputDirectory: outputDir,
    };
}

