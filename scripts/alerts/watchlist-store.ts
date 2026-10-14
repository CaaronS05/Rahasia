import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";

export interface WatchlistEntry {
    address: string;
    alias?: string;
    enabled: boolean;
}

export interface WatchlistData {
    wallets: WatchlistEntry[];
}

export class WatchlistCorruptError extends Error {
    constructor(filePath: string, cause?: unknown) {
        super(
            `Watchlist file is corrupted or malformed at '${filePath}': ${
                cause instanceof Error ? cause.message : String(cause)
            }`
        );
        this.name = "WatchlistCorruptError";
    }
}

export function isValidSolanaAddress(address: unknown): boolean {
    if (typeof address !== "string") return false;
    const trimmed = address.trim();
    if (trimmed.length < 32 || trimmed.length > 44) return false;
    try {
        const pk = new PublicKey(trimmed);
        return pk.toBase58() === trimmed;
    } catch {
        return false;
    }
}

export class WatchlistStore {
    private static locks = new Map<string, Promise<unknown>>();
    public readonly filePath: string;

    constructor(filePath?: string) {
        this.filePath = path.resolve(
            filePath || process.env.WATCHLIST_PATH || path.join(process.cwd(), "data/alerts/watchlist.json")
        );
    }
    private runExclusive<T>(op: () => Promise<T>): Promise<T> {
        const key = this.filePath;
        const current = WatchlistStore.locks.get(key) || Promise.resolve();
        const next = current.catch(() => {}).then(() => op());
        WatchlistStore.locks.set(key, next.catch(() => {}));
        return next;
    }

    private readData(): WatchlistData {
        if (!fs.existsSync(this.filePath)) {
            return { wallets: [] };
        }

        let content: string;
        try {
            content = fs.readFileSync(this.filePath, "utf8");
        } catch (err) {
            throw new WatchlistCorruptError(this.filePath, err);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (err) {
            throw new WatchlistCorruptError(this.filePath, err);
        }

        if (!parsed || typeof parsed !== "object") {
            throw new WatchlistCorruptError(
                this.filePath,
                new Error("Expected JSON object at root")
            );
        }

        const rawObj = parsed as Record<string, unknown>;
        let rawWallets: unknown;
        if (Array.isArray(parsed)) {
            rawWallets = parsed;
        } else if (Array.isArray(rawObj.wallets)) {
            rawWallets = rawObj.wallets;
        } else {
            throw new WatchlistCorruptError(
                this.filePath,
                new Error("Missing or invalid 'wallets' array")
            );
        }

        const seen = new Set<string>();
        const wallets: WatchlistEntry[] = [];

        for (let i = 0; i < (rawWallets as unknown[]).length; i++) {
            const rawEntry = (rawWallets as unknown[])[i];
            if (!rawEntry || typeof rawEntry !== "object") {
                throw new WatchlistCorruptError(
                    this.filePath,
                    new Error(`Entry at index ${i} is not an object`)
                );
            }
            const item = rawEntry as Record<string, unknown>;
            if (
                typeof item.address !== "string" ||
                !isValidSolanaAddress(item.address)
            ) {
                throw new WatchlistCorruptError(
                    this.filePath,
                    new Error(`Entry at index ${i} has invalid Solana address`)
                );
            }
            if (typeof item.enabled !== "boolean") {
                throw new WatchlistCorruptError(
                    this.filePath,
                    new Error(`Entry at index ${i} has non-boolean enabled status`)
                );
            }

            if (seen.has(item.address)) {
                throw new WatchlistCorruptError(
                    this.filePath,
                    new Error(`Duplicate wallet address '${item.address}' at index ${i}`)
                );
            }
            seen.add(item.address);

            const entry: WatchlistEntry = {
                address: item.address,
                enabled: item.enabled,
            };

            if (typeof item.alias === "string" && item.alias.trim().length > 0) {
                entry.alias = item.alias.trim();
            } else if (item.alias !== undefined && item.alias !== null) {
                throw new WatchlistCorruptError(
                    this.filePath,
                    new Error(`Entry at index ${i} has invalid alias type`)
                );
            }

            wallets.push(entry);
        }

        return { wallets };
    }

    private writeData(data: WatchlistData): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const tempPath = path.join(
            dir,
            `.${path.basename(this.filePath)}.${Date.now()}.${Math.random()
                .toString(36)
                .slice(2, 8)}.tmp`
        );
        const payload = JSON.stringify(data, null, 2) + "\n";

        try {
            fs.writeFileSync(tempPath, payload, "utf8");
            fs.renameSync(tempPath, this.filePath);
        } catch (err) {
            try {
                if (fs.existsSync(tempPath)) {
                    fs.unlinkSync(tempPath);
                }
            } catch {
                // ignore temp cleanup failure
            }
            throw err;
        }
    }

    public async listWallets(): Promise<WatchlistEntry[]> {
        return this.runExclusive(async () => {
            const data = this.readData();
            return data.wallets.map((w) => ({ ...w }));
        });
    }

    public async getWallet(address: string): Promise<WatchlistEntry | null> {
        if (!isValidSolanaAddress(address)) {
            throw new Error(`Invalid Solana wallet address: ${address}`);
        }
        const cleanAddress = address.trim();
        return this.runExclusive(async () => {
            const data = this.readData();
            const found = data.wallets.find((w) => w.address === cleanAddress);
            return found ? { ...found } : null;
        });
    }

    public async hasWallet(address: string): Promise<boolean> {
        return (await this.getWallet(address)) !== null;
    }

    public async addWallet(
        addressOrEntry: string | { address: string; alias?: string; enabled?: boolean },
        alias?: string,
        enabled?: boolean
    ): Promise<WatchlistEntry> {
        let rawAddress: string;
        let rawAlias: string | undefined = alias;
        let rawEnabled = enabled ?? false;

        if (typeof addressOrEntry === "object" && addressOrEntry !== null) {
            rawAddress = addressOrEntry.address;
            rawAlias = addressOrEntry.alias ?? alias;
            rawEnabled = addressOrEntry.enabled ?? enabled ?? false;
        } else {
            rawAddress = addressOrEntry;
        }

        if (!isValidSolanaAddress(rawAddress)) {
            throw new Error(`Invalid Solana wallet address: ${rawAddress}`);
        }
        const cleanAddress = rawAddress.trim();
        const cleanAlias =
            typeof rawAlias === "string" && rawAlias.trim().length > 0
                ? rawAlias.trim()
                : undefined;

        return this.runExclusive(async () => {
            const data = this.readData();
            if (data.wallets.some((w) => w.address === cleanAddress)) {
                throw new Error(`Wallet already in watchlist: ${cleanAddress}`);
            }

            const newEntry: WatchlistEntry = {
                address: cleanAddress,
                enabled: Boolean(rawEnabled),
            };
            if (cleanAlias) {
                newEntry.alias = cleanAlias;
            }

            data.wallets.push(newEntry);
            this.writeData(data);
            return { ...newEntry };
        });
    }

    public async updateWallet(
        address: string,
        updates: { alias?: string | null; enabled?: boolean }
    ): Promise<WatchlistEntry> {
        if (!isValidSolanaAddress(address)) {
            throw new Error(`Invalid Solana wallet address: ${address}`);
        }
        const cleanAddress = address.trim();

        return this.runExclusive(async () => {
            const data = this.readData();
            const entry = data.wallets.find((w) => w.address === cleanAddress);
            if (!entry) {
                throw new Error(`Wallet not found in watchlist: ${cleanAddress}`);
            }

            if (updates.enabled !== undefined) {
                if (typeof updates.enabled !== "boolean") {
                    throw new Error("Property 'enabled' must be a boolean");
                }
                entry.enabled = updates.enabled;
            }

            if (updates.alias !== undefined) {
                if (updates.alias === null || updates.alias.trim() === "") {
                    delete entry.alias;
                } else if (typeof updates.alias === "string") {
                    entry.alias = updates.alias.trim();
                } else {
                    throw new Error("Property 'alias' must be a string or null");
                }
            }

            this.writeData(data);
            return { ...entry };
        });
    }

    public async enableWallet(address: string): Promise<WatchlistEntry> {
        return this.updateWallet(address, { enabled: true });
    }

    public async disableWallet(address: string): Promise<WatchlistEntry> {
        return this.updateWallet(address, { enabled: false });
    }

    public async removeWallet(address: string): Promise<boolean> {
        if (!isValidSolanaAddress(address)) {
            throw new Error(`Invalid Solana wallet address: ${address}`);
        }
        const cleanAddress = address.trim();

        return this.runExclusive(async () => {
            const data = this.readData();
            const idx = data.wallets.findIndex((w) => w.address === cleanAddress);
            if (idx === -1) {
                return false;
            }
            data.wallets.splice(idx, 1);
            this.writeData(data);
            return true;
        });
    }
}
