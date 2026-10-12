import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
    selectBatchTargets,
    extractSnapshotTargets,
    validateSolanaAddress,
} from "../../scripts/fabriq/snapshot-targets.mjs";

function makeBase58(index, prefix = "test") {
    const b58Chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let str = prefix;
    let n = index;
    while (str.length < 44) {
        str += b58Chars[n % b58Chars.length];
        n = Math.floor(n / b58Chars.length) + 1;
    }
    return str;
}

describe("selectBatchTargets Suite", () => {
    const SNAPSHOT_PATH = path.resolve("frontend/public/data/wallets-14d.json");

    it("deterministically partitions snapshot targets into disjoint batches", () => {
        const dummySnapshot = {
            wallets: Array.from({ length: 600 }, (_, i) => ({
                owner: makeBase58(i, "Dummy"),
            })),
        };

        const batch0 = selectBatchTargets({
            snapshotSource: dummySnapshot,
            batchSize: 200,
            batchIndex: 0,
        });

        const batch1 = selectBatchTargets({
            snapshotSource: dummySnapshot,
            batchSize: 200,
            batchIndex: 1,
        });

        const batch2 = selectBatchTargets({
            snapshotSource: dummySnapshot,
            batchSize: 200,
            batchIndex: 2,
        });

        assert.equal(batch0.batchCount, 200);
        assert.equal(batch1.batchCount, 200);
        assert.equal(batch2.batchCount, 200);
        assert.equal(batch0.totalEligible, 600);

        // Zero intersection
        const set0 = new Set(batch0.targets);
        const set1 = new Set(batch1.targets);
        const set2 = new Set(batch2.targets);

        for (const t of batch1.targets) {
            assert.ok(!set0.has(t), "Batch 1 overlaps with Batch 0");
        }
        for (const t of batch2.targets) {
            assert.ok(!set0.has(t), "Batch 2 overlaps with Batch 0");
            assert.ok(!set1.has(t), "Batch 2 overlaps with Batch 1");
        }
    });

    it("strictly excludes specified previous wallets", () => {
        const addrA = makeBase58(1, "WAtA");
        const addrB = makeBase58(2, "WAtB");
        const addrC = makeBase58(3, "WAtC");
        const addrD = makeBase58(4, "WAtD");

        const dummySnapshot = {
            wallets: [
                { owner: addrA },
                { owner: addrB },
                { owner: addrC },
                { owner: addrD },
            ],
        };

        const excluded = [addrA, { owner: addrB }];

        const res = selectBatchTargets({
            snapshotSource: dummySnapshot,
            batchSize: 2,
            batchIndex: 0,
            excludeWallets: excluded,
        });

        assert.equal(res.totalEligible, 2);
        assert.equal(res.batchCount, 2);
        assert.deepEqual(res.targets, [addrC, addrD]);
    });

    it("selects exactly 250 distinct valid addresses for Stage D1 from production snapshot", () => {
        const canary = ["DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"];
        const prevFiles = [
            "data/bench/fabriq-batch/batch-wallets.json",
            "data/bench/fabriq-stage-b/batch-wallets.json",
            "data/bench/fabriq-stage-c/batch-wallets.json",
        ];
        const prevWallets = [...canary];
        for (const file of prevFiles) {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            for (const item of parsed) {
                prevWallets.push(item.owner || item);
            }
        }

        const d1 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 0,
            excludeWallets: prevWallets,
        });

        const d2 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 1,
            excludeWallets: prevWallets,
        });

        assert.equal(d1.batchCount, 250);
        assert.equal(d2.batchCount, 250);

        // Every address is valid Solana address
        for (const addr of d1.targets) {
            assert.ok(validateSolanaAddress(addr), `Invalid Solana address: ${addr}`);
        }
        for (const addr of d2.targets) {
            assert.ok(validateSolanaAddress(addr), `Invalid Solana address: ${addr}`);
        }

        // Distinct addresses
        assert.equal(new Set(d1.targets).size, 250);
        assert.equal(new Set(d2.targets).size, 250);

        // Zero overlap between D1 and previous stages
        const prevSet = new Set(prevWallets);
        for (const addr of d1.targets) {
            assert.ok(!prevSet.has(addr), `D1 contains previous wallet: ${addr}`);
        }

        // Zero overlap between D1 and D2
        const d1Set = new Set(d1.targets);
        for (const addr of d2.targets) {
            assert.ok(!d1Set.has(addr), `D2 overlaps with D1: ${addr}`);
        }
    });

    it("selects exactly 250 distinct valid addresses for Stage D3 with Strategy A/B parity and zero overlap", () => {
        const canary = ["DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"];
        const prevFiles = [
            "data/bench/fabriq-batch/batch-wallets.json",
            "data/bench/fabriq-stage-b/batch-wallets.json",
            "data/bench/fabriq-stage-c/batch-wallets.json",
        ];
        const prevWallets = [...canary];
        for (const file of prevFiles) {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            for (const item of parsed) {
                prevWallets.push(item.owner || item);
            }
        }

        const d1 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 0,
            excludeWallets: prevWallets,
        });

        const d2 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 1,
            excludeWallets: prevWallets,
        });

        // Strategy A: Frozen initial exclusion set + batchIndex=2 [500, 750)
        const d3A = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 2,
            excludeWallets: prevWallets,
        });

        // Strategy B: Cumulative exclusion set + batchIndex=0
        const cumulativeExcluded = [
            ...prevWallets,
            ...d1.targets,
            ...d2.targets,
        ];
        const d3B = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 0,
            excludeWallets: cumulativeExcluded,
        });

        assert.equal(d3A.batchCount, 250);
        assert.equal(d3B.batchCount, 250);
        assert.equal(d3A.startIndex, 500);
        assert.equal(d3A.endIndex, 750);

        // Parity
        assert.deepEqual(d3A.targets, d3B.targets);

        // Boundary addresses
        assert.equal(d3A.targets[0], "Eh7TonnqPTyQMFiQkMZag2wxJMXwm3YLo5xkGX8DXQZr");
        assert.equal(d3A.targets[249], "CoT18QN29toTbNHKEBviSwwqKNAQgPAtg6tERMY8Mgjh");

        // Address validity
        for (const addr of d3A.targets) {
            assert.ok(validateSolanaAddress(addr), `Invalid Solana address: ${addr}`);
        }

        // Distinct addresses
        assert.equal(new Set(d3A.targets).size, 250);

        // Zero overlap with all prior stages
        const priorSet = new Set(cumulativeExcluded);
        for (const addr of d3A.targets) {
            assert.ok(!priorSet.has(addr), `D3 overlaps with prior stages: ${addr}`);
        }
    });
    it("selects exactly 250 distinct valid addresses for Stage D4 with Strategy A/B parity and zero overlap", () => {
        const canary = ["DicCKYqkhbfJYYMaEH82H5kpJ7nUu7vp4VLefZnTRfsU"];
        const prevFiles = [
            "data/bench/fabriq-batch/batch-wallets.json",
            "data/bench/fabriq-stage-b/batch-wallets.json",
            "data/bench/fabriq-stage-c/batch-wallets.json",
        ];
        const prevWallets = [...canary];
        for (const file of prevFiles) {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            for (const item of parsed) {
                prevWallets.push(item.owner || item);
            }
        }

        const d1 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 0,
            excludeWallets: prevWallets,
        });

        const d2 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 1,
            excludeWallets: prevWallets,
        });

        const d3 = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 2,
            excludeWallets: prevWallets,
        });

        // Strategy A: Initial exclusion set + batchIndex=3 [750, 1000)
        const d4A = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 3,
            excludeWallets: prevWallets,
        });

        // Strategy B: Cumulative exclusion set + batchIndex=0 [0, 250)
        const cumulativeExcluded = [
            ...prevWallets,
            ...d1.targets,
            ...d2.targets,
            ...d3.targets,
        ];
        const d4B = selectBatchTargets({
            snapshotSource: SNAPSHOT_PATH,
            batchSize: 250,
            batchIndex: 0,
            excludeWallets: cumulativeExcluded,
        });

        assert.equal(d4A.batchCount, 250);
        assert.equal(d4B.batchCount, 250);
        assert.equal(d4A.startIndex, 750);
        assert.equal(d4A.endIndex, 1000);

        // Parity
        assert.deepEqual(d4A.targets, d4B.targets);

        // Boundary addresses
        assert.equal(d4A.targets[0], "BXsx1EzoXXGNznzW4TVMMXhyAWbiFAzcRGAmT2fdxGAF");
        assert.equal(d4A.targets[249], "CaEXATaWNGWFVZ92awwsJYfGHCSMFSA1nLfaYJfHFocn");

        // Address validity
        for (const addr of d4A.targets) {
            assert.ok(validateSolanaAddress(addr), `Invalid Solana address: ${addr}`);
        }

        // Distinct addresses
        assert.equal(new Set(d4A.targets).size, 250);

        // Zero overlap with all prior stages
        const priorSet = new Set(cumulativeExcluded);
        for (const addr of d4A.targets) {
            assert.ok(!priorSet.has(addr), `D4 overlaps with prior stages: ${addr}`);
        }
    });
});
