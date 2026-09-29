import fs from "node:fs";
import path from "node:path";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const DEFAULT_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";

interface BinSegment {
    lowerBin: number;
    upperBin: number;
    binCount?: number;
    rangeSpanBinCount?: number;
    positiveWeightBinCount?: number;
    continuous?: boolean;
    occupiedBinIds?: number[];
    amount?: string | number;
    activeId?: number;
    binLiquidityDist?: Array<{ binId: number; weight: number }>;
    rangeSource?: string;
    instruction?: string;
    strategyType?: string | null;
}

interface MergedBinSegment {
    lowerBin: number;
    upperBin: number;
    binCount: number;
    rangeSpanBinCount?: number;
    positiveWeightBinCount?: number;
    continuous?: boolean;
    occupiedBinIds?: number[];
}

interface RemovalSegment {
    signature: string;
    timestamp: string;
    lowerBin: number;
    upperBin: number;
    binCount: number;
    bpsToRemove: number;
}

interface TimelineEntry {
    timestamp: string;
    signature: string;
    instruction: string;
    classification: string;
    activeId: number | null;
    addSegments: BinSegment[];
    removeSegments: any[];
    removalRange?: {
        lowerBin: number;
        upperBin: number;
        binCount: number;
    };
    bpsToRemove?: number;
    initializeRange?: {
        lowerBinId: number;
        width: number;
    };
    strategyType?: string | null;
}

interface OpeningBuild {
    rawSegments: BinSegment[];
    mergedSegments: MergedBinSegment[];
    lowerBin: number | null;
    upperBin: number | null;
    binCount: number | null;
    continuous?: boolean;
    addInstructionCount: number;
    startedAt: string | null;
    completedAt: string | null;
    activeIds?: number[];
}

interface StrategyDerivedOutput {
    wallet: string;
    pool: string;
    position: string;
    generatedAt: string;
    rangeAvailability: "AVAILABLE" | "NO_LIQUIDITY";
    placementSemantics: string;

    initializeMetadata: {
        lowerBinId: number;
        width: number;
    } | null;

    openingBuild: OpeningBuild;

    initialPlacement: {
        rawSegments: BinSegment[];
        mergedSegments: MergedBinSegment[];
        lowerBin: number | null;
        upperBin: number | null;
        binCount: number | null;
        continuous?: boolean;
    };

    initialLowerBin: number | null;
    initialUpperBin: number | null;
    initialBinCount: number | null;

    behaviour: {
        addOnlyInstructionCount: number;
        removeOnlyInstructionCount: number;
        trueRebalanceCount: number;
        emptyRebalanceInstructionCount: number;
    };

    addOnlyInstructionCount: number;
    removeOnlyInstructionCount: number;
    trueRebalanceCount: number;
    emptyRebalanceInstructionCount: number;

    fullRemovalSegments: RemovalSegment[];

    timeline: TimelineEntry[];
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

function validateNumber(value: unknown, name: string, context: string): number {
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
        value = Number(value);
    }
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
        throw new Error(`Missing or invalid numeric field '${name}' (${value}) in ${context}`);
    }
    return value;
}

function mergeSegments(segments: BinSegment[]): MergedBinSegment[] {
    if (segments.length === 0) {
        return [];
    }

    // Sort by lowerBin ascending, then upperBin ascending
    const sorted = [...segments].sort((a, b) => {
        if (a.lowerBin !== b.lowerBin) {
            return a.lowerBin - b.lowerBin;
        }
        return a.upperBin - b.upperBin;
    });

    const getSegmentBins = (seg: BinSegment): Set<number> => {
        if (seg.occupiedBinIds && seg.occupiedBinIds.length > 0) {
            return new Set(seg.occupiedBinIds);
        }
        const bins = new Set<number>();
        for (let b = seg.lowerBin; b <= seg.upperBin; b++) {
            bins.add(b);
        }
        return bins;
    };

    const merged: MergedBinSegment[] = [];
    let currentLower = sorted[0].lowerBin;
    let currentUpper = sorted[0].upperBin;
    let currentBins = getSegmentBins(sorted[0]);

    for (let i = 1; i < sorted.length; i++) {
        const next = sorted[i];
        // Directly adjacent (next.lowerBin === currentUpper + 1) or overlapping (next.lowerBin <= currentUpper):
        if (next.lowerBin <= currentUpper + 1) {
            currentUpper = Math.max(currentUpper, next.upperBin);
            const nextBins = getSegmentBins(next);
            for (const b of nextBins) {
                currentBins.add(b);
            }
        } else {
            const sortedBins = Array.from(currentBins).sort((a, b) => a - b);
            const span = currentUpper - currentLower + 1;
            merged.push({
                lowerBin: currentLower,
                upperBin: currentUpper,
                binCount: sortedBins.length,
                positiveWeightBinCount: sortedBins.length,
                rangeSpanBinCount: span,
                continuous: sortedBins.length === span,
                occupiedBinIds: sortedBins,
            });
            currentLower = next.lowerBin;
            currentUpper = next.upperBin;
            currentBins = getSegmentBins(next);
        }
    }

    const sortedBins = Array.from(currentBins).sort((a, b) => a - b);
    const span = currentUpper - currentLower + 1;
    merged.push({
        lowerBin: currentLower,
        upperBin: currentUpper,
        binCount: sortedBins.length,
        positiveWeightBinCount: sortedBins.length,
        rangeSpanBinCount: span,
        continuous: sortedBins.length === span,
        occupiedBinIds: sortedBins,
    });

    return merged;
}

async function main() {
    const args = parseCliArgs();

    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;
    const positionAddress =
        args.position || process.env.POSITION_ADDRESS || DEFAULT_POSITION;

    const strategyFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy",
        `${positionAddress}.json`
    );

    if (!fs.existsSync(strategyFilePath)) {
        throw new Error(
            `Decoded strategy file not found: ${strategyFilePath}. Run waldisc-2-decode-one-position-strategy first.`
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

    const poolAddress = strategyData.pool;
    if (!poolAddress) {
        throw new Error(
            `Pool address missing in strategy file: ${strategyFilePath}`
        );
    }

    const rawInstructions = Array.isArray(strategyData.instructions)
        ? strategyData.instructions
        : [];

    let initializeMetadata: { lowerBinId: number; width: number } | null = null;
    let addOnlyInstructionCount = 0;
    let removeOnlyInstructionCount = 0;
    let trueRebalanceCount = 0;
    let emptyRebalanceInstructionCount = 0;

    const timeline: TimelineEntry[] = [];
    const fullRemovalSegments: RemovalSegment[] = [];

    // Opening build phase tracking:
    // Consists of all add-only liquidity segments from the beginning of the position
    // until the first liquidity-removing mutation.
    let inOpeningBuildPhase = true;
    const openingBuildRawSegments: BinSegment[] = [];
    const openingBuildActiveIds: number[] = [];
    let openingBuildAddInstructionCount = 0;
    let openingBuildStartedAt: string | null = null;
    let openingBuildCompletedAt: string | null = null;

    for (const ix of rawInstructions) {
        const signature = String(ix.signature || "").trim();
        const timestamp = String(ix.createdAt || "").trim();
        const instructionName = String(ix.instruction || "").trim();
        const decodedArgs = ix.decodedArgs || {};

        if (instructionName.startsWith("initialize_position")) {
            const lowerBinId = validateNumber(
                decodedArgs.lower_bin_id,
                "lower_bin_id",
                `initialize_position in tx ${signature}`
            );
            const width = validateNumber(
                decodedArgs.width,
                "width",
                `initialize_position in tx ${signature}`
            );

            initializeMetadata = {
                lowerBinId,
                width,
            };

            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "initialize",
                activeId: null,
                addSegments: [],
                removeSegments: [],
                initializeRange: {
                    lowerBinId,
                    width,
                },
            });
            continue;
        }

        if (instructionName === "rebalance_liquidity") {
            const params = decodedArgs.params;
            if (!params) {
                throw new Error(
                    `Missing 'params' in rebalance_liquidity decodedArgs in tx ${signature}`
                );
            }

            const activeId = validateNumber(
                params.active_id,
                "active_id",
                `rebalance_liquidity in tx ${signature}`
            );

            const rawAdds = Array.isArray(params.adds) ? params.adds : [];
            const rawRemoves = Array.isArray(params.removes) ? params.removes : [];

            // 1. Classify rebalance behaviour
            let classification: "add_only" | "remove_only" | "range_rebalance" | "empty";
            if (rawAdds.length > 0 && rawRemoves.length === 0) {
                classification = "add_only";
                addOnlyInstructionCount++;
            } else if (rawRemoves.length > 0 && rawAdds.length === 0) {
                classification = "remove_only";
                removeOnlyInstructionCount++;
            } else if (rawAdds.length > 0 && rawRemoves.length > 0) {
                classification = "range_rebalance";
                trueRebalanceCount++;
            } else {
                classification = "empty";
                emptyRebalanceInstructionCount++;
            }

            // 2. Decode absolute add segments
            const addSegments: BinSegment[] = [];
            for (const add of rawAdds) {
                const minDeltaId = validateNumber(
                    add.min_delta_id,
                    "min_delta_id",
                    `rebalance_liquidity add segment in tx ${signature}`
                );
                const maxDeltaId = validateNumber(
                    add.max_delta_id,
                    "max_delta_id",
                    `rebalance_liquidity add segment in tx ${signature}`
                );

                const absoluteLowerBin = activeId + minDeltaId;
                const absoluteUpperBin = activeId + maxDeltaId;

                if (absoluteLowerBin > absoluteUpperBin) {
                    throw new Error(
                        `Invalid add range: lowerBin (${absoluteLowerBin}) > upperBin (${absoluteUpperBin}) in tx ${signature}`
                    );
                }

                addSegments.push({
                    lowerBin: absoluteLowerBin,
                    upperBin: absoluteUpperBin,
                });
            }

            // 3. Decode absolute remove segments
            const removeSegments: any[] = [];
            for (const rem of rawRemoves) {
                if (
                    rem.min_bin_id !== undefined &&
                    rem.min_bin_id !== null &&
                    rem.max_bin_id !== undefined &&
                    rem.max_bin_id !== null
                ) {
                    const minBin = validateNumber(
                        rem.min_bin_id,
                        "min_bin_id",
                        `rebalance_liquidity remove segment in tx ${signature}`
                    );
                    const maxBin = validateNumber(
                        rem.max_bin_id,
                        "max_bin_id",
                        `rebalance_liquidity remove segment in tx ${signature}`
                    );

                    if (minBin > maxBin) {
                        throw new Error(
                            `Invalid remove range: min_bin_id (${minBin}) > max_bin_id (${maxBin}) in tx ${signature}`
                        );
                    }

                    removeSegments.push({
                        lowerBin: minBin,
                        upperBin: maxBin,
                        binCount: maxBin - minBin + 1,
                        bps: rem.bps,
                    });
                }
            }

            if (classification === "remove_only" || classification === "range_rebalance") {
                inOpeningBuildPhase = false;
            } else if (classification === "add_only") {
                if (inOpeningBuildPhase) {
                    openingBuildRawSegments.push(...addSegments);
                    openingBuildAddInstructionCount++;
                    if (!openingBuildStartedAt && timestamp) {
                        openingBuildStartedAt = timestamp;
                    }
                    if (timestamp) {
                        openingBuildCompletedAt = timestamp;
                    }
                    openingBuildActiveIds.push(activeId);
                }
            }

            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification,
                activeId,
                addSegments,
                removeSegments,
            });
            continue;
        }

        if (instructionName === "add_liquidity_by_strategy2") {
            const lpParam = decodedArgs.liquidity_parameter;
            if (!lpParam || typeof lpParam !== "object") {
                throw new Error(
                    `Missing 'liquidity_parameter' in add_liquidity_by_strategy2 decodedArgs in tx ${signature}`
                );
            }

            const stratParams = lpParam.strategy_parameters;
            if (!stratParams || typeof stratParams !== "object") {
                throw new Error(
                    `Missing 'strategy_parameters' in add_liquidity_by_strategy2 decodedArgs in tx ${signature}`
                );
            }

            const activeId = validateNumber(
                lpParam.active_id,
                "active_id",
                `add_liquidity_by_strategy2 in tx ${signature}`
            );
            const lowerBin = validateNumber(
                stratParams.min_bin_id,
                "min_bin_id",
                `add_liquidity_by_strategy2 in tx ${signature}`
            );
            const upperBin = validateNumber(
                stratParams.max_bin_id,
                "max_bin_id",
                `add_liquidity_by_strategy2 in tx ${signature}`
            );

            if (lowerBin > upperBin) {
                throw new Error(
                    `Invalid strategy range: min_bin_id (${lowerBin}) > max_bin_id (${upperBin}) in tx ${signature}`
                );
            }

            let strategyType: string | null = null;
            const rawStrategyType = stratParams.strategy_type;
            if (typeof rawStrategyType === "string") {
                strategyType = rawStrategyType;
            } else if (rawStrategyType && typeof rawStrategyType === "object") {
                const keys = Object.keys(rawStrategyType);
                if (keys.length > 0) {
                    strategyType = keys[0];
                }
            }

            const segment: BinSegment = {
                lowerBin,
                upperBin,
                rangeSource: "strategy_parameters",
                instruction: "add_liquidity_by_strategy2",
                strategyType,
            };

            const addSegments: BinSegment[] = [segment];
            addOnlyInstructionCount++;

            if (inOpeningBuildPhase) {
                openingBuildRawSegments.push(segment);
                openingBuildAddInstructionCount++;
                if (!openingBuildStartedAt && timestamp) {
                    openingBuildStartedAt = timestamp;
                }
                if (timestamp) {
                    openingBuildCompletedAt = timestamp;
                }
                openingBuildActiveIds.push(activeId);
            }

            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "add_only",
                activeId,
                addSegments,
                removeSegments: [],
                strategyType,
            });
            continue;
        }

        if (instructionName === "add_liquidity_one_side") {
            const lpParam = decodedArgs.liquidity_parameter;
            if (!lpParam || typeof lpParam !== "object") {
                throw new Error(
                    `Missing 'liquidity_parameter' in add_liquidity_one_side decodedArgs in tx ${signature}`
                );
            }

            const activeId = validateNumber(
                lpParam.active_id,
                "active_id",
                `add_liquidity_one_side in tx ${signature}`
            );

            const dist = lpParam.bin_liquidity_dist;
            if (!Array.isArray(dist) || dist.length === 0) {
                throw new Error(
                    `Missing or empty 'bin_liquidity_dist' in add_liquidity_one_side in tx ${signature}`
                );
            }

            const binWeightMap = new Map<number, number>();
            for (let idx = 0; idx < dist.length; idx++) {
                const entry = dist[idx];
                if (!entry || typeof entry !== "object") {
                    throw new Error(
                        `Invalid entry at index ${idx} in bin_liquidity_dist in tx ${signature}`
                    );
                }
                const binId = validateNumber(
                    entry.bin_id,
                    `bin_liquidity_dist[${idx}].bin_id`,
                    `add_liquidity_one_side in tx ${signature}`
                );
                const weight = validateNumber(
                    entry.weight,
                    `bin_liquidity_dist[${idx}].weight`,
                    `add_liquidity_one_side in tx ${signature}`
                );

                if (weight > 0) {
                    if (binWeightMap.has(binId)) {
                        const existingWeight = binWeightMap.get(binId)!;
                        if (existingWeight !== weight) {
                            throw new Error(
                                `Conflicting duplicate bin_id ${binId} with weights ${existingWeight} and ${weight} in tx ${signature}`
                            );
                        }
                    } else {
                        binWeightMap.set(binId, weight);
                    }
                }
            }

            const positiveBinIds = Array.from(binWeightMap.keys()).sort(
                (a, b) => a - b
            );
            if (positiveBinIds.length === 0) {
                throw new Error(
                    `No positive weight entries found in bin_liquidity_dist in tx ${signature}`
                );
            }

            const lowerBin = positiveBinIds[0];
            const upperBin = positiveBinIds[positiveBinIds.length - 1];
            const positiveWeightBinCount = positiveBinIds.length;
            const rangeSpanBinCount = upperBin - lowerBin + 1;
            const continuous = positiveWeightBinCount === rangeSpanBinCount;

            const binLiquidityDist = positiveBinIds.map((binId) => ({
                binId,
                weight: binWeightMap.get(binId)!,
            }));

            const segment: BinSegment = {
                lowerBin,
                upperBin,
                binCount: positiveWeightBinCount,
                rangeSpanBinCount,
                positiveWeightBinCount,
                continuous,
                occupiedBinIds: positiveBinIds,
                rangeSource: "bin_liquidity_dist",
                instruction: "add_liquidity_one_side",
                amount: lpParam.amount,
                activeId,
                binLiquidityDist,
            };

            const addSegments: BinSegment[] = [segment];
            addOnlyInstructionCount++;

            if (inOpeningBuildPhase) {
                openingBuildRawSegments.push(segment);
                openingBuildAddInstructionCount++;
                if (!openingBuildStartedAt && timestamp) {
                    openingBuildStartedAt = timestamp;
                }
                if (timestamp) {
                    openingBuildCompletedAt = timestamp;
                }
                openingBuildActiveIds.push(activeId);
            }

            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "add_only",
                activeId,
                addSegments,
                removeSegments: [],
            });
            continue;
        }

        if (instructionName === "remove_liquidity_by_range2" || instructionName.startsWith("remove_liquidity")) {
            inOpeningBuildPhase = false;
            const fromBinId = validateNumber(
                decodedArgs.from_bin_id,
                "from_bin_id",
                `remove_liquidity_by_range2 in tx ${signature}`
            );
            const toBinId = validateNumber(
                decodedArgs.to_bin_id,
                "to_bin_id",
                `remove_liquidity_by_range2 in tx ${signature}`
            );
            const bpsToRemove = validateNumber(
                decodedArgs.bps_to_remove,
                "bps_to_remove",
                `remove_liquidity_by_range2 in tx ${signature}`
            );

            if (fromBinId > toBinId) {
                throw new Error(
                    `Invalid range: from_bin_id (${fromBinId}) > to_bin_id (${toBinId}) in tx ${signature}`
                );
            }

            const binCount = toBinId - fromBinId + 1;
            const removalRange = {
                lowerBin: fromBinId,
                upperBin: toBinId,
                binCount,
            };

            fullRemovalSegments.push({
                signature,
                timestamp,
                lowerBin: fromBinId,
                upperBin: toBinId,
                binCount,
                bpsToRemove,
            });

            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "remove",
                activeId: null,
                addSegments: [],
                removeSegments: [
                    {
                        lowerBin: fromBinId,
                        upperBin: toBinId,
                        binCount,
                        bpsToRemove,
                    },
                ],
                removalRange,
                bpsToRemove,
            });
            continue;
        }

        if (instructionName.startsWith("claim_fee")) {
            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "claim_fee",
                activeId: null,
                addSegments: [],
                removeSegments: [],
            });
            continue;
        }

        if (instructionName.startsWith("close_position")) {
            timeline.push({
                timestamp,
                signature,
                instruction: instructionName,
                classification: "close",
                activeId: null,
                addSegments: [],
                removeSegments: [],
            });
            continue;
        }

        // Generic fallback for any other instructions
        timeline.push({
            timestamp,
            signature,
            instruction: instructionName,
            classification: ix.category || "unknown",
            activeId: null,
            addSegments: [],
            removeSegments: [],
        });
    }

    // 4. Derive opening-build and initial occupied range
    const openingBuildMergedSegments = mergeSegments(openingBuildRawSegments);
    let openingLowerBin: number | null = null;
    let openingUpperBin: number | null = null;
    let openingBinCount: number | null = null;

    if (openingBuildMergedSegments.length > 0) {
        openingLowerBin = openingBuildMergedSegments[0].lowerBin;
        openingUpperBin =
            openingBuildMergedSegments[
                openingBuildMergedSegments.length - 1
            ].upperBin;

        if (openingBuildMergedSegments.length === 1) {
            openingBinCount = openingBuildMergedSegments[0].binCount;
        } else {
            openingBinCount = openingBuildMergedSegments.reduce(
                (sum, s) => sum + s.binCount,
                0
            );
        }
    }

    const isContinuousBool =
        openingBuildMergedSegments.length === 1 &&
        openingBuildMergedSegments[0].continuous !== false &&
        openingBuildMergedSegments[0].binCount ===
            openingBuildMergedSegments[0].upperBin -
                openingBuildMergedSegments[0].lowerBin +
                1;

    const openingBuild: OpeningBuild = {
        rawSegments: openingBuildRawSegments,
        mergedSegments: openingBuildMergedSegments,
        lowerBin: openingLowerBin,
        upperBin: openingUpperBin,
        binCount: openingBinCount,
        continuous: isContinuousBool,
        addInstructionCount: openingBuildAddInstructionCount,
        startedAt: openingBuildStartedAt,
        completedAt: openingBuildCompletedAt,
        activeIds: Array.from(new Set(openingBuildActiveIds)),
    };

    const initialPlacement = {
        rawSegments: openingBuildRawSegments,
        mergedSegments: openingBuildMergedSegments,
        lowerBin: openingLowerBin,
        upperBin: openingUpperBin,
        binCount: openingBinCount,
        continuous: isContinuousBool,
    };

    const initialLowerBin = openingLowerBin;
    const initialUpperBin = openingUpperBin;
    const initialBinCount = openingBinCount;

    const behaviour = {
        addOnlyInstructionCount,
        removeOnlyInstructionCount,
        trueRebalanceCount,
        emptyRebalanceInstructionCount,
    };

    const isNoLiquidity =
        openingBuildRawSegments.length === 0 &&
        openingLowerBin === null &&
        openingUpperBin === null;
    const rangeAvailability: "AVAILABLE" | "NO_LIQUIDITY" = isNoLiquidity
        ? "NO_LIQUIDITY"
        : "AVAILABLE";

    const outputData: StrategyDerivedOutput = {
        wallet: walletAddress,
        pool: poolAddress,
        position: positionAddress,
        generatedAt: new Date().toISOString(),
        rangeAvailability,
        placementSemantics:
            "all_add_only_segments_before_first_liquidity_removal",

        initializeMetadata,

        openingBuild,
        initialPlacement,

        initialLowerBin,
        initialUpperBin,
        initialBinCount,

        behaviour,

        addOnlyInstructionCount,
        removeOnlyInstructionCount,
        trueRebalanceCount,
        emptyRebalanceInstructionCount,

        fullRemovalSegments,

        timeline,
    };

    // 5. Write output JSON
    const outputFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy-derived",
        `${positionAddress}.json`
    );

    atomicWriteJson(outputFilePath, outputData);

    // 6. Terminal Summary
    const isContinuous = isContinuousBool ? "YES" : "NO";

    console.log("========================================");
    console.log("WALDISC-2 STEP 1C.2 — POSITION RANGE & REBALANCE EXTRACTION");
    console.log("========================================");
    console.log(`Wallet              : ${walletAddress}`);
    console.log(`Pool                : ${poolAddress}`);
    console.log(`Position            : ${positionAddress}`);
    if (initializeMetadata) {
        console.log(
            `Init Metadata Range : [${initializeMetadata.lowerBinId}, ${
                initializeMetadata.lowerBinId + initializeMetadata.width - 1
            }] (width: ${initializeMetadata.width})`
        );
    }
    console.log(
        `Opening Build Range : [${openingLowerBin}, ${openingUpperBin}] (bins: ${openingBinCount}, ixs: ${openingBuildAddInstructionCount})`
    );
    console.log(
        `Initial Placement   : [${initialLowerBin}, ${initialUpperBin}] (bins: ${initialBinCount})`
    );
    console.log(`Placement Semantics : all_add_only_segments_before_first_liquidity_removal`);
    console.log(`Range Availability  : ${rangeAvailability}`);
    console.log(`Continuous Range    : ${isContinuous}`);
    console.log(`Add-only Ixs        : ${addOnlyInstructionCount}`);
    console.log(`Remove-only Ixs     : ${removeOnlyInstructionCount}`);
    console.log(`True Rebalance Ixs  : ${trueRebalanceCount}`);
    console.log(`Empty Rebalance Ixs : ${emptyRebalanceInstructionCount}`);
    console.log(`Removal Segments    : ${fullRemovalSegments.length}`);
    console.log(`Output File         : ${outputFilePath}`);
    console.log("========================================\n");

    console.table(
        timeline.map((item) => {
            let details = "-";
            if (item.instruction === "initialize_position" && item.initializeRange) {
                details = `lower: ${item.initializeRange.lowerBinId}, width: ${item.initializeRange.width}`;
            } else if (item.instruction === "rebalance_liquidity") {
                if (item.addSegments.length > 0) {
                    details = `adds: ${item.addSegments
                        .map((s) => `[${s.lowerBin}, ${s.upperBin}]`)
                        .join(", ")}`;
                } else if (item.removeSegments.length > 0) {
                    details = `removes: ${item.removeSegments
                        .map((s) => `[${s.lowerBin}, ${s.upperBin}]`)
                        .join(", ")}`;
                } else {
                    details = "empty";
                }
            } else if (item.instruction === "add_liquidity_by_strategy2") {
                if (item.addSegments.length > 0) {
                    const seg = item.addSegments[0];
                    details = `add: [${seg.lowerBin}, ${seg.upperBin}] (${seg.upperBin - seg.lowerBin + 1} bins)`;
                }
            } else if (item.instruction === "add_liquidity_one_side") {
                if (item.addSegments.length > 0) {
                    const seg = item.addSegments[0];
                    const count = seg.binCount ?? (seg.upperBin - seg.lowerBin + 1);
                    details = `add: [${seg.lowerBin}, ${seg.upperBin}] (${count} bins)`;
                }
            } else if (
                item.instruction === "remove_liquidity_by_range2" &&
                item.removalRange
            ) {
                details = `remove: [${item.removalRange.lowerBin}, ${item.removalRange.upperBin}] (${item.bpsToRemove} bps)`;
            }

            return {
                timestamp: item.timestamp,
                instruction: item.instruction,
                classification: item.classification,
                activeId: item.activeId !== null ? item.activeId : "-",
                details,
                signature: `${item.signature.slice(0, 8)}...${item.signature.slice(-8)}`,
            };
        })
    );
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Strategy range extraction failed: ${err.message}`);
    process.exit(1);
});
