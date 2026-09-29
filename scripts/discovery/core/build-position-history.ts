import type {
    FabriqPositionRecord,
    FabriqTransactionEvent,
} from "./fabriq-position-history.ts";
import type { WalletLpEventRecord } from "./scan-wallet-history.ts";

export interface FabriqPositionSummary {
    openedAt: string | null;
    latestCloseAt: string | null;
    totalAddUsd: number;
    totalAddSol: number;
    totalRemoveUsd: number;
    totalRemoveSol: number;
    totalFeeUsd: number;
    totalFeeSol: number;
    totalPnlUsd: number;
    totalPnlSol: number;
}

export interface PositionLifecycleEvent {
    rawType: string;
    category: string;
    createdAt: string;
    signature: string;
    source: string;
    tokenXAmount: number;
    tokenYAmount: number;
    tokenXAmountUsd: number;
    tokenYAmountUsd: number;
    tokenXAmountSol: number;
    tokenYAmountSol: number;
    totalInUsd: number;
    totalInSol: number;
    rawId?: string;
}

export interface PositionLifecycleRecord {
    wallet: string;
    pool: string;
    position: string;
    source: string;

    openedAt: string | null;
    closedAt: string | null;

    firstSeenAt: string;
    lastSeenAt: string;

    lifecycle: {
        initializeCount: number;
        addCount: number;
        removeCount: number;
        claimFeeCount: number;
        claimRewardCount: number;
        rebalanceCount: number;
        closeCount: number;
        unknownCount: number;
    };

    hasInitialize: boolean;
    hasClose: boolean;

    status: "CLOSED" | "PARTIAL_HISTORY";

    eventCount: number;

    fabriqSummary: FabriqPositionSummary;

    events: PositionLifecycleEvent[];
}

export interface BuildFabriqPositionHistoryResult {
    wallet: string;
    positions: PositionLifecycleRecord[];
    positionsClosed: number;
    positionsPartialHistory: number;
}

export function buildFabriqPositionHistory(
    wallet: string,
    fabriqPositions: FabriqPositionRecord[],
    fabriqEvents: FabriqTransactionEvent[]
): BuildFabriqPositionHistoryResult {
    // Group transaction events by positionId
    const eventsByPosition = new Map<string, FabriqTransactionEvent[]>();

    for (const ev of fabriqEvents) {
        if (!ev.positionId) continue;
        const list = eventsByPosition.get(ev.positionId);
        if (list) {
            list.push(ev);
        } else {
            eventsByPosition.set(ev.positionId, [ev]);
        }
    }

    const records: PositionLifecycleRecord[] = [];
    let positionsClosed = 0;
    let positionsPartialHistory = 0;

    for (const pos of fabriqPositions) {
        const posEvents = (eventsByPosition.get(pos.id) || []).slice();

        // Sort events deterministically:
        // 1. createdAt ascending
        // 2. signature ascending
        // 3. raw event id ascending
        posEvents.sort((a, b) => {
            const timeA = new Date(a.createdAt).getTime() || 0;
            const timeB = new Date(b.createdAt).getTime() || 0;
            if (timeA !== timeB) return timeA - timeB;
            if (a.signature !== b.signature) {
                return a.signature.localeCompare(b.signature);
            }
            return String(a.rawId).localeCompare(String(b.rawId));
        });

        const lifecycle = {
            initializeCount: 0,
            addCount: 0,
            removeCount: 0,
            claimFeeCount: 0,
            claimRewardCount: 0,
            rebalanceCount: 0,
            closeCount: 0,
            unknownCount: 0,
        };

        const initTimestamps: string[] = [];
        const closeTimestamps: string[] = [];

        for (const ev of posEvents) {
            switch (ev.category) {
                case "initialize":
                    lifecycle.initializeCount++;
                    initTimestamps.push(ev.createdAt);
                    break;
                case "add":
                    lifecycle.addCount++;
                    break;
                case "remove":
                    lifecycle.removeCount++;
                    break;
                case "claim_fee":
                    lifecycle.claimFeeCount++;
                    break;
                case "close":
                    lifecycle.closeCount++;
                    closeTimestamps.push(ev.createdAt);
                    break;
                default:
                    lifecycle.unknownCount++;
                    break;
            }
        }

        const hasInitialize = lifecycle.initializeCount > 0;
        const hasClose = lifecycle.closeCount > 0;

        // Closed-position proof status:
        // CLOSED: POSITION_CLOSE is observed.
        // PARTIAL_HISTORY: Fabriq position summary says position was closed, but POSITION_CLOSE not observed.
        const status: "CLOSED" | "PARTIAL_HISTORY" = hasClose
            ? "CLOSED"
            : "PARTIAL_HISTORY";

        if (status === "CLOSED") {
            positionsClosed++;
        } else {
            positionsPartialHistory++;
        }

        const openedAt =
            initTimestamps.length > 0
                ? initTimestamps[0]
                : pos.opened_at ?? null;

        const closedAt =
            closeTimestamps.length > 0
                ? closeTimestamps[closeTimestamps.length - 1]
                : null;

        const firstSeenAt =
            posEvents.length > 0
                ? posEvents[0].createdAt
                : pos.opened_at ?? pos.latest_close_ts ?? "";

        const lastSeenAt =
            posEvents.length > 0
                ? posEvents[posEvents.length - 1].createdAt
                : pos.latest_close_ts ?? pos.opened_at ?? "";

        const strippedEvents: PositionLifecycleEvent[] = posEvents.map((e) => ({
            rawType: e.rawType,
            category: e.category,
            createdAt: e.createdAt,
            signature: e.signature,
            source: e.source,
            tokenXAmount: e.tokenXAmount,
            tokenYAmount: e.tokenYAmount,
            tokenXAmountUsd: e.tokenXAmountUsd,
            tokenYAmountUsd: e.tokenYAmountUsd,
            tokenXAmountSol: e.tokenXAmountSol,
            tokenYAmountSol: e.tokenYAmountSol,
            totalInUsd: e.totalInUsd,
            totalInSol: e.totalInSol,
            rawId: e.rawId,
        }));

        const fabriqSummary: FabriqPositionSummary = {
            openedAt: pos.opened_at,
            latestCloseAt: pos.latest_close_ts,
            totalAddUsd: pos.total_add_usd,
            totalAddSol: pos.total_add_sol,
            totalRemoveUsd: pos.total_rem_usd,
            totalRemoveSol: pos.total_rem_sol,
            totalFeeUsd: pos.total_fee_usd,
            totalFeeSol: pos.total_fee_sol,
            totalPnlUsd: pos.total_pnl_usd,
            totalPnlSol: pos.total_pnl_sol,
        };

        records.push({
            wallet,
            pool: pos.pool_id,
            position: pos.id,
            source: pos.source,
            openedAt,
            closedAt,
            firstSeenAt,
            lastSeenAt,
            lifecycle,
            hasInitialize,
            hasClose,
            status,
            eventCount: strippedEvents.length,
            fabriqSummary,
            events: strippedEvents,
        });
    }

    // Sort positions deterministically: firstSeenAt ascending, then position address
    records.sort((a, b) => {
        if (a.firstSeenAt !== b.firstSeenAt) {
            return a.firstSeenAt.localeCompare(b.firstSeenAt);
        }
        return a.position.localeCompare(b.position);
    });

    return {
        wallet,
        positions: records,
        positionsClosed,
        positionsPartialHistory,
    };
}

// Backward-compatible alias / RPC position builder for existing code
export function buildPositionHistory(
    wallet: string,
    eventsOrPositions: any[],
    maybeEvents?: any[]
): any {
    if (maybeEvents !== undefined) {
        return buildFabriqPositionHistory(wallet, eventsOrPositions, maybeEvents);
    }
    // Existing RPC implementation fallback
    const positionMap = new Map<string, any[]>();
    for (const ev of eventsOrPositions) {
        if (!ev.position) continue;
        const list = positionMap.get(ev.position);
        if (list) list.push(ev);
        else positionMap.set(ev.position, [ev]);
    }

    const positions: any[] = [];
    const invariantViolations: any[] = [];
    const statusCounts = { CLOSED: 0, OPEN_CANDIDATE: 0, PARTIAL_HISTORY: 0 };

    for (const [posAddress, pEvents] of positionMap.entries()) {
        const pools = Array.from(new Set(pEvents.map((e) => e.pool))).sort();
        let pool = pools[0] || "";
        if (pools.length > 1) {
            invariantViolations.push({ position: posAddress, pools, description: "Multiple pools" });
            pool = `INVARIANT_VIOLATION_MULTIPLE_POOLS[${pools.join(",")}]`;
        }
        let initCount = 0;
        let closeCount = 0;
        for (const e of pEvents) {
            if (e.category === "initialize") initCount++;
            if (e.category === "close") closeCount++;
        }
        const hasInit = initCount > 0;
        const hasClose = closeCount > 0;
        const status = hasClose ? "CLOSED" : hasInit ? "OPEN_CANDIDATE" : "PARTIAL_HISTORY";
        statusCounts[status]++;
        positions.push({
            wallet,
            pool,
            position: posAddress,
            status,
            events: pEvents,
            eventCount: pEvents.length,
        });
    }

    return {
        wallet,
        positions,
        invariantViolations,
        statusCounts,
    };
}
