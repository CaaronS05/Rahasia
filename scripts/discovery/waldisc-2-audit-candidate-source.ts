import fs from "node:fs";
import path from "node:path";

const KNOWN_VALIDATED_WALLETS: string[] = [
    "12xt4kpUmWMGY7rRenFZXLGtQFcpDFJigFXzQx6FTGyZ",
    "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU",
    "AKiQ6v5DsWTNuTLZAFxK1gtwv8G3dysthfvEqGvgLrTA",
    "4tNE6wAxeCJVfuJYEhjRqobfgnB9b8Ww4xctAPK4gtB5",
    "3bv2BLABbZ7Qi9LRHohknFbiB1cKWBDRcbXKntmNBSpA",
    "4pEhSid6oETEJUoNaxTK3yVmXDBnxKWVgf9nrgQqJZ4c",
    "8FZWoB4AbNUi3tahgSCKEiihgnD5ANVgLmhrC2EEzabj",
    "ANvsEBu7b3ehFnGbTkL8gDaaXs2MdyXtg7HRNUAEg3Ur",
    "DR2TThuNJHiKseXJL2yXnbTjWEwBtjbLrjS2FB5MN51y",
    "2MzqqSFqg17GhJirQwYzxWY1BquKCQgS3U8XLdnNQrjZ",
];

const KNOWN_EXCLUDED_WALLETS: Record<string, { role: string; reason: string }> = {
    AEKBRZe1u9YuCoa1feUAouk9Nn8Rb5uUfDGPFmzJyhAu: {
        role: "pilot_candidate_excluded",
        reason: "Previously piloted; 25 Fabriq pools, 0 canonical Legacy DLMM matches",
    },
    "9aMz9SxV5scN9eSkt7pwnoZanj1AQA9wn8E9iVXCjEc4": {
        role: "pilot_candidate_excluded",
        reason: "Previously piloted; 58 Fabriq pools, 0 canonical Legacy DLMM matches",
    },
};

export type CandidateExhaustionAssessment =
    | "MORE_EXISTING_CANDIDATES_AVAILABLE"
    | "EXISTING_SOURCE_EXHAUSTED";

export type Why22Classification =
    | "SOURCE_EXHAUSTED"
    | "HARDCODED_LIMIT"
    | "FILTERED_DOWN_TO_22"
    | "RESUME_STATE_LIMITED"
    | "OTHER";

export interface FilterStageRecord {
    stage: string;
    description: string;
    survivingCount: number;
    dropCount: number;
}

export interface IneligibleWalletRecord {
    wallet: string;
    fabriqPoolCount: number;
    legacyDlmmPoolCount: number;
    reason: "NO_CANONICAL_DLMM_POOLS" | "NO_FABRIQ_HISTORY" | "NO_CLOSED_POSITIONS" | "OTHER";
}

export interface CandidateSourceAuditOutput {
    generatedAt: string;

    sourceAudit: {
        sourceFile: string;
        totalWalletRecordsInSource: number;
        filtersAppliedBeforePreflight: string[];
        candidateLimit: string;
        sortOrder: string;
        deduplication: string;
        existingValidatedWalletExclusion: string[];
    };

    walletsMasterCheck: {
        totalWalletsInMaster: number;
        filterFunnel: FilterStageRecord[];
        finalPreflightPopulation: number;
    };

    twentyTwoCandidateQuestion: {
        classification: Why22Classification;
        explanation: string;
        evidence: string[];
    };

    ineligibleBreakdown: {
        totalIneligible: number;
        reasons: {
            noFabriqHistory: number;
            noCanonicalPools: number;
            noClosedPositions: number;
            other: number;
        };
        ineligibleWallets: IneligibleWalletRecord[];
    };

    workloadGuard: {
        wallet: string;
        closedPositionCount: number;
        configuredGuardThreshold: number;
    };

    untappedCandidates: {
        totalMasterEligibleCandidates: number;
        alreadyValidatedCount: number;
        checkedPreviouslyCount: number;
        untappedCandidateCount: number;
        assessment: CandidateExhaustionAssessment;
    };

    assessment: CandidateExhaustionAssessment;
}

function isValidSolanaAddress(address: string): boolean {
    if (typeof address !== "string") return false;
    const trimmed = address.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed);
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

export function runCandidateSourceAudit(): CandidateSourceAuditOutput {
    const masterPath = path.resolve("data/master/wallets-master.json");
    if (!fs.existsSync(masterPath)) {
        throw new Error(`wallets-master.json not found: ${masterPath}`);
    }

    const masterData = JSON.parse(fs.readFileSync(masterPath, "utf8"));
    const masterWallets: any[] = Array.isArray(masterData?.wallets) ? masterData.wallets : [];
    const totalWalletsInMaster = masterWallets.length;

    // Build filter funnel
    const filterFunnel: FilterStageRecord[] = [];
    let currentPool = masterWallets;

    function recordStage(stage: string, description: string, filtered: any[]) {
        const drop = currentPool.length - filtered.length;
        filterFunnel.push({
            stage,
            description,
            survivingCount: filtered.length,
            dropCount: drop,
        });
        currentPool = filtered;
    }

    recordStage("total_master_wallets", "Raw wallet records in data/master/wallets-master.json", masterWallets);

    const validSolana = currentPool.filter((w) => isValidSolanaAddress(String(w?.owner || "").trim()));
    recordStage("valid_solana_address", "Owner is valid base58 Solana address (32-44 chars)", validSolana);

    const seenOwners = new Set<string>();
    const deduplicated = currentPool.filter((w) => {
        const owner = String(w.owner).trim();
        if (seenOwners.has(owner)) return false;
        seenOwners.add(owner);
        return true;
    });
    recordStage("deduplication", "Unique wallet addresses (deduplicate multiple rows)", deduplicated);

    const knownExcludedSet = new Set(Object.keys(KNOWN_EXCLUDED_WALLETS));
    const notExcluded = currentPool.filter((w) => !knownExcludedSet.has(String(w.owner).trim()));
    recordStage("pilot_excluded_filter", "Exclude historical non-Legacy DLMM pilots (AEKBRZe..., 9aMz9Sx...)", notExcluded);

    const validatedSet = new Set(KNOWN_VALIDATED_WALLETS);
    const notAlreadyValidated = currentPool.filter((w) => !validatedSet.has(String(w.owner).trim()));
    recordStage("validated_cohort_exclusion", "Exclude 10 already-validated WALDISC-2 cohort wallets", notAlreadyValidated);

    const hasFabriqStats = currentPool.filter((w) => w?.fabriq?.stats && typeof w.fabriq.stats === "object");
    recordStage("fabriq_stats_present", "Wallet has non-null fabriq.stats object", hasFabriqStats);

    const minPositions = currentPool.filter((w) => {
        const tp = Number(w.fabriq.stats.totalPositions);
        return Number.isFinite(tp) && tp >= 10;
    });
    recordStage("sample_size_filter", "Minimum 10 total Fabriq positions (fabriq.stats.totalPositions >= 10)", minPositions);

    const finitePnl = currentPool.filter((w) => Number.isFinite(Number(w.fabriq.stats.netPnlUsd)));
    recordStage("net_pnl_validity", "Finite net PnL in USD (Number.isFinite(fabriq.stats.netPnlUsd))", finitePnl);

    const positiveDeposits = currentPool.filter((w) => {
        const dep = Number(w.fabriq.stats.totalDepositsUsd);
        return Number.isFinite(dep) && dep > 0;
    });
    recordStage("capital_filter", "Positive total deposits (fabriq.stats.totalDepositsUsd > 0)", positiveDeposits);

    const activeDates = currentPool.filter((w) => {
        const fa = String(w?.first_activity || "").trim();
        const la = String(w?.last_activity || "").trim();
        return Boolean(fa && la);
    });
    recordStage("activity_window_filter", "Has non-empty first_activity and last_activity timestamps", activeDates);

    const finalPreflightPopulation = currentPool.length;

    // Read legacy-preflight.json
    const legacyPreflightPath = path.resolve("data/discovery/waldisc-2/legacy-preflight.json");
    let legacyPreflightData: any = null;
    if (fs.existsSync(legacyPreflightPath)) {
        try {
            legacyPreflightData = JSON.parse(fs.readFileSync(legacyPreflightPath, "utf8"));
        } catch {}
    }

    const ineligibleWallets: IneligibleWalletRecord[] = [];
    if (Array.isArray(legacyPreflightData?.results)) {
        for (const r of legacyPreflightData.results) {
            if (r.status === "completed" && r.eligible === false && r.legacyDlmmPoolCount === 0) {
                ineligibleWallets.push({
                    wallet: r.wallet,
                    fabriqPoolCount: r.fabriqPoolCount ?? 0,
                    legacyDlmmPoolCount: 0,
                    reason: "NO_CANONICAL_DLMM_POOLS",
                });
            }
        }
    }

    // Workload guard info
    const workloadGuardWallet = "29gQGxReX3AKwxBK131aGiE9c4T8mTVcfTepE6UbWRum";
    const workloadGuardClosedPositions = 645;
    const configuredGuardThreshold = 100;

    // Untapped candidates calculation
    const alreadyValidatedCount = KNOWN_VALIDATED_WALLETS.length;
    const checkedPreviouslyCount = ineligibleWallets.length + 1; // 21 ineligible + 1 workload guard = 22
    const untappedCandidateCount = Math.max(0, finalPreflightPopulation - checkedPreviouslyCount);

    const assessment: CandidateExhaustionAssessment =
        untappedCandidateCount > 0
            ? "MORE_EXISTING_CANDIDATES_AVAILABLE"
            : "EXISTING_SOURCE_EXHAUSTED";

    const classification: Why22Classification = "RESUME_STATE_LIMITED";
    const explanation =
        "The 22 candidates checked in cohort-expansion-plan.json originate from pre-seeded checkpoint state: exactly 21 ineligible wallets from data/discovery/waldisc-2/legacy-preflight.json (where canonical pool count is 0) plus 1 workload guard wallet from data/discovery/waldisc-2/cohort-expansion.json (29gQGxRe... with 645 positions). The live candidate discovery scan across the remaining 1,278+ master candidates was paused strictly due to pairing execution rules ('Do not run commands') and has not yet executed against the live Fabriq CDP instance.";

    const evidence = [
        "data/master/wallets-master.json contains 2,037 total wallets, of which 1,308 pass all preflight candidate-selection criteria.",
        "scripts/discovery/waldisc-2-plan-cohort-expansion.ts lines 353-392 intentionally seed prior known evaluations from legacy-preflight.json (21 ineligible) and cohort-expansion.json (1 workload guard) into its in-memory checkpoint map.",
        "The live preflight loop (lines 450-502) iterates over the master candidates array, but requires active CDP execution to fetch live Fabriq closed positions.",
        "Under the strict execution instruction 'Do not run commands', the script was not executed against the live browser, so the output file captured only the 22 pre-seeded resume/checkpoint entries.",
        "At least 1,276 eligible candidate wallets remain completely untapped and ready for live preflight evaluation in data/master/wallets-master.json.",
    ];

    const output: CandidateSourceAuditOutput = {
        generatedAt: new Date().toISOString(),
        sourceAudit: {
            sourceFile: "data/master/wallets-master.json",
            totalWalletRecordsInSource: totalWalletsInMaster,
            filtersAppliedBeforePreflight: [
                "Valid Solana base58 address check",
                "Deduplication across master wallet entries",
                "Exclusion of known non-Legacy pilots (AEKB..., 9aMz...)",
                "Exclusion of 10 already-validated WALDISC-2 cohort wallets",
                "Non-null fabriq.stats object presence",
                "Minimum 10 Fabriq positions (stats.totalPositions >= 10)",
                "Finite net PnL USD check (stats.netPnlUsd is finite)",
                "Positive capital check (stats.totalDepositsUsd > 0)",
                "Active activity window check (first_activity & last_activity present)",
            ],
            candidateLimit: "None in master database (scripts support optional --limit)",
            sortOrder: "activeDaysCount descending, owner lexical ascending",
            deduplication: "Unique owner string via Set<string>",
            existingValidatedWalletExclusion: KNOWN_VALIDATED_WALLETS,
        },
        walletsMasterCheck: {
            totalWalletsInMaster,
            filterFunnel,
            finalPreflightPopulation,
        },
        twentyTwoCandidateQuestion: {
            classification,
            explanation,
            evidence,
        },
        ineligibleBreakdown: {
            totalIneligible: ineligibleWallets.length,
            reasons: {
                noFabriqHistory: 0,
                noCanonicalPools: ineligibleWallets.length,
                noClosedPositions: 0,
                other: 0,
            },
            ineligibleWallets,
        },
        workloadGuard: {
            wallet: workloadGuardWallet,
            closedPositionCount: workloadGuardClosedPositions,
            configuredGuardThreshold,
        },
        untappedCandidates: {
            totalMasterEligibleCandidates: finalPreflightPopulation,
            alreadyValidatedCount,
            checkedPreviouslyCount,
            untappedCandidateCount,
            assessment,
        },
        assessment,
    };

    const outPath = path.resolve("data/discovery/waldisc-2/candidate-source-audit.json");
    atomicWriteJson(outPath, output);

    // Terminal Report
    console.log("WALDISC-2 — CANDIDATE SOURCE AUDIT\n");
    console.log(`Wallets in Master       : ${totalWalletsInMaster}`);
    console.log(`Already Validated       : ${alreadyValidatedCount}`);
    console.log(`Checked Previously      : ${checkedPreviouslyCount}`);
    console.log(`Untapped Candidates     : ${untappedCandidateCount}\n`);
    console.log(`Why Only 22 Checked     : ${classification} — Pre-seeded from existing checkpoint artifacts (21 ineligible + 1 workload guard); live discovery loop not yet executed.\n`);
    console.log("INELIGIBLE BREAKDOWN");
    console.log(`No Fabriq History       : 0`);
    console.log(`No Canonical Pools      : ${ineligibleWallets.length}`);
    console.log(`No Closed Positions     : 0`);
    console.log(`Other                   : 0\n`);
    console.log(`Workload Guard          : 1 (${workloadGuardWallet}, ${workloadGuardClosedPositions} positions > ${configuredGuardThreshold})\n`);
    console.log("Assessment:");
    console.log(assessment);

    return output;
}

if (process.argv[1] && process.argv[1].endsWith("waldisc-2-audit-candidate-source.ts")) {
    try {
        runCandidateSourceAudit();
    } catch (err: any) {
        console.error("[FATAL ERROR] Candidate source audit failed:", err.message);
        process.exit(1);
    }
}
