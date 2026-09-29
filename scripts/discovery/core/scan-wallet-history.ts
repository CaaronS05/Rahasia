import fs from "node:fs";
import path from "node:path";
import { loadDiscoveryConfig, type DiscoveryConfig } from "./config.ts";
import {
    fetchTransactionsForAddressPage,
    fetchSignaturesForAddress,
    fetchStandardTransaction,
    mapConcurrent,
} from "./rpc.ts";
import {
    normalizeTransactionInstructions,
    type NormalizedInstruction,
} from "./transaction-normalizer.ts";
import { loadMeteoraIdl } from "./meteora-idl.ts";
import {
    decodeLpInstruction,
    type UnknownDiscriminatorClassification,
} from "./lp-instruction-decoder.ts";
import { resolveLpWallet } from "./wallet-resolver.ts";

export interface WalletLpEventRecord {
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
}

export interface WalletScanMetrics {
    meteoraInstructionsDecoded: number;
    lpInstructionsDecoded: number;
    targetWalletEventsAccepted: number;
    wrongOwnerRejected: number;
    nonLegacyPoolRejected: number;
    nonLpInstructionsRejected: number;
    unknownDiscriminatorTotalCount: number;
    unresolvedEvents: number;
    uniquePools: number;
    uniquePositions: number;
    eventsWithoutPosition: number;
}

export interface WalletScanSummary {
    wallet: string;
    generatedAt: string;
    scanMode: string;
    startTime: string;
    endTime: string;
    days: number;
    pagesFetched: number;
    transactionsFetched: number;
    transactionLimit: number;
    transactionLimitReached: boolean;
    historyWindowComplete: boolean;
    metrics: WalletScanMetrics;
    uniquePoolsList: string[];
    uniquePositionsList: string[];
}

export interface ScanWalletHistoryOptions {
    walletAddress: string;
    days?: number;
    endTime?: number;
    maxTransactions?: number;
    scanMode?: "auto" | "gtfa" | "standard";
    configOverrides?: Partial<DiscoveryConfig>;
    onLog?: (message: string) => void;
}

export interface ScanWalletHistoryResult {
    summary: WalletScanSummary;
    events: WalletLpEventRecord[];
}

export async function scanWalletHistory(
    options: ScanWalletHistoryOptions
): Promise<ScanWalletHistoryResult> {
    const log = options.onLog || ((msg: string) => console.log(msg));
    const walletAddress = options.walletAddress;

    const config = loadDiscoveryConfig({
        ...options.configOverrides,
        ...(options.scanMode ? { scanMode: options.scanMode } : {}),
        ...(options.maxTransactions !== undefined
            ? { maxTransactions: options.maxTransactions }
            : {}),
    });

    const days = Math.max(1, options.days ?? Number(process.env.SCAN_DAYS || 14));
    const maxTransactions = config.maxTransactions;

    // Load and cache Legacy DLMM pools (pairType === 0)
    const cachePath = path.resolve("data/pools/legacy-dlmm-pools.json");
    if (!fs.existsSync(cachePath)) {
        throw new Error(`Legacy pool cache not found at: ${cachePath}`);
    }

    const cacheJson = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const legacyPoolMap = new Map<string, any>();
    if (Array.isArray(cacheJson.pools)) {
        for (const pool of cacheJson.pools) {
            if (pool.address && pool.pairType === 0) {
                legacyPoolMap.set(pool.address, pool);
            }
        }
    }

    const endTime = options.endTime ?? Math.floor(Date.now() / 1000);
    const startTime = endTime - days * 86400;

    log(`[SCAN-WALLET] Target Wallet: ${walletAddress}`);
    log(`[SCAN-WALLET] Window: ${new Date(startTime * 1000).toISOString()} to ${new Date(endTime * 1000).toISOString()} (${days} days)`);
    log(`[SCAN-WALLET] Legacy DLMM pool index: ${legacyPoolMap.size} pairType=0 pools loaded`);

    // Load IDL
    log("[SCAN-WALLET] Loading official Meteora DLMM IDL...");
    const idlBundle = await loadMeteoraIdl(config.meteoraDlmmProgramId);

    // Fetch transactions
    const rawTransactions: any[] = [];
    let pagesFetched = 0;
    let effectiveMode = config.scanMode;
    let paginationExhausted = false;

    const useGtfa =
        config.scanMode === "gtfa" ||
        (config.scanMode === "auto" && Boolean(config.heliusApiKey));

    if (useGtfa) {
        effectiveMode = "gtfa";
        log("[SCAN-WALLET] Using Helius getTransactionsForAddress (gTFA)...");
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

                const pageResult = await fetchTransactionsForAddressPage(
                    config,
                    walletAddress,
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
                log(`[SCAN-WALLET] gTFA failed (${(gtfaErr as any).message}), falling back to standard RPC...`);
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
        log("[SCAN-WALLET] Using Standard RPC (getSignaturesForAddress + getTransaction)...");
        let beforeSignature: string | undefined;

        while (true) {
            pagesFetched++;
            const sigLimit = config.signaturePageSize;
            const sigs = await fetchSignaturesForAddress(
                config,
                walletAddress,
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

    log(`[SCAN-WALLET] Total raw transactions retrieved: ${rawTransactions.length}`);

    // Process and decode instructions
    let meteoraInstructionsDecoded = 0;
    let lpInstructionsDecoded = 0;
    let nonLpInstructionsRejected = 0;
    let unknownDiscriminatorTotalCount = 0;
    let wrongOwnerRejected = 0;
    let nonLegacyPoolRejected = 0;
    let unresolvedEvents = 0;

    const acceptedEvents: WalletLpEventRecord[] = [];

    for (const rawTx of rawTransactions) {
        const normalizedList = normalizeTransactionInstructions(rawTx);

        for (const ix of normalizedList) {
            if (ix.programId !== config.meteoraDlmmProgramId) {
                continue;
            }

            meteoraInstructionsDecoded++;
            const decoded = decodeLpInstruction(
                ix,
                null, // targetPool is null: accept any Meteora DLMM pool
                config.meteoraDlmmProgramId,
                idlBundle.instructionMap,
                idlBundle.eventMap
            );

            if (decoded.status === "UNKNOWN_DISCRIMINATOR") {
                unknownDiscriminatorTotalCount++;
                continue;
            }

            if (decoded.status === "NON_LP_INSTRUCTION") {
                nonLpInstructionsRejected++;
                continue;
            }

            if (decoded.status === "NO_POOL_ACCOUNT") {
                continue;
            }

            if (decoded.status === "ACCEPTED") {
                lpInstructionsDecoded++;

                // Resolve wallet
                const walletResolution = resolveLpWallet(decoded);
                if (!walletResolution) {
                    unresolvedEvents++;
                    continue;
                }

                // Check wallet match: resolvedWallet === target walletAddress
                if (walletResolution.wallet !== walletAddress) {
                    wrongOwnerRejected++;
                    continue;
                }

                // Require decoded pool and check legacy pool cache (pairType === 0)
                if (!decoded.pool) {
                    continue;
                }

                if (!legacyPoolMap.has(decoded.pool)) {
                    nonLegacyPoolRejected++;
                    continue;
                }

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
                    pool: decoded.pool,
                    position: decoded.position,
                    wallet: walletResolution.wallet,
                    walletAccountName: walletResolution.walletAccountName,
                    walletResolutionMethod: walletResolution.walletResolutionMethod,
                });
            }
        }
    }

    // Sort accepted events deterministically:
    // 1. blockTime ascending
    // 2. slot ascending
    // 3. signature ascending
    // 4. parentInstructionIndex
    // 5. instructionIndex
    acceptedEvents.sort((a, b) => {
        if (a.blockTime !== b.blockTime) {
            return a.blockTime - b.blockTime;
        }
        if (a.slot !== b.slot) {
            return a.slot - b.slot;
        }
        if (a.signature !== b.signature) {
            return a.signature.localeCompare(b.signature);
        }
        const aParent = a.parentInstructionIndex ?? -1;
        const bParent = b.parentInstructionIndex ?? -1;
        if (aParent !== bParent) {
            return aParent - bParent;
        }
        return a.instructionIndex - b.instructionIndex;
    });

    const uniquePoolsSet = new Set<string>();
    const uniquePositionsSet = new Set<string>();
    let eventsWithoutPosition = 0;

    for (const ev of acceptedEvents) {
        if (ev.pool) uniquePoolsSet.add(ev.pool);
        if (ev.position) {
            uniquePositionsSet.add(ev.position);
        } else {
            eventsWithoutPosition++;
        }
    }

    const metrics: WalletScanMetrics = {
        meteoraInstructionsDecoded,
        lpInstructionsDecoded,
        targetWalletEventsAccepted: acceptedEvents.length,
        wrongOwnerRejected,
        nonLegacyPoolRejected,
        nonLpInstructionsRejected,
        unknownDiscriminatorTotalCount,
        unresolvedEvents,
        uniquePools: uniquePoolsSet.size,
        uniquePositions: uniquePositionsSet.size,
        eventsWithoutPosition,
    };

    const summary: WalletScanSummary = {
        wallet: walletAddress,
        generatedAt: new Date().toISOString(),
        scanMode: effectiveMode,
        startTime: new Date(startTime * 1000).toISOString(),
        endTime: new Date(endTime * 1000).toISOString(),
        days,
        pagesFetched,
        transactionsFetched: rawTransactions.length,
        transactionLimit: maxTransactions,
        transactionLimitReached,
        historyWindowComplete,
        metrics,
        uniquePoolsList: Array.from(uniquePoolsSet).sort(),
        uniquePositionsList: Array.from(uniquePositionsSet).sort(),
    };

    log(`[SCAN-WALLET] Decoded ${meteoraInstructionsDecoded} Meteora instructions`);
    log(`[SCAN-WALLET] LP instructions decoded: ${lpInstructionsDecoded}`);
    log(`[SCAN-WALLET] Target wallet events accepted: ${acceptedEvents.length}`);
    log(`[SCAN-WALLET] Wrong owner rejected: ${wrongOwnerRejected}`);
    log(`[SCAN-WALLET] Non-legacy pool rejected: ${nonLegacyPoolRejected}`);
    log(`[SCAN-WALLET] Unique pools: ${uniquePoolsSet.size}, unique positions: ${uniquePositionsSet.size}`);

    return {
        summary,
        events: acceptedEvents,
    };
}
