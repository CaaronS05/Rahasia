import {
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

interface ParsedCliArgs {
    dryRun: boolean;
}

interface MasterMeta {
    updatedAt?: string;
    [key: string]: unknown;
}

interface MasterWalletRow {
    owner?: unknown;
    fabriq?: unknown;
    _local?: unknown;
    [key: string]: unknown;
}

interface MasterFile {
    meta?: MasterMeta;
    wallets?: MasterWalletRow[];
    [key: string]: unknown;
}

interface CanonicalFabriqWallet {
    owner: string;
    fabriq: Record<string, unknown>;
    _local?: Record<string, unknown>;
}

interface CanonicalWalletsFabriqFile {
    version: "v1";
    updatedAt: string;
    walletCount: number;
    wallets: CanonicalFabriqWallet[];
}

function parseCliArgs(): ParsedCliArgs {
    const args = process.argv.slice(2);
    let dryRun = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dry-run") {
            dryRun = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return { dryRun };
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || typeof a !== "object" || b === null || typeof b !== "object") {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
        if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
}

async function loadExistingJsonOrDefault<T>(filePath: string, defaultVal: T): Promise<T> {
    try {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content) as T;
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return defaultVal;
        }
        throw err;
    }
}

async function main() {
    const { dryRun } = parseCliArgs();

    const MASTER_PATH = path.resolve("data/master/wallets-master.json");
    const CANONICAL_PATH = path.resolve("data/master/wallets-fabriq.json");

    // 1. Read wallets-master.json
    let masterRaw: string;
    try {
        masterRaw = await readFile(MASTER_PATH, "utf8");
    } catch (err: unknown) {
        throw new Error(`Failed to read master wallets file at ${MASTER_PATH}: ${getErrorMessage(err)}`);
    }

    let masterPayload: MasterFile;
    try {
        masterPayload = JSON.parse(masterRaw) as MasterFile;
    } catch (err: unknown) {
        throw new Error(`Failed to parse master wallets JSON: ${getErrorMessage(err)}`);
    }

    // 2. Validate root wallets array
    if (!masterPayload || typeof masterPayload !== "object") {
        throw new Error("Validation failed: wallets-master.json root is not an object");
    }
    if (!Array.isArray(masterPayload.wallets)) {
        throw new Error("Validation failed: wallets-master.json missing 'wallets' array");
    }

    const masterWallets = masterPayload.wallets;
    const masterWalletCount = masterWallets.length;

    let masterWalletsWithFabriq = 0;
    let fullLpAgentWalletsWithFabriq = 0;
    let fabriqOnlyStubWallets = 0;

    const candidateWallets: CanonicalFabriqWallet[] = [];
    const seenOwners = new Set<string>();
    const stubOwners = new Set<string>();

    for (let index = 0; index < masterWallets.length; index++) {
        const wallet = masterWallets[index];
        if (!isPlainObject(wallet)) {
            throw new Error(`Validation failed: Wallet at index ${index} is not an object`);
        }

        const rawOwner = wallet.owner;
        if (typeof rawOwner !== "string" || !rawOwner.trim()) {
            throw new Error(`Validation failed: Wallet at index ${index} has invalid or empty owner`);
        }
        const owner = rawOwner.trim();

        const hasFabriq = isPlainObject(wallet.fabriq);
        const isStub = Object.keys(wallet).every((k) => k === "owner" || k === "fabriq" || k === "_local");

        if (isStub) {
            fabriqOnlyStubWallets++;
            stubOwners.add(owner);
        }

        if (hasFabriq) {
            masterWalletsWithFabriq++;
            if (!isStub) {
                fullLpAgentWalletsWithFabriq++;
            }

            if (seenOwners.has(owner)) {
                throw new Error(`Validation failed: Duplicate owner found in master wallets: ${owner}`);
            }
            seenOwners.add(owner);

            const record: CanonicalFabriqWallet = {
                owner,
                fabriq: wallet.fabriq as Record<string, unknown>,
            };

            if (isPlainObject(wallet._local)) {
                record._local = wallet._local as Record<string, unknown>;
            }

            candidateWallets.push(record);
        }
    }

    // Sort wallets by owner ascending for determinism
    candidateWallets.sort((a, b) => a.owner.localeCompare(b.owner));

    const outputWalletCount = candidateWallets.length;

    // Invariant checks
    if (outputWalletCount !== masterWalletsWithFabriq) {
        throw new Error(
            `Invariant violation: outputWalletCount (${outputWalletCount}) !== masterWalletsWithFabriq (${masterWalletsWithFabriq})`
        );
    }

    if (fabriqOnlyStubWallets !== 941) {
        throw new Error(
            `Invariant violation: Expected 941 Fabriq-only legacy stubs, found ${fabriqOnlyStubWallets}`
        );
    }

    for (const stubOwner of stubOwners) {
        if (!seenOwners.has(stubOwner)) {
            throw new Error(
                `Invariant violation: Stub owner ${stubOwner} missing from canonical output candidates`
            );
        }
    }

    // Determine updatedAt: derive from authoritative master meta.updatedAt if available
    let canonicalUpdatedAt = masterPayload.meta?.updatedAt;
    if (typeof canonicalUpdatedAt !== "string" || !canonicalUpdatedAt.trim()) {
        canonicalUpdatedAt = new Date().toISOString();
    }

    // Check existing canonical file if present for byte-identical idempotency
    const existingCanonical = await loadExistingJsonOrDefault<CanonicalWalletsFabriqFile | null>(
        CANONICAL_PATH,
        null
    );

    let isContentIdenticalToExisting = false;

    if (existingCanonical && isPlainObject(existingCanonical)) {
        if (
            existingCanonical.version === "v1" &&
            existingCanonical.walletCount === outputWalletCount &&
            Array.isArray(existingCanonical.wallets) &&
            existingCanonical.wallets.length === outputWalletCount
        ) {
            let matches = true;
            for (let i = 0; i < outputWalletCount; i++) {
                const exW = existingCanonical.wallets[i];
                const candW = candidateWallets[i];
                if (!exW || candW.owner !== exW.owner || !deepEqual(candW.fabriq, exW.fabriq) || !deepEqual(candW._local, exW._local)) {
                    matches = false;
                    break;
                }
            }

            if (matches) {
                isContentIdenticalToExisting = true;
                // Preserve existing updatedAt for idempotent byte-for-byte reproducibility
                canonicalUpdatedAt = existingCanonical.updatedAt;
            }
        }
    }

    const finalOutputFile: CanonicalWalletsFabriqFile = {
        version: "v1",
        updatedAt: canonicalUpdatedAt,
        walletCount: outputWalletCount,
        wallets: candidateWallets,
    };

    if (dryRun) {
        console.log("STEP 3D-B1 FABRIQ CANONICAL DRY RUN\n");
        console.log(`MASTER WALLETS:`);
        console.log(masterWalletCount);
        console.log(`\nMASTER WALLETS WITH FABRIQ:`);
        console.log(masterWalletsWithFabriq);
        console.log(`\nFULL LP AGENT + FABRIQ:`);
        console.log(fullLpAgentWalletsWithFabriq);
        console.log(`\nFABRIQ-ONLY STUBS:`);
        console.log(fabriqOnlyStubWallets);
        console.log(`\nOUTPUT WALLETS:`);
        console.log(outputWalletCount);
        console.log(`\nVALIDATION:`);
        console.log("PASS");
        console.log(`\nCANONICAL FILE WRITTEN:`);
        console.log("NO");
        return;
    }

    // Atomic write
    const targetDir = path.dirname(CANONICAL_PATH);
    await mkdir(targetDir, { recursive: true });

    const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpCanonicalPath = path.join(targetDir, `wallets-fabriq.${nonce}.tmp`);

    const jsonContent = JSON.stringify(finalOutputFile, null, 2) + "\n";

    try {
        await writeFile(tmpCanonicalPath, jsonContent, "utf8");
        await rename(tmpCanonicalPath, CANONICAL_PATH);
    } catch (writeErr) {
        try {
            await unlink(tmpCanonicalPath);
        } catch {
            // Ignore temporary cleanup error
        }
        throw writeErr;
    }

    console.log("STEP 3D-B1 FABRIQ CANONICAL MIGRATION COMPLETE\n");
    console.log(`MASTER WALLETS: ${masterWalletCount}`);
    console.log(`MASTER WALLETS WITH FABRIQ: ${masterWalletsWithFabriq}`);
    console.log(`FULL LP AGENT + FABRIQ: ${fullLpAgentWalletsWithFabriq}`);
    console.log(`FABRIQ-ONLY STUBS: ${fabriqOnlyStubWallets}`);
    console.log(`OUTPUT WALLETS: ${outputWalletCount}`);
    console.log(`CANONICAL FILE: ${CANONICAL_PATH}`);
    if (isContentIdenticalToExisting) {
        console.log("STATUS: IDEMPOTENT (no content changes from existing canonical file)");
    } else {
        console.log("STATUS: WRITTEN");
    }
}

main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
