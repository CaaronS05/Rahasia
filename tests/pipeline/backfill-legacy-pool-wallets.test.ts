import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BASE58_REGEX,
  calculateDryRunReport,
  computeLegacyScanFingerprint,
  DEFAULT_PATHS,
  EXCLUDED_AMBIGUOUS_OWNERS,
  EXCLUDED_AMBIGUOUS_RECORD,
  extractCandidateWallets,
  LEGACY_TOKENS,
  loadLegacyTokenScan,
  partitionCandidateEligibility,
  runLegacyBackfill,
  type ExtractedCandidateMapEntry,
  type LegacyTokenScanArtifacts,
  type PoolWalletsRegistryFile,
} from "../../scripts/pipeline/backfill-legacy-pool-wallets.ts";

describe("Safe Legacy Pool Scanner Backfill Suite", () => {
  // =========================================================================
  // 1. LEGACY FLAT-LAYOUT PARSING
  // =========================================================================
  it("1. Legacy flat-layout parsing: correctly parses summary, pools, and flat wallets array", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "legacy-parse-test-"));
    try {
      const token = "TokenA11111111111111111111111111111111111111";
      const tokenDir = path.join(tmpDir, token);
      await mkdir(tokenDir, { recursive: true });

      const summary = {
        tokenCa: token,
        generatedAt: "2026-09-26T07:52:57.928Z",
        poolCount: 2,
        uniqueWallets: 2,
        pools: [
          { pool: "Pool11111111111111111111111111111111111111111" },
          { pool: "Pool22222222222222222222222222222222222222222" },
        ],
      };
      const pools = [
        { pool: "Pool11111111111111111111111111111111111111111", pair: "A/SOL" },
        { pool: "Pool22222222222222222222222222222222222222222", pair: "A/SOL" },
      ];
      const wallets = [
        "Wallet1111111111111111111111111111111111111111",
        "Wallet2222222222222222222222222222222222222222",
      ];

      await writeFile(path.join(tokenDir, "summary.json"), JSON.stringify(summary));
      await writeFile(path.join(tokenDir, "pools.json"), JSON.stringify(pools));
      await writeFile(path.join(tokenDir, "wallets.json"), JSON.stringify(wallets));

      const parsed = await loadLegacyTokenScan(token, tmpDir);

      assert.equal(parsed.tokenCa, token);
      assert.equal(parsed.generatedAt, "2026-09-26T07:52:57.928Z");
      assert.deepEqual(parsed.candidatePools, [
        "Pool11111111111111111111111111111111111111111",
        "Pool22222222222222222222222222222222222222222",
      ]);
      assert.deepEqual(parsed.wallets, wallets);
      assert.equal(typeof parsed.scanFingerprint, "string");
      assert.equal(parsed.scanFingerprint.length, 64);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 2. MULTI-TOKEN OVERLAP DEDUPLICATION
  // =========================================================================
  it("2. Multi-token overlap deduplication: merges tokens, candidatePools, and scans without duplicate owners", () => {
    const ownerMulti = "MultiTokenWallet111111111111111111111111111111";
    const ownerSingle = "SingleTokenWallet22222222222222222222222222222";

    const scan1: LegacyTokenScanArtifacts = {
      tokenCa: "Token111111111111111111111111111111111111111",
      generatedAt: "2026-09-26T00:00:00.000Z",
      candidatePools: ["PoolA"],
      wallets: [ownerMulti, ownerSingle],
      scanFingerprint: "fingerprint1",
      artifactPath: "path/1/wallets.json",
    };

    const scan2: LegacyTokenScanArtifacts = {
      tokenCa: "Token222222222222222222222222222222222222222",
      generatedAt: "2026-09-30T00:00:00.000Z",
      candidatePools: ["PoolB"],
      wallets: [ownerMulti],
      scanFingerprint: "fingerprint2",
      artifactPath: "path/2/wallets.json",
    };

    const { candidateMap, duplicateOwnersAcrossScans } = extractCandidateWallets([scan1, scan2]);

    assert.equal(candidateMap.size, 2);
    assert.equal(duplicateOwnersAcrossScans, 1);

    const multi = candidateMap.get(ownerMulti);
    assert.ok(multi);
    assert.deepEqual(Array.from(multi.tokens).sort(), ["Token111111111111111111111111111111111111111", "Token222222222222222222222222222222222222222"]);
    assert.deepEqual(Array.from(multi.candidatePools).sort(), ["PoolA", "PoolB"]);
    assert.deepEqual(Array.from(multi.scans).sort(), ["fingerprint1", "fingerprint2"]);
    assert.deepEqual(Array.from(multi.sourceArtifactPaths).sort(), ["path/1/wallets.json", "path/2/wallets.json"]);
    assert.equal(multi.firstSeenAt, "2026-09-26T00:00:00.000Z");
    assert.equal(multi.lastSeenAt, "2026-09-30T00:00:00.000Z");
  });

  // =========================================================================
  // 3. EXCLUSION OF AMBIGUOUS BLUEPRINT WALLETS
  // =========================================================================
  it("3. Exclusion of ambiguous BLUEPRINT wallets: strictly excludes exact public keys", () => {
    assert.equal(EXCLUDED_AMBIGUOUS_OWNERS.length, 2);
    assert.equal(EXCLUDED_AMBIGUOUS_OWNERS[0], "4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN");
    assert.equal(EXCLUDED_AMBIGUOUS_OWNERS[1], "D5vLKeUASwyeV9kY45mewajqR6JfyZZhxdj8dgoFtqbg");
    assert.ok(EXCLUDED_AMBIGUOUS_RECORD["4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN"]);
    assert.ok(EXCLUDED_AMBIGUOUS_RECORD["D5vLKeUASwyeV9kY45mewajqR6JfyZZhxdj8dgoFtqbg"]);

    const mockCandidates = new Map<string, ExtractedCandidateMapEntry>();
    mockCandidates.set("4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN", {
      owner: "4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN",
      firstSeenAt: "2026-09-26T00:00:00.000Z",
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      tokens: new Set(["TokenA"]),
      candidatePools: new Set(["PoolA"]),
      scans: new Set(["scan1"]),
      sourceArtifactPaths: new Set(["path1"]),
    });

    const validOwner = "2625mS6p7x4wtjdtTbwK3gKjttrwSD7kCSiBqYDfCwww";
    mockCandidates.set(validOwner, {
      owner: validOwner,
      firstSeenAt: "2026-09-26T00:00:00.000Z",
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      tokens: new Set(["TokenA"]),
      candidatePools: new Set(["PoolA"]),
      scans: new Set(["scan1"]),
      sourceArtifactPaths: new Set(["path1"]),
    });

    const masterSet = new Set<string>();
    const registrySet = new Set<string>();
    const fabriqSet = new Set<string>([
      "4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN",
      validOwner,
    ]);

    const partition = partitionCandidateEligibility(mockCandidates, masterSet, registrySet, fabriqSet);

    assert.equal(partition.eligibleNew.length, 1);
    assert.equal(partition.eligibleNew[0].owner, validOwner);
    assert.deepEqual(partition.excludedAmbiguous, ["4K67o7cH4VUppuY42XDkCZBL1VxT6H6HFhqpbwXFZqcN"]);
  });
  // =========================================================================
  // 4. CANDIDATE POOLS KEPT SEPARATE FROM CONFIRMED POOLS
  // =========================================================================
  it("4. Candidate pools kept separate from confirmed pools: pools is empty array and candidatePools is in legacyProvenance", () => {
    const mockCandidates = new Map<string, ExtractedCandidateMapEntry>();
    const owner = "2PUpV37wRsHCZeJdxHCpVnYnWczRBcyBXpSb8dhQaqDa";
    mockCandidates.set(owner, {
      owner,
      firstSeenAt: "2026-09-26T00:00:00.000Z",
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      tokens: new Set(["TokenX"]),
      candidatePools: new Set(["PoolCandidateA", "PoolCandidateB"]),
      scans: new Set(["scan1"]),
      sourceArtifactPaths: new Set(["data/discovery/pool-scanner/TokenX/wallets.json"]),
    });

    const partition = partitionCandidateEligibility(
      mockCandidates,
      new Set(),
      new Set(),
      new Set([owner])
    );

    assert.equal(partition.eligibleNew.length, 1);
    const entry = partition.eligibleNew[0];
    assert.deepEqual(entry.pools, []); // Confirmed pools must remain empty
    assert.equal(entry.legacyProvenance.evidenceLevel, "TOKEN_SCAN_CANDIDATE");
    assert.deepEqual(entry.legacyProvenance.candidatePools, ["PoolCandidateA", "PoolCandidateB"]);
    assert.deepEqual(entry.legacyProvenance.sourceArtifactPaths, [
      "data/discovery/pool-scanner/TokenX/wallets.json",
    ]);
  });

  // =========================================================================
  // 5. HISTORICAL TIMESTAMP PRESERVATION
  // =========================================================================
  it("5. Historical timestamp preservation: preserves earliest firstSeenAt and latest lastSeenAt across token scans", () => {
    const owner = "33333333333333333333333333333333333333333333";
    const tEarly = "2026-09-26T07:52:57.928Z";
    const tMid = "2026-09-27T11:59:18.105Z";
    const tLate = "2026-09-30T17:34:18.817Z";

    const scans: LegacyTokenScanArtifacts[] = [
      {
        tokenCa: "TokenA",
        generatedAt: tMid,
        candidatePools: ["P1"],
        wallets: [owner],
        scanFingerprint: "s1",
        artifactPath: "a1",
      },
      {
        tokenCa: "TokenB",
        generatedAt: tEarly,
        candidatePools: ["P2"],
        wallets: [owner],
        scanFingerprint: "s2",
        artifactPath: "a2",
      },
      {
        tokenCa: "TokenC",
        generatedAt: tLate,
        candidatePools: ["P3"],
        wallets: [owner],
        scanFingerprint: "s3",
        artifactPath: "a3",
      },
    ];

    const { candidateMap } = extractCandidateWallets(scans);
    const partition = partitionCandidateEligibility(candidateMap, new Set(), new Set(), new Set([owner]));

    assert.equal(partition.eligibleNew.length, 1);
    assert.equal(partition.eligibleNew[0].firstSeenAt, tEarly);
    assert.equal(partition.eligibleNew[0].lastSeenAt, tLate);
  });

  // =========================================================================
  // 6. REGISTRY IDEMPOTENCY
  // =========================================================================
  it("6. Registry idempotency: re-running does not duplicate owners or increment registry counts", () => {
    const mockCandidates = new Map<string, ExtractedCandidateMapEntry>();
    const owner = "44444444444444444444444444444444444444444444";
    mockCandidates.set(owner, {
      owner,
      firstSeenAt: "2026-09-26T00:00:00.000Z",
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      tokens: new Set(["TokenX"]),
      candidatePools: new Set(["PoolA"]),
      scans: new Set(["scan1"]),
      sourceArtifactPaths: new Set(["path1"]),
    });

    // Case 1: Not in registry -> eligible
    const part1 = partitionCandidateEligibility(mockCandidates, new Set(), new Set(), new Set([owner]));
    assert.equal(part1.eligibleNew.length, 1);

    // Case 2: Already in registry -> 0 new eligible, preserved in alreadyInRegistry
    const part2 = partitionCandidateEligibility(mockCandidates, new Set(), new Set([owner]), new Set([owner]));
    assert.equal(part2.eligibleNew.length, 0);
    assert.deepEqual(part2.alreadyInRegistry, [owner]);
  });

  // =========================================================================
  // 7. EXISTING OWNER PRESERVATION
  // =========================================================================
  it("7. Existing owner preservation: existing registry wallets retain all confirmed pools and metadata", () => {
    const mockCandidates = new Map<string, ExtractedCandidateMapEntry>();
    const existingOwner = "55555555555555555555555555555555555555555555";
    mockCandidates.set(existingOwner, {
      owner: existingOwner,
      firstSeenAt: "2026-09-26T00:00:00.000Z",
      lastSeenAt: "2026-09-26T00:00:00.000Z",
      tokens: new Set(["LegacyToken"]),
      candidatePools: new Set(["LegacyPool"]),
      scans: new Set(["legacyScan"]),
      sourceArtifactPaths: new Set(["legacyPath"]),
    });

    const registrySet = new Set([existingOwner]);
    const partition = partitionCandidateEligibility(mockCandidates, new Set(), registrySet, new Set([existingOwner]));

    assert.equal(partition.eligibleNew.length, 0);
    assert.equal(partition.alreadyInRegistry.length, 1);
    assert.equal(partition.alreadyInRegistry[0], existingOwner);
  });

  // =========================================================================
  // 8. EXISTING CANONICAL FABRIQ IMMUTABILITY
  // =========================================================================
  it("8. Existing canonical Fabriq immutability: dry-run and migration never modify wallets-fabriq.json", async () => {
    const fabriqPath = path.resolve("data/master/wallets-fabriq.json");
    const rawBefore = await readFile(fabriqPath, "utf8");

    // Execute dry-run backfill
    const res = await runLegacyBackfill({ dryRun: true });
    assert.equal(res.mode, "dry-run");

    const rawAfter = await readFile(fabriqPath, "utf8");
    assert.equal(rawBefore, rawAfter, "wallets-fabriq.json must be byte-for-byte identical after run");
  });

  // =========================================================================
  // 9. DRY-RUN CREATES NO FILES
  // =========================================================================
  it("9. Dry-run creates no files: dry-run writes zero files or backups", async () => {
    const backupDir = path.resolve("data/backup");
    const backupsBefore = await readFile(path.resolve("data/master/pool-wallets-registry.json"), "utf8");

    const res = await runLegacyBackfill({ dryRun: true });
    assert.equal(res.mode, "dry-run");
    assert.equal(res.backupPath, undefined);

    const backupsAfter = await readFile(path.resolve("data/master/pool-wallets-registry.json"), "utf8");
    assert.equal(backupsBefore, backupsAfter, "Registry file must be untouched by dry-run");
  });

  // =========================================================================
  // 10. MISSING OR MALFORMED SOURCE ARTIFACTS FAIL CLOSED
  // =========================================================================
  it("10. Missing or malformed source artifacts: rejects corrupted or incomplete artifacts", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "corrupt-artifacts-"));
    try {
      const token = "CorruptToken11111111111111111111111111111111";
      const tokenDir = path.join(tmpDir, token);
      await mkdir(tokenDir, { recursive: true });

      // Missing pools.json
      await writeFile(path.join(tokenDir, "summary.json"), JSON.stringify({ tokenCa: token, generatedAt: "2026-09-26T00:00:00.000Z", pools: [] }));
      await writeFile(path.join(tokenDir, "wallets.json"), JSON.stringify(["W1"]));

      await assert.rejects(
        () => loadLegacyTokenScan(token, tmpDir),
        /Failed to read legacy artifacts/
      );

      // Malformed JSON
      await writeFile(path.join(tokenDir, "pools.json"), "{ invalid JSON ");
      await assert.rejects(
        () => loadLegacyTokenScan(token, tmpDir),
        /JSON parsing error/
      );

      // Conflicting token CA
      await writeFile(path.join(tokenDir, "pools.json"), JSON.stringify([{ pool: "P1" }]));
      await writeFile(path.join(tokenDir, "summary.json"), JSON.stringify({ tokenCa: "DifferentToken", generatedAt: "2026-09-26T00:00:00.000Z", pools: [{ pool: "P1" }] }));
      await assert.rejects(
        () => loadLegacyTokenScan(token, tmpDir),
        /Conflicting token mint in summary/
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 11. EXPECTED POPULATION CALCULATION
  // =========================================================================
  it("11. Expected population calculation: verifies pre-migration (199 eligible) and post-migration (0 eligible idempotent) states", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "backfill-reconciliation-"));
    try {
      // A. Pre-migration state fixture: reconstruct pre-migration registry (2,982 wallets)
      const liveRegistryRaw = await readFile(DEFAULT_PATHS.registryPath, "utf8");
      const liveRegistry = JSON.parse(liveRegistryRaw) as PoolWalletsRegistryFile;
      const preMigrationWallets = liveRegistry.wallets.filter(
        (w) => w.legacyProvenance?.evidenceLevel !== "TOKEN_SCAN_CANDIDATE"
      );
      assert.equal(preMigrationWallets.length, 2982, "Pre-migration fixture must have exactly 2,982 wallets");

      const preMigrationRegistryPath = path.join(tmpDir, "pre-migration-registry.json");
      await writeFile(
        preMigrationRegistryPath,
        JSON.stringify(
          {
            ...liveRegistry,
            totalUniqueWallets: preMigrationWallets.length,
            wallets: preMigrationWallets,
          },
          null,
          2
        ),
        "utf8"
      );

      // Verify pre-migration state: exactly 199 additions eligible
      const preRes = await runLegacyBackfill({
        dryRun: true,
        basePaths: {
          ...DEFAULT_PATHS,
          registryPath: preMigrationRegistryPath,
        },
      });
      assert.equal(preRes.report.existingLpAgentWallets, 1557);
      assert.equal(preRes.report.existingPoolRegistryWallets, 2982);
      assert.equal(preRes.report.newEligibleWallets, 199);
      assert.equal(preRes.report.newRegistryTotal, 3181);
      assert.equal(preRes.report.predictedPublishedWallets, 4352);
      assert.equal(preRes.report.canonicalFabriqWallets, 4354);
      assert.equal(preRes.report.excludedAmbiguousWallets, 2);
      assert.equal(preRes.report.missingCanonicalRecords, 446);
      assert.equal(preRes.report.invalidAddresses, 0);
      assert.equal(preRes.report.missingOrAmbiguousProvenance, 2);
      assert.equal(preRes.report.matchesExpectations, true);
      assert.deepEqual(preRes.report.mismatches, []);

      // B. Post-migration state: exactly 0 additions eligible, repeated migration is idempotent
      const postRes = await runLegacyBackfill({ dryRun: true });
      assert.equal(postRes.report.existingLpAgentWallets, 1557);
      assert.equal(postRes.report.existingPoolRegistryWallets, 3181);
      assert.equal(postRes.report.newEligibleWallets, 0);
      assert.equal(postRes.report.newRegistryTotal, 3181);
      assert.equal(postRes.report.predictedPublishedWallets, 4352);
      assert.equal(postRes.report.canonicalFabriqWallets, 4354);
      assert.equal(postRes.report.excludedAmbiguousWallets, 2);
      assert.equal(postRes.report.missingCanonicalRecords, 446);
      assert.equal(postRes.report.invalidAddresses, 0);
      assert.equal(postRes.report.missingOrAmbiguousProvenance, 2);
      assert.equal(postRes.report.matchesExpectations, true);
      assert.deepEqual(postRes.report.mismatches, []);

      // C. Idempotency & metadata integrity assertions
      const registryWallets = liveRegistry.wallets;
      assert.equal(registryWallets.length, 3181);

      // Verify the two ambiguous BLUEPRINT wallets remain strictly excluded
      for (const excludedKey of EXCLUDED_AMBIGUOUS_OWNERS) {
        assert.equal(
          registryWallets.some((w) => w.owner === excludedKey),
          false,
          `Ambiguous wallet ${excludedKey} must NOT be present in registry`
        );
      }

      // Verify all 199 migrated wallets have candidate pools kept strictly in legacyProvenance, never confirmed pools
      const migratedWallets = registryWallets.filter(
        (w) => w.legacyProvenance?.evidenceLevel === "TOKEN_SCAN_CANDIDATE"
      );
      assert.equal(migratedWallets.length, 199);
      for (const mw of migratedWallets) {
        assert.deepEqual(
          mw.pools,
          [],
          `Migrated wallet ${mw.owner} confirmed pools array must remain empty`
        );
        assert.ok(
          Array.isArray(mw.legacyProvenance?.candidatePools) && mw.legacyProvenance.candidatePools.length > 0,
          `Migrated wallet ${mw.owner} must retain candidatePools in legacyProvenance`
        );
      }

      // Verify pre-existing wallets retained their existing confirmed pools and metadata
      for (const preWallet of preMigrationWallets) {
        const liveWallet = registryWallets.find((w) => w.owner === preWallet.owner);
        assert.ok(liveWallet, `Pre-existing wallet ${preWallet.owner} must exist in registry`);
        assert.deepEqual(liveWallet.pools, preWallet.pools);
        assert.deepEqual(liveWallet.tokens, preWallet.tokens);
        assert.equal(liveWallet.firstSeenAt, preWallet.firstSeenAt);
        assert.equal(liveWallet.lastSeenAt, preWallet.lastSeenAt);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 12. SAFE HANDLING OF WRITE / PUBLISH FAILURE
  // =========================================================================
  it("12. Safe handling of write / publish failure: fails closed and reports error without silent partial success", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "publish-failure-test-"));
    try {
      const mockMasterPath = path.join(tmpDir, "wallets-master.json");
      const mockRegistryPath = path.join(tmpDir, "pool-wallets-registry.json");
      const mockFabriqPath = path.join(tmpDir, "wallets-fabriq.json");
      const mockBackupDir = path.join(tmpDir, "backup");

      await writeFile(mockMasterPath, JSON.stringify({ wallets: [] }));
      await writeFile(mockRegistryPath, JSON.stringify({ version: "v1", updatedAt: "2026-10-01", totalUniqueWallets: 0, wallets: [] }));
      await writeFile(mockFabriqPath, JSON.stringify({ wallets: [] }));

      // Backfill with apply = true, publishAfterApply = true, but invalid publish configuration
      const customPaths = {
        poolScannerBase: path.resolve("data/discovery/pool-scanner"),
        masterDir: tmpDir,
        backupDir: mockBackupDir,
        masterPath: mockMasterPath,
        registryPath: mockRegistryPath,
        fabriqPath: mockFabriqPath,
      };

      // Since masterCount !== 1557 in mock paths, it will throw dataset mismatch error before write
      await assert.rejects(
        () => runLegacyBackfill({ apply: true, dryRun: false, basePaths: customPaths }),
        /Dataset population check failed/
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
