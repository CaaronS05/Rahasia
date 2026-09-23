import bs58 from "bs58";
import type { NormalizedInstruction } from "./transaction-normalizer.ts";
import type { IdlDiscriminatorMap, IdlInstruction } from "./meteora-idl.ts";

export type DecodeStatus =
    | "ACCEPTED"
    | "NOT_METEORA"
    | "DATA_TOO_SHORT"
    | "UNKNOWN_DISCRIMINATOR"
    | "NON_LP_INSTRUCTION"
    | "NO_POOL_ACCOUNT"
    | "WRONG_POOL";

export interface DecodedLpInstruction {
    status: DecodeStatus;
    instructionName: string | null;
    discriminatorHex: string | null;
    category: string | null;
    pool: string | null;
    position: string | null;
    mappedAccounts: Record<string, string>;
    idlInstruction: IdlInstruction | null;
    rejectReason?: string;
}

export function classifyInstructionCategory(name: string): string | null {
    // Operator/admin instructions are explicitly not direct LP lifecycle
    if (
        name.includes("operator") ||
        name.includes("admin") ||
        name.includes("protocol") ||
        name.includes("reward_funder")
    ) {
        return null;
    }

    if (name.startsWith("initialize_position")) {
        return "initialize";
    }
    if (name.startsWith("add_liquidity")) {
        return "add";
    }
    if (name.startsWith("remove_liquidity") || name === "remove_all_liquidity") {
        return "remove";
    }
    if (name.startsWith("claim_fee")) {
        return "claim_fee";
    }
    if (name.startsWith("claim_reward")) {
        return "claim_reward";
    }
    if (name.startsWith("close_position")) {
        return "close";
    }
    if (name === "rebalance_liquidity") {
        return "rebalance";
    }

    return null;
}

export function decodeLpInstruction(
    ix: NormalizedInstruction,
    targetPool: string,
    meteoraProgramId: string,
    discriminatorMap: IdlDiscriminatorMap
): DecodedLpInstruction {
    if (ix.programId !== meteoraProgramId) {
        return {
            status: "NOT_METEORA",
            instructionName: null,
            discriminatorHex: null,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction: null,
            rejectReason: `Program ID ${ix.programId} does not match Meteora DLMM ${meteoraProgramId}`,
        };
    }

    if (!ix.data || typeof ix.data !== "string") {
        return {
            status: "DATA_TOO_SHORT",
            instructionName: null,
            discriminatorHex: null,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction: null,
            rejectReason: "Missing instruction data",
        };
    }

    let rawBuffer: Buffer;
    try {
        rawBuffer = Buffer.from(bs58.decode(ix.data));
    } catch (err) {
        return {
            status: "DATA_TOO_SHORT",
            instructionName: null,
            discriminatorHex: null,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction: null,
            rejectReason: "Failed to decode base58 instruction data",
        };
    }

    if (rawBuffer.length < 8) {
        return {
            status: "DATA_TOO_SHORT",
            instructionName: null,
            discriminatorHex: null,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction: null,
            rejectReason: `Instruction data too short (${rawBuffer.length} bytes < 8 bytes)`,
        };
    }

    const discriminatorHex = rawBuffer.subarray(0, 8).toString("hex");
    const idlInstruction = discriminatorMap.get(discriminatorHex);

    if (!idlInstruction) {
        return {
            status: "UNKNOWN_DISCRIMINATOR",
            instructionName: null,
            discriminatorHex,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction: null,
            rejectReason: `Unknown instruction discriminator: ${discriminatorHex}`,
        };
    }

    const instructionName = idlInstruction.name;
    const category = classifyInstructionCategory(instructionName);

    if (!category) {
        return {
            status: "NON_LP_INSTRUCTION",
            instructionName,
            discriminatorHex,
            category: null,
            pool: null,
            position: null,
            mappedAccounts: {},
            idlInstruction,
            rejectReason: `Instruction '${instructionName}' is not an accepted LP lifecycle instruction`,
        };
    }

    // Map accounts using IDL definition
    const mappedAccounts: Record<string, string> = {};
    const flatAccounts = idlInstruction.flatAccounts || [];

    for (let i = 0; i < flatAccounts.length; i++) {
        const accountDef = flatAccounts[i];
        const actualKey = ix.accounts[i] ?? null;
        if (actualKey) {
            mappedAccounts[accountDef.name] = actualKey;
        }
    }

    // Extract pool account: lb_pair or pool
    const pool =
        mappedAccounts["lb_pair"] ||
        mappedAccounts["pool"] ||
        null;

    if (!pool) {
        return {
            status: "NO_POOL_ACCOUNT",
            instructionName,
            discriminatorHex,
            category,
            pool: null,
            position: null,
            mappedAccounts,
            idlInstruction,
            rejectReason: `Instruction '${instructionName}' does not specify an lb_pair pool account`,
        };
    }

    // Exact pool check: decodedPool === targetPool
    if (pool !== targetPool) {
        return {
            status: "WRONG_POOL",
            instructionName,
            discriminatorHex,
            category,
            pool,
            position: null,
            mappedAccounts,
            idlInstruction,
            rejectReason: `Decoded pool ${pool} does not match target pool ${targetPool}`,
        };
    }

    // Extract position account: position or position_v2
    const position =
        mappedAccounts["position"] ||
        mappedAccounts["position_v2"] ||
        null;

    return {
        status: "ACCEPTED",
        instructionName,
        discriminatorHex,
        category,
        pool,
        position,
        mappedAccounts,
        idlInstruction,
    };
}
