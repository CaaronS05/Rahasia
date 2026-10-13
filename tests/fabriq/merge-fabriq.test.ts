import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeFabriqPayloads } from "../../scripts/pipeline/merge-fabriq.ts";
describe("mergeFabriqPayloads Safety Suite", () => {
    const OWNER_A = "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4";
    const OWNER_B = "6PHvGJZHs3zrC9AwvQ8VD3ahWyNGhGhosQirf86cbSPw";

    it("preserves _local and any wallet metadata outside owner, fabriq, and _local on update", () => {
        const canonical = {
            version: "v1",
            updatedAt: "2026-10-12T05:00:00.000Z",
            walletCount: 1,
            wallets: [
                {
                    owner: OWNER_A,
                    source: "lpagent",
                    customTag: "tier-1",
                    _discovery: { pools: ["pool1"] },
                    _local: { firstSeenAt: "2026-10-01T00:00:00.000Z", scrapeCount: 3 },
                    fabriq: {
                        fetchedAt: "2026-10-12T05:00:00.000Z",
                        stats: { netPnlSol: 10, totalPositions: 5 },
                        calendars: {
                            "2026-09": { "2026-09-15": { pnlSol: 2 } },
                        },
                    },
                },
            ],
        };

        const incoming = {
            generatedAt: "2026-10-12T18:00:00.000Z",
            results: [
                {
                    owner: OWNER_A,
                    status: "ok",
                    poolLocalMetricShouldNotLeak: 999,
                    fabriq: {
                        fetchedAt: "2026-10-12T18:00:00.000Z",
                        stats: { netPnlSol: 15, totalPositions: 7 },
                        calendars: {
                            "2026-10": { "2026-10-12": { pnlSol: 5 } },
                        },
                    },
                },
            ],
        };

        const res = mergeFabriqPayloads(canonical, incoming);
        assert.equal(res.updated, 1);
        assert.equal(res.added, 0);

        const mergedWallet = res.outputPayload.wallets[0];
        assert.equal(mergedWallet.owner, OWNER_A);
        assert.equal(mergedWallet.source, "lpagent");
        assert.equal(mergedWallet.customTag, "tier-1");
        assert.deepEqual(mergedWallet._discovery, { pools: ["pool1"] });
        assert.deepEqual(mergedWallet._local, { firstSeenAt: "2026-10-01T00:00:00.000Z", scrapeCount: 3 });
        assert.equal("poolLocalMetricShouldNotLeak" in mergedWallet, false);
        assert.equal(mergedWallet.fabriq.stats.netPnlSol, 15);
        assert.deepEqual(mergedWallet.fabriq.calendars, {
            "2026-09": { "2026-09-15": { pnlSol: 2 } },
            "2026-10": { "2026-10-12": { pnlSol: 5 } },
        });
    });

    it("rejects stale incoming records when incoming fetchedAt is older than canonical", () => {
        const canonical = {
            version: "v1",
            updatedAt: "2026-10-12T18:00:00.000Z",
            walletCount: 1,
            wallets: [
                {
                    owner: OWNER_A,
                    fabriq: {
                        fetchedAt: "2026-10-12T18:00:00.000Z",
                        stats: { netPnlSol: 25 },
                        calendars: { "2026-10": { "2026-10-12": { pnlSol: 25 } } },
                    },
                },
            ],
        };

        const incoming = {
            results: [
                {
                    owner: OWNER_A,
                    status: "ok",
                    fabriq: {
                        fetchedAt: "2026-10-12T12:00:00.000Z",
                        stats: { netPnlSol: 10 },
                        calendars: { "2026-10": { "2026-10-12": { pnlSol: 10 } } },
                    },
                },
            ],
        };

        const res = mergeFabriqPayloads(canonical, incoming);
        assert.equal(res.staleSkipped, 1);
        assert.equal(res.unchanged, 1);
        assert.equal(res.updated, 0);
        assert.equal(res.isContentChanged, false);
        assert.equal(res.outputPayload.wallets[0].fabriq.stats.netPnlSol, 25);
    });

    it("deduplicates duplicate incoming owners by selecting newest timestamp regardless of array order", () => {
        const canonical = { version: "v1", updatedAt: "", walletCount: 0, wallets: [] };

        // Newer entry first, older entry second (with an extra historical month)
        const incoming = {
            results: [
                {
                    owner: OWNER_A,
                    status: "ok",
                    fabriq: {
                        fetchedAt: "2026-10-12T17:54:34.070Z",
                        stats: { netPnlSol: 50 },
                        calendars: { "2026-10": { "2026-10-12": { pnlSol: 50 } } },
                    },
                },
                {
                    owner: OWNER_A,
                    status: "ok",
                    fabriq: {
                        fetchedAt: "2026-10-12T12:27:06.983Z",
                        stats: { netPnlSol: 10 },
                        calendars: {
                            "2026-06": { "2026-06-30": { pnlSol: 3 } },
                            "2026-10": { "2026-10-12": { pnlSol: 10 } },
                        },
                    },
                },
            ],
        };

        const res = mergeFabriqPayloads(canonical, incoming);
        assert.equal(res.incomingOk, 2);
        assert.equal(res.incomingUnique, 1);
        assert.equal(res.added, 1);

        const w = res.outputPayload.wallets[0];
        assert.equal(w.fabriq.fetchedAt, "2026-10-12T17:54:34.070Z");
        assert.equal(w.fabriq.stats.netPnlSol, 50);
        assert.deepEqual(w.fabriq.calendars["2026-06"], { "2026-06-30": { pnlSol: 3 } });
        assert.deepEqual(w.fabriq.calendars["2026-10"], { "2026-10-12": { pnlSol: 50 } });
    });

    it("handles invalid timestamps safely and achieves strict second-run idempotency", () => {
        const canonical = {
            version: "v1",
            updatedAt: "2026-10-12T05:00:00.000Z",
            walletCount: 1,
            wallets: [
                {
                    owner: OWNER_A,
                    fabriq: {
                        fetchedAt: "2026-10-12T05:00:00.000Z",
                        stats: { netPnlSol: 10 },
                        calendars: { "2026-10": { "2026-10-10": { pnlSol: 10 } } },
                    },
                },
            ],
        };

        const incoming = {
            generatedAt: "2026-10-12T19:00:00.000Z",
            results: [
                {
                    owner: OWNER_A,
                    status: "ok",
                    fabriq: {
                        fetchedAt: "not-a-valid-timestamp",
                        stats: { netPnlSol: 999 },
                        calendars: { "2026-10": { "2026-10-11": { pnlSol: 4 } } },
                    },
                },
                {
                    owner: OWNER_B,
                    status: "ok",
                    fabriq: {
                        fetchedAt: "2026-10-12T19:00:00.000Z",
                        stats: { netPnlSol: 8 },
                        calendars: { "2026-10": { "2026-10-12": { pnlSol: 8 } } },
                    },
                },
            ],
        };

        const run1 = mergeFabriqPayloads(canonical, incoming);
        assert.equal(run1.timestampUnsafe, 1);
        assert.equal(run1.added, 1);
        assert.equal(run1.updated, 1);

        const walletA = run1.outputPayload.wallets.find((w: any) => w.owner === OWNER_A);
        // Valid canonical timestamp and stats must not be overwritten by invalid timestamp row
        assert.equal(walletA.fabriq.fetchedAt, "2026-10-12T05:00:00.000Z");
        assert.equal(walletA.fabriq.stats.netPnlSol, 10);
        // Non-destructive calendar addition is preserved
        assert.deepEqual(walletA.fabriq.calendars["2026-10"]["2026-10-11"], { pnlSol: 4 });

        // Second merge with identical incoming payload must be a complete no-op
        const run2 = mergeFabriqPayloads(run1.outputPayload, incoming);
        assert.equal(run2.added, 0);
        assert.equal(run2.updated, 0);
        assert.equal(run2.unchanged, 2);
        assert.equal(run2.isContentChanged, false);
        assert.deepEqual(run2.outputPayload, run1.outputPayload);
    });

    it("honors FABRIQ_INPUT_PATH and FABRIQ_CANONICAL_PATH in CLI execution", () => {
        const tempDir = mkdtempSync(path.join(tmpdir(), "merge-fabriq-test-"));
        try {
            const mockCanonicalPath = path.join(tempDir, "canonical.json");
            const mockInputPath = path.join(tempDir, "input.json");

            writeFileSync(
                mockCanonicalPath,
                JSON.stringify({
                    version: "v1",
                    updatedAt: "2026-10-12T00:00:00.000Z",
                    walletCount: 1,
                    wallets: [{ owner: OWNER_A, fabriq: { fetchedAt: "2026-10-12T00:00:00.000Z" } }],
                }),
            );

            writeFileSync(
                mockInputPath,
                JSON.stringify({
                    version: "v1",
                    results: [
                        {
                            owner: OWNER_A,
                            status: "ok",
                            fabriq: { fetchedAt: "2026-10-12T01:00:00.000Z", stats: { netPnlSol: 1 } },
                        },
                    ],
                }),
            );

            const output = execFileSync(
                process.execPath,
                ["--experimental-strip-types", "scripts/pipeline/merge-fabriq.ts", "--dry-run"],
                {
                    env: {
                        ...process.env,
                        FABRIQ_INPUT_PATH: mockInputPath,
                        FABRIQ_CANONICAL_PATH: mockCanonicalPath,
                    },
                    encoding: "utf8",
                },
            );

            assert.match(output, /FABRIQ CANONICAL MERGE DRY RUN/);
            assert.match(output, new RegExp(mockInputPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            assert.match(output, /INCOMING UNIQUE:\n1/);
            assert.match(output, /UPDATED:\n1/);
            assert.match(output, /WALLETS-MASTER WRITTEN:\nNO/);
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
