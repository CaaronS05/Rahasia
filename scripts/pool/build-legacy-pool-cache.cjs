const fs = require("fs");
const path = require("path");

const dlmmModule = require("@meteora-ag/dlmm");
const DLMM = dlmmModule.default ?? dlmmModule;

const {
    Connection,
    PublicKey,
} = require("@solana/web3.js");

// ============================================================
// CONFIG
// ============================================================

const RPC_URL =
    process.env.SOLANA_RPC_URL ??
    "https://api.mainnet-beta.solana.com";

const METEORA_API =
    "https://dlmm.datapi.meteora.ag/pools";

const PAGE_SIZE = 1000;

const CHUNK_SIZE = 50;
const DELAY_MS = 2500;

const MAX_RETRIES = 5;

const MIN_TVL = 50;

const OUTPUT_PATH = path.resolve(
    "data/pools/legacy-dlmm-pools.json"
);

const CHECKPOINT_PATH = path.resolve(
    "data/checkpoints/pool-legacy-scan.json"
);

const connection = new Connection(
    RPC_URL,
    "confirmed"
);

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
}

function ensureDirectory(filePath) {
    const dir =
        path.dirname(filePath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true,
        });
    }
}

function atomicWriteJson(
    filePath,
    data
) {
    ensureDirectory(filePath);

    const tempPath =
        `${filePath}.tmp`;

    fs.writeFileSync(
        tempPath,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );

    fs.renameSync(
        tempPath,
        filePath
    );
}

function normalizeToken(token) {
    return {
        address:
            token?.address ?? null,

        name:
            token?.name ?? null,

        symbol:
            token?.symbol ?? null,

        decimals:
            token?.decimals ?? null,

        verified:
            token?.is_verified ??
            false,

        holders:
            token?.holders ?? null,

        price:
            token?.price ?? null,

        marketCap:
            token?.market_cap ??
            null,

        totalSupply:
            token?.total_supply ??
            null,

        freezeAuthorityDisabled:
            token?.freeze_authority_disabled ??
            null,
    };
}

function normalizeTimeframeMetrics(
    metrics
) {
    return {
        "30m":
            metrics?.["30m"] ?? 0,

        "1h":
            metrics?.["1h"] ?? 0,

        "2h":
            metrics?.["2h"] ?? 0,

        "4h":
            metrics?.["4h"] ?? 0,

        "12h":
            metrics?.["12h"] ?? 0,

        "24h":
            metrics?.["24h"] ?? 0,
    };
}

function normalizePool(
    source,
    pairType
) {
    return {
        address:
            source.address,

        name:
            source.name,

        pairType,

        tokenX:
            normalizeToken(
                source.token_x
            ),

        tokenY:
            normalizeToken(
                source.token_y
            ),

        binStep:
            source.pool_config
                ?.bin_step ?? null,

        baseFeePct:
            source.pool_config
                ?.base_fee_pct ?? null,

        maxFeePct:
            source.pool_config
                ?.max_fee_pct ?? null,

        protocolFeePct:
            source.pool_config
                ?.protocol_fee_pct ??
            null,

        dynamicFeePct:
            source.dynamic_fee_pct ??
            null,

        tvl:
            source.tvl ?? 0,

        currentPrice:
            source.current_price ??
            null,

        volume:
            normalizeTimeframeMetrics(
                source.volume
            ),

        fees:
            normalizeTimeframeMetrics(
                source.fees
            ),

        feeTvlRatio:
            normalizeTimeframeMetrics(
                source.fee_tvl_ratio
            ),

        apr:
            source.apr ?? 0,

        apy:
            source.apy ?? 0,

        hasFarm:
            source.has_farm ??
            false,

        farmApr:
            source.farm_apr ?? 0,

        farmApy:
            source.farm_apy ?? 0,

        createdAt:
            source.created_at ??
            null,

        cumulativeVolume:
            source.cumulative_metrics
                ?.volume ?? 0,

        cumulativeFees:
            source.cumulative_metrics
                ?.fees ?? 0,

        reserveX:
            source.reserve_x ??
            null,

        reserveY:
            source.reserve_y ??
            null,

        tokenXAmount:
            source.token_x_amount ??
            null,

        tokenYAmount:
            source.token_y_amount ??
            null,

        launchpad:
            source.launchpad ??
            "",

        tags:
            Array.isArray(
                source.tags
            )
                ? source.tags
                : [],
    };
}

// ============================================================
// CHECKPOINT
// ============================================================

function loadCheckpoint() {
    if (
        !fs.existsSync(
            CHECKPOINT_PATH
        )
    ) {
        return {
            version: 1,

            pairTypes: {},
        };
    }

    try {
        const raw =
            fs.readFileSync(
                CHECKPOINT_PATH,
                "utf8"
            );

        const parsed =
            JSON.parse(raw);

        return {
            version: 1,

            pairTypes:
                parsed.pairTypes ??
                {},
        };
    } catch (error) {
        console.warn(
            "[CHECKPOINT] Invalid checkpoint, starting fresh:",
            error.message
        );

        return {
            version: 1,
            pairTypes: {},
        };
    }
}

function saveCheckpoint(
    pairTypes
) {
    atomicWriteJson(
        CHECKPOINT_PATH,
        {
            version: 1,

            updatedAt:
                new Date()
                    .toISOString(),

            filters: {
                isBlacklisted:
                    false,

                minTvl:
                    MIN_TVL,
            },

            classified:
                Object.keys(
                    pairTypes
                ).length,

            pairTypes,
        }
    );
}

// ============================================================
// FETCH ALL METEORA CANDIDATES
// ============================================================

async function fetchPage(page) {
    const url =
        new URL(
            METEORA_API
        );

    url.searchParams.set(
        "page",
        String(page)
    );

    url.searchParams.set(
        "page_size",
        String(PAGE_SIZE)
    );

    url.searchParams.set(
        "filter_by",
        `is_blacklisted=false && tvl>${MIN_TVL}`
    );

    url.searchParams.set(
        "sort_by",
        "pool_created_at:asc"
    );

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Meteora API failed: ${response.status}`
        );
    }

    return response.json();
}

async function fetchAllCandidates() {
    console.log(
        "[API] Fetching page 1..."
    );

    const first =
        await fetchPage(1);

    const total =
        first.total ?? 0;

    const pages =
        first.pages ?? 1;

    const allPools = [
        ...(first.data ?? []),
    ];

    console.log(
        `[API] page 1/${pages} | ${allPools.length}/${total}`
    );

    for (
        let page = 2;
        page <= pages;
        page++
    ) {
        const result =
            await fetchPage(page);

        const data =
            result.data ?? [];

        allPools.push(
            ...data
        );

        console.log(
            `[API] page ${page}/${pages} | ${allPools.length}/${total}`
        );
    }

    // Dedupe by pool address
    const map =
        new Map();

    for (
        const pool of allPools
    ) {
        if (
            !pool?.address
        ) {
            continue;
        }

        map.set(
            pool.address,
            pool
        );
    }

    const pools =
        Array.from(
            map.values()
        );

    console.log(
        `[API] ${pools.length} unique candidates`
    );

    return {
        totalReported:
            total,

        pools,
    };
}

// ============================================================
// RPC CLASSIFICATION
// ============================================================

function isRateLimitError(
    error
) {
    const message =
        String(
            error?.message ??
            error ??
            ""
        );

    return (
        message.includes("429") ||
        message.includes(
            "Too Many Requests"
        ) ||
        message.includes(
            "rate limit"
        )
    );
}

async function classifyBatch(
    sourceChunk
) {
    const pubkeys =
        sourceChunk.map(
            (pool) =>
                new PublicKey(
                    pool.address
                )
        );

    let attempt = 0;

    while (
        attempt < MAX_RETRIES
    ) {
        attempt++;

        try {
            return await DLMM.createMultiple(
                connection,
                pubkeys
            );
        } catch (error) {
            if (
                !isRateLimitError(
                    error
                ) ||
                attempt >=
                MAX_RETRIES
            ) {
                throw error;
            }

            const delay =
                DELAY_MS *
                Math.pow(
                    2,
                    attempt - 1
                );

            console.log(
                `[RPC] 429 detected. Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`
            );

            await sleep(
                delay
            );
        }
    }

    throw new Error(
        "Batch classification failed"
    );
}

async function classifyCandidates(
    sourcePools,
    pairTypes
) {
    const pending =
        sourcePools.filter(
            (pool) =>
                pairTypes[
                pool.address
                ] === undefined
        );

    console.log(
        `[CHECKPOINT] ${Object.keys(pairTypes).length} classifications restored`
    );

    console.log(
        `[SCAN] ${pending.length} pools remaining`
    );

    if (
        pending.length === 0
    ) {
        return;
    }

    let processed =
        sourcePools.length -
        pending.length;

    for (
        let start = 0;
        start < pending.length;
        start += CHUNK_SIZE
    ) {
        const sourceChunk =
            pending.slice(
                start,
                start + CHUNK_SIZE
            );

        const batchStart =
            processed + 1;

        const batchEnd =
            processed +
            sourceChunk.length;

        console.log(
            `[RPC] Batch ${batchStart}-${batchEnd}/${sourcePools.length}`
        );

        const dlmmPools =
            await classifyBatch(
                sourceChunk
            );

        if (
            dlmmPools.length !==
            sourceChunk.length
        ) {
            throw new Error(
                `RPC batch length mismatch: expected ${sourceChunk.length}, got ${dlmmPools.length}`
            );
        }

        for (
            let i = 0;
            i <
            sourceChunk.length;
            i++
        ) {
            const source =
                sourceChunk[i];

            const dlmmPool =
                dlmmPools[i];

            const pairType =
                Number(
                    dlmmPool
                        .lbPair
                        .pairType
                );

            pairTypes[
                source.address
            ] =
                pairType;
        }

        processed +=
            sourceChunk.length;

        saveCheckpoint(
            pairTypes
        );

        const legacySoFar =
            sourcePools.filter(
                (pool) =>
                    pairTypes[
                    pool.address
                    ] === 0
            ).length;

        console.log(
            `[CHECKPOINT] ${processed}/${sourcePools.length} classified | legacy=${legacySoFar}`
        );

        if (
            processed <
            sourcePools.length
        ) {
            await sleep(
                DELAY_MS
            );
        }
    }
}

// ============================================================
// BUILD FINAL CACHE
// ============================================================

function buildLegacyPools(
    sourcePools,
    pairTypes
) {
    return sourcePools
        .filter(
            (pool) =>
                pairTypes[
                pool.address
                ] === 0
        )
        .map(
            (pool) =>
                normalizePool(
                    pool,
                    0
                )
        );
}

function saveFinalCache({
    totalReported,
    sourcePools,
    pairTypes,
    legacyPools,
}) {
    const currentClassified =
        sourcePools.filter(
            (pool) =>
                pairTypes[
                pool.address
                ] !== undefined
        ).length;

    const currentExcluded =
        sourcePools.filter(
            (pool) => {
                const type =
                    pairTypes[
                    pool.address
                    ];

                return (
                    type !==
                    undefined &&
                    type !== 0
                );
            }
        ).length;

    const payload = {
        generatedAt:
            new Date()
                .toISOString(),

        source:
            "meteora-dlmm",

        filters: {
            pairType: 0,

            isBlacklisted:
                false,

            minTvl:
                MIN_TVL,
        },

        scan: {
            totalReportedCandidates:
                totalReported,

            uniqueCandidates:
                sourcePools.length,

            classified:
                currentClassified,

            legacyIncluded:
                legacyPools.length,

            excluded:
                currentExcluded,

            unclassified:
                sourcePools.length -
                currentClassified,
        },

        total:
            legacyPools.length,

        pools:
            legacyPools,
    };

    atomicWriteJson(
        OUTPUT_PATH,
        payload
    );

    console.log(
        `[SAVE] ${OUTPUT_PATH}`
    );

    console.log(
        `[SAVE] ${legacyPools.length} legacy DLMM pools`
    );
}

// ============================================================
// MAIN
// ============================================================

(async () => {
    try {
        console.log(
            "================================"
        );

        console.log(
            "LEGACY DLMM POOL CACHE"
        );

        console.log(
            "================================"
        );

        const {
            totalReported,
            pools,
        } =
            await fetchAllCandidates();

        const checkpoint =
            loadCheckpoint();

        const pairTypes =
            checkpoint.pairTypes;

        await classifyCandidates(
            pools,
            pairTypes
        );

        const legacyPools =
            buildLegacyPools(
                pools,
                pairTypes
            );

        saveFinalCache({
            totalReported,

            sourcePools:
                pools,

            pairTypes,

            legacyPools,
        });

        console.log(
            "\n================================"
        );

        console.log(
            "SUMMARY"
        );

        console.log(
            "================================"
        );

        console.log(
            "Candidates:",
            pools.length
        );

        console.log(
            "Legacy DLMM:",
            legacyPools.length
        );

        console.log(
            "Checkpoint:",
            CHECKPOINT_PATH
        );

        console.log(
            "Output:",
            OUTPUT_PATH
        );
    } catch (error) {
        console.error(
            "\n[FATAL]",
            error.message
        );

        console.error(
            "[FATAL] Progress already saved in checkpoint."
        );

        process.exitCode = 1;
    }
})();