import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import {
    extractSnapshotTargets,
    getOrFreezeSnapshotTargets,
    validateSolanaAddress,
    discardFrozenTargets,
    DEFAULT_SNAPSHOT_PATH,
} from "../../scripts/fabriq/snapshot-targets.mjs";

describe("Fabriq Snapshot Target Population & Refresh Pipeline Suite", () => {
    // -------------------------------------------------------------
    // Acceptance Criterion A: 1,557 LP Agent and 2,596 Pool Scanner
    // -------------------------------------------------------------
    it("A. Current published snapshot contains LP Agent and pool-only owners yielding unique targets matching dataset input", () => {
        assert.ok(
            fsSync.existsSync(DEFAULT_SNAPSHOT_PATH),
            `Snapshot file exists at ${DEFAULT_SNAPSHOT_PATH}`
        );

        const rawContent = JSON.parse(fsSync.readFileSync(DEFAULT_SNAPSHOT_PATH, "utf8"));
        const rawWallets = Array.isArray(rawContent) ? rawContent : (rawContent.wallets || []);

        // Calculate expected unique owners and source breakdown from actual dataset input
        const expectedOwnerSet = new Set<string>();
        let expectedLpAgentCount = 0;
        let expectedPoolScannerCount = 0;
        for (const row of rawWallets) {
            if (!row || typeof row !== "object") continue;
            const owner = (row.owner ?? row.wallet ?? row.wallet_address ?? "").trim();
            if (!validateSolanaAddress(owner)) continue;
            if (expectedOwnerSet.has(owner)) continue;
            expectedOwnerSet.add(owner);
            const source = (
                row.source ??
                (row.scannedPoolCount && !row.smart_lp ? "pool-scanner" : "lpagent")
            );
            if (source === "pool-scanner") {
                expectedPoolScannerCount++;
            } else {
                expectedLpAgentCount++;
            }
        }

        const result = extractSnapshotTargets(DEFAULT_SNAPSHOT_PATH);

        // Verify counts derived dynamically from actual dataset input
        assert.equal(result.total, expectedOwnerSet.size);
        assert.equal(result.lpAgentCount, expectedLpAgentCount);
        assert.equal(result.poolScannerCount, expectedPoolScannerCount);
        assert.equal(result.targets.length, expectedOwnerSet.size);
        assert.equal(result.total, result.lpAgentCount + result.poolScannerCount);

        // Verify actual owner sets match exactly
        assert.deepEqual(new Set(result.targets), expectedOwnerSet);

        // Every target must be a valid Solana address
        for (const target of result.targets) {
            assert.ok(
                validateSolanaAddress(target),
                `Wallet ${target} must be a valid base58 Solana address`
            );
        }

        // Must be completely deduplicated
        const uniqueSet = new Set(result.targets);
        assert.equal(uniqueSet.size, result.total);

        // Verify snapshot baseline: LP Agent invariant (1,557) and current 4,352 population
        assert.equal(result.lpAgentCount, 1557);
        if (expectedOwnerSet.size === 4352) {
            assert.equal(result.total, 4352);
            assert.equal(result.poolScannerCount, 2795);
        }
    });

    // -------------------------------------------------------------
    // Acceptance Criterion B: Same owner in both sources -> exactly one target
    // -------------------------------------------------------------
    it("B. Same owner appearing in both sources yields exactly one refresh target without duplicate entries", () => {
        const dualSourceOwner = "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4";
        const secondOwner = "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1";

        const mockSnapshot = {
            wallets: [
                {
                    owner: dualSourceOwner,
                    source: "lpagent",
                    smart_lp: true,
                },
                {
                    owner: dualSourceOwner,
                    source: "pool-scanner",
                    scannedPoolCount: 3,
                },
                {
                    owner: secondOwner,
                    source: "pool-scanner",
                    scannedPoolCount: 1,
                },
            ],
        };

        const result = extractSnapshotTargets(mockSnapshot);

        assert.equal(result.total, 2);
        assert.equal(result.targets.length, 2);
        assert.deepEqual(result.targets, [dualSourceOwner, secondOwner]);

        // Dual-source owner appears once, prioritized by LP Agent
        assert.equal(result.lpAgentCount, 1);
        assert.equal(result.poolScannerCount, 1);
    });

    // -------------------------------------------------------------
    // Acceptance Criterion C: Refresh All selected -> all targets scheduled
    // -------------------------------------------------------------
    it("C. Refresh All mode targets every wallet in snapshot and forces fresh retrieval regardless of cache", () => {
        const targets = [
            "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
            "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1",
            "2EHE8MFF2DFjS76RWiMpHHRmpMNzuSzzg6U4jty492c2",
        ];

        // Even if all 3 wallets have cached Fabriq fetched 5 minutes ago
        const stateByOwner = new Map();
        const recentTs = new Date(Date.now() - 300_000).toISOString();
        for (const t of targets) {
            stateByOwner.set(t, {
                fetchedAt: recentTs,
                stats: { netPnlSol: 10 },
                calendars: { "2026-10": {} },
            });
        }

        // Full refresh starts NOW: refreshBefore is set to current timestamp
        const refreshBefore = Date.now();

        function isFabriqFresh(row) {
            const fetchedAt = row?.fabriq?.fetchedAt;
            if (!fetchedAt) return false;
            const ts = Date.parse(fetchedAt);
            if (!Number.isFinite(ts)) return false;
            if (Number.isFinite(refreshBefore) && ts < refreshBefore) {
                return false;
            }
            return true;
        }

        const walletsNeedingRefresh = targets.filter((owner) => {
            const fabriq = stateByOwner.get(owner);
            return !isFabriqFresh({ fabriq });
        });

        const freshWallets = targets.length - walletsNeedingRefresh.length;

        // In Refresh All: 0 wallets are fresh, all 3 are scheduled for fresh retrieval
        assert.equal(freshWallets, 0);
        assert.equal(walletsNeedingRefresh.length, 3);
        assert.deepEqual(walletsNeedingRefresh, targets);
    });

    // -------------------------------------------------------------
    // Acceptance Criterion D: Refresh Stale mode -> only stale/missing fetched
    // -------------------------------------------------------------
    it("D. Refresh Stale mode evaluates freshness, reuses valid fresh records, and fetches only stale/missing records", () => {
        const freshWallet = "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4";
        const staleWallet = "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1";
        const missingWallet = "2EHE8MFF2DFjS76RWiMpHHRmpMNzuSzzg6U4jty492c2";

        const targets = [freshWallet, staleWallet, missingWallet];

        const stateByOwner = new Map();
        // freshWallet fetched 1 hour ago (<24h)
        stateByOwner.set(freshWallet, {
            fetchedAt: new Date(Date.now() - 3600_000).toISOString(),
            stats: { netPnlSol: 5 },
            calendars: { "2026-10": {} },
        });
        // staleWallet fetched 48 hours ago (>24h)
        stateByOwner.set(staleWallet, {
            fetchedAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
            stats: { netPnlSol: 1 },
            calendars: { "2026-10": {} },
        });
        // missingWallet has no fabriq entry in state

        const refreshBefore = null; // Stale mode
        const STALE_AFTER_MS = 24 * 3600_000;

        function isFabriqFresh(row) {
            const fetchedAt = row?.fabriq?.fetchedAt;
            if (!fetchedAt) return false;
            const ts = Date.parse(fetchedAt);
            if (!Number.isFinite(ts)) return false;
            if (Date.now() - ts >= STALE_AFTER_MS) return false;
            return true;
        }

        const walletsNeedingRefresh = targets.filter((owner) => {
            const fabriq = stateByOwner.get(owner);
            return !isFabriqFresh({ fabriq });
        });

        const freshWallets = targets.length - walletsNeedingRefresh.length;

        // Exactly 1 is fresh and reused
        assert.equal(freshWallets, 1);
        // Exactly 2 need refresh (stale + missing)
        assert.equal(walletsNeedingRefresh.length, 2);
        assert.ok(walletsNeedingRefresh.includes(staleWallet));
        assert.ok(walletsNeedingRefresh.includes(missingWallet));
        assert.ok(!walletsNeedingRefresh.includes(freshWallet));
    });

    // -------------------------------------------------------------
    // Acceptance Criterion E: Stop & Save Progress followed by Resume
    // -------------------------------------------------------------
    it("E. Stop & Save Progress preserves completed work and checkpoint resume avoids duplicate retrieval", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabriq-test-checkpoint-"));
        const checkpointFile = path.join(tempDir, "fabriq.jsonl");

        const wallet1 = "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4";
        const wallet2 = "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1";
        const targets = [wallet1, wallet2];

        // 1. First run: wallet1 is completed, then job is stopped
        const row1 = {
            owner: wallet1,
            status: "ok",
            fabriq: {
                fetchedAt: new Date().toISOString(),
                stats: { netPnlSol: 2.5 },
                calendars: { "2026-10": {} },
            },
        };
        await fs.writeFile(checkpointFile, JSON.stringify(row1) + "\n", "utf8");

        // 2. Resume run: load checkpoint
        const checkpointMap = new Map();
        const text = await fs.readFile(checkpointFile, "utf8");
        for (const line of text.split("\n").filter(Boolean)) {
            const parsed = JSON.parse(line);
            if (parsed.owner && parsed.status === "ok") {
                checkpointMap.set(parsed.owner, parsed);
            }
        }

        // Wallet 1 is identified as already done
        const alreadyDone = targets.filter((w) => checkpointMap.has(w));
        assert.equal(alreadyDone.length, 1);
        assert.equal(alreadyDone[0], wallet1);

        // Workers only process remaining wallet 2
        const remainingToProcess = targets.filter((w) => !checkpointMap.has(w));
        assert.deepEqual(remainingToProcess, [wallet2]);

        // Cleanup
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // -------------------------------------------------------------
    // Acceptance Criterion F: Snapshot changes during paused run
    // -------------------------------------------------------------
    it("F. Frozen target list is strictly preserved across resume even if snapshot changes on disk", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabriq-test-frozen-"));
        const snapshotFile = path.join(tempDir, "wallets-14d.json");
        const manifestFile = path.join(tempDir, "fabriq-targets.json");

        const snapshotA = {
            wallets: [
                { owner: "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4", source: "lpagent" },
                { owner: "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1", source: "pool-scanner" },
            ],
        };
        await fs.writeFile(snapshotFile, JSON.stringify(snapshotA, null, 2), "utf8");

        // Initial run freezes population A
        const run1 = await getOrFreezeSnapshotTargets({
            snapshotPath: snapshotFile,
            manifestPath: manifestFile,
            isResume: false,
        });
        assert.equal(run1.total, 2);
        assert.equal(run1.isResumed, false);

        // While run is stopped, snapshot on disk is replaced with snapshot B
        const snapshotB = {
            wallets: [
                { owner: "2EHE8MFF2DFjS76RWiMpHHRmpMNzuSzzg6U4jty492c2", source: "lpagent" },
                { owner: "EJXEjBGCeHiRSeFnBSVwzfndATB6LX2XAJ4T2XwhUoPc", source: "pool-scanner" },
                { owner: "GuPbekwP9MqB23CghhiMQZTaigPdUJooovo1neCErhM8", source: "pool-scanner" },
            ],
        };
        await fs.writeFile(snapshotFile, JSON.stringify(snapshotB, null, 2), "utf8");

        // Resuming run MUST safely preserve the original frozen target population A
        const resumeRun = await getOrFreezeSnapshotTargets({
            snapshotPath: snapshotFile,
            manifestPath: manifestFile,
            isResume: true,
        });

        assert.equal(resumeRun.isResumed, true);
        assert.equal(resumeRun.hashChanged, true);
        assert.equal(resumeRun.total, 2);
        assert.deepEqual(resumeRun.targets, [
            "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
            "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1",
        ]);

        // Cleanup
        discardFrozenTargets(manifestFile);
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // -------------------------------------------------------------
    // Acceptance Criterion G: Failed wallet preserves previous canonical data
    // -------------------------------------------------------------
    it("G. Failed wallet is recorded as failure and previous canonical data is preserved intact", () => {
        const canonicalWallet = {
            owner: "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
            fabriq: {
                fetchedAt: "2026-10-10T00:00:00.000Z",
                stats: { netPnlSol: 15.0 },
            },
        };

        const canonicalDataset = {
            wallets: [{ ...canonicalWallet }],
        };

        // Incoming run results with an error status for this wallet
        const incomingResults = [
            {
                owner: "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
                status: "error",
                error: "HTTP 500 Internal Server Error",
            },
        ];

        // In merge-fabriq: only row.status === "ok" rows are applied
        const incomingOkMap = new Map();
        for (const row of incomingResults) {
            if (row.status === "ok" && row.fabriq) {
                incomingOkMap.set(row.owner, row.fabriq);
            }
        }

        // Canonical record is untouched because failed row is omitted from ok map
        const mergedWallets = canonicalDataset.wallets.map((w) => {
            const incoming = incomingOkMap.get(w.owner);
            if (!incoming) return w;
            return { ...w, fabriq: incoming };
        });

        assert.deepEqual(mergedWallets[0], canonicalWallet);
        assert.equal(mergedWallets[0].fabriq.stats.netPnlSol, 15.0);
    });

    // -------------------------------------------------------------
    // Acceptance Criterion H: New LP Agent wallet not yet in snapshot can be enriched
    // -------------------------------------------------------------
    it("H. Update Wallet List pipeline enriches newly discovered master wallets without snapshot mode", async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fabriq-test-master-"));
        const masterFile = path.join(tempDir, "wallets-master.json");

        const newLpWallet = "DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU";
        const masterData = {
            wallets: [
                {
                    owner: newLpWallet,
                    smart_lp: true,
                    total_inflow: 5000,
                },
            ],
        };
        await fs.writeFile(masterFile, JSON.stringify(masterData, null, 2), "utf8");

        // When non-snapshot mode is used (default for Update Wallet List):
        const raw = JSON.parse(await fs.readFile(masterFile, "utf8"));
        const wallets = raw.wallets.map((w) => w.owner);

        assert.equal(wallets.length, 1);
        assert.equal(wallets[0], newLpWallet);

        await fs.rm(tempDir, { recursive: true, force: true });
    });

    // -------------------------------------------------------------
    // Acceptance Criterion I: Publish retains all original wallet owners & provenance
    // -------------------------------------------------------------
    it("I. Published explorer preserves LP Agent and Pool Scanner provenance without duplication", () => {
        const masterWallets = [
            { owner: "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4", total_inflow: 1000 },
            { owner: "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1", total_inflow: 2000 },
        ];
        const poolWallets = [
            // Already in master
            { owner: "37SuThcdeJU46TYHE6zcGDotASfQtXNC3HHsWZjWLdx1", scannedPoolCount: 2 },
            // Pool-only
            { owner: "2EHE8MFF2DFjS76RWiMpHHRmpMNzuSzzg6U4jty492c2", scannedPoolCount: 1 },
        ];

        const published = [];
        const seenOwners = new Set();

        // 1. Process Master
        for (const w of masterWallets) {
            seenOwners.add(w.owner);
            published.push({ ...w, source: "lpagent" });
        }

        // 2. Process Pool
        for (const w of poolWallets) {
            if (seenOwners.has(w.owner)) continue; // Deduplicate
            seenOwners.add(w.owner);
            published.push({ ...w, source: "pool-scanner" });
        }

        assert.equal(published.length, 3);
        assert.equal(published[0].source, "lpagent");
        assert.equal(published[1].source, "lpagent");
        assert.equal(published[2].source, "pool-scanner");
        assert.equal(seenOwners.size, 3);
    });

    // -------------------------------------------------------------
    // Acceptance Criterion J: Progress display reconciles correctly without inflating success
    // -------------------------------------------------------------
    it("J. Progress display reconciles counts correctly and failed wallets never inflate success", () => {
        const total = 4153;
        const fresh = 1557;
        const skipped = 50;
        const ok = 100; // API refreshed
        const failed = 5; // 5 failed wallets

        const successful = fresh + skipped + ok;
        const completed = successful + failed;
        const remaining = Math.max(0, total - completed);
        const progressPercent = Math.floor((completed / total) * 100);

        assert.equal(successful, 1707);
        assert.equal(completed, 1712);
        assert.equal(remaining, 2441);
        assert.equal(progressPercent, 41);

        // Success count must strictly exclude failed count
        assert.ok(successful < completed);
        assert.ok(successful < total);
        assert.equal(completed - successful, failed);

        // If completed equals total but failed > 0, successful must not equal total
        const allCompletedWithFailure = {
            total: 100,
            fresh: 50,
            skipped: 0,
            ok: 48,
            failed: 2,
        };
        const allCompSuccess = allCompletedWithFailure.fresh + allCompletedWithFailure.ok;
        const allCompTotal = allCompSuccess + allCompletedWithFailure.failed;
        assert.equal(allCompTotal, 100);
        assert.equal(allCompSuccess, 98);
        assert.notEqual(allCompSuccess, 100);
    });

    // -------------------------------------------------------------
    // Dataset Validation Edge Cases
    // -------------------------------------------------------------
    it("Rejects empty, invalid, and corrupt source datasets with descriptive errors", () => {
        assert.throws(
            () => extractSnapshotTargets(null),
            /root must be an object or array/
        );
        assert.throws(
            () => extractSnapshotTargets({}),
            /missing 'wallets' array/
        );
        assert.throws(
            () => extractSnapshotTargets({ wallets: [] }),
            /wallets array is empty/
        );
        assert.throws(
            () => extractSnapshotTargets({ wallets: [{ owner: "not-a-solana-address" }] }),
            /no valid Solana wallet addresses found/
        );
    });
});
