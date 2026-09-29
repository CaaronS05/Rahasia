import fs from "node:fs";
import path from "node:path";

const DEFAULT_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
const DEFAULT_POSITION = "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc";

interface PoolMetadata {
    binStep: number;
    tokenXDecimals?: number;
    tokenYDecimals?: number;
    tokenXSymbol?: string;
    tokenYSymbol?: string;
    source: string;
}

interface StrategyNormalizedOutput {
    wallet: string;
    pool: string;
    position: string;
    generatedAt: string;
    rangeAvailability: "AVAILABLE" | "NO_LIQUIDITY";
    placementSemantics?: string;

    binStep: number;

    range: {
        lowerBin: number | null;
        upperBin: number | null;
        binCount: number | null;

        lowerPricePerLamport: string | null;
        upperPricePerLamport: string | null;

        priceRatio: string | null;
        rangeWidthPct: string | null;
    };

    placementContext: {
        activeBinAtPlacement: number | null;
        conflictingActiveBins?: number[];
        lowerDistanceBins: number | null;
        upperDistanceBins: number | null;
        placementFraction?: number | null;
    };

    decimalAdjustedPrice: {
        tokenXSymbol: string;
        tokenYSymbol: string;
        tokenXDecimals: number;
        tokenYDecimals: number;
        decimalMultiplier: string;
        lowerPrice: string | null;
        upperPrice: string | null;
        priceQuote: string;
    } | null;

    behaviour?: {
        addOnlyInstructionCount: number;
        removeOnlyInstructionCount: number;
        trueRebalanceCount: number;
        emptyRebalanceInstructionCount: number;
    };

    addOnlyInstructionCount?: number;
    removeOnlyInstructionCount?: number;
    trueRebalanceCount?: number;
    emptyRebalanceInstructionCount?: number;
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

function resolvePoolMetadata(
    poolAddress: string,
    walletAddress: string,
    customPath?: string
): PoolMetadata {
    // 1. Try legacy-dlmm-pools.json (or custom path)
    const primaryPath = customPath
        ? path.resolve(customPath)
        : path.resolve("data/pools/legacy-dlmm-pools.json");

    if (fs.existsSync(primaryPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(primaryPath, "utf8"));
            const pools = Array.isArray(raw?.pools) ? raw.pools : [];
            const found = pools.find(
                (p: any) => p.address === poolAddress || p.id === poolAddress
            );

            if (found) {
                const binStep = Number(found.binStep);
                if (Number.isFinite(binStep) && binStep > 0) {
                    return {
                        binStep,
                        tokenXDecimals: found.tokenX?.decimals,
                        tokenYDecimals: found.tokenY?.decimals,
                        tokenXSymbol: found.tokenX?.symbol,
                        tokenYSymbol: found.tokenY?.symbol,
                        source: primaryPath,
                    };
                }
            }
        } catch {
            // fallback
        }
    }

    // 2. Try local discovery pool metadata: data/discovery/waldisc-2/<WALLET>/pools.json
    const walletPoolsPath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "pools.json"
    );

    if (fs.existsSync(walletPoolsPath)) {
        try {
            const raw = JSON.parse(fs.readFileSync(walletPoolsPath, "utf8"));
            const poolRows = Array.isArray(raw) ? raw : [];
            const found = poolRows.find(
                (p: any) =>
                    p.pool_id === poolAddress ||
                    p.pool?.id === poolAddress ||
                    p.id === poolAddress
            );

            if (found) {
                let binStep: number | null = null;
                if (Number.isFinite(Number(found.parsedParams?.binStep))) {
                    binStep = Number(found.parsedParams.binStep);
                } else if (found.pool?.params) {
                    try {
                        const parsed =
                            typeof found.pool.params === "string"
                                ? JSON.parse(found.pool.params)
                                : found.pool.params;
                        if (Number.isFinite(Number(parsed?.binStep))) {
                            binStep = Number(parsed.binStep);
                        }
                    } catch {}
                }

                if (binStep !== null && binStep > 0) {
                    return {
                        binStep,
                        tokenXDecimals: found.pool?.tokenX?.decimals,
                        tokenYDecimals: found.pool?.tokenY?.decimals,
                        tokenXSymbol: found.pool?.tokenX?.symbol,
                        tokenYSymbol: found.pool?.tokenY?.symbol,
                        source: walletPoolsPath,
                    };
                }
            }
        } catch {
            // error
        }
    }

    throw new Error(
        `Pool '${poolAddress}' not found with valid binStep in ${primaryPath} or ${walletPoolsPath}.`
    );
}

async function main() {
    const args = parseCliArgs();

    const walletAddress =
        args.wallet || process.env.WALLET_ADDRESS || DEFAULT_WALLET;
    const positionAddress =
        args.position || process.env.POSITION_ADDRESS || DEFAULT_POSITION;
    const customPoolMetaPath = args["pool-metadata"] || process.env.POOL_METADATA_PATH;

    // 1. Read strategy-derived position JSON
    const derivedFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy-derived",
        `${positionAddress}.json`
    );

    if (!fs.existsSync(derivedFilePath)) {
        throw new Error(
            `Strategy-derived file not found: ${derivedFilePath}. Run waldisc-2-build-one-position-range first.`
        );
    }

    let derivedData: any;
    try {
        const rawContent = fs.readFileSync(derivedFilePath, "utf8");
        derivedData = JSON.parse(rawContent);
    } catch (err: any) {
        throw new Error(
            `Failed to parse strategy-derived file ${derivedFilePath}: ${err.message}`
        );
    }

    const poolAddress = derivedData.pool;
    if (!poolAddress) {
        throw new Error(
            `Pool address missing from strategy-derived file: ${derivedFilePath}`
        );
    }

    const initialPlacement = derivedData.openingBuild || derivedData.initialPlacement;
    if (!initialPlacement && derivedData.rangeAvailability !== "NO_LIQUIDITY") {
        throw new Error(
            `openingBuild or initialPlacement missing from strategy-derived file: ${derivedFilePath}`
        );
    }

    // 2. Resolve pool metadata and binStep
    const poolMeta = resolvePoolMetadata(poolAddress, walletAddress, customPoolMetaPath);
    const binStep = poolMeta.binStep;

    if (!Number.isFinite(binStep) || binStep <= 0) {
        throw new Error(
            `Missing or invalid binStep for pool ${poolAddress}: ${binStep}`
        );
    }

    const isNoLiquidity =
        derivedData.rangeAvailability === "NO_LIQUIDITY" ||
        (!initialPlacement) ||
        (initialPlacement.lowerBin === null &&
            initialPlacement.upperBin === null &&
            (initialPlacement.binCount === null || initialPlacement.binCount === 0 || initialPlacement.binCount === undefined));

    if (isNoLiquidity) {
        let decimalAdjustedPrice: StrategyNormalizedOutput["decimalAdjustedPrice"] = null;

        if (
            typeof poolMeta.tokenXDecimals === "number" &&
            typeof poolMeta.tokenYDecimals === "number"
        ) {
            const diff = poolMeta.tokenXDecimals - poolMeta.tokenYDecimals;
            const decimalMultiplier = Math.pow(10, diff);
            const tokenXSymbol = poolMeta.tokenXSymbol || "TokenX";
            const tokenYSymbol = poolMeta.tokenYSymbol || "TokenY";

            decimalAdjustedPrice = {
                tokenXSymbol,
                tokenYSymbol,
                tokenXDecimals: poolMeta.tokenXDecimals,
                tokenYDecimals: poolMeta.tokenYDecimals,
                decimalMultiplier: decimalMultiplier.toString(),
                lowerPrice: null,
                upperPrice: null,
                priceQuote: `${tokenYSymbol} per ${tokenXSymbol}`,
            };
        }

        const outputData: StrategyNormalizedOutput = {
            wallet: walletAddress,
            pool: poolAddress,
            position: positionAddress,
            generatedAt: new Date().toISOString(),
            rangeAvailability: "NO_LIQUIDITY",
            ...(derivedData.placementSemantics
                ? { placementSemantics: derivedData.placementSemantics }
                : {}),

            binStep,

            range: {
                lowerBin: null,
                upperBin: null,
                binCount: null,

                lowerPricePerLamport: null,
                upperPricePerLamport: null,

                priceRatio: null,
                rangeWidthPct: null,
            },

            placementContext: {
                activeBinAtPlacement: null,
                lowerDistanceBins: null,
                upperDistanceBins: null,
                placementFraction: null,
            },

            decimalAdjustedPrice,

            behaviour: derivedData.behaviour || {
                addOnlyInstructionCount: Number(derivedData.addOnlyInstructionCount ?? 0),
                removeOnlyInstructionCount: Number(derivedData.removeOnlyInstructionCount ?? 0),
                trueRebalanceCount: Number(derivedData.trueRebalanceCount ?? 0),
                emptyRebalanceInstructionCount: Number(derivedData.emptyRebalanceInstructionCount ?? 0),
            },
            addOnlyInstructionCount: Number(
                derivedData.addOnlyInstructionCount ?? derivedData.behaviour?.addOnlyInstructionCount ?? 0
            ),
            removeOnlyInstructionCount: Number(
                derivedData.removeOnlyInstructionCount ?? derivedData.behaviour?.removeOnlyInstructionCount ?? 0
            ),
            trueRebalanceCount: Number(
                derivedData.trueRebalanceCount ?? derivedData.behaviour?.trueRebalanceCount ?? 0
            ),
            emptyRebalanceInstructionCount: Number(
                derivedData.emptyRebalanceInstructionCount ?? derivedData.behaviour?.emptyRebalanceInstructionCount ?? 0
            ),
        };

        const outputFilePath = path.resolve(
            "data/discovery/waldisc-2",
            walletAddress,
            "strategy-normalized",
            `${positionAddress}.json`
        );

        atomicWriteJson(outputFilePath, outputData);

        console.log("========================================");
        console.log("WALDISC-2 STEP 1C.3 — NORMALIZED PRICE RANGE");
        console.log("========================================");
        console.log(`Wallet                  : ${walletAddress}`);
        console.log(`Pool                    : ${poolAddress}`);
        console.log(`Position                : ${positionAddress}`);
        console.log(`Bin Step                : ${binStep} (${(binStep / 100).toFixed(2)}%)`);
        console.log(`Range Availability      : NO_LIQUIDITY`);
        console.log(`Occupied Bin Range      : null`);
        console.log(`Output File             : ${outputFilePath}`);
        console.log("========================================\n");
        return;
    }

    if (
        initialPlacement.lowerBin === null ||
        initialPlacement.upperBin === null ||
        initialPlacement.binCount === null ||
        typeof initialPlacement.lowerBin !== "number" ||
        typeof initialPlacement.upperBin !== "number" ||
        typeof initialPlacement.binCount !== "number" ||
        !Number.isFinite(initialPlacement.lowerBin) ||
        !Number.isFinite(initialPlacement.upperBin) ||
        !Number.isFinite(initialPlacement.binCount)
    ) {
        throw new Error(
            `Invalid bin range values in initialPlacement: lowerBin=${initialPlacement.lowerBin}, upperBin=${initialPlacement.upperBin}, binCount=${initialPlacement.binCount}`
        );
    }

    const lowerBin = initialPlacement.lowerBin;
    const upperBin = initialPlacement.upperBin;
    const binCount = initialPlacement.binCount;

    if (lowerBin > upperBin) {
        throw new Error(
            `Invalid range: lowerBin (${lowerBin}) > upperBin (${upperBin})`
        );
    }

    const expectedBinCount = upperBin - lowerBin + 1;
    if (binCount !== expectedBinCount) {
        throw new Error(
            `Invalid binCount: ${binCount} !== upperBin - lowerBin + 1 (${expectedBinCount})`
        );
    }

    // 3. Compute Meteora Price Per Lamport
    // Formula: pricePerLamport(binId) = (1 + binStep / 10000) ^ binId
    const base = 1 + binStep / 10000;
    const lowerPricePerLamport = Math.pow(base, lowerBin);
    const upperPricePerLamport = Math.pow(base, upperBin);

    if (!Number.isFinite(lowerPricePerLamport) || lowerPricePerLamport <= 0) {
        throw new Error(
            `Calculated lowerPricePerLamport is non-finite or non-positive: ${lowerPricePerLamport}`
        );
    }

    if (!Number.isFinite(upperPricePerLamport) || upperPricePerLamport <= 0) {
        throw new Error(
            `Calculated upperPricePerLamport is non-finite or non-positive: ${upperPricePerLamport}`
        );
    }

    const priceRatio = upperPricePerLamport / lowerPricePerLamport;
    if (!Number.isFinite(priceRatio) || priceRatio < 1) {
        throw new Error(
            `Calculated priceRatio is invalid: ${priceRatio} (must be >= 1)`
        );
    }

    const rangeWidthPct = (priceRatio - 1) * 100;
    if (!Number.isFinite(rangeWidthPct) || rangeWidthPct < 0) {
        throw new Error(
            `Calculated rangeWidthPct is invalid: ${rangeWidthPct} (must be >= 0)`
        );
    }

    // 4. Inspect active bin relation at placement
    let activeIds: number[] = [];
    if (
        derivedData.openingBuild &&
        Array.isArray(derivedData.openingBuild.activeIds) &&
        derivedData.openingBuild.activeIds.length > 0
    ) {
        activeIds = derivedData.openingBuild.activeIds;
    } else {
        const timeline = Array.isArray(derivedData.timeline) ? derivedData.timeline : [];
        const initialAddIxs: any[] = [];
        for (const item of timeline) {
            if (
                item.classification === "remove" ||
                item.classification === "remove_only" ||
                item.classification === "range_rebalance" ||
                item.instruction === "remove_liquidity_by_range2"
            ) {
                break;
            }
            if (
                item.classification === "add_only" &&
                item.activeId !== null &&
                item.activeId !== undefined
            ) {
                initialAddIxs.push(item);
            }
        }
        activeIds = Array.from(
            new Set(initialAddIxs.map((item: any) => Number(item.activeId)))
        );
    }

    let activeBinAtPlacement: number | null = null;
    let conflictingActiveBins: number[] | undefined = undefined;
    let lowerDistanceBins: number | null = null;
    let upperDistanceBins: number | null = null;

    if (activeIds.length === 1) {
        activeBinAtPlacement = activeIds[0];
        lowerDistanceBins = activeBinAtPlacement - lowerBin;
        upperDistanceBins = upperBin - activeBinAtPlacement;
    } else if (activeIds.length > 1) {
        conflictingActiveBins = activeIds;
    }

    // 5. Compute Decimal-Adjusted Token Price if token decimals are available
    let decimalAdjustedPrice: StrategyNormalizedOutput["decimalAdjustedPrice"] = null;

    if (
        typeof poolMeta.tokenXDecimals === "number" &&
        typeof poolMeta.tokenYDecimals === "number"
    ) {
        const diff = poolMeta.tokenXDecimals - poolMeta.tokenYDecimals;
        const decimalMultiplier = Math.pow(10, diff);
        const lowerPrice = lowerPricePerLamport * decimalMultiplier;
        const upperPrice = upperPricePerLamport * decimalMultiplier;

        const tokenXSymbol = poolMeta.tokenXSymbol || "TokenX";
        const tokenYSymbol = poolMeta.tokenYSymbol || "TokenY";

        decimalAdjustedPrice = {
            tokenXSymbol,
            tokenYSymbol,
            tokenXDecimals: poolMeta.tokenXDecimals,
            tokenYDecimals: poolMeta.tokenYDecimals,
            decimalMultiplier: decimalMultiplier.toString(),
            lowerPrice: lowerPrice.toString(),
            upperPrice: upperPrice.toString(),
            priceQuote: `${tokenYSymbol} per ${tokenXSymbol}`,
        };
    }

    // 6. Build normalized output
    const outputData: StrategyNormalizedOutput = {
        wallet: walletAddress,
        pool: poolAddress,
        position: positionAddress,
        generatedAt: new Date().toISOString(),
        rangeAvailability: derivedData.rangeAvailability || "AVAILABLE",
        ...(derivedData.placementSemantics
            ? { placementSemantics: derivedData.placementSemantics }
            : {}),

        binStep,

        range: {
            lowerBin,
            upperBin,
            binCount,

            lowerPricePerLamport: lowerPricePerLamport.toString(),
            upperPricePerLamport: upperPricePerLamport.toString(),

            priceRatio: priceRatio.toString(),
            rangeWidthPct: rangeWidthPct.toString(),
        },

        placementContext: {
            activeBinAtPlacement,
            ...(conflictingActiveBins ? { conflictingActiveBins } : {}),
            lowerDistanceBins,
            upperDistanceBins,
        },

        decimalAdjustedPrice,

        ...(derivedData.behaviour ? { behaviour: derivedData.behaviour } : {}),
        ...(derivedData.addOnlyInstructionCount !== undefined ? { addOnlyInstructionCount: derivedData.addOnlyInstructionCount } : {}),
        ...(derivedData.removeOnlyInstructionCount !== undefined ? { removeOnlyInstructionCount: derivedData.removeOnlyInstructionCount } : {}),
        ...(derivedData.trueRebalanceCount !== undefined ? { trueRebalanceCount: derivedData.trueRebalanceCount } : {}),
        ...(derivedData.emptyRebalanceInstructionCount !== undefined ? { emptyRebalanceInstructionCount: derivedData.emptyRebalanceInstructionCount } : {}),
    };

    // 7. Write output JSON
    const outputFilePath = path.resolve(
        "data/discovery/waldisc-2",
        walletAddress,
        "strategy-normalized",
        `${positionAddress}.json`
    );

    atomicWriteJson(outputFilePath, outputData);

    // 8. Terminal Summary
    console.log("========================================");
    console.log("WALDISC-2 STEP 1C.3 — NORMALIZED PRICE RANGE");
    console.log("========================================");
    console.log(`Wallet                  : ${walletAddress}`);
    console.log(`Pool                    : ${poolAddress}`);
    console.log(`Position                : ${positionAddress}`);
    console.log(`Bin Step                : ${binStep} (${(binStep / 100).toFixed(2)}%)`);
    console.log(`Range Availability      : ${outputData.rangeAvailability}`);
    console.log(`Occupied Bin Range      : [${lowerBin}, ${upperBin}] (${binCount} bins)`);
    console.log(
        `Active Bin At Placement : ${activeBinAtPlacement !== null ? activeBinAtPlacement : "null (conflicting)"}`
    );
    console.log(
        `Lower Distance (Bins)   : ${lowerDistanceBins !== null ? lowerDistanceBins : "-"}`
    );
    console.log(
        `Upper Distance (Bins)   : ${upperDistanceBins !== null ? upperDistanceBins : "-"}`
    );
    console.log(`Lower Price / Lamport   : ${lowerPricePerLamport}`);
    console.log(`Upper Price / Lamport   : ${upperPricePerLamport}`);
    console.log(`Price Ratio             : ${priceRatio.toFixed(6)}`);
    console.log(`Range Width (%)         : ${rangeWidthPct.toFixed(2)}%`);
    if (decimalAdjustedPrice) {
        console.log(
            `Decimal-Adjusted Price  : ${Number(decimalAdjustedPrice.lowerPrice).toFixed(8)} -> ${Number(decimalAdjustedPrice.upperPrice).toFixed(8)} ${decimalAdjustedPrice.priceQuote}`
        );
    }
    console.log(`Output File             : ${outputFilePath}`);
    console.log("========================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Price range normalization failed: ${err.message}`);
    process.exit(1);
});
