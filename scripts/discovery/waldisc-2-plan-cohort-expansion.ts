import fs from "node:fs";
import path from "node:path";
import {
    fabriqFetch,
    isFabriqDlmmPool,
    closeFabriqConnection,
} from "./core/fabriq-position-history.ts";

const DEFAULT_TARGET_ELIGIBLE_TOTAL = 60;
const DEFAULT_MVP_TARGET = 50;
const DEFAULT_MAX_CLOSED_POSITIONS = 100;
const DEFAULT_DELAY_MS = 300;

const KNOWN_VALIDATED_WALLETS = new Set<string>([
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
]);

const KNOWN_EXCLUDED_WALLETS: Record<
    string,
    { role: string; reason: string }
> = {};

export type CohortAssessment =
    | "ENOUGH_CANDIDATES_FOR_50"
    | "MORE_CANDIDATES_REQUIRED";

export interface PlannedCandidate {
    wallet: string;
    dlmmPoolCount: number;
    canonicalPoolCount?: number;
    closedPositionCount: number;
    status: "ELIGIBLE";
}

export interface CandidateEvaluationRecord {
    wallet: string;
    status: "ELIGIBLE" | "WORKLOAD_GUARD" | "INELIGIBLE" | "ERROR";
    dlmmPoolCount: number;
    canonicalPoolCount?: number;
    closedPositionCount: number;
    error: string | null;
    checkedAt: string;
}

export interface CohortExpansionPlanOutput {
    currentValidatedWallets: number;
    mvpTargetWallets: number;
    eligibleTargetTotal: number;

    candidatesCheckedCumulative: number;
    candidatesCheckedThisRun: number;

    eligibleNewCandidates: number;
    eligibleTotal: number;

    workloadGuard: number;
    ineligible: number;
    errors: number;

    untappedRemaining: number;

    plannedCandidates: PlannedCandidate[];

    assessment: CohortAssessment;
}

interface CliArgs {
    targetTotal: number;
    mvpTarget: number;
    maxClosedPositions: number;
    limit?: number;
    force: boolean;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseCliArgs(): CliArgs {
    const args = process.argv.slice(2);
    let targetTotal = DEFAULT_TARGET_ELIGIBLE_TOTAL;
    let mvpTarget = DEFAULT_MVP_TARGET;
    let maxClosedPositions = DEFAULT_MAX_CLOSED_POSITIONS;
    let limit: number | undefined = undefined;
    let force = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--target-total" && args[i + 1]) {
            targetTotal = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--target-total=")) {
            targetTotal = Number(arg.split("=")[1]);
        } else if (arg === "--mvp-target" && args[i + 1]) {
            mvpTarget = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--mvp-target=")) {
            mvpTarget = Number(arg.split("=")[1]);
        } else if (arg === "--max-closed-positions" && args[i + 1]) {
            maxClosedPositions = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--max-closed-positions=")) {
            maxClosedPositions = Number(arg.split("=")[1]);
        } else if (arg === "--limit" && args[i + 1]) {
            limit = Number(args[i + 1]);
            i++;
        } else if (arg.startsWith("--limit=")) {
            limit = Number(arg.split("=")[1]);
        } else if (arg === "--force") {
            force = true;
        }
    }

    return { targetTotal, mvpTarget, maxClosedPositions, limit, force };
}

function loadCandidateWallets(): { totalSourceWallets: number; candidateWallets: string[] } {
    const masterPath = path.resolve("data/master/wallets-master.json");
    if (!fs.existsSync(masterPath)) {
        throw new Error(`Master wallets database not found: ${masterPath}`);
    }

    const fabriqPath = path.resolve("data/master/wallets-fabriq.json");
    if (!fs.existsSync(fabriqPath)) {
        throw new Error(`Canonical Fabriq database not found: ${fabriqPath}`);
    }

    let masterData: any;
    try {
        masterData = JSON.parse(fs.readFileSync(masterPath, "utf8"));
    } catch (err: any) {
        throw new Error(`Failed to parse master wallets file: ${err?.message || err}`);
    }

    let fabriqData: any;
    try {
        fabriqData = JSON.parse(fs.readFileSync(fabriqPath, "utf8"));
    } catch (err: any) {
        throw new Error(`Failed to parse canonical Fabriq file: ${err?.message || err}`);
    }

    const masterWallets = Array.isArray(masterData?.wallets) ? masterData.wallets : [];
    const totalSourceWallets = masterWallets.length;

    const canonicalWallets = Array.isArray(fabriqData?.wallets) ? fabriqData.wallets : [];
    const canonicalFabriqByOwner = new Map<string, any>();
    for (const fw of canonicalWallets) {
        const fOwner = String(fw?.owner || "").trim();
        if (fOwner && fw?.fabriq) {
            canonicalFabriqByOwner.set(fOwner, fw.fabriq);
        }
    }

    interface EligibleCandidate {
        owner: string;
        activeDaysCount: number;
    }

    const seenOwners = new Set<string>();
    const eligible: EligibleCandidate[] = [];

    for (const w of masterWallets) {
        const owner = String(w?.owner || "").trim();

        if (!isValidSolanaAddress(owner)) continue;
        if (KNOWN_EXCLUDED_WALLETS[owner]) continue;
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);

        const fabriqRecord = canonicalFabriqByOwner.get(owner);
        const fabriqStats = fabriqRecord?.stats;
        if (!fabriqStats || typeof fabriqStats !== "object") continue;

        const totalPositions = Number(fabriqStats.totalPositions);
        const netPnlUsd = Number(fabriqStats.netPnlUsd);
        const totalDepositsUsd = Number(fabriqStats.totalDepositsUsd);

        if (!Number.isFinite(totalPositions) || totalPositions < 10) continue;
        if (!Number.isFinite(netPnlUsd)) continue;
        if (!Number.isFinite(totalDepositsUsd) || totalDepositsUsd <= 0) continue;

        const firstActivity = String(w?.first_activity || "").trim();
        const lastActivity = String(w?.last_activity || "").trim();
        if (!firstActivity || !lastActivity) continue;

        let activeDaysCount = 0;
        if (fabriqRecord?.calendar && typeof fabriqRecord.calendar === "object") {
            activeDaysCount = Object.keys(fabriqRecord.calendar).length;
        }
        if (Array.isArray(w?.pnl_chart)) {
            activeDaysCount = Math.max(activeDaysCount, w.pnl_chart.length);
        }

        eligible.push({
            owner,
            activeDaysCount,
        });
    }

    eligible.sort((a, b) => {
        if (b.activeDaysCount !== a.activeDaysCount) {
            return b.activeDaysCount - a.activeDaysCount;
        }
        return a.owner.localeCompare(b.owner);
    });

    return {
        totalSourceWallets,
        candidateWallets: eligible.map((e) => e.owner),
    };
}

async function fetchWalletDlmmPoolSummary(
    wallet: string
): Promise<{
    reachable: boolean;
    dlmmPoolCount: number;
    closedPositionCount: number;
    dlmmPools: string[];
    pagesFetched: number;
    error: string | null;
}> {
    let page = 1;
    let pagesFetched = 0;
    const poolPositions = new Map<string, number>();

    try {
        while (true) {
            pagesFetched++;
            const params = new URLSearchParams();
            params.set("page", String(page));
            params.set("limit", "100");
            params.set("sortBy", "latest_close_ts");
            params.set("sortOrder", "desc");
            params.set("pnlCurrency", "USD");
            params.set("timezone", "Asia/Jakarta");
            params.append("sources", "wallet");
            params.append("sources", "hawkfi");
            params.set("pnlScope", "pool");
            params.set("lastCloseScope", "pool");
            params.set("durationScope", "pool");
            params.set("depositsScope", "pool");
            params.set("withdrawalsScope", "pool");
            params.set("feesScope", "pool");

            let resJson: any;
            while (true) {
                try {
                    resJson = await fabriqFetch<any>(
                        `/history/${wallet}/pnl-by-pool`,
                        params
                    );
                    break;
                } catch (err: any) {
                    const msg = String(err?.message || err);
                    if (msg.includes("404")) {
                        console.log(`  [FABRIQ] 404 data not ready for ${wallet}. Waiting 5s and retrying...`);
                        await sleep(5000);
                        continue;
                    }
                    throw err;
                }
            }

            const dataNode = resJson?.data ?? resJson;
            const pageItems: any[] = Array.isArray(dataNode)
                ? dataNode
                : Array.isArray(dataNode?.items)
                ? dataNode.items
                : Array.isArray(dataNode?.pools)
                ? dataNode.pools
                : Array.isArray(dataNode?.data)
                ? dataNode.data
                : [];

            if (pageItems.length === 0) {
                break;
            }

            for (const row of pageItems) {
                const poolId =
                    row.pool_id ||
                    row.poolId ||
                    row.pool?.id ||
                    row.pool?.address ||
                    row.id;

                if (!poolId) continue;
                const poolIdStr = String(poolId).trim();

                if (isFabriqDlmmPool(row)) {
                    const posCount =
                        typeof row.position_count === "number"
                            ? row.position_count
                            : (Number(row.position_count_wallet ?? 0) + Number(row.position_count_hawkfi ?? 0)) || 0;

                    poolPositions.set(
                        poolIdStr,
                        (poolPositions.get(poolIdStr) || 0) + posCount
                    );
                }
            }

            if (pageItems.length < 100) {
                break;
            }

            page++;
        }

        const dlmmPools = Array.from(poolPositions.keys()).sort();
        const dlmmPoolCount = dlmmPools.length;
        let closedPositionCount = 0;
        for (const count of poolPositions.values()) {
            closedPositionCount += count;
        }

        return {
            reachable: true,
            dlmmPoolCount,
            closedPositionCount,
            dlmmPools,
            pagesFetched,
            error: null,
        };
    } catch (err: any) {
        return {
            reachable: false,
            dlmmPoolCount: 0,
            closedPositionCount: 0,
            dlmmPools: [],
            pagesFetched,
            error: String(err?.message || err),
        };
    }
}

export async function runCohortExpansionPlanning(): Promise<CohortExpansionPlanOutput> {
    const cli = parseCliArgs();

    const { totalSourceWallets, candidateWallets } = loadCandidateWallets();

    const currentValidatedWallets = KNOWN_VALIDATED_WALLETS.size;
    const mvpTargetWallets = cli.mvpTarget;
    const eligibleTargetTotal = cli.targetTotal;

    const planOutPath = path.resolve("data/discovery/waldisc-2/cohort-expansion-plan.json");
    const checkpointPath = path.resolve("data/discovery/waldisc-2/cohort-expansion-plan-checkpoint.json");

    // Load prior preflight records
    const evaluatedRecords = new Map<string, CandidateEvaluationRecord>();

    // 1. Seed ineligible from legacy-preflight.json only if checkpoint is under FABRIQ_DLMM rule
    const legacyPreflightPath = path.resolve("data/discovery/waldisc-2/legacy-preflight.json");
    if (fs.existsSync(legacyPreflightPath)) {
        try {
            const rawPreflight = JSON.parse(fs.readFileSync(legacyPreflightPath, "utf8"));
            if (rawPreflight?.config?.poolEligibilityRule === "FABRIQ_DLMM" && Array.isArray(rawPreflight?.results)) {
                for (const r of rawPreflight.results) {
                    if (!r?.wallet || KNOWN_VALIDATED_WALLETS.has(r.wallet)) continue;
                    const pools = r.dlmmPoolCount ?? r.legacyDlmmPoolCount ?? 0;
                    if (r.status === "completed" && r.eligible === false && pools === 0) {
                        evaluatedRecords.set(r.wallet, {
                            wallet: r.wallet,
                            status: "INELIGIBLE",
                            dlmmPoolCount: 0,
                            closedPositionCount: 0,
                            error: null,
                            checkedAt: r.checkedAt || new Date().toISOString(),
                        });
                    }
                }
            }
        } catch {}
    }

    // 2. Seed workload guard from cohort-expansion.json only if checkpoint is under FABRIQ_DLMM rule
    const cohortExpansionPath = path.resolve("data/discovery/waldisc-2/cohort-expansion.json");
    if (fs.existsSync(cohortExpansionPath)) {
        try {
            const rawExpansion = JSON.parse(fs.readFileSync(cohortExpansionPath, "utf8"));
            if (rawExpansion?.config?.poolEligibilityRule === "FABRIQ_DLMM" && Array.isArray(rawExpansion?.results)) {
                for (const r of rawExpansion.results) {
                    if (!r?.wallet || KNOWN_VALIDATED_WALLETS.has(r.wallet)) continue;
                    if (r.status === "WORKLOAD_GUARD") {
                        evaluatedRecords.set(r.wallet, {
                            wallet: r.wallet,
                            status: "WORKLOAD_GUARD",
                            dlmmPoolCount: r.dlmmPoolCount ?? r.legacyDlmmPoolCount ?? 0,
                            closedPositionCount: r.closedPositions ?? 0,
                            error: null,
                            checkedAt: r.updatedAt || new Date().toISOString(),
                        });
                    }
                }
            }
        } catch {}
    }

    // 3. Load checkpoint from prior runs of this planner
    if (fs.existsSync(checkpointPath) && !cli.force) {
        try {
            const rawCheckpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
            if (Array.isArray(rawCheckpoint?.records)) {
                for (const rec of rawCheckpoint.records) {
                    if (rec?.wallet) {
                        evaluatedRecords.set(rec.wallet, rec);
                    }
                }
            }
        } catch {}
    }

    // Build checkedWalletSet: skip only wallets already present in:
    // validated, ineligible, workload guard, completed preflight checkpoint
    const checkedWalletSet = new Set<string>();

    for (const w of KNOWN_VALIDATED_WALLETS) {
        checkedWalletSet.add(w);
    }
    for (const w of evaluatedRecords.keys()) {
        checkedWalletSet.add(w);
    }

    // Determine genuinely untapped candidates
    const untappedWallets = candidateWallets.filter((w) => !checkedWalletSet.has(w));

    // Runtime Assertion before preflight
    console.log(`Total Source Wallets    : ${totalSourceWallets}`);
    console.log(`Checked Set Size        : ${checkedWalletSet.size}`);
    console.log(`Untapped Candidate Size : ${untappedWallets.length}`);
    console.log(`First Untapped Wallet   : ${untappedWallets.length > 0 ? untappedWallets[0] : "none"}`);

    const previouslyCheckedCount = evaluatedRecords.size;
    let checkedThisRun = 0;

    let currentEligibleTotal = currentValidatedWallets +
        Array.from(evaluatedRecords.values()).filter((r) => r.status === "ELIGIBLE").length;

    function buildOutput(): CohortExpansionPlanOutput {
        const records = Array.from(evaluatedRecords.values());

        const eligibleList: PlannedCandidate[] = [];
        let workloadGuardCount = 0;
        let ineligibleCount = 0;
        let errorCount = 0;

        for (const rec of records) {
            if (rec.status === "ELIGIBLE") {
                eligibleList.push({
                    wallet: rec.wallet,
                    dlmmPoolCount: rec.dlmmPoolCount,
                    canonicalPoolCount: rec.dlmmPoolCount,
                    closedPositionCount: rec.closedPositionCount,
                    status: "ELIGIBLE",
                });
            } else if (rec.status === "WORKLOAD_GUARD") {
                workloadGuardCount++;
            } else if (rec.status === "INELIGIBLE") {
                ineligibleCount++;
            } else if (rec.status === "ERROR") {
                errorCount++;
            }
        }

        eligibleList.sort((a, b) => {
            if (a.closedPositionCount !== b.closedPositionCount) {
                return a.closedPositionCount - b.closedPositionCount;
            }
            const aPools = a.dlmmPoolCount ?? a.canonicalPoolCount ?? 0;
            const bPools = b.dlmmPoolCount ?? b.canonicalPoolCount ?? 0;
            if (bPools !== aPools) {
                return bPools - aPools;
            }
            return a.wallet.localeCompare(b.wallet);
        });

        const eligibleTotal = currentValidatedWallets + eligibleList.length;
        const candidatesCheckedCumulative = records.length;
        const untappedRemaining = Math.max(0, untappedWallets.length - checkedThisRun);

        const assessment: CohortAssessment =
            eligibleTotal >= eligibleTargetTotal
                ? "ENOUGH_CANDIDATES_FOR_50"
                : "MORE_CANDIDATES_REQUIRED";

        return {
            currentValidatedWallets,
            mvpTargetWallets,
            eligibleTargetTotal,
            candidatesCheckedCumulative,
            candidatesCheckedThisRun: checkedThisRun,
            eligibleNewCandidates: eligibleList.length,
            eligibleTotal,
            workloadGuard: workloadGuardCount,
            ineligible: ineligibleCount,
            errors: errorCount,
            untappedRemaining,
            plannedCandidates: eligibleList,
            assessment,
        };
    }

    function saveCheckpoint(): void {
        const output = buildOutput();
        atomicWriteJson(planOutPath, output);
        atomicWriteJson(checkpointPath, {
            generatedAt: new Date().toISOString(),
            config: {
                poolEligibilityRule: "FABRIQ_DLMM",
            },
            records: Array.from(evaluatedRecords.values()),
        });
    }

    // Graceful interrupt handling to guarantee zero lost progress
    let isTerminating = false;
    const onExitSignal = () => {
        if (isTerminating) return;
        isTerminating = true;
        console.log("\n[INTERRUPT] Exit signal caught. Saving checkpoint state before exit...");
        saveCheckpoint();
        closeFabriqConnection().finally(() => {
            process.exit(130);
        });
    };
    process.on("SIGINT", onExitSignal);
    process.on("SIGTERM", onExitSignal);

    let loopEntered = false;

    try {
        for (let i = 0; i < untappedWallets.length; i++) {
            loopEntered = true;

            if (currentEligibleTotal >= eligibleTargetTotal) {
                console.log(`[STOP CONDITION MET] Target eligible total reached (${currentEligibleTotal} >= ${eligibleTargetTotal}).`);
                break;
            }

            if (cli.limit !== undefined && checkedThisRun >= cli.limit) {
                console.log(`[LIMIT REACHED] Limit of ${cli.limit} candidates checked this run.`);
                break;
            }

            const wallet = untappedWallets[i];
            console.log(`[${i + 1}/${untappedWallets.length}] Preflighting ${wallet}...`);

            const summary = await fetchWalletDlmmPoolSummary(wallet);

            let status: "ELIGIBLE" | "WORKLOAD_GUARD" | "INELIGIBLE" | "ERROR";
            let terminalMessage = "";

            if (!summary.reachable) {
                status = "ERROR";
                terminalMessage = `ERROR — ${summary.error || "Unreachable"}`;
            } else if (summary.dlmmPoolCount === 0) {
                status = "INELIGIBLE";
                terminalMessage = "INELIGIBLE | NO_DLMM_POOLS";
            } else if (summary.closedPositionCount === 0) {
                status = "INELIGIBLE";
                terminalMessage = "INELIGIBLE | 0_CLOSED_POSITIONS";
            } else if (summary.closedPositionCount > cli.maxClosedPositions) {
                status = "WORKLOAD_GUARD";
                terminalMessage = "WORKLOAD_GUARD";
            } else {
                status = "ELIGIBLE";
                terminalMessage = "ELIGIBLE";
                currentEligibleTotal++;
            }

            console.log(terminalMessage);
            console.log(`DLMM Pools        : ${summary.dlmmPoolCount}`);
            console.log(`Closed Positions  : ${summary.closedPositionCount}\n`);
            checkedThisRun++;

            evaluatedRecords.set(wallet, {
                wallet,
                status,
                dlmmPoolCount: summary.dlmmPoolCount,
                canonicalPoolCount: summary.dlmmPoolCount,
                closedPositionCount: summary.closedPositionCount,
                error: summary.error,
                checkedAt: new Date().toISOString(),
            });
            checkedWalletSet.add(wallet);

            saveCheckpoint();

            if (i < untappedWallets.length - 1 && currentEligibleTotal < eligibleTargetTotal) {
                await sleep(DEFAULT_DELAY_MS);
            }
        }

        if (untappedWallets.length > 0 && !loopEntered) {
            throw new Error("Untapped candidates exist but live preflight loop was not entered.");
        }
    } finally {
        await closeFabriqConnection();
    }

    const finalOutput = buildOutput();
    saveCheckpoint();

    // Final Terminal Report matching specification
    console.log("\n==================================================");
    console.log("WALDISC-2 — LIVE COHORT EXPANSION PREFLIGHT\n");
    console.log(`Current Validated       : ${finalOutput.currentValidatedWallets}`);
    console.log(`Target Eligible Total   : ${finalOutput.eligibleTargetTotal}\n`);
    console.log(`Previously Checked      : ${previouslyCheckedCount}`);
    console.log(`Checked This Run        : ${finalOutput.candidatesCheckedThisRun}`);
    console.log(`Checked Cumulative      : ${finalOutput.candidatesCheckedCumulative}\n`);
    console.log(`Eligible New            : ${finalOutput.eligibleNewCandidates}`);
    console.log(`Eligible Total          : ${finalOutput.eligibleTotal}\n`);
    console.log(`Workload Guard          : ${finalOutput.workloadGuard}`);
    console.log(`Ineligible              : ${finalOutput.ineligible}`);
    console.log(`Errors                  : ${finalOutput.errors}\n`);
    console.log(`Untapped Remaining      : ${finalOutput.untappedRemaining}\n`);
    console.log(`Assessment:`);
    console.log(finalOutput.assessment);
    console.log("==================================================");

    return finalOutput;
}

const isMain =
    Boolean(process.argv[1]) &&
    (process.argv[1].endsWith("waldisc-2-plan-cohort-expansion.ts") ||
        process.argv[1].endsWith("waldisc-2-plan-cohort-expansion.js") ||
        process.argv[1].includes("waldisc-2-plan-cohort-expansion"));

if (isMain) {
    runCohortExpansionPlanning().catch((err) => {
        console.error("[FATAL ERROR] Live cohort expansion preflight failed:", err.message);
        process.exit(1);
    });
}
