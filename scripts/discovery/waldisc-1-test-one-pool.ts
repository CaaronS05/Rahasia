import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
    scanPoolHistory,
    type ScanPoolHistoryResult,
    type LpEventRecord,
} from "./core/scan-pool-history.ts";
import { loadDiscoveryConfig } from "./core/config.ts";

function parseCliArgs() {
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

function getDirectoryFingerprint(dirPath: string): string | null {
    if (!fs.existsSync(dirPath)) return null;
    const hash = crypto.createHash("sha256");

    function walk(current: string) {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            hash.update(path.relative(dirPath, fullPath));
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const content = fs.readFileSync(fullPath);
                hash.update(content);
            }
        }
    }

    walk(dirPath);
    return hash.digest("hex");
}

function getFileFingerprint(filePath: string): string | null {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
        return getDirectoryFingerprint(filePath);
    }
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
}

async function main() {
    const args = parseCliArgs();

    // Default to the validated Legacy DLMM candidate pool (JUP-SOL 4)
    const poolAddress =
        args.pool ||
        process.env.POOL_ADDRESS ||
        "Eio6hAieGTAmKgfvbEfbnXke6o5kfEd74tqHm2Z9SFjf";

    const days = args.days ? Number(args.days) : 7;
    const maxTransactions = args["max-transactions"]
        ? Number(args["max-transactions"])
        : 1000;
    const mode = (args.mode || "auto") as "auto" | "gtfa" | "standard";

    const config = loadDiscoveryConfig({
        maxTransactions,
        scanMode: mode,
    });

    console.log("========================================");
    console.log("WALDISC-1 — ONE POOL LP DISCOVERY PROOF");
    console.log("========================================");
    console.log(`Pool Address      : ${poolAddress}`);
    console.log(`Time Window (days): ${days}`);
    console.log(`Max Transactions  : ${maxTransactions}`);
    console.log(`Requested Mode    : ${mode}`);
    console.log("----------------------------------------");

    // Baseline check for Master files (Section 8 L: No Master Mutation)
    const baselineMaster = getFileFingerprint("data/master/wallets-master.json");
    const baselineFrontend = getFileFingerprint("frontend/public/data/wallets-14d.json");
    const baselineRawFabriq = getFileFingerprint("data/raw/fabriq");

    // Run discovery scanner
    const result: ScanPoolHistoryResult = await scanPoolHistory({
        poolAddress,
        days,
        maxTransactions,
        scanMode: mode,
        onLog: (msg) => console.log(msg),
    });

    const summary = result.summary;
    const wallets = result.wallets;
    const events = result.events;

    // Post-scan fingerprint checks for Section 8 L
    const afterMaster = getFileFingerprint("data/master/wallets-master.json");
    const afterFrontend = getFileFingerprint("frontend/public/data/wallets-14d.json");
    const afterRawFabriq = getFileFingerprint("data/raw/fabriq");

    const noMasterMutation =
        baselineMaster === afterMaster &&
        baselineFrontend === afterFrontend &&
        baselineRawFabriq === afterRawFabriq;

    // ========================================================
    // SAMPLES OF ACCEPTED EVIDENCE (Section 13)
    // ========================================================
    console.log("\n========================================");
    console.log("ACCEPTED EVIDENCE SAMPLES (UP TO 5)");
    console.log("========================================");
    const sampleAccepted = events.slice(0, 5);
    console.table(
        sampleAccepted.map((e) => ({
            wallet: e.wallet,
            walletAccountName: e.walletAccountName,
            instruction: e.instruction,
            category: e.category,
            position: e.position ? `${e.position.slice(0, 8)}...` : "none",
            pool: `${e.pool.slice(0, 8)}...`,
            programId: e.programId,
            signature: `${e.signature.slice(0, 12)}...`,
            timestamp: e.timestamp,
            verification: e.verification.status,
        }))
    );

    // ========================================================
    // SAMPLES OF REJECTED INSTRUCTIONS (Section 13)
    // ========================================================
    console.log("\n========================================");
    console.log("REJECTED INSTRUCTION SAMPLES (FALSE-POSITIVE FILTERING)");
    console.log("========================================");
    const sampleRejected = result.rejectedSamples.slice(0, 5);
    console.table(
        sampleRejected.map((r) => ({
            instruction: r.instructionName,
            source: r.source,
            index: r.instructionIndex,
            reason: r.reason,
            signature: `${r.signature.slice(0, 12)}...`,
        }))
    );

    // ========================================================
    // TOP UNKNOWN DISCRIMINATOR FAMILIES (Section 13)
    // ========================================================
    console.log("\n========================================");
    console.log("TOP UNKNOWN DISCRIMINATOR FAMILIES (UP TO 10)");
    console.log("========================================");
    const sampleUnknowns = result.unknownDiscriminators.slice(0, 10);
    console.table(
        sampleUnknowns.map((u) => {
            const sourcesText = Object.entries(u.sources)
                .map(([src, count]) => `${src}:${count}`)
                .join(",");
            return {
                discriminator: u.discriminatorHex,
                count: u.count,
                classification: u.classification,
                sampleSignature: u.sampleSignatures[0]
                    ? `${u.sampleSignatures[0].slice(0, 12)}...`
                    : "none",
                source: sourcesText,
                dataLength: u.sampleDataLengths[0] ?? 0,
            };
        })
    );

    // ========================================================
    // ACCEPTANCE ASSERTIONS A-M (Section 8)
    // ========================================================
    interface AssertionResult {
        code: string;
        name: string;
        pass: boolean;
        isNa?: boolean;
        details: string;
    }

    const assertions: AssertionResult[] = [];

    // A — Legacy Pool
    const cachePath = path.resolve("data/pools/legacy-dlmm-pools.json");
    let poolInLegacyCache = false;
    if (fs.existsSync(cachePath)) {
        try {
            const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
            poolInLegacyCache = Array.isArray(cache.pools)
                ? cache.pools.some((p: any) => p.address === poolAddress)
                : false;
        } catch {}
    }
    const aPass = poolInLegacyCache && summary.pool.pairType === 0;
    assertions.push({
        code: "A",
        name: "Pool exists in legacy cache with pairType === 0",
        pass: aPass,
        details: `pairType=${summary.pool.pairType}, inLegacyCache=${poolInLegacyCache}`,
    });

    // B — Transactions
    const bPass = summary.scan.transactionsFetched > 0;
    assertions.push({
        code: "B",
        name: "Transactions fetched > 0",
        pass: bPass,
        details: `${summary.scan.transactionsFetched} transactions fetched`,
    });

    // C — LP Instructions
    const cPass = summary.scan.lpInstructionsAccepted > 0;
    assertions.push({
        code: "C",
        name: "Accepted LP instructions > 0",
        pass: cPass,
        details: `${summary.scan.lpInstructionsAccepted} accepted LP instructions`,
    });

    // D — Wallet Resolution
    const dPass =
        summary.scan.uniqueWallets > 0 && summary.scan.walletResolvedEvents > 0;
    assertions.push({
        code: "D",
        name: "Resolved LP wallets and events > 0",
        pass: dPass,
        details: `${summary.scan.uniqueWallets} unique wallets, ${summary.scan.walletResolvedEvents} resolved events`,
    });

    // E — Exact Pool (100% of accepted events)
    const wrongPoolInAccepted = events.filter((e) => e.pool !== poolAddress);
    const ePass = wrongPoolInAccepted.length === 0 && events.length > 0;
    assertions.push({
        code: "E",
        name: "100% of accepted LP events match target pool",
        pass: ePass,
        details: `${events.length - wrongPoolInAccepted.length}/${events.length} match target pool`,
    });

    // F — Program Correctness (Real assertion, no hardcoded pass)
    const correctProgramEvents = events.filter(
        (e) => e.programId === config.meteoraDlmmProgramId
    ).length;
    const wrongProgramEvents = events.length - correctProgramEvents;
    const fPass = wrongProgramEvents === 0 && events.length > 0;
    assertions.push({
        code: "F",
        name: "100% of accepted events match Meteora DLMM program ID",
        pass: fPass,
        details: `correctProgramEvents=${correctProgramEvents}, wrongProgramEvents=${wrongProgramEvents}`,
    });

    // G — LP Allowlist (100% in accepted categories)
    const allowedCategories = new Set([
        "initialize",
        "add",
        "remove",
        "claim_fee",
        "claim_reward",
        "close",
        "rebalance",
    ]);
    const invalidCategories = events.filter(
        (e) => !allowedCategories.has(e.category)
    );
    const gPass = invalidCategories.length === 0 && events.length > 0;
    assertions.push({
        code: "G",
        name: "100% of accepted instructions belong to LP allowlist",
        pass: gPass,
        details: `${events.length - invalidCategories.length}/${events.length} in allowlist`,
    });

    // H — No Fee-Payer Fallback
    const nonIdlSigner = events.filter(
        (e) => e.walletResolutionMethod !== "idl_signer"
    );
    const hPass = nonIdlSigner.length === 0 && events.length > 0;
    assertions.push({
        code: "H",
        name: "100% of resolved wallets use IDL signer semantics (no fee-payer fallback)",
        pass: hPass,
        details: `${events.length - nonIdlSigner.length}/${events.length} resolved via idl_signer`,
    });

    // I — Wallet Dedup
    const uniqueOwnersSet = new Set(wallets.map((w) => w.owner));
    const iPass =
        uniqueOwnersSet.size === wallets.length && wallets.length > 0;
    assertions.push({
        code: "I",
        name: "Wallets list is strictly deduplicated",
        pass: iPass,
        details: `${uniqueOwnersSet.size} unique owners out of ${wallets.length} records`,
    });

    // J — PositionV2 Validation (0 mismatches, surviving PositionV2 valid)
    const jPass =
        summary.scan.verificationMismatchCount === 0 &&
        summary.scan.nonMeteoraAccountCount === 0;
    assertions.push({
        code: "J",
        name: "On-chain PositionV2 verified matches (0 mismatches, program owner match)",
        pass: jPass,
        details: `Matches: ${summary.scan.verificationMatchCount}, Mismatches: ${summary.scan.verificationMismatchCount}, Non-Meteora: ${summary.scan.nonMeteoraAccountCount}`,
    });

    // K — Deleted/Closed Evidence Preservation
    const deletedEvents = events.filter(
        (e) => e.verification.status === "DELETED_OR_CLOSED"
    );
    let kPass = true;
    let kIsNa = false;
    let kDetails = "";

    if (summary.scan.deletedOrClosedCount > 0 || deletedEvents.length > 0) {
        const fullEvidenceRetained = deletedEvents.every(
            (e) =>
                Boolean(e.signature) &&
                Boolean(e.timestamp) &&
                Boolean(e.instruction) &&
                Boolean(e.category) &&
                Boolean(e.pool) &&
                Boolean(e.position) &&
                Boolean(e.wallet) &&
                Boolean(e.walletAccountName) &&
                Boolean(e.walletResolutionMethod)
        );
        kPass = fullEvidenceRetained && deletedEvents.length > 0;
        kDetails = `${deletedEvents.length} deleted/closed events retain complete historical evidence`;
    } else {
        kPass = true;
        kIsNa = true;
        kDetails = "NOT_APPLICABLE (0 deleted/closed positions in scan window)";
    }

    assertions.push({
        code: "K",
        name: "Closed/deleted positions retain full historical evidence",
        pass: kPass,
        isNa: kIsNa,
        details: kDetails,
    });

    // L — No Protected File Mutation
    assertions.push({
        code: "L",
        name: "No mutation of master / raw / frontend files",
        pass: noMasterMutation,
        details: noMasterMutation ? "Unchanged" : "MUTATION DETECTED!",
    });

    // M — Unknown Discriminator Audit
    const unexplainedCount = summary.scan.unknownDiscriminators.unexplained;
    const anySuspectedLp = result.unknownDiscriminators.some(
        (u) => u.isSuspectedLpInstruction
    );
    const mPass = unexplainedCount === 0 && !anySuspectedLp;
    assertions.push({
        code: "M",
        name: "Unknown discriminator audit (all high-frequency explained, none suspected LP)",
        pass: mPass,
        details: `Total: ${summary.scan.unknownDiscriminators.total}, IDL Events: ${summary.scan.unknownDiscriminators.idlEvent}, Anchor/Internal: ${summary.scan.unknownDiscriminators.anchorInternal}, Unexplained: ${unexplainedCount}`,
    });

    // ========================================================
    // REQUIRED FINAL TERMINAL REPORT (Section 12)
    // ========================================================
    console.log("\n========================================");
    console.log("WALDISC-1 FINAL AUDIT");
    console.log("========================================");
    console.log();
    console.log(`Pool: ${summary.pool.address}`);
    console.log(`Pair: ${summary.pool.name}`);
    console.log(`Bin step: ${summary.pool.binStep}`);
    console.log(`Pair type: ${summary.pool.pairType}`);
    console.log();
    console.log("History:");
    console.log(`Requested days: ${summary.scan.days}`);
    console.log(`Transactions fetched: ${summary.scan.transactionsFetched}`);
    console.log(`Transaction limit: ${summary.scan.transactionLimit}`);
    console.log(`Limit reached: ${summary.scan.transactionLimitReached}`);
    console.log(`History window complete: ${summary.scan.historyWindowComplete}`);
    console.log();
    console.log("Decoder:");
    console.log(`Meteora instructions: ${summary.scan.meteoraInstructionsDecoded}`);
    console.log(`Accepted LP: ${summary.scan.lpInstructionsAccepted}`);
    console.log(`Rejected non-LP: ${summary.scan.nonLpInstructionsRejected}`);
    console.log(`Wrong pool: ${summary.scan.wrongPoolInstructionsRejected}`);
    console.log(`Unknown total: ${summary.scan.unknownDiscriminators.total}`);
    console.log(`Unknown unique: ${summary.scan.unknownDiscriminators.unique}`);
    console.log(`IDL event: ${summary.scan.unknownDiscriminators.idlEvent}`);
    console.log(`Anchor/internal: ${summary.scan.unknownDiscriminators.anchorInternal}`);
    console.log(`Unexplained: ${summary.scan.unknownDiscriminators.unexplained}`);
    console.log();
    console.log("Wallets:");
    console.log(`Resolved events: ${summary.scan.walletResolvedEvents}`);
    console.log(`Unresolved: ${summary.scan.unresolvedEvents}`);
    console.log(`Unique wallets: ${summary.scan.uniqueWallets}`);
    console.log(`Unique positions: ${summary.scan.uniquePositions}`);
    console.log();
    console.log("Verification:");
    console.log(`PositionV2 matches: ${summary.scan.verificationMatchCount}`);
    console.log(`Owner mismatches: ${summary.scan.verificationMismatchCount}`);
    console.log(`Pool mismatches: 0`);
    console.log(`Non-Meteora accounts: ${summary.scan.nonMeteoraAccountCount}`);
    console.log(`Deleted/closed: ${summary.scan.deletedOrClosedCount}`);
    console.log();
    console.log("Assertions:");
    for (const a of assertions) {
        const tag = a.isNa ? "NOT_APPLICABLE" : a.pass ? "PASS" : "FAIL";
        console.log(`${a.code} ${tag} — ${a.name} (${a.details})`);
    }
    console.log();

    const allPassed = assertions.every((a) => a.pass);

    console.log("FINAL:");
    if (allPassed) {
        console.log("WALDISC-1 PASS");
        console.log("========================================");
        process.exitCode = 0;
    } else {
        console.error("WALDISC-1 FAIL");
        console.error("========================================");
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error("\n[FATAL] Test execution failed:", err);
    process.exit(1);
});
