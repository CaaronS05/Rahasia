import fs from "node:fs";
import path from "node:path";

const CONTROL_WALLET = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";

interface AvailableEvidence {
    totalPositionsFabriq: number;
    closedLpMaster: number;
    totalLpMaster: number;
    netPnlUsd: number;
    totalDepositsUsd: number;
    totalWithdrawalsUsd: number;
    totalFeesUsd: number;
    winRateFabriq: number;
    firstActivity: string;
    lastActivity: string;
    activeDaysCount: number;
}

interface CandidateItem {
    wallet: string;
    localDataComplete: boolean;
    closedPositionEligibilityKnown: boolean;
    cohort: string;
    selectionReason: string;
    availableEvidence: AvailableEvidence;
}

interface PilotCandidatesOutput {
    generatedAt: string;

    referenceWallet: {
        wallet: string;
        role: string;
    };

    sourceSummary: {
        masterWalletCount: number;
        fabriqRecordCount: number;
    };

    selectionRules: string[];

    candidates: CandidateItem[];

    eligibleCandidatesCount: number;

    warnings: string[];
}

function isValidSolanaAddress(addr: string): boolean {
    if (!addr || typeof addr !== "string") return false;
    if (addr.length < 32 || addr.length > 44) return false;
    return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
}

function tryReadJson(filePath: string): any | null {
    if (!fs.existsSync(filePath)) return null;
    try {
        const raw = fs.readFileSync(filePath, "utf8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
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
    const warnings: string[] = [];

    const masterPath = path.resolve("data/master/wallets-master.json");
    const fabriqPath = path.resolve("data/raw/fabriq/fabriq-enriched.json");

    if (!fs.existsSync(masterPath)) {
        throw new Error(`Master wallets database not found: ${masterPath}`);
    }

    const masterData = tryReadJson(masterPath);
    if (!masterData || !Array.isArray(masterData.wallets)) {
        throw new Error(`Invalid master database format in ${masterPath}: expected array in 'wallets'`);
    }

    const fabriqData = tryReadJson(fabriqPath);
    const fabriqRecordCount =
        fabriqData && Array.isArray(fabriqData.results)
            ? fabriqData.results.length
            : masterData.meta?.fabriqMatchedWallets || 0;

    const masterWallets = masterData.wallets;
    const masterWalletCount = masterWallets.length;

    const selectionRules: string[] = [
        "Rule 1: Base eligibility requires a valid base58 Solana owner address, non-reference wallet, complete Fabriq enrichment with totalPositions >= 10, totalDepositsUsd > 0, and non-empty activity dates.",
        "Rule 2: Exclude the reference control wallet (DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU) and any duplicate owner addresses.",
        "Rule 3: Establish 3 diversity cohorts without skill scoring: Cohort 1 (Compact Scale: 10-50 positions, net positive PnL), Cohort 2 (Mixed/Drawdown Profile: net negative PnL, >= 10 positions), Cohort 3 (High Scale: > 100 positions).",
        "Rule 4: Stable deterministic tie-breaking within each cohort: (1) higher active calendar days count, (2) lexical ascending order of owner address.",
        "Rule 5: Closed-position eligibility is explicitly marked as closedPositionEligibilityKnown = false because local master & Fabriq summary datasets track aggregate totals; exact closed Meteora DLMM positions are resolved on-chain during WALDISC-2 execution."
    ];

    interface EligibleWallet {
        owner: string;
        evidence: AvailableEvidence;
        activeDaysCount: number;
    }

    const seenOwners = new Set<string>();
    const eligible: EligibleWallet[] = [];

    for (const w of masterWallets) {
        const owner = String(w.owner || "").trim();

        if (!isValidSolanaAddress(owner)) continue;
        if (owner === CONTROL_WALLET) continue;
        if (seenOwners.has(owner)) continue;
        seenOwners.add(owner);

        const fabriqStats = w.fabriq?.stats;
        if (!fabriqStats || typeof fabriqStats !== "object") continue;

        const totalPositions = Number(fabriqStats.totalPositions);
        const netPnlUsd = Number(fabriqStats.netPnlUsd);
        const totalDepositsUsd = Number(fabriqStats.totalDepositsUsd);

        if (!Number.isFinite(totalPositions) || totalPositions < 10) continue;
        if (!Number.isFinite(netPnlUsd)) continue;
        if (!Number.isFinite(totalDepositsUsd) || totalDepositsUsd <= 0) continue;

        const firstActivity = String(w.first_activity || "").trim();
        const lastActivity = String(w.last_activity || "").trim();
        if (!firstActivity || !lastActivity) continue;

        let activeDaysCount = 0;
        if (w.fabriq?.calendar && typeof w.fabriq.calendar === "object") {
            activeDaysCount = Object.keys(w.fabriq.calendar).length;
        }
        if (Array.isArray(w.pnl_chart)) {
            activeDaysCount = Math.max(activeDaysCount, w.pnl_chart.length);
        }

        const evidence: AvailableEvidence = {
            totalPositionsFabriq: totalPositions,
            closedLpMaster: Number(w.closed_lp || 0),
            totalLpMaster: Number(w.total_lp || 0),
            netPnlUsd,
            totalDepositsUsd,
            totalWithdrawalsUsd: Number(fabriqStats.totalWithdrawalsUsd || 0),
            totalFeesUsd: Number(fabriqStats.totalFeesUsd || 0),
            winRateFabriq: Number(fabriqStats.positionWinUsd?.percentage || 0),
            firstActivity,
            lastActivity,
            activeDaysCount,
        };

        eligible.push({
            owner,
            evidence,
            activeDaysCount,
        });
    }

    function tieBreakSort(a: EligibleWallet, b: EligibleWallet): number {
        if (b.activeDaysCount !== a.activeDaysCount) {
            return b.activeDaysCount - a.activeDaysCount;
        }
        return a.owner.localeCompare(b.owner);
    }

    const selectedCandidates: CandidateItem[] = [];
    const chosenOwners = new Set<string>();

    if (eligible.length === 0) {
        warnings.push("No eligible candidates found matching minimum data completeness requirements.");
    } else {
        // Cohort 1: Compact Scale (10-50 positions, net positive PnL)
        const cohort1 = eligible
            .filter(
                (e) =>
                    !chosenOwners.has(e.owner) &&
                    e.evidence.totalPositionsFabriq >= 10 &&
                    e.evidence.totalPositionsFabriq <= 50 &&
                    e.evidence.netPnlUsd > 0
            )
            .sort(tieBreakSort);

        if (cohort1.length > 0) {
            const pick = cohort1[0];
            chosenOwners.add(pick.owner);
            selectedCandidates.push({
                wallet: pick.owner,
                localDataComplete: true,
                closedPositionEligibilityKnown: false,
                cohort: "compact_scale_positive_pnl",
                selectionReason: `Compact scale (${pick.evidence.totalPositionsFabriq} positions, $${pick.evidence.netPnlUsd.toFixed(2)} net PnL across ${pick.activeDaysCount} active days) — ideal manageable baseline resembling control scale.`,
                availableEvidence: pick.evidence,
            });
        }

        // Cohort 2: Drawdown / Mixed Profile (net negative PnL, >= 10 positions)
        const cohort2 = eligible
            .filter(
                (e) =>
                    !chosenOwners.has(e.owner) &&
                    e.evidence.netPnlUsd < 0
            )
            .sort(tieBreakSort);

        if (cohort2.length > 0) {
            const pick = cohort2[0];
            chosenOwners.add(pick.owner);
            selectedCandidates.push({
                wallet: pick.owner,
                localDataComplete: true,
                closedPositionEligibilityKnown: false,
                cohort: "mixed_drawdown_profile",
                selectionReason: `Drawdown profile (${pick.evidence.totalPositionsFabriq} positions, -$${Math.abs(pick.evidence.netPnlUsd).toFixed(2)} net PnL across ${pick.activeDaysCount} active days) — validates pipeline behaviour on negative PnL positions without bias.`,
                availableEvidence: pick.evidence,
            });
        }

        // Cohort 3: High Scale (> 100 positions)
        const cohort3 = eligible
            .filter(
                (e) =>
                    !chosenOwners.has(e.owner) &&
                    e.evidence.totalPositionsFabriq > 100
            )
            .sort(tieBreakSort);

        if (cohort3.length > 0) {
            const pick = cohort3[0];
            chosenOwners.add(pick.owner);
            selectedCandidates.push({
                wallet: pick.owner,
                localDataComplete: true,
                closedPositionEligibilityKnown: false,
                cohort: "high_scale_active",
                selectionReason: `High activity scale (${pick.evidence.totalPositionsFabriq} positions, $${pick.evidence.totalDepositsUsd.toFixed(2)} deposits across ${pick.activeDaysCount} active days) — tests multi-position throughput and rebalance intensity.`,
                availableEvidence: pick.evidence,
            });
        }

        // Fallback if any cohort had no matches: fill remaining slots from remaining eligible
        if (selectedCandidates.length < 3) {
            const remaining = eligible
                .filter((e) => !chosenOwners.has(e.owner))
                .sort(tieBreakSort);

            for (const pick of remaining) {
                if (selectedCandidates.length >= 3) break;
                chosenOwners.add(pick.owner);
                selectedCandidates.push({
                    wallet: pick.owner,
                    localDataComplete: true,
                    closedPositionEligibilityKnown: false,
                    cohort: "fallback_high_evidence",
                    selectionReason: `High evidence fallback (${pick.evidence.totalPositionsFabriq} positions, ${pick.activeDaysCount} active days).`,
                    availableEvidence: pick.evidence,
                });
            }
        }
    }

    const outputFilePath = path.resolve(
        "data/discovery/waldisc-2/pilot-candidates.json"
    );

    const outputData: PilotCandidatesOutput = {
        generatedAt: new Date().toISOString(),
        referenceWallet: {
            wallet: CONTROL_WALLET,
            role: "control",
        },
        sourceSummary: {
            masterWalletCount,
            fabriqRecordCount,
        },
        selectionRules,
        candidates: selectedCandidates,
        eligibleCandidatesCount: eligible.length,
        warnings,
    };

    atomicWriteJson(outputFilePath, outputData);

    const cand1 = selectedCandidates[0] ? selectedCandidates[0].wallet : "None";
    const cand2 = selectedCandidates[1] ? selectedCandidates[1].wallet : "None";
    const cand3 = selectedCandidates[2] ? selectedCandidates[2].wallet : "None";

    console.log("========================================");
    console.log("WALDISC-2 STEP 1F.0 — PILOT CANDIDATES");
    console.log("========================================");
    console.log(`Master Wallets      : ${masterWalletCount}`);
    console.log(`Usable Candidates   : ${eligible.length}`);
    console.log(`Selected New Wallets: ${selectedCandidates.length}\n`);

    console.log("Control:");
    console.log(`${CONTROL_WALLET}\n`);

    console.log(`Pilot Candidate #1 : ${cand1}`);
    console.log(`Pilot Candidate #2 : ${cand2}`);
    console.log(`Pilot Candidate #3 : ${cand3}\n`);

    console.log("Closed-position eligibility known locally:");
    console.log("false (master and Fabriq summary datasets track aggregate totals; exact closed Meteora DLMM positions are resolved during WALDISC-2 position discovery)\n");

    console.log("Warnings:");
    if (warnings.length === 0) {
        console.log("None");
    } else {
        for (const w of warnings) {
            console.log(`- ${w}`);
        }
    }
    console.log("========================================\n");
}

main().catch((err) => {
    console.error(`\n[FATAL ERROR] Pilot wallet selection failed: ${err.message}`);
    process.exit(1);
});
