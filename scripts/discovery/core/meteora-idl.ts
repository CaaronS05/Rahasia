import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const METEORA_IDL_URL =
    "https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json";

export const LOCAL_IDL_PATH = path.resolve("data/idl/dlmm.json");
export const LOCAL_IDL_META_PATH = path.resolve("data/idl/dlmm.meta.json");

export interface RawIdlAccount {
    name?: string;
    signer?: boolean;
    writable?: boolean;
    accounts?: RawIdlAccount[];
}

export interface FlatIdlAccount {
    name: string;
    signer: boolean;
    writable: boolean;
}

export interface IdlInstruction {
    name: string;
    discriminator: number[];
    accounts?: RawIdlAccount[];
    flatAccounts?: FlatIdlAccount[];
}

export interface IdlEvent {
    name: string;
    discriminator: number[];
}

export interface IdlMetadata {
    sourceUrl: string;
    fetchedAt: string;
    sha256: string;
    instructionCount: number;
    eventCount: number;
    programAddress: string | null;
    programAddressValidation: "matched" | "mismatched" | "unavailable_from_idl";
}

export interface MeteoraIdlBundle {
    instructionMap: Map<string, IdlInstruction>;
    eventMap: Map<string, IdlEvent>;
    metadata: IdlMetadata;
}

export function flattenIdlAccounts(
    accounts: RawIdlAccount[] = [],
    prefix = ""
): FlatIdlAccount[] {
    const result: FlatIdlAccount[] = [];

    for (const account of accounts) {
        if (Array.isArray(account.accounts)) {
            const nestedPrefix = account.name ? `${prefix}${account.name}.` : prefix;
            result.push(...flattenIdlAccounts(account.accounts, nestedPrefix));
            continue;
        }

        const name = account.name
            ? prefix
                ? `${prefix}${account.name}`
                : account.name
            : "unknown";

        result.push({
            name,
            signer: Boolean(account.signer),
            writable: Boolean(account.writable),
        });
    }

    return result;
}

export type IdlDiscriminatorMap = Map<string, IdlInstruction>;
export type IdlEventDiscriminatorMap = Map<string, IdlEvent>;

export async function loadMeteoraIdl(
    expectedProgramId = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
): Promise<MeteoraIdlBundle> {
    let idlJson: any;
    let rawContent: string | null = null;
    let fetchedAt: string | null = null;

    if (fs.existsSync(LOCAL_IDL_PATH)) {
        try {
            rawContent = fs.readFileSync(LOCAL_IDL_PATH, "utf8");
            idlJson = JSON.parse(rawContent);
            if (fs.existsSync(LOCAL_IDL_META_PATH)) {
                try {
                    const existingMeta = JSON.parse(
                        fs.readFileSync(LOCAL_IDL_META_PATH, "utf8")
                    );

                    if (typeof existingMeta.fetchedAt === "string") {
                        fetchedAt = existingMeta.fetchedAt;
                    }
                } catch {
                    // Ignore invalid metadata; IDL cache itself can still be used.
                }
            }
        } catch (error) {
            console.warn("[IDL] Local cache read error, re-fetching:", error);
            rawContent = null;
            idlJson = null;
        }
    }

    if (!idlJson || !rawContent) {
        const response = await fetch(METEORA_IDL_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch Meteora IDL: HTTP ${response.status}`);
        }
        rawContent = await response.text();
        fetchedAt = new Date().toISOString();
        idlJson = JSON.parse(rawContent);

        // Cache locally for resilient subsequent runs
        try {
            const dir = path.dirname(LOCAL_IDL_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(LOCAL_IDL_PATH, JSON.stringify(idlJson, null, 2), "utf8");
        } catch (writeErr) {
            console.warn("[IDL] Warning: Failed to write local IDL cache:", writeErr);
        }
    }

    // Validation
    const instructions: IdlInstruction[] = Array.isArray(idlJson.instructions)
        ? idlJson.instructions
        : [];

    if (instructions.length === 0) {
        throw new Error("Invalid Meteora IDL: instructions array is empty or missing");
    }

    const events: IdlEvent[] = Array.isArray(idlJson.events)
        ? idlJson.events
        : [];

    const instructionMap: IdlDiscriminatorMap = new Map();
    for (const ix of instructions) {
        if (!ix.name || !Array.isArray(ix.discriminator)) continue;
        if (ix.discriminator.length !== 8) {
            throw new Error(
                `Invalid instruction discriminator length for ${ix.name}: expected 8 bytes, got ${ix.discriminator.length}`
            );
        }
        const hex = Buffer.from(ix.discriminator).toString("hex");
        ix.flatAccounts = flattenIdlAccounts(ix.accounts);
        instructionMap.set(hex, ix);
    }

    const eventMap: IdlEventDiscriminatorMap = new Map();
    for (const ev of events) {
        if (!ev.name || !Array.isArray(ev.discriminator)) continue;
        if (ev.discriminator.length !== 8) {
            throw new Error(
                `Invalid event discriminator length for ${ev.name}: expected 8 bytes, got ${ev.discriminator.length}`
            );
        }
        const hex = Buffer.from(ev.discriminator).toString("hex");
        eventMap.set(hex, ev);
    }

    // Program address validation
    const idlProgramAddress = typeof idlJson.address === "string" ? idlJson.address : null;
    let programAddressValidation: "matched" | "mismatched" | "unavailable_from_idl" =
        "unavailable_from_idl";

    if (idlProgramAddress) {
        programAddressValidation =
            idlProgramAddress === expectedProgramId ? "matched" : "mismatched";
    }

    const sha256 = crypto.createHash("sha256").update(rawContent).digest("hex");

    const metadata: IdlMetadata = {
        sourceUrl: METEORA_IDL_URL,
        fetchedAt: fetchedAt ?? new Date().toISOString(),
        sha256,
        instructionCount: instructions.length,
        eventCount: events.length,
        programAddress: idlProgramAddress,
        programAddressValidation,
    };

    // Save or update dlmm.meta.json
    try {
        const metaDir = path.dirname(LOCAL_IDL_META_PATH);
        if (!fs.existsSync(metaDir)) {
            fs.mkdirSync(metaDir, { recursive: true });
        }
        fs.writeFileSync(
            LOCAL_IDL_META_PATH,
            JSON.stringify(metadata, null, 2),
            "utf8"
        );
    } catch (metaErr) {
        console.warn("[IDL] Warning: Failed to write dlmm.meta.json:", metaErr);
    }

    return {
        instructionMap,
        eventMap,
        metadata,
    };
}

