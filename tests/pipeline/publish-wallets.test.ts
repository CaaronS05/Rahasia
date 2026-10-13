import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishWallets } from "../../scripts/pipeline/publish-wallets.ts";

describe("publishWallets Pipeline Suite", () => {
    it("supports isolated output path and produces valid snapshot", async () => {
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), "publish-wallets-test-"));
        try {
            const outputPath = path.join(tmpDir, "preview-wallets.json");
            const result = await publishWallets({ outputPath });

            assert.ok(result.publishedCount > 0, "publishedCount must be > 0");
            assert.ok(result.masterCount > 0, "masterCount must be > 0");
            assert.equal(result.targetPath, outputPath);
            assert.equal(result.dryRun, false);

            const raw = await readFile(outputPath, "utf8");
            const data = JSON.parse(raw);

            assert.ok(Array.isArray(data.wallets), "wallets must be an array");
            assert.equal(data.wallets.length, result.publishedCount);
            assert.ok(data.meta, "meta object must exist");
            assert.equal(data.meta.totalUniqueWallets, result.publishedCount);

            // Pool-only wallet check: metrics must be strictly null, never zero
            const poolOnly = data.wallets.find((w: { source: string }) => w.source === "pool-scanner");
            if (poolOnly) {
                assert.equal(poolOnly.total_pool, null, "total_pool must remain null");
                assert.equal(poolOnly.closed_lp, null, "closed_lp must remain null");
                assert.equal(poolOnly.apr, null, "apr must remain null");
                assert.equal(poolOnly.roi, null, "roi must remain null");
            }
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });

    it("dry-run mode executes calculations without writing to target path", async () => {
        const tmpDir = await mkdtemp(path.join(os.tmpdir(), "publish-wallets-dryrun-"));
        try {
            const nonExistentPath = path.join(tmpDir, "nonexistent-wallets.json");
            const result = await publishWallets({ outputPath: nonExistentPath, dryRun: true });

            assert.ok(result.publishedCount > 0);
            assert.equal(result.dryRun, true);

            await assert.rejects(
                () => readFile(nonExistentPath, "utf8"),
                /ENOENT/,
                "File must not be created during dry-run",
            );
        } finally {
            await rm(tmpDir, { recursive: true, force: true });
        }
    });
});
