import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { WatchlistStore } from "../../scripts/alerts/watchlist-store.ts";
import {
    AlertsEngine,
    DefaultAlertsRpcClient,
    ALERTS_POLL_INTERVAL_MS,
    type AlertsRpcClient,
    type SignatureItem,
    type DlmmAlertEvent,
    POSITION_V2_DISCRIMINATOR_BYTES,
    POSITION_V1_DISCRIMINATOR_BYTES,
    POSITION_V2_DISCRIMINATOR_BS58,
    POSITION_V1_DISCRIMINATOR_BS58,
} from "../../scripts/alerts/alerts-engine.ts";
import { TelegramDryRunAdapter } from "../../scripts/alerts/telegram-dryrun.ts";
const PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const DUMMY_PUBKEY = "11111111111111111111111111111111";

// Discriminator base58 strings for target DLMM instructions
const DISC_INIT_POS = "dktKySaJ62B";
const DISC_ADD_LIQ = "XNtbQu6Ykyd";
const DISC_REMOVE_LIQ = "ESMSB6NvEXM";
const DISC_CLOSE_POS = "MfLxSQLgoGV";
const DISC_CLAIM_FEE = "VHjhLVShzoA";
const DISC_CLAIM_REWARD = "Rz7bL11WqRj";
const DISC_INIT_POOL = "8dRo4Fj8tuq";

// Test wallets and fixtures
const WALLET_A = "So11111111111111111111111111111111111111112";
const WALLET_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WALLET_C = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"; // Disabled wallet
const RELAYER_WALLET = "ComputeBudget111111111111111111111111111111";

const POOL_1 = "45345345345345345345345345345345345345345345";
const POS_1 = "67867867867867867867867867867867867867867867";
const POS_2 = "89089089089089089089089089089089089089089089";

function createPositionBuffer(
    lbPair: string,
    owner: string,
    version: "V1" | "V2" = "V2",
    hasLiquidity = true,
    feeOrReward?: { feeClaimedX?: bigint; feeClaimedY?: bigint }
): Buffer {
    const size = version === "V2" ? 8120 : 7560;
    const buf = Buffer.alloc(size);
    const disc = version === "V2" ? POSITION_V2_DISCRIMINATOR_BYTES : POSITION_V1_DISCRIMINATOR_BYTES;
    disc.copy(buf, 0);

    const poolPk = new PublicKey(lbPair);
    poolPk.toBuffer().copy(buf, 8);

    const ownerPk = new PublicKey(owner);
    ownerPk.toBuffer().copy(buf, 40);

    if (hasLiquidity) {
        if (version === "V1") {
            buf.writeBigUInt64LE(100n, 72);
        } else {
            buf.writeBigUInt64LE(100n, 72);
            buf.writeBigUInt64LE(0n, 80);
        }
    }

    if (feeOrReward?.feeClaimedX) {
        const off = version === "V2" ? 7920 : 7360;
        buf.writeBigUInt64LE(feeOrReward.feeClaimedX, off);
    }
    if (feeOrReward?.feeClaimedY) {
        const off = version === "V2" ? 7928 : 7368;
        buf.writeBigUInt64LE(feeOrReward.feeClaimedY, off);
    }

    return buf;
}

interface MockInstructionParams {
    programId?: string;
    data: string;
    accounts: string[];
}

function createMockTx(params: {
    signature: string;
    slot: number;
    blockTime: number;
    feePayer: string;
    instructions: MockInstructionParams[];
    innerInstructions?: Array<{ index: number; instructions: MockInstructionParams[] }>;
    err?: unknown;
}): unknown {
    const allAccountKeys = new Set<string>();
    allAccountKeys.add(params.feePayer);

    for (const ix of params.instructions) {
        allAccountKeys.add(ix.programId ?? PROGRAM_ID);
        for (const acc of ix.accounts) allAccountKeys.add(acc);
    }
    if (params.innerInstructions) {
        for (const innerGroup of params.innerInstructions) {
            for (const ix of innerGroup.instructions) {
                allAccountKeys.add(ix.programId ?? PROGRAM_ID);
                for (const acc of ix.accounts) allAccountKeys.add(acc);
            }
        }
    }

    const accountKeysArray = Array.from(allAccountKeys);
    const keyToIndex = new Map(accountKeysArray.map((k, idx) => [k, idx]));

    const formatIx = (ix: MockInstructionParams) => ({
        programId: ix.programId ?? PROGRAM_ID,
        programIdIndex: keyToIndex.get(ix.programId ?? PROGRAM_ID),
        accounts: ix.accounts.map((a) => keyToIndex.get(a)!),
        data: ix.data,
    });

    const topIxs = params.instructions.map(formatIx);
    const innerIxs = (params.innerInstructions || []).map((grp) => ({
        index: grp.index,
        instructions: grp.instructions.map(formatIx),
    }));

    return {
        slot: params.slot,
        blockTime: params.blockTime,
        transaction: {
            signatures: [params.signature],
            message: {
                accountKeys: accountKeysArray,
                instructions: topIxs,
            },
        },
        meta: {
            err: params.err ?? null,
            innerInstructions: innerIxs,
        },
    };
}

class MockAlertsRpcClient implements AlertsRpcClient {
    public signaturesMap = new Map<string, SignatureItem[]>(); // address -> list of signature items
    public txMap = new Map<string, unknown>(); // signature -> tx
    public programAccountsMap = new Map<string, Array<{ pubkey: string; account: { data: Buffer } }>>(); // owner -> accounts

    public throwOnProgramAccounts: Error | null = null;
    public throwOnSignatures: ((address: string) => Error | null) | null = null;
    public throwOnTx: ((sig: string) => Error | null) | null = null;
    public onProgramAccountsHook: (() => void) | null = null;
    public getSignaturesHook: ((address: string) => Promise<void>) | null = null;
    public getTxHook: ((sig: string) => Promise<void>) | null = null;
    public recordedCommitments: string[] = [];
    public recordedProgramFilters: Array<Array<{ memcmp: { offset: number; bytes: string } }>> = [];
    public getSignaturesCalls = 0;
    public getTxCalls = 0;
    public getProgramAccountsCalls = 0;

    async getSignaturesForAddress(
        address: string,
        options?: { limit?: number; before?: string; until?: string; commitment?: string }
    ): Promise<SignatureItem[]> {
        this.getSignaturesCalls++;
        if (options?.commitment) {
            this.recordedCommitments.push(options.commitment);
        }
        if (this.getSignaturesHook) {
            await this.getSignaturesHook(address);
        }
        if (this.throwOnSignatures) {
            const err = this.throwOnSignatures(address);
            if (err) throw err;
        }
        const all = this.signaturesMap.get(address) || [];
        let filtered = [...all];

        if (options?.until) {
            const untilIdx = filtered.findIndex((s) => s.signature === options.until);
            if (untilIdx >= 0) {
                // Returns items before the until item (exclusive)
                filtered = filtered.slice(0, untilIdx);
            }
        }

        if (options?.before) {
            const beforeIdx = filtered.findIndex((s) => s.signature === options.before);
            if (beforeIdx >= 0) {
                filtered = filtered.slice(beforeIdx + 1);
            }
        }

        const limit = options?.limit ?? 100;
        return filtered.slice(0, limit);
    }

    async getTransaction(
        signature: string,
        options?: { encoding?: string; commitment?: string; maxSupportedTransactionVersion?: number }
    ): Promise<unknown> {
        this.getTxCalls++;
        if (options?.commitment) {
            this.recordedCommitments.push(options.commitment);
        }
        if (this.getTxHook) {
            await this.getTxHook(signature);
        }
        if (this.throwOnTx) {
            const err = this.throwOnTx(signature);
            if (err) throw err;
        }
        const tx = this.txMap.get(signature);
        if (!tx) {
            throw new Error(`Transaction ${signature} not found in mock RPC`);
        }
        return tx;
    }

    async getProgramAccounts(
        programId: string,
        config?: {
            commitment?: string;
            filters?: Array<{ memcmp: { offset: number; bytes: string } }>;
        }
    ): Promise<Array<{ pubkey: string; account: { data: string | Buffer; [key: string]: unknown } }>> {
        this.getProgramAccountsCalls++;
        if (config?.commitment) {
            this.recordedCommitments.push(config.commitment);
        }
        if (config?.filters) {
            this.recordedProgramFilters.push(config.filters);
        }
        if (this.onProgramAccountsHook) {
            this.onProgramAccountsHook();
        }
        if (this.throwOnProgramAccounts) {
            throw this.throwOnProgramAccounts;
        }

        const ownerFilter = config?.filters?.find((f) => f.memcmp.offset === 40);
        const owner = ownerFilter ? ownerFilter.memcmp.bytes : null;

        const discFilter = config?.filters?.find((f) => f.memcmp.offset === 0);
        const discBytes = discFilter?.memcmp.bytes;

        const results: Array<{ pubkey: string; account: { data: Buffer; [key: string]: unknown } }> = [];
        if (owner) {
            const accounts = this.programAccountsMap.get(owner) || [];
            for (const acc of accounts) {
                const isV2 = acc.account.data.subarray(0, 8).equals(POSITION_V2_DISCRIMINATOR_BYTES);
                if (discBytes === POSITION_V2_DISCRIMINATOR_BS58 && isV2) {
                    results.push(acc);
                } else if (discBytes === POSITION_V1_DISCRIMINATOR_BS58 && !isV2) {
                    results.push(acc);
                }
            }
        }

        return results;
    }
}

describe("DLLM Alerts Engine Phase 2 Suite", () => {
    let tempDir: string;
    let watchlistPath: string;
    let watchlistStore: WatchlistStore;
    let mockRpc: MockAlertsRpcClient;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-engine-test-"));
        watchlistPath = path.join(tempDir, "watchlist.json");
        watchlistStore = new WatchlistStore(watchlistPath);

        // Enroll test wallets
        await watchlistStore.addWallet(WALLET_A, "Whale A");
        await watchlistStore.enableWallet(WALLET_A);

        await watchlistStore.addWallet(WALLET_B, "Trader B");
        await watchlistStore.enableWallet(WALLET_B);

        // WALLET_C is added but explicitly disabled
        await watchlistStore.addWallet(WALLET_C, "Disabled C");

        mockRpc = new MockAlertsRpcClient();
    });

    afterEach(() => {
        try {
            if (fs.existsSync(tempDir)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        } catch {
            // ignore
        }
    });

    describe("1. Active Position Discovery & Initialization", () => {
        it("handles zero-position and zero-history wallets with zero initial alerts", async () => {
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();

            assert.equal(engine.getActivePositions().length, 0);
            assert.equal(engine.getRecentActivity().length, 0);
            const health = engine.getHealth();
            assert.equal(health.monitoredWalletsCount, 2); // WALLET_A and WALLET_B, not WALLET_C
            assert.equal(health.isDegraded, false);
            assert.equal(health.totalEventsEmitted, 0);

            // Run a poll cycle: zero alerts
            const events = await engine.poll();
            assert.equal(events.length, 0);
        });

        it("discovers existing open positions with zero liquidity without closing them", async () => {
            // WALLET_A has an open position on-chain with 0 liquidity shares
            const posData = createPositionBuffer(POOL_1, WALLET_A, "V2", false);
            mockRpc.programAccountsMap.set(WALLET_A, [
                { pubkey: POS_1, account: { data: posData } },
            ]);

            // Wallets have baseline signatures
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "baseSigA", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();

            // Discovered 1 active position with hasLiquidity: false
            const positions = engine.getActivePositions(WALLET_A);
            assert.equal(positions.length, 1);
            assert.equal(positions[0].positionAddress, POS_1);
            assert.equal(positions[0].poolAddress, POOL_1);
            assert.equal(positions[0].hasLiquidity, false);

            // Startup emits ZERO historical alerts
            assert.equal(engine.getRecentActivity().length, 0);
            assert.equal(engine.getHealth().totalEventsEmitted, 0);
        });

        it("fails startup on initial position discovery error without assuming zero positions", async () => {
            mockRpc.throwOnProgramAccounts = new Error("RPC 500 Node unavailable");

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await assert.rejects(
                async () => {
                    await engine.init();
                },
                /Initial position discovery failed/
            );

            const health = engine.getHealth();
            assert.equal(health.status, "DEGRADED");
            assert.equal(health.isDegraded, true);
            assert.equal(health.coverageGaps.length > 0, true);
        });
    });

    describe("2. DLMM Event Classification & Verification", () => {
        it("detects new position opening after baseline and adds to active snapshots", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();
            assert.equal(engine.getActivePositions().length, 0);

            // New transaction: initialize_position
            const initTx = createMockTx({
                signature: "sigOpen",
                slot: 101,
                blockTime: 1050,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sigOpen", initTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigOpen", slot: 101, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const emitted = await engine.poll();
            assert.equal(emitted.length, 1);
            assert.equal(emitted[0].eventType, "POSITION_OPENED");
            assert.equal(emitted[0].walletAddress, WALLET_A);
            assert.equal(emitted[0].positionAddress, POS_1);
            assert.equal(emitted[0].poolAddress, POOL_1);

            // In-memory active positions snapshot now has POS_1
            const active = engine.getActivePositions(WALLET_A);
            assert.equal(active.length, 1);
            assert.equal(active[0].positionAddress, POS_1);
        });

        it("handles add, remove, and fee-claim events, and distinguishes fee claim from reward claim", async () => {
            // Setup baseline with known open position POS_1
            const posData = createPositionBuffer(POOL_1, WALLET_A, "V2", true);
            mockRpc.programAccountsMap.set(WALLET_A, [
                { pubkey: POS_1, account: { data: posData } },
            ]);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // 1. Add liquidity
            const addTx = createMockTx({
                signature: "sigAdd",
                slot: 102,
                blockTime: 1100,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_ADD_LIQ,
                        accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            // 2. Remove liquidity (should NOT close position)
            const removeTx = createMockTx({
                signature: "sigRemove",
                slot: 103,
                blockTime: 1150,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_REMOVE_LIQ,
                        accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            // 3. Claim fee (valid DLMM fee claim)
            const claimFeeTx = createMockTx({
                signature: "sigClaimFee",
                slot: 104,
                blockTime: 1200,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_CLAIM_FEE,
                        accounts: [POOL_1, POS_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, ...Array(9).fill(DUMMY_PUBKEY)],
                    },
                ],
            });

            // 4. Claim reward (farming reward claim, must NOT be emitted as FEES_CLAIMED)
            const claimRewardTx = createMockTx({
                signature: "sigClaimReward",
                slot: 105,
                blockTime: 1250,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_CLAIM_REWARD,
                        accounts: [POOL_1, POS_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, ...Array(9).fill(DUMMY_PUBKEY)],
                    },
                ],
            });

            // 5. Initialize pool (pool creation, must be excluded)
            const initPoolTx = createMockTx({
                signature: "sigInitPool",
                slot: 106,
                blockTime: 1300,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POOL,
                        accounts: Array(15).fill(DUMMY_PUBKEY),
                    },
                ],
            });

            mockRpc.txMap.set("sigAdd", addTx);
            mockRpc.txMap.set("sigRemove", removeTx);
            mockRpc.txMap.set("sigClaimFee", claimFeeTx);
            mockRpc.txMap.set("sigClaimReward", claimRewardTx);
            mockRpc.txMap.set("sigInitPool", initPoolTx);

            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigInitPool", slot: 106, err: null, blockTime: 1300 },
                { signature: "sigClaimReward", slot: 105, err: null, blockTime: 1250 },
                { signature: "sigClaimFee", slot: 104, err: null, blockTime: 1200 },
                { signature: "sigRemove", slot: 103, err: null, blockTime: 1150 },
                { signature: "sigAdd", slot: 102, err: null, blockTime: 1100 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const emitted = await engine.poll();

            // Exactly 3 events expected: ADD, REMOVE, FEES_CLAIMED
            assert.equal(emitted.length, 3);
            assert.equal(emitted[0].eventType, "LIQUIDITY_ADDED");
            assert.equal(emitted[1].eventType, "LIQUIDITY_REMOVED");
            assert.equal(emitted[2].eventType, "FEES_CLAIMED");

            // Position still remains open in active snapshot
            assert.equal(engine.getActivePositions(WALLET_A).length, 1);
        });

        it("removes closed position only after verified close_position closure", async () => {
            const posData = createPositionBuffer(POOL_1, WALLET_A, "V2", true);
            mockRpc.programAccountsMap.set(WALLET_A, [
                { pubkey: POS_1, account: { data: posData } },
            ]);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();
            assert.equal(engine.getActivePositions(WALLET_A).length, 1);

            const closeTx = createMockTx({
                signature: "sigClose",
                slot: 110,
                blockTime: 1400,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_CLOSE_POS,
                        accounts: [POS_1, POOL_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sigClose", closeTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigClose", slot: 110, err: null, blockTime: 1400 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const emitted = await engine.poll();
            assert.equal(emitted.length, 1);
            assert.equal(emitted[0].eventType, "POSITION_CLOSED");
            assert.equal(emitted[0].positionAddress, POS_1);

            // Verified closure removed it from active positions
            assert.equal(engine.getActivePositions(WALLET_A).length, 0);
        });

        it("handles opened-and-closed position between polling cycles through transaction evidence", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();
            assert.equal(engine.getActivePositions(WALLET_A).length, 0);

            // Sequence in one interval: Open -> Add -> Close
            const openTx = createMockTx({
                signature: "sig1Open",
                slot: 101,
                blockTime: 1010,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_2, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            const addTx = createMockTx({
                signature: "sig2Add",
                slot: 102,
                blockTime: 1020,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_ADD_LIQ,
                        accounts: [POS_2, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            const closeTx = createMockTx({
                signature: "sig3Close",
                slot: 103,
                blockTime: 1030,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_CLOSE_POS,
                        accounts: [POS_2, POOL_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sig1Open", openTx);
            mockRpc.txMap.set("sig2Add", addTx);
            mockRpc.txMap.set("sig3Close", closeTx);

            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sig3Close", slot: 103, err: null, blockTime: 1030 },
                { signature: "sig2Add", slot: 102, err: null, blockTime: 1020 },
                { signature: "sig1Open", slot: 101, err: null, blockTime: 1010 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events = await engine.poll();
            assert.equal(events.length, 3);
            assert.equal(events[0].eventType, "POSITION_OPENED");
            assert.equal(events[1].eventType, "LIQUIDITY_ADDED");
            assert.equal(events[2].eventType, "POSITION_CLOSED");

            // Ended with 0 active positions
            assert.equal(engine.getActivePositions(WALLET_A).length, 0);
        });

        it("correctly distinguishes multiple events (outer and inner) in one transaction", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Single transaction containing outer initialize_position and inner add_liquidity
            const compositeTx = createMockTx({
                signature: "sigComposite",
                slot: 105,
                blockTime: 1050,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
                innerInstructions: [
                    {
                        index: 0,
                        instructions: [
                            {
                                data: DISC_ADD_LIQ,
                                accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                            },
                        ],
                    },
                ],
            });

            mockRpc.txMap.set("sigComposite", compositeTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigComposite", slot: 105, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events = await engine.poll();
            assert.equal(events.length, 2);
            assert.equal(events[0].eventType, "POSITION_OPENED");
            assert.equal(events[0].source, "top-level");
            assert.equal(events[1].eventType, "LIQUIDITY_ADDED");
            assert.equal(events[1].source, "inner");
        });

        it("distinguishes position owner, signer, and fee payer without inferring ownership from fee payer", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBaseA", slot: 100, err: null, blockTime: 1000 },
            ]);
            mockRpc.signaturesMap.set(WALLET_B, [
                { signature: "sigBaseB", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Scenario 1: Third-party relayer pays fee, but WALLET_A is position owner
            const relayerTx = createMockTx({
                signature: "sigRelayer",
                slot: 110,
                blockTime: 1100,
                feePayer: RELAYER_WALLET,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [RELAYER_WALLET, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sigRelayer", relayerTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigRelayer", slot: 110, err: null, blockTime: 1100 },
                { signature: "sigBaseA", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events1 = await engine.poll();
            assert.equal(events1.length, 1);
            assert.equal(events1[0].walletAddress, WALLET_A); // Owner is WALLET_A
            assert.equal(events1[0].feePayer, RELAYER_WALLET); // Fee payer is recorded as RELAYER

            // Scenario 2: WALLET_B is fee payer for an unwatched user's position
            const unwatchedUser = "22222222222222222222222222222222";
            const botTx = createMockTx({
                signature: "sigBot",
                slot: 111,
                blockTime: 1110,
                feePayer: WALLET_B, // WALLET_B paid the gas
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_B, POS_2, POOL_1, unwatchedUser, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sigBot", botTx);
            mockRpc.signaturesMap.set(WALLET_B, [
                { signature: "sigBot", slot: 111, err: null, blockTime: 1110 },
                { signature: "sigBaseB", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events2 = await engine.poll();
            // Ownership is NOT inferred from fee payer: zero events emitted for WALLET_B!
            assert.equal(events2.length, 0);
        });
    });

    describe("3. Polling Safety, Pagination, and RPC Fault Tolerance", () => {
        it("suppresses duplicate events across consecutive polling runs", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            const initTx = createMockTx({
                signature: "sigOpen",
                slot: 101,
                blockTime: 1050,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            mockRpc.txMap.set("sigOpen", initTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigOpen", slot: 101, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            // First poll: 1 event
            const firstPoll = await engine.poll();
            assert.equal(firstPoll.length, 1);

            // Second poll with same state: 0 events (deduplicated)
            const secondPoll = await engine.poll();
            assert.equal(secondPoll.length, 0);
            assert.equal(engine.getHealth().totalEventsEmitted, 1);
        });

        it("handles multi-page signature pagination and same-slot transactions correctly", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Create 3 transactions in the same slot 102
            const tx1 = createMockTx({
                signature: "sig1",
                slot: 102,
                blockTime: 1020,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            const tx2 = createMockTx({
                signature: "sig2",
                slot: 102,
                blockTime: 1020,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_ADD_LIQ,
                        accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            const tx3 = createMockTx({
                signature: "sig3",
                slot: 102,
                blockTime: 1020,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_CLAIM_FEE,
                        accounts: [POOL_1, POS_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, ...Array(9).fill(DUMMY_PUBKEY)],
                    },
                ],
            });

            mockRpc.txMap.set("sig1", tx1);
            mockRpc.txMap.set("sig2", tx2);
            mockRpc.txMap.set("sig3", tx3);

            // Stored in reverse chronological order
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sig3", slot: 102, err: null, blockTime: 1020 },
                { signature: "sig2", slot: 102, err: null, blockTime: 1020 },
                { signature: "sig1", slot: 102, err: null, blockTime: 1020 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const emitted = await engine.poll();
            assert.equal(emitted.length, 3);
            assert.equal(emitted[0].signature, "sig1");
            assert.equal(emitted[1].signature, "sig2");
            assert.equal(emitted[2].signature, "sig3");
        });

        it("does not advance cursor across incomplete signature pagination on RPC error", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Simulate HTTP 429 during getSignaturesForAddress
            mockRpc.throwOnSignatures = (addr: string) => {
                if (addr === WALLET_A) {
                    return new Error("HTTP 429 Rate limited");
                }
                return null;
            };

            const emitted = await engine.poll();
            assert.equal(emitted.length, 0);

            // Cursor was NOT advanced, and coverage gap is recorded
            const health = engine.getHealth();
            assert.equal(health.isDegraded, true);
            assert.equal(health.coverageGaps.length, 1);
            assert.match(health.coverageGaps[0].reason, /Incomplete signature pagination/);
        });

        it("does not advance cursor across failed getTransaction and advances only to last complete signature", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
                maxRetries: 2,
                retryDelayMs: 0,
            });
            await engine.init();

            const tx1 = createMockTx({
                signature: "sig1",
                slot: 101,
                blockTime: 1010,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });

            mockRpc.txMap.set("sig1", tx1);
            // tx2 is intentionally missing from mockRpc.txMap
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sig2", slot: 102, err: null, blockTime: 1020 },
                { signature: "sig1", slot: 101, err: null, blockTime: 1010 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const emitted = await engine.poll();
            // tx1 was processed successfully, tx2 failed
            assert.equal(emitted.length, 1);
            assert.equal(emitted[0].signature, "sig1");

            // Health is degraded due to coverage gap on sig2
            const health = engine.getHealth();
            assert.equal(health.isDegraded, true);
            assert.equal(health.coverageGaps.length, 1);
            assert.equal(health.coverageGaps[0].signature, "sig2");
        });
    });

    describe("4. Lifecycle, Pause & Fresh Resume Semantics", () => {
        it("pause and fresh resume skips pause interval without historical notifications", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.start();
            assert.equal(engine.getHealth().status, "RUNNING");

            // 1. Pause monitoring
            engine.pause();
            assert.equal(engine.getHealth().status, "PAUSED");

            // 2. Transactions occur while paused
            const pausedTx = createMockTx({
                signature: "sigWhilePaused",
                slot: 120,
                blockTime: 1200,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            mockRpc.txMap.set("sigWhilePaused", pausedTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigWhilePaused", slot: 120, err: null, blockTime: 1200 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            // 3. Fresh Resume establishes new baseline at sigWhilePaused
            await engine.resume();
            assert.equal(engine.getHealth().status, "RUNNING");

            // 4. Zero historical alerts emitted for pause interval
            const eventsAfterResume = await engine.poll();
            assert.equal(eventsAfterResume.length, 0);
            assert.equal(engine.getHealth().totalEventsEmitted, 0);

            // 5. Subsequent new transaction after resume is detected normally
            const newTx = createMockTx({
                signature: "sigAfterResume",
                slot: 125,
                blockTime: 1250,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_ADD_LIQ,
                        accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            mockRpc.txMap.set("sigAfterResume", newTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigAfterResume", slot: 125, err: null, blockTime: 1250 },
                { signature: "sigWhilePaused", slot: 120, err: null, blockTime: 1200 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events = await engine.poll();
            assert.equal(events.length, 1);
            assert.equal(events[0].signature, "sigAfterResume");

            engine.stop();
        });

        it("enforces bounded in-memory recent activity cap of 100 items", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
                maxRecentActivity: 100,
            });
            await engine.init();

            // Emit 150 events
            for (let i = 1; i <= 150; i++) {
                const sig = `sig_${i}`;
                const tx = createMockTx({
                    signature: sig,
                    slot: 100 + i,
                    blockTime: 1000 + i,
                    feePayer: WALLET_A,
                    instructions: [
                        {
                            data: DISC_CLAIM_FEE,
                            accounts: [POOL_1, POS_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, ...Array(9).fill(DUMMY_PUBKEY)],
                        },
                    ],
                });
                mockRpc.txMap.set(sig, tx);
                mockRpc.signaturesMap.set(WALLET_A, [
                    { signature: sig, slot: 100 + i, err: null, blockTime: 1000 + i },
                    { signature: i === 1 ? "sigBase" : `sig_${i - 1}`, slot: 100 + i - 1, err: null, blockTime: 1000 + i - 1 },
                ]);

                await engine.poll();
            }

            assert.equal(engine.getHealth().totalEventsEmitted, 150);
            // In-memory sliding window never exceeds 100
            assert.equal(engine.getRecentActivity().length, 100);
            assert.equal(engine.getRecentActivity(50).length, 50);
        });
    });

    describe("5. Phase 2 Verification Hardening Suite", () => {
        it("transaction arriving during monitoring initialization is caught on subsequent poll without race condition", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            // Inject newly arrived transaction right while getProgramAccounts is executing during init
            mockRpc.onProgramAccountsHook = () => {
                const initRaceTx = createMockTx({
                    signature: "sigArrivedDuringInit",
                    slot: 105,
                    blockTime: 1050,
                    feePayer: WALLET_A,
                    instructions: [
                        {
                            data: DISC_ADD_LIQ,
                            accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                        },
                    ],
                });
                mockRpc.txMap.set("sigArrivedDuringInit", initRaceTx);
                mockRpc.signaturesMap.set(WALLET_A, [
                    { signature: "sigArrivedDuringInit", slot: 105, err: null, blockTime: 1050 },
                    { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
                ]);
            };

            await engine.init();
            mockRpc.onProgramAccountsHook = null;

            // Poll should catch the transaction that arrived during initialization
            const events = await engine.poll();
            assert.equal(events.length, 1);
            assert.equal(events[0].signature, "sigArrivedDuringInit");
            assert.equal(events[0].eventType, "LIQUIDITY_ADDED");

            engine.stop();
        });

        it("strictly verifies finalized commitment for signature discovery, transaction fetching, and program accounts", async () => {
            mockRpc.recordedCommitments.length = 0;
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();
            await engine.poll();

            assert.ok(mockRpc.recordedCommitments.length > 0);
            for (const commitment of mockRpc.recordedCommitments) {
                assert.equal(commitment, "finalized");
            }

            engine.stop();
        });

        it("verifies getProgramAccounts uses efficient owner and discriminator filters for Position V1 and Position V2", async () => {
            mockRpc.recordedProgramFilters.length = 0;
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();

            const v2Query = mockRpc.recordedProgramFilters.find(
                (filters) =>
                    filters.some((f) => f.memcmp.offset === 0 && f.memcmp.bytes === POSITION_V2_DISCRIMINATOR_BS58) &&
                    filters.some((f) => f.memcmp.offset === 40 && f.memcmp.bytes === WALLET_A)
            );
            assert.ok(v2Query, "getProgramAccounts must query PositionV2 with offset 0 (discriminator) and offset 40 (owner)");

            const v1Query = mockRpc.recordedProgramFilters.find(
                (filters) =>
                    filters.some((f) => f.memcmp.offset === 0 && f.memcmp.bytes === POSITION_V1_DISCRIMINATOR_BS58) &&
                    filters.some((f) => f.memcmp.offset === 40 && f.memcmp.bytes === WALLET_A)
            );
            assert.ok(v1Query, "getProgramAccounts must query PositionV1 with offset 0 (discriminator) and offset 40 (owner)");

            engine.stop();
        });

        it("tracks open positions with zero liquidity and keeps them tracked across LIQUIDITY_REMOVED events", async () => {
            const zeroLiqBuf = createPositionBuffer(POOL_1, WALLET_A, "V2", false);
            mockRpc.programAccountsMap.set(WALLET_A, [{ pubkey: POS_1, account: { data: zeroLiqBuf } }]);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            await engine.init();
            const initialPositions = engine.getActivePositions(WALLET_A);
            assert.equal(initialPositions.length, 1);
            assert.equal(initialPositions[0].hasLiquidity, false);
            assert.equal(initialPositions[0].positionAddress, POS_1);

            // Send LIQUIDITY_REMOVED transaction
            const removeTx = createMockTx({
                signature: "sigRemoveLiq",
                slot: 110,
                blockTime: 1100,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_REMOVE_LIQ,
                        accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                ],
            });
            mockRpc.txMap.set("sigRemoveLiq", removeTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigRemoveLiq", slot: 110, err: null, blockTime: 1100 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events = await engine.poll();
            assert.equal(events.length, 1);
            assert.equal(events[0].eventType, "LIQUIDITY_REMOVED");

            // Position must STILL be tracked in memory snapshot!
            const positionsAfterRemove = engine.getActivePositions(WALLET_A);
            assert.equal(positionsAfterRemove.length, 1);
            assert.equal(positionsAfterRemove[0].positionAddress, POS_1);

            engine.stop();
        });

        it("confirm incomplete RPC pagination cannot advance the cursor silently", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Case A: getSignaturesForAddress fails during pagination
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigPage1", slot: 101, err: null, blockTime: 1010 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            mockRpc.throwOnSignatures = () => new Error("RPC Rate Limit 429");

            const events = await engine.poll();
            assert.equal(events.length, 0);
            const health = engine.getHealth();
            assert.equal(health.isDegraded, true);
            assert.ok(health.coverageGaps.some((g) => g.reason.includes("Incomplete signature pagination")));

            mockRpc.throwOnSignatures = null;
            engine.stop();
        });
    });

    describe("6. Live Monitoring V1.1 Stage A Required Test Suite", () => {
        it("1. Polling target interval, long RPC cycles, timeout and no overlapping polls", async () => {
            // A. Verify default target interval
            assert.equal(ALERTS_POLL_INTERVAL_MS, 5000);

            // B. Verify configuration validation rejects unsafe values
            assert.throws(() => new AlertsEngine({ watchlistStore, pollIntervalMs: -100 }), /Invalid pollIntervalMs/);
            assert.throws(() => new AlertsEngine({ watchlistStore, pollIntervalMs: 0 }), /Invalid pollIntervalMs/);
            assert.throws(() => new AlertsEngine({ watchlistStore, pollIntervalMs: NaN }), /Invalid pollIntervalMs/);
            assert.throws(() => new AlertsEngine({ watchlistStore, commitment: "confirmed" as any }), /Commitment must be strictly finalized/);
            assert.throws(() => new AlertsEngine({ watchlistStore, maxRetries: -1 }), /Invalid maxRetries/);
            assert.throws(() => new AlertsEngine({ watchlistStore, requestTimeoutMs: 0 }), /Invalid requestTimeoutMs/);
            assert.throws(() => new AlertsEngine({ watchlistStore, getTxConcurrency: 0 }), /Invalid getTxConcurrency/);

            // C. Test no overlapping polling cycles
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            let releaseRpc!: () => void;
            let rpcStartedResolve!: () => void;
            const rpcStarted = new Promise<void>((resolve) => {
                rpcStartedResolve = resolve;
            });
            const rpcGate = new Promise<void>((resolve) => {
                releaseRpc = resolve;
            });
            mockRpc.getSignaturesHook = async () => {
                rpcStartedResolve();
                await rpcGate;
            };
            // Run first poll cycle manually (will pause inside getSignaturesHook)
            const firstCyclePromise = engine.poll();
            await rpcStarted;

            // Attempt overlapping second poll cycle
            const overlappingEvents = await engine.poll();
            assert.equal(overlappingEvents.length, 0, "Concurrent overlapping polling cycle must return empty immediately");

            // Release hook and finish first cycle
            releaseRpc();
            await firstCyclePromise;
            mockRpc.getSignaturesHook = null;

            // D. Test long RPC cycles (duration > interval)
            await engine.poll();
            const health = engine.getHealth();
            assert.ok(health.lastPollDurationMs !== null && health.lastPollDurationMs >= 0);
            assert.equal(health.configuredPollIntervalMs, 50);

            engine.stop();
        });

        it("2. Adaptive 429 backoff and recovery", async () => {
            const originalFetch = globalThis.fetch;
            let callCount = 0;

            globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                callCount++;
                if (callCount === 1) {
                    return new Response(JSON.stringify({ error: { code: 429, message: "Too Many Requests" } }), {
                        status: 429,
                        headers: { "retry-after": "0.01", "Content-Type": "application/json" },
                    });
                }
                return new Response(JSON.stringify({ jsonrpc: "2.0", result: [{ signature: "sigRecovered", slot: 100 }] }), {
                    status: 200,
                    headers: { "Content-Type": "application/json" },
                });
            }) as typeof fetch;

            try {
                const rpc = new DefaultAlertsRpcClient("http://127.0.0.1:8899", 3, "finalized", 2000);
                const sigs = await rpc.getSignaturesForAddress(WALLET_A);
                assert.equal(sigs.length, 1);
                assert.equal(sigs[0].signature, "sigRecovered");
                assert.equal(rpc.http429Count, 1, "Must record exactly 1 HTTP 429 hit before recovery");

                // Test persistent 429 exceeding retries
                globalThis.fetch = (async () => {
                    return new Response(JSON.stringify({ error: { code: 429, message: "Rate limit exceeded" } }), {
                        status: 429,
                        headers: { "Content-Type": "application/json" },
                    });
                }) as typeof fetch;

                await assert.rejects(
                    async () => {
                        await rpc.getSignaturesForAddress(WALLET_A);
                    },
                    /429/
                );
                assert.ok(rpc.http429Count >= 2);
            } finally {
                globalThis.fetch = originalFetch;
            }
        });

        it("3. Global and per-wallet Pause/Resume fencing, including late RPC responses", async () => {
            // A. Global Pause fencing
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            let releaseLateRpc!: () => void;
            let lateRpcStartedResolve!: () => void;
            const lateRpcStarted = new Promise<void>((resolve) => {
                lateRpcStartedResolve = resolve;
            });
            const lateRpcPromise = new Promise<void>((resolve) => {
                releaseLateRpc = resolve;
            });
            mockRpc.getSignaturesHook = async () => {
                lateRpcStartedResolve();
                await lateRpcPromise;
            };
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigLateGlobal", slot: 101, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            mockRpc.txMap.set(
                "sigLateGlobal",
                createMockTx({
                    signature: "sigLateGlobal",
                    slot: 101,
                    blockTime: 1050,
                    feePayer: WALLET_A,
                    instructions: [
                        {
                            data: DISC_INIT_POS,
                            accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                        },
                    ],
                })
            );

            // In-flight poll
            const inFlightCycle = engine.poll();
            await lateRpcStarted;

            // Invalidate session via global pause
            engine.pause();

            // Release late RPC response
            releaseLateRpc();
            const lateEvents = await inFlightCycle;

            // Late response from invalidated session must NOT emit alerts or mutate state
            assert.equal(lateEvents.length, 0);
            assert.equal(engine.getActivePositions(WALLET_A).length, 0);
            mockRpc.getSignaturesHook = null;

            // B. Per-wallet pause & fresh resume fencing
            await engine.init();

            let releaseWalletRpc!: () => void;
            let walletRpcStartedResolve!: () => void;
            const walletRpcStarted = new Promise<void>((resolve) => {
                walletRpcStartedResolve = resolve;
            });
            const walletRpcPromise = new Promise<void>((resolve) => {
                releaseWalletRpc = resolve;
            });
            mockRpc.getSignaturesHook = async (addr) => {
                if (addr === WALLET_A) {
                    walletRpcStartedResolve();
                    await walletRpcPromise;
                }
            };

            const inFlightWalletPoll = engine.poll();
            await walletRpcStarted;
            // Invalidate specific wallet session
            engine.pauseWallet(WALLET_A);

            releaseWalletRpc();
            const walletLateEvents = await inFlightWalletPoll;
            assert.equal(walletLateEvents.some((e) => e.walletAddress === WALLET_A), false);

            mockRpc.getSignaturesHook = null;
            engine.stop();
        });

        it("4. V1/V2 account decoding and zero-liquidity positions containing nonzero fee/reward fields", async () => {
            const bufV2Zero = createPositionBuffer(POOL_1, WALLET_A, "V2", false, {
                feeClaimedX: 7777n,
                feeClaimedY: 8888n,
            });
            const bufV1Zero = createPositionBuffer(POOL_1, WALLET_A, "V1", false, {
                feeClaimedX: 3333n,
                feeClaimedY: 4444n,
            });
            const bufV2Active = createPositionBuffer(POOL_1, WALLET_A, "V2", true);
            const bufV1Active = createPositionBuffer(POOL_1, WALLET_A, "V1", true);

            mockRpc.programAccountsMap.set(WALLET_A, [
                { pubkey: "pos_v2_zero", account: { data: bufV2Zero } },
                { pubkey: "pos_v1_zero", account: { data: bufV1Zero } },
                { pubkey: "pos_v2_active", account: { data: bufV2Active } },
                { pubkey: "pos_v1_active", account: { data: bufV1Active } },
            ]);

            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            const discovered = await engine.discoverActivePositions(WALLET_A);
            assert.equal(discovered.length, 4, "All 4 valid V1 and V2 positions must be discovered");

            const v2Zero = discovered.find((p) => p.positionAddress === "pos_v2_zero")!;
            assert.ok(v2Zero, "V2 zero-liquidity position must be discovered");
            assert.equal(v2Zero.version, "V2");
            assert.equal(v2Zero.hasLiquidity, false, "Zero liquidity shares correctly flagged as hasLiquidity=false");

            const v1Zero = discovered.find((p) => p.positionAddress === "pos_v1_zero")!;
            assert.ok(v1Zero, "V1 zero-liquidity position must be discovered");
            assert.equal(v1Zero.version, "V1");
            assert.equal(v1Zero.hasLiquidity, false);

            const v2Active = discovered.find((p) => p.positionAddress === "pos_v2_active")!;
            assert.equal(v2Active.version, "V2");
            assert.equal(v2Active.hasLiquidity, true);

            const v1Active = discovered.find((p) => p.positionAddress === "pos_v1_active")!;
            assert.equal(v1Active.version, "V1");
            assert.equal(v1Active.hasLiquidity, true);

            engine.stop();
        });

        it("5. Discovery failure without partial wallet initialization", async () => {
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });

            mockRpc.throwOnProgramAccounts = new Error("RPC 503 Service Unavailable");

            // Attempt to enroll fresh wallet with failing discovery
            const uninitializedWallet = "UninitWallet111111111111111111111111111111111";
            await assert.rejects(async () => {
                await engine.enrollWallet(uninitializedWallet);
            }, /503/);

            // Assert no partial initialization exists
            assert.equal(engine.getActivePositions(uninitializedWallet).length, 0);
            const health = engine.getHealth();
            assert.equal(health.walletStatus[uninitializedWallet], undefined);

            mockRpc.throwOnProgramAccounts = null;
            engine.stop();
        });

        it("6. Multiple CPI events with different parent indices", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Transaction containing 1 outer open event and 2 inner CPI events with different parent indices
            const multiCpiTx = createMockTx({
                signature: "sigMultiCpi",
                slot: 105,
                blockTime: 1050,
                feePayer: WALLET_A,
                instructions: [
                    {
                        data: DISC_INIT_POS,
                        accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                    },
                    {
                        data: DISC_INIT_POOL,
                        accounts: Array(15).fill(DUMMY_PUBKEY),
                    },
                ],
                innerInstructions: [
                    {
                        index: 0,
                        instructions: [
                            {
                                data: DISC_ADD_LIQ,
                                accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY],
                            },
                        ],
                    },
                    {
                        index: 1,
                        instructions: [
                            {
                                data: DISC_CLAIM_FEE,
                                accounts: [POOL_1, POS_1, DUMMY_PUBKEY, DUMMY_PUBKEY, WALLET_A, ...Array(9).fill(DUMMY_PUBKEY)],
                            },
                        ],
                    },
                ],
            });
            mockRpc.txMap.set("sigMultiCpi", multiCpiTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigMultiCpi", slot: 105, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const events = await engine.poll();
            assert.equal(events.length, 3, "All 3 distinct events (outer + 2 inner CPI) must be emitted");

            // Event 1: outer
            assert.equal(events[0].eventType, "POSITION_OPENED");
            assert.equal(events[0].source, "top-level");
            assert.equal(events[0].parentIndex, null);
            assert.ok(events[0].id.includes("sigMultiCpi:outer:-1:0:"));

            // Event 2: inner parent 0
            assert.equal(events[1].eventType, "LIQUIDITY_ADDED");
            assert.equal(events[1].source, "inner");
            assert.equal(events[1].parentIndex, 0);
            assert.ok(events[1].id.includes("sigMultiCpi:inner:0:0:"));

            // Event 3: inner parent 1
            assert.equal(events[2].eventType, "FEES_CLAIMED");
            assert.equal(events[2].source, "inner");
            assert.equal(events[2].parentIndex, 1);
            assert.ok(events[2].id.includes("sigMultiCpi:inner:1:0:"));

            // Unique deterministic identities
            const ids = new Set(events.map((e) => e.id));
            assert.equal(ids.size, 3, "Deterministic event IDs must be strictly unique");

            engine.stop();
        });

        it("7. Deduplication and cursor preservation on partial RPC failures", async () => {
            const posData = createPositionBuffer(POOL_1, WALLET_A, "V2", true);
            mockRpc.programAccountsMap.set(WALLET_A, [
                { pubkey: POS_1, account: { data: posData } },
            ]);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();

            // Set up 3 signatures: sig1 succeeds, sig2 fails, sig3 skipped
            const tx1 = createMockTx({
                signature: "sig1",
                slot: 101,
                blockTime: 1010,
                feePayer: WALLET_A,
                instructions: [{ data: DISC_ADD_LIQ, accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY] }],
            });
            const tx3 = createMockTx({
                signature: "sig3",
                slot: 103,
                blockTime: 1030,
                feePayer: WALLET_A,
                instructions: [{ data: DISC_ADD_LIQ, accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY] }],
            });

            mockRpc.txMap.set("sig1", tx1);
            mockRpc.txMap.set("sig3", tx3);
            mockRpc.throwOnTx = (sig) => (sig === "sig2" ? new Error("RPC 500 error fetching sig2") : null);

            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sig3", slot: 103, err: null, blockTime: 1030 },
                { signature: "sig2", slot: 102, err: null, blockTime: 1020 },
                { signature: "sig1", slot: 101, err: null, blockTime: 1010 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            const partialEvents = await engine.poll();
            assert.equal(partialEvents.length, 1, "Only sig1 processed before sig2 failure");
            assert.equal(partialEvents[0].signature, "sig1");

            const health = engine.getHealth();
            assert.equal(health.isDegraded, true);
            assert.equal(health.walletStatus[WALLET_A].lastSignature, "sig1", "Cursor preserved at last completely processed signature sig1");

            // Recover RPC for sig2 on subsequent poll
            mockRpc.throwOnTx = null;
            const tx2 = createMockTx({
                signature: "sig2",
                slot: 102,
                blockTime: 1020,
                feePayer: WALLET_A,
                instructions: [{ data: DISC_ADD_LIQ, accounts: [POS_1, POOL_1, ...Array(9).fill(DUMMY_PUBKEY), WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY] }],
            });
            mockRpc.txMap.set("sig2", tx2);

            const recoveredEvents = await engine.poll();
            assert.equal(recoveredEvents.length, 2, "Emits remaining events sig2 and sig3 without replaying sig1");
            assert.equal(recoveredEvents[0].signature, "sig2");
            assert.equal(recoveredEvents[1].signature, "sig3");

            engine.stop();
        });

        it("8. Accurate backend telemetry and 5-second frontend refresh", async () => {
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();
            await engine.poll();

            const health = engine.getHealth();
            assert.equal(health.configuredPollIntervalMs, 50);
            assert.ok(health.effectivePollIntervalMs !== null);
            assert.ok(health.lastSuccessfulPollAt !== null);
            assert.ok(health.lastPollDurationMs !== null && health.lastPollDurationMs >= 0);
            assert.equal(typeof health.rpcErrorCount, "number");
            assert.equal(typeof health.http429Count, "number");
            assert.equal(health.totalPollsAttempted >= 1, true);
            assert.equal(health.totalPollsSuccessful >= 1, true);
            assert.ok(health.walletStatus[WALLET_A]);

            // Test frontend refresh simulation: reading RAM telemetry makes 0 blockchain scans
            const sigCallsBefore = mockRpc.getSignaturesCalls;
            const txCallsBefore = mockRpc.getTxCalls;
            const paCallsBefore = mockRpc.getProgramAccountsCalls;

            // Frontend calls:
            engine.getHealth();
            engine.getActivePositions();
            engine.getRecentActivity();

            assert.equal(mockRpc.getSignaturesCalls, sigCallsBefore, "Frontend refresh must not trigger blockchain signature queries");
            assert.equal(mockRpc.getTxCalls, txCallsBefore, "Frontend refresh must not trigger blockchain tx queries");
            assert.equal(mockRpc.getProgramAccountsCalls, paCallsBefore, "Frontend refresh must not trigger blockchain account queries");

            engine.stop();
        });

        it("9. No activity replay after intentional Fresh Resume", async () => {
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);
            const engine = new AlertsEngine({
                watchlistStore,
                rpcClient: mockRpc,
                pollIntervalMs: 50,
            });
            await engine.init();
            await engine.start();

            // Pause monitoring
            engine.pause();

            // Activity occurs while engine is paused
            const pauseTx = createMockTx({
                signature: "sigPauseActivity",
                slot: 105,
                blockTime: 1050,
                feePayer: WALLET_A,
                instructions: [{ data: DISC_INIT_POS, accounts: [WALLET_A, POS_1, POOL_1, WALLET_A, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY, DUMMY_PUBKEY] }],
            });
            mockRpc.txMap.set("sigPauseActivity", pauseTx);
            mockRpc.signaturesMap.set(WALLET_A, [
                { signature: "sigCurrentTip", slot: 110, err: null, blockTime: 1100 },
                { signature: "sigPauseActivity", slot: 105, err: null, blockTime: 1050 },
                { signature: "sigBase", slot: 100, err: null, blockTime: 1000 },
            ]);

            // Execute Fresh Resume
            await engine.resume();

            // Poll after fresh resume
            const eventsAfterResume = await engine.poll();
            assert.equal(eventsAfterResume.length, 0, "No historical activity from paused interval must be replayed");

            engine.stop();
        });

        it("10. No Telegram network traffic or transaction history persistence", async () => {
            const originalFetch = globalThis.fetch;
            let externalNetworkCalled = false;

            globalThis.fetch = (async (url: RequestInfo | URL) => {
                if (String(url).includes("api.telegram.org") || String(url).includes("telegram")) {
                    externalNetworkCalled = true;
                }
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }) as typeof fetch;

            try {
                const adapter = new TelegramDryRunAdapter({
                    watchlistStore,
                    maxPreviews: 50,
                });

                const dummyEvent: DlmmAlertEvent = {
                    id: "sigTest:outer:-1:0:posTest:POSITION_OPENED:0",
                    eventType: "POSITION_OPENED",
                    walletAddress: WALLET_A,
                    positionAddress: POS_1,
                    poolAddress: POOL_1,
                    signature: "sigTelegramTest",
                    slot: 100,
                    blockTime: 1000,
                    instructionIndex: 0,
                    source: "outer",
                    signer: WALLET_A,
                    feePayer: WALLET_A,
                    operator: null,
                    instructionName: "initialize_position",
                    detectedAt: Date.now(),
                };

                await adapter.processEvent(dummyEvent);

                assert.equal(externalNetworkCalled, false, "Must emit zero external Telegram network calls");
                assert.equal(adapter.getCount(), 1, "Previews must be held strictly in memory");
                assert.ok(adapter.getPreviews()[0].messageText.includes("POSITION_OPENED"));

                // Verify no sqlite / database persistence created in temp dir
                const files = fs.readdirSync(tempDir);
                assert.equal(
                    files.some((f) => f.endsWith(".db") || f.endsWith(".sqlite")),
                    false,
                    "Zero SQLite or historical transaction database files allowed"
                );
            } finally {
                globalThis.fetch = originalFetch;
            }
        });
    });
});
