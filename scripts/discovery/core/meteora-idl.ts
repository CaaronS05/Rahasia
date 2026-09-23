import fs from "node:fs";
import path from "node:path";

export const METEORA_IDL_URL =
    "https://raw.githubusercontent.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json";

export const LOCAL_IDL_PATH = path.resolve("data/idl/dlmm.json");

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

export async function loadMeteoraIdl(): Promise<IdlDiscriminatorMap> {
    let idlJson: any;

    if (fs.existsSync(LOCAL_IDL_PATH)) {
        try {
            const content = fs.readFileSync(LOCAL_IDL_PATH, "utf8");
            idlJson = JSON.parse(content);
        } catch (error) {
            console.warn("[IDL] Local cache read error, re-fetching:", error);
        }
    }

    if (!idlJson) {
        const response = await fetch(METEORA_IDL_URL);
        if (!response.ok) {
            throw new Error(`Failed to fetch Meteora IDL: HTTP ${response.status}`);
        }
        idlJson = await response.json();

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

    const instructions: IdlInstruction[] = Array.isArray(idlJson.instructions)
        ? idlJson.instructions
        : [];

    const discriminatorMap: IdlDiscriminatorMap = new Map();

    for (const ix of instructions) {
        if (!ix.name || !Array.isArray(ix.discriminator)) continue;

        const hex = Buffer.from(ix.discriminator).toString("hex");
        ix.flatAccounts = flattenIdlAccounts(ix.accounts);
        discriminatorMap.set(hex, ix);
    }

    return discriminatorMap;
}
