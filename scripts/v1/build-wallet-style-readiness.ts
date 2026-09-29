import fs from "node:fs";
import path from "node:path";

const METEORA_API_BASE = "https://dlmm.datapi.meteora.ag";
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_PACING_MS = 60;
const BACKOFF_SCHEDULE_MS = [2000, 4000, 8000, 16000, 30000];
const TERMINAL_BACKOFF_MS = 30000;

export interface PoolCreationRecord {
    pool: string;
    createdAt: string | null;
    source: "METEORA_DATA_API";
    status: "AVAILABLE" | "UNAVAILABLE";
}

export interface PoolCreationTimesOutput {
    generatedAt: string;
    poolCount: number;
    coverage: {
        available: number;
        unavailable: number;
        coveragePct: number;
    };
    pools: PoolCreationRecord[];
}

export interface WalletEntryDelayMetrics {
    positionsWithEntryDelay: number;
    totalClosedPositions: number;
    entryDelayCoveragePct: number;
    medianEntryDelayHours: number | null;
    meanEntryDelayHours: number | null;
    p25EntryDelayHours: number | null;
    p75EntryDelayHours: number | null;
    negativeEntryDelayCount: number;
    fractions: {
        within1hPct: number;
        within6hPct: number;
        within24hPct: number;
        within72hPct: number;
        within7dPct: number;
    };
}

export interface WalletHoldingMetrics {
    medianHoldHours: number;
    meanHoldHours: number;
    p25HoldHours: number;
    p75HoldHours: number;
    fractions: {
        within1hPct: number;
        within6hPct: number;
        within24hPct: number;
        within72hPct: number;
        ge7dPct: number;
    };
}

export interface WalletFarmerMetrics {
    closedPositionCount: number;
    uniqueDlmmPools: number;
    positionsPerPool: number;
    totalFees: number;
    totalDeposits: number;
    feesToDepositsPct: number;
}

export interface WalletStyleRecord {
    wallet: string;
    entryDelay: WalletEntryDelayMetrics;
    holding: WalletHoldingMetrics;
    farmer: WalletFarmerMetrics;
}

export interface DistributionStats {
    count: number;
    min: number;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    max: number;
}

export interface SniperGridCell {
    entryDelayMaxHours: number;
    entryDelayLabel: string;
    holdMaxHours: number;
    holdLabel: string;
    candidateWalletCount: number;
    walletPct: number;
}

export interface FarmerGridOutput {
    cohortP75HoldHours: number;
    cohortP25UniquePools: number;
    cohortP75PositionsPerPool: number;
    counts: {
        longHoldOnly: number;
        longHoldLowUniquePools: number;
        longHoldHighPositionsPerPool: number;
        longHoldLowUniquePoolsHighPositionsPerPool: number;
    };
}

export interface WalletStyleReadinessOutput {
    generatedAt: string;
    version: "v1";
    assessment: {
        sniperStyleReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
        farmerStyleReadiness: "READY";
        overallReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
        notes: string;
    };
    poolCoverage: {
        uniquePools: number;
        poolCreationAvailable: number;
        poolCreationUnavailable: number;
        poolCreationCoveragePct: number;
    };
    positionCoverage: {
        totalClosedPositions: number;
        positionsWithEntryDelay: number;
        entryDelayCoveragePct: number;
        negativeEntryDelays: number;
        walletsWithHighCoverage: number;
        walletsWithLowCoverage: number;
    };
    cohortDistributions: {
        medianEntryDelayHours: DistributionStats;
        medianHoldHours: DistributionStats;
        positionsPerPool: DistributionStats;
        uniqueDlmmPools: DistributionStats;
        feesToDepositsPct: DistributionStats;
    };
    sniperSupportGrid: SniperGridCell[];
    farmerSupportGrid: FarmerGridOutput;
    wallets: WalletStyleRecord[];
}

interface CliOptions {
    datasetPath: string;
    poolCreationPath: string;
    outputPath: string;
}

function parseCliArgs(): CliOptions {
    const args = process.argv.slice(2);
    let datasetPath = path.resolve("data/v1/wallet-screening-dataset.json");
    let poolCreationPath = path.resolve("data/v1/pool-creation-times.json");
    let outputPath = path.resolve("data/v1/wallet-style-readiness.json");

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if ((arg === "--dataset" || arg === "--input") && args[i + 1]) {
            datasetPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--dataset=") || arg.startsWith("--input=")) {
            datasetPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--pools" && args[i + 1]) {
            poolCreationPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--pools=")) {
            poolCreationPath = path.resolve(arg.split("=")[1]);
        } else if (arg === "--output" && args[i + 1]) {
            outputPath = path.resolve(args[i + 1]);
            i++;
        } else if (arg.startsWith("--output=")) {
            outputPath = path.resolve(arg.slice(9));
        }
    }

    if (!fs.existsSync(datasetPath)) {
        const alt = path.resolve(process.cwd(), "data/v1/wallet-screening-dataset.json");
        if (fs.existsSync(alt)) datasetPath = alt;
    }

    return { datasetPath, poolCreationPath, outputPath };
}

function atomicWriteJson(filePath: string, data: any): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseTimestampMs(ts: string | number | null | undefined): number | null {
    if (ts === null || ts === undefined || ts === "") return null;
    if (typeof ts === "number") {
        return ts > 1e11 ? ts : ts * 1000;
    }
    const str = String(ts).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) {
        const num = Number(str);
        return num > 1e11 ? num : num * 1000;
    }
    const isoStr = str.includes("T") ? str : str.replace(" ", "T") + (str.endsWith("Z") ? "" : "Z");
    const parsed = Date.parse(isoStr);
    return Number.isFinite(parsed) ? parsed : null;
}

export function computePercentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];
    const rank = (p / 100) * (sortedValues.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const weight = rank - lower;
    if (lower === upper) return sortedValues[lower];
    return Number((sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight).toFixed(4));
}

function computeDistribution(values: number[]): DistributionStats {
    if (values.length === 0) {
        return { count: 0, min: 0, p10: 0, p25: 0, median: 0, p75: 0, p90: 0, max: 0 };
    }
    const sorted = [...values].sort((a, b) => a - b);
    return {
        count: sorted.length,
        min: Number(sorted[0].toFixed(2)),
        p10: Number(computePercentile(sorted, 10).toFixed(2)),
        p25: Number(computePercentile(sorted, 25).toFixed(2)),
        median: Number(computePercentile(sorted, 50).toFixed(2)),
        p75: Number(computePercentile(sorted, 75).toFixed(2)),
        p90: Number(computePercentile(sorted, 90).toFixed(2)),
        max: Number(sorted[sorted.length - 1].toFixed(2)),
    };
}

async function fetchMeteoraPoolMetadata(poolAddress: string): Promise<number | null> {
    let attempt = 0;
    const url = `${METEORA_API_BASE}/pools/${poolAddress}`;

    while (attempt <= BACKOFF_SCHEDULE_MS.length) {
        try {
            const res = await fetch(url, {
                headers: {
                    Accept: "application/json",
                    "User-Agent": "Meteora-Scanner-Style-Readiness/1.0",
                },
            });

            if (res.status === 429) {
                const delay =
                    attempt < BACKOFF_SCHEDULE_MS.length
                        ? BACKOFF_SCHEDULE_MS[attempt]
                        : TERMINAL_BACKOFF_MS;
                attempt++;
                await sleep(delay);
                continue;
            }

            if (res.status === 404 || !res.ok) {
                return null;
            }

            const json: any = await res.json();
            const rawTs = json?.created_at ?? json?.createdAt;
            return parseTimestampMs(rawTs);
        } catch {
            const delay =
                attempt < BACKOFF_SCHEDULE_MS.length
                    ? BACKOFF_SCHEDULE_MS[attempt]
                    : TERMINAL_BACKOFF_MS;
            attempt++;
            await sleep(delay);
        }
    }
    return null;
}

export async function resolvePoolCreationTimes(
    uniquePools: string[],
    poolCreationOutputPath: string
): Promise<Map<string, { createdAtMs: number | null; createdAtIso: string | null; status: "AVAILABLE" | "UNAVAILABLE" }>> {
    const resultMap = new Map<string, { createdAtMs: number | null; createdAtIso: string | null; status: "AVAILABLE" | "UNAVAILABLE" }>();

    // 1. Try loading existing target pool creation times file
    if (fs.existsSync(poolCreationOutputPath)) {
        try {
            const existingRaw = JSON.parse(fs.readFileSync(poolCreationOutputPath, "utf8"));
            const poolList: any[] = Array.isArray(existingRaw) ? existingRaw : existingRaw?.pools ?? [];
            for (const p of poolList) {
                if (!p || !p.pool) continue;
                const addr = String(p.pool).trim();
                const ms = parseTimestampMs(p.createdAt);
                if (p.status === "AVAILABLE" && ms !== null) {
                    resultMap.set(addr, {
                        createdAtMs: ms,
                        createdAtIso: new Date(ms).toISOString(),
                        status: "AVAILABLE",
                    });
                } else if (p.status === "UNAVAILABLE") {
                    resultMap.set(addr, {
                        createdAtMs: null,
                        createdAtIso: null,
                        status: "UNAVAILABLE",
                    });
                }
            }
        } catch {}
    }

    // 2. Try loading cached legacy pools file
    const legacyPoolsPath = path.resolve("data/pools/legacy-dlmm-pools.json");
    if (fs.existsSync(legacyPoolsPath)) {
        try {
            const legacyRaw = JSON.parse(fs.readFileSync(legacyPoolsPath, "utf8"));
            const pools: any[] = Array.isArray(legacyRaw?.pools) ? legacyRaw.pools : [];
            for (const lp of pools) {
                if (!lp || !lp.address) continue;
                const addr = String(lp.address).trim();
                if (resultMap.has(addr)) continue;
                const ms = parseTimestampMs(lp.createdAt);
                if (ms !== null && ms > 0) {
                    resultMap.set(addr, {
                        createdAtMs: ms,
                        createdAtIso: new Date(ms).toISOString(),
                        status: "AVAILABLE",
                    });
                }
            }
        } catch {}
    }

    // 3. Try loading waldisc-2 pool creation caches
    const waldisc2Paths = [
        path.resolve("data/discovery/waldisc-2/pool-creation-times.json"),
        path.resolve("data/discovery/waldisc-2/meteora-pool-created-at-audit.json"),
    ];

    for (const wPath of waldisc2Paths) {
        if (fs.existsSync(wPath)) {
            try {
                const wRaw = JSON.parse(fs.readFileSync(wPath, "utf8"));
                const pools: any[] = Array.isArray(wRaw?.pools) ? wRaw.pools : [];
                for (const p of pools) {
                    if (!p || !p.pool) continue;
                    const addr = String(p.pool).trim();
                    if (resultMap.has(addr)) continue;
                    const ms = parseTimestampMs(p.createdAt ?? p.timestamp ?? p.rawValue);
                    if (ms !== null && ms > 0) {
                        resultMap.set(addr, {
                            createdAtMs: ms,
                            createdAtIso: new Date(ms).toISOString(),
                            status: "AVAILABLE",
                        });
                    }
                }
            } catch {}
        }
    }

    // 4. Identify remaining missing pools that must be fetched from Meteora Data API
    const missingPools = uniquePools.filter((p) => !resultMap.has(p));

    if (missingPools.length > 0) {
        console.log(`Resolving creation timestamps for ${missingPools.length} pools from Meteora Data API...`);
        let completed = 0;

        for (let i = 0; i < missingPools.length; i += DEFAULT_CONCURRENCY) {
            const batch = missingPools.slice(i, i + DEFAULT_CONCURRENCY);
            await Promise.all(
                batch.map(async (poolAddr) => {
                    const tsMs = await fetchMeteoraPoolMetadata(poolAddr);
                    if (tsMs !== null && tsMs > 0) {
                        resultMap.set(poolAddr, {
                            createdAtMs: tsMs,
                            createdAtIso: new Date(tsMs).toISOString(),
                            status: "AVAILABLE",
                        });
                    } else {
                        resultMap.set(poolAddr, {
                            createdAtMs: null,
                            createdAtIso: null,
                            status: "UNAVAILABLE",
                        });
                    }
                })
            );
            completed += batch.length;
            if (completed % 50 === 0 || completed === missingPools.length) {
                console.log(`  Meteora pool metadata fetched: ${completed}/${missingPools.length}`);
            }
            await sleep(DEFAULT_PACING_MS);
        }
    }

    // 5. Persist unified data/v1/pool-creation-times.json
    const records: PoolCreationRecord[] = uniquePools.map((addr) => {
        const info = resultMap.get(addr);
        return {
            pool: addr,
            createdAt: info?.createdAtIso ?? null,
            source: "METEORA_DATA_API",
            status: info?.status ?? "UNAVAILABLE",
        };
    });

    const availableCount = records.filter((r) => r.status === "AVAILABLE").length;
    const unavailableCount = records.length - availableCount;
    const coveragePct = records.length > 0
        ? Number(((availableCount / records.length) * 100).toFixed(2))
        : 0;

    const outputPayload: PoolCreationTimesOutput = {
        generatedAt: new Date().toISOString(),
        poolCount: records.length,
        coverage: {
            available: availableCount,
            unavailable: unavailableCount,
            coveragePct,
        },
        pools: records,
    };

    atomicWriteJson(poolCreationOutputPath, outputPayload);
    return resultMap;
}

export async function buildStyleReadiness(
    dataset: any,
    poolCreationOutputPath: string
): Promise<WalletStyleReadinessOutput> {
    if (!dataset || !Array.isArray(dataset.wallets)) {
        throw new Error("Invalid screening dataset: missing or malformed wallets array");
    }

    const validWallets: any[] = dataset.wallets.filter((w: any) => w?.valid === true);
    if (validWallets.length === 0) {
        throw new Error("No valid wallets found in screening dataset");
    }

    // 1. Gather all unique DLMM pools across valid wallets
    const uniquePoolSet = new Set<string>();
    for (const w of validWallets) {
        const positions: any[] = Array.isArray(w.positions) ? w.positions : [];
        for (const p of positions) {
            if (p.pool) uniquePoolSet.add(String(p.pool).trim());
        }
    }
    const uniquePoolList = Array.from(uniquePoolSet).sort();

    // 2. Resolve pool creation times using existing cache and Meteora Data API
    const poolCreationMap = await resolvePoolCreationTimes(uniquePoolList, poolCreationOutputPath);

    let totalCohortClosedPositions = 0;
    let cohortPositionsWithEntryDelay = 0;
    let cohortNegativeEntryDelays = 0;
    let walletsWithHighCoverage = 0;
    let walletsWithLowCoverage = 0;

    const scoredWallets: WalletStyleRecord[] = [];

    // 3. Process each wallet
    for (const w of validWallets) {
        const wallet = String(w.wallet).trim();
        const positions: any[] = Array.isArray(w.positions) ? w.positions : [];
        const closedPositionCount = Number(w.metrics?.closedPositionCount ?? positions.length);

        const walletPoolSet = new Set<string>();
        for (const p of positions) {
            if (p.pool) walletPoolSet.add(String(p.pool).trim());
        }
        const uniqueDlmmPools = walletPoolSet.size;

        const positionsPerPool = uniqueDlmmPools > 0
            ? Number((closedPositionCount / uniqueDlmmPools).toFixed(2))
            : 0;

        const totalFees = Number(w.metrics?.totalFees ?? 0);
        const totalDeposits = Number(w.metrics?.totalDeposits ?? 0);
        const feesToDepositsPct = totalDeposits > 0
            ? Number(((totalFees / totalDeposits) * 100).toFixed(4))
            : 0;

        // Entry Delay calculation
        const entryDelays: number[] = [];
        let walletNegativeEntryDelays = 0;

        for (const p of positions) {
            const openMs = parseTimestampMs(p.openedAt);
            const poolAddr = p.pool ? String(p.pool).trim() : null;
            const poolInfo = poolAddr ? poolCreationMap.get(poolAddr) : null;

            if (openMs !== null && poolInfo && poolInfo.status === "AVAILABLE" && poolInfo.createdAtMs !== null) {
                // Do not clamp negative values
                const delayHours = (openMs - poolInfo.createdAtMs) / 3600000;
                entryDelays.push(delayHours);
                if (delayHours < 0) {
                    walletNegativeEntryDelays++;
                    cohortNegativeEntryDelays++;
                }
            }
        }

        totalCohortClosedPositions += closedPositionCount;
        cohortPositionsWithEntryDelay += entryDelays.length;

        const entryDelayCoveragePct = closedPositionCount > 0
            ? Number(((entryDelays.length / closedPositionCount) * 100).toFixed(2))
            : 0;

        if (entryDelayCoveragePct >= 90) {
            walletsWithHighCoverage++;
        } else {
            walletsWithLowCoverage++;
        }

        entryDelays.sort((a, b) => a - b);
        const nDelays = entryDelays.length;

        const medianEntryDelayHours = nDelays > 0
            ? Number(computePercentile(entryDelays, 50).toFixed(2))
            : null;
        const meanEntryDelayHours = nDelays > 0
            ? Number((entryDelays.reduce((s, v) => s + v, 0) / nDelays).toFixed(2))
            : null;
        const p25EntryDelayHours = nDelays > 0
            ? Number(computePercentile(entryDelays, 25).toFixed(2))
            : null;
        const p75EntryDelayHours = nDelays > 0
            ? Number(computePercentile(entryDelays, 75).toFixed(2))
            : null;

        const within1hCount = entryDelays.filter((h) => h <= 1).length;
        const within6hCount = entryDelays.filter((h) => h <= 6).length;
        const within24hCount = entryDelays.filter((h) => h <= 24).length;
        const within72hCount = entryDelays.filter((h) => h <= 72).length;
        const within7dCount = entryDelays.filter((h) => h <= 168).length;

        const entryFractions = {
            within1hPct: nDelays > 0 ? Number(((within1hCount / nDelays) * 100).toFixed(2)) : 0,
            within6hPct: nDelays > 0 ? Number(((within6hCount / nDelays) * 100).toFixed(2)) : 0,
            within24hPct: nDelays > 0 ? Number(((within24hCount / nDelays) * 100).toFixed(2)) : 0,
            within72hPct: nDelays > 0 ? Number(((within72hCount / nDelays) * 100).toFixed(2)) : 0,
            within7dPct: nDelays > 0 ? Number(((within7dCount / nDelays) * 100).toFixed(2)) : 0,
        };

        // Hold Behaviour calculation
        const holdHoursList: number[] = [];
        for (const p of positions) {
            if (typeof p.holdDurationHours === "number" && Number.isFinite(p.holdDurationHours)) {
                holdHoursList.push(p.holdDurationHours);
            } else {
                const openMs = parseTimestampMs(p.openedAt);
                const closeMs = parseTimestampMs(p.closedAt);
                if (openMs !== null && closeMs !== null && closeMs >= openMs) {
                    holdHoursList.push((closeMs - openMs) / 3600000);
                }
            }
        }

        holdHoursList.sort((a, b) => a - b);
        const nHolds = holdHoursList.length;

        const medianHoldHours = nHolds > 0
            ? Number(computePercentile(holdHoursList, 50).toFixed(2))
            : Number(w.metrics?.medianHoldHours ?? 0);
        const meanHoldHours = nHolds > 0
            ? Number((holdHoursList.reduce((s, v) => s + v, 0) / nHolds).toFixed(2))
            : Number(w.metrics?.meanHoldHours ?? 0);
        const p25HoldHours = nHolds > 0
            ? Number(computePercentile(holdHoursList, 25).toFixed(2))
            : 0;
        const p75HoldHours = nHolds > 0
            ? Number(computePercentile(holdHoursList, 75).toFixed(2))
            : 0;

        const holdWithin1h = holdHoursList.filter((h) => h <= 1).length;
        const holdWithin6h = holdHoursList.filter((h) => h <= 6).length;
        const holdWithin24h = holdHoursList.filter((h) => h <= 24).length;
        const holdWithin72h = holdHoursList.filter((h) => h <= 72).length;
        const holdGe7d = holdHoursList.filter((h) => h >= 168).length;

        const holdFractions = {
            within1hPct: nHolds > 0 ? Number(((holdWithin1h / nHolds) * 100).toFixed(2)) : 0,
            within6hPct: nHolds > 0 ? Number(((holdWithin6h / nHolds) * 100).toFixed(2)) : 0,
            within24hPct: nHolds > 0 ? Number(((holdWithin24h / nHolds) * 100).toFixed(2)) : 0,
            within72hPct: nHolds > 0 ? Number(((holdWithin72h / nHolds) * 100).toFixed(2)) : 0,
            ge7dPct: nHolds > 0 ? Number(((holdGe7d / nHolds) * 100).toFixed(2)) : 0,
        };

        scoredWallets.push({
            wallet,
            entryDelay: {
                positionsWithEntryDelay: nDelays,
                totalClosedPositions: closedPositionCount,
                entryDelayCoveragePct,
                medianEntryDelayHours,
                meanEntryDelayHours,
                p25EntryDelayHours,
                p75EntryDelayHours,
                negativeEntryDelayCount: walletNegativeEntryDelays,
                fractions: entryFractions,
            },
            holding: {
                medianHoldHours,
                meanHoldHours,
                p25HoldHours,
                p75HoldHours,
                fractions: holdFractions,
            },
            farmer: {
                closedPositionCount,
                uniqueDlmmPools,
                positionsPerPool,
                totalFees,
                totalDeposits,
                feesToDepositsPct,
            },
        });
    }

    scoredWallets.sort((a, b) => a.wallet.localeCompare(b.wallet));

    // 4. Cohort Distributions
    const cohortMedianEntryDelays = scoredWallets
        .map((w) => w.entryDelay.medianEntryDelayHours)
        .filter((v): v is number => v !== null);
    const cohortMedianHolds = scoredWallets.map((w) => w.holding.medianHoldHours);
    const cohortPositionsPerPool = scoredWallets.map((w) => w.farmer.positionsPerPool);
    const cohortUniquePools = scoredWallets.map((w) => w.farmer.uniqueDlmmPools);
    const cohortFeesToDeposits = scoredWallets.map((w) => w.farmer.feesToDepositsPct);

    const distMedianEntryDelay = computeDistribution(cohortMedianEntryDelays);
    const distMedianHold = computeDistribution(cohortMedianHolds);
    const distPositionsPerPool = computeDistribution(cohortPositionsPerPool);
    const distUniquePools = computeDistribution(cohortUniquePools);
    const distFeesToDeposits = computeDistribution(cohortFeesToDeposits);

    // 5. Sniper Support Grid
    const entryCutoffs = [
        { maxH: 1, label: "<= 1h" },
        { maxH: 6, label: "<= 6h" },
        { maxH: 24, label: "<= 24h" },
        { maxH: 72, label: "<= 72h" },
        { maxH: 168, label: "<= 7d" },
    ];

    const holdCutoffs = [
        { maxH: 1, label: "<= 1h" },
        { maxH: 6, label: "<= 6h" },
        { maxH: 24, label: "<= 24h" },
        { maxH: 72, label: "<= 72h" },
    ];

    const sniperSupportGrid: SniperGridCell[] = [];
    for (const ec of entryCutoffs) {
        for (const hc of holdCutoffs) {
            const count = scoredWallets.filter((w) => {
                const medEntry = w.entryDelay.medianEntryDelayHours;
                return (
                    medEntry !== null &&
                    medEntry <= ec.maxH &&
                    w.holding.medianHoldHours <= hc.maxH
                );
            }).length;

            sniperSupportGrid.push({
                entryDelayMaxHours: ec.maxH,
                entryDelayLabel: ec.label,
                holdMaxHours: hc.maxH,
                holdLabel: hc.label,
                candidateWalletCount: count,
                walletPct: Number(((count / scoredWallets.length) * 100).toFixed(2)),
            });
        }
    }

    // 6. Farmer Support Grid
    const cohortP75Hold = distMedianHold.p75;
    const cohortP25Pools = distUniquePools.p25;
    const cohortP75PositionsPerPoolVal = distPositionsPerPool.p75;

    const countLongHoldOnly = scoredWallets.filter(
        (w) => w.holding.medianHoldHours >= cohortP75Hold
    ).length;

    const countLongHoldLowPools = scoredWallets.filter(
        (w) =>
            w.holding.medianHoldHours >= cohortP75Hold &&
            w.farmer.uniqueDlmmPools <= cohortP25Pools
    ).length;

    const countLongHoldHighPositionsPerPool = scoredWallets.filter(
        (w) =>
            w.holding.medianHoldHours >= cohortP75Hold &&
            w.farmer.positionsPerPool >= cohortP75PositionsPerPoolVal
    ).length;

    const countLongHoldLowPoolsHighPositionsPerPool = scoredWallets.filter(
        (w) =>
            w.holding.medianHoldHours >= cohortP75Hold &&
            w.farmer.uniqueDlmmPools <= cohortP25Pools &&
            w.farmer.positionsPerPool >= cohortP75PositionsPerPoolVal
    ).length;

    const farmerSupportGrid: FarmerGridOutput = {
        cohortP75HoldHours: cohortP75Hold,
        cohortP25UniquePools: cohortP25Pools,
        cohortP75PositionsPerPool: cohortP75PositionsPerPoolVal,
        counts: {
            longHoldOnly: countLongHoldOnly,
            longHoldLowUniquePools: countLongHoldLowPools,
            longHoldHighPositionsPerPool: countLongHoldHighPositionsPerPool,
            longHoldLowUniquePoolsHighPositionsPerPool: countLongHoldLowPoolsHighPositionsPerPool,
        },
    };

    // 7. Overall Coverage & Readiness Assessment
    let poolCreationAvailableCount = 0;
    for (const poolAddr of uniquePoolList) {
        const info = poolCreationMap.get(poolAddr);
        if (info && info.status === "AVAILABLE") poolCreationAvailableCount++;
    }
    const poolCreationUnavailableCount = uniquePoolList.length - poolCreationAvailableCount;
    const poolCreationCoveragePct = uniquePoolList.length > 0
        ? Number(((poolCreationAvailableCount / uniquePoolList.length) * 100).toFixed(2))
        : 0;

    const cohortEntryDelayCoveragePct = totalCohortClosedPositions > 0
        ? Number(((cohortPositionsWithEntryDelay / totalCohortClosedPositions) * 100).toFixed(2))
        : 0;

    let sniperReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY";
    if (cohortEntryDelayCoveragePct >= 90 && cohortNegativeEntryDelays === 0) {
        sniperReadiness = "READY";
    } else if (cohortEntryDelayCoveragePct >= 70) {
        sniperReadiness = "READY_WITH_LIMITATIONS";
    } else {
        sniperReadiness = "NOT_READY";
    }

    const farmerReadiness = "READY";

    const overallReadiness: "READY" | "READY_WITH_LIMITATIONS" | "NOT_READY" =
        sniperReadiness === "READY" && farmerReadiness === "READY"
            ? "READY"
            : sniperReadiness === "NOT_READY"
            ? "NOT_READY"
            : "READY_WITH_LIMITATIONS";

    return {
        generatedAt: new Date().toISOString(),
        version: "v1",
        assessment: {
            sniperStyleReadiness: sniperReadiness,
            farmerStyleReadiness: farmerReadiness,
            overallReadiness,
            notes:
                sniperReadiness === "READY"
                    ? "Sufficient pool creation and hold time coverage across cohort. Ready for empirical threshold selection."
                    : "Entry delay coverage has limitations or missing pool timestamps; inspect coverage details.",
        },
        poolCoverage: {
            uniquePools: uniquePoolList.length,
            poolCreationAvailable: poolCreationAvailableCount,
            poolCreationUnavailable: poolCreationUnavailableCount,
            poolCreationCoveragePct,
        },
        positionCoverage: {
            totalClosedPositions: totalCohortClosedPositions,
            positionsWithEntryDelay: cohortPositionsWithEntryDelay,
            entryDelayCoveragePct: cohortEntryDelayCoveragePct,
            negativeEntryDelays: cohortNegativeEntryDelays,
            walletsWithHighCoverage,
            walletsWithLowCoverage,
        },
        cohortDistributions: {
            medianEntryDelayHours: distMedianEntryDelay,
            medianHoldHours: distMedianHold,
            positionsPerPool: distPositionsPerPool,
            uniqueDlmmPools: distUniquePools,
            feesToDepositsPct: distFeesToDeposits,
        },
        sniperSupportGrid,
        farmerSupportGrid,
        wallets: scoredWallets,
    };
}

export async function main(): Promise<void> {
    const cli = parseCliArgs();

    if (!fs.existsSync(cli.datasetPath)) {
        throw new Error(`Screening dataset file not found: ${cli.datasetPath}`);
    }

    console.log("==================================================");
    console.log("V1 — WALLET STYLE READINESS DATASET GENERATION");
    console.log("==================================================");
    console.log(`Input Screening Dataset : ${cli.datasetPath}`);
    console.log(`Pool Creation Times Path: ${cli.poolCreationPath}`);
    console.log(`Output Style Readiness  : ${cli.outputPath}\n`);

    const datasetRaw = JSON.parse(fs.readFileSync(cli.datasetPath, "utf8"));
    const output = await buildStyleReadiness(datasetRaw, cli.poolCreationPath);

    atomicWriteJson(cli.outputPath, output);

    console.log(`Wallets Processed       : ${output.wallets.length}`);
    console.log(`Unique DLMM Pools       : ${output.poolCoverage.uniquePools}`);
    console.log(`Pool Creation Coverage  : ${output.poolCoverage.poolCreationCoveragePct}%`);
    console.log(`Entry Delay Coverage    : ${output.positionCoverage.entryDelayCoveragePct}%`);
    console.log(`Overall Style Readiness : ${output.assessment.overallReadiness}`);
    console.log("==================================================\n");
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("build-wallet-style-readiness.ts") ||
        process.argv[1].endsWith("build-wallet-style-readiness.js") ||
        process.argv[1].includes("build-wallet-style-readiness"));

if (isMain) {
    main().catch((err) => {
        console.error(`\n[FATAL ERROR] Style readiness generation failed: ${err?.message || err}`);
        process.exit(1);
    });
}
