import type { DiscoveryConfig } from "./config.ts";

let nextRpcId = 1;

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RpcError extends Error {
    code?: number;
    data?: unknown;

    constructor(message: string, code?: number, data?: unknown) {
        super(message);
        this.name = "RpcError";
        this.code = code;
        this.data = data;
    }
}

export async function rpcCall<T>(
    rpcUrl: string,
    method: string,
    params: unknown[],
    retries = 5
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const response = await fetch(rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: nextRpcId++,
                    method,
                    params,
                }),
            });

            if (response.status === 429 || response.status >= 500) {
                throw new Error(`HTTP ${response.status}`);
            }

            const json = (await response.json()) as {
                result?: T;
                error?: { code?: number; message?: string; data?: unknown };
            };

            if (json.error) {
                throw new RpcError(
                    json.error.message || `RPC ${method} failed`,
                    json.error.code,
                    json.error.data
                );
            }

            return json.result as T;
        } catch (error) {
            lastError = error;
            if (error instanceof RpcError && error.code !== 429) {
                throw error;
            }
            const delay = Math.min(500 * Math.pow(2, attempt), 8000);
            await sleep(delay);
        }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function mapConcurrent<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const index = nextIndex++;
            if (index >= items.length) return;
            out[index] = await fn(items[index], index);
        }
    }

    const workerCount = Math.min(concurrency, Math.max(items.length, 1));
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);
    return out;
}

export interface GtfaPageResult {
    data: any[];
    paginationToken: string | null;
}

export async function fetchGtfaPage(
    config: DiscoveryConfig,
    poolAddress: string,
    startTime: number,
    endTime: number,
    limit: number,
    paginationToken?: string
): Promise<GtfaPageResult> {
    const options: Record<string, unknown> = {
        transactionDetails: "full",
        sortOrder: "asc",
        limit,
        maxSupportedTransactionVersion: 1,
        filters: {
            blockTime: { gte: startTime, lte: endTime },
            status: "succeeded",
        },
    };

    if (paginationToken) {
        options.paginationToken = paginationToken;
    }

    const result = await rpcCall<{ data?: any[]; paginationToken?: string | null }>(
        config.rpcUrl,
        "getTransactionsForAddress",
        [poolAddress, options],
        config.requestRetries
    );

    return {
        data: result?.data ?? [],
        paginationToken: result?.paginationToken || null,
    };
}

export interface StandardSignatureInfo {
    signature: string;
    blockTime: number | null;
    err: unknown;
    slot: number;
}

export async function fetchStandardSignatures(
    config: DiscoveryConfig,
    poolAddress: string,
    limit: number,
    before?: string
): Promise<StandardSignatureInfo[]> {
    const options: Record<string, unknown> = { limit };
    if (before) options.before = before;

    const signatures = await rpcCall<StandardSignatureInfo[]>(
        config.rpcUrl,
        "getSignaturesForAddress",
        [poolAddress, options],
        config.requestRetries
    );

    return signatures || [];
}

export async function fetchStandardTransaction(
    config: DiscoveryConfig,
    signature: string
): Promise<any> {
    return rpcCall<any>(
        config.rpcUrl,
        "getTransaction",
        [
            signature,
            {
                encoding: "json",
                commitment: "confirmed",
                maxSupportedTransactionVersion: 1,
            },
        ],
        config.requestRetries
    );
}

export interface AccountInfoResponse {
    data: [string, string]; // [base64 string, encoding]
    executable: boolean;
    lamports: number;
    owner: string;
    rentEpoch: number;
}

export async function fetchMultipleAccounts(
    rpcUrl: string,
    addresses: string[],
    retries = 5
): Promise<(AccountInfoResponse | null)[]> {
    if (addresses.length === 0) return [];

    const CHUNK_SIZE = 100;
    const results: (AccountInfoResponse | null)[] = [];

    for (let i = 0; i < addresses.length; i += CHUNK_SIZE) {
        const chunk = addresses.slice(i, i + CHUNK_SIZE);
        const chunkResult = await rpcCall<{ value?: (AccountInfoResponse | null)[] }>(
            rpcUrl,
            "getMultipleAccounts",
            [
                chunk,
                {
                    commitment: "confirmed",
                    encoding: "base64",
                },
            ],
            retries
        );

        results.push(...(chunkResult?.value ?? chunk.map(() => null)));
    }

    return results;
}
