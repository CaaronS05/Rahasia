export interface DiscoveryConfig {
    heliusApiKey: string;
    meteoraDlmmProgramId: string;
    rpcUrl: string;
    gtfaPageSize: number;
    signaturePageSize: number;
    getTxConcurrency: number;
    requestRetries: number;
    maxTransactions: number;
    scanMode: "auto" | "gtfa" | "standard";
}

export function loadDiscoveryConfig(overrides?: Partial<DiscoveryConfig>): DiscoveryConfig {
    const heliusApiKey = process.env.HELIUS_API_KEY || "";
    const meteoraDlmmProgramId =
        process.env.METEORA_DLMM_PROGRAM_ID ||
        "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

    const defaultRpcUrl = heliusApiKey
        ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
        : "https://api.mainnet-beta.solana.com";

    const rpcUrl = process.env.SOLANA_RPC_URL || defaultRpcUrl;

    const gtfaPageSize = Math.max(1, Number(process.env.GTFA_PAGE_SIZE || 100));
    const signaturePageSize = Math.max(1, Number(process.env.STANDARD_SIGNATURE_PAGE_SIZE || 100));
    const getTxConcurrency = Math.max(1, Number(process.env.GET_TX_CONCURRENCY || 5));
    const requestRetries = Math.max(1, Number(process.env.REQUEST_RETRIES || 5));
    const maxTransactions = Math.max(0, Number(process.env.MAX_TRANSACTIONS || 0));

    const rawMode = (process.env.SCAN_MODE || "auto").toLowerCase();
    const scanMode: "auto" | "gtfa" | "standard" =
        rawMode === "gtfa" || rawMode === "standard" ? rawMode : "auto";

    return {
        heliusApiKey,
        meteoraDlmmProgramId,
        rpcUrl,
        gtfaPageSize,
        signaturePageSize,
        getTxConcurrency,
        requestRetries,
        maxTransactions,
        scanMode,
        ...overrides,
    };
}
