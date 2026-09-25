export interface NormalizedInstruction {
    signature: string;
    slot: number;
    blockTime: number;
    source: "top-level" | "inner";
    parentIndex: number | null;
    instructionIndex: number;
    programId: string;
    accounts: string[];
    data: string;
    feePayer: string | null;
    signers: string[];
}

export function pubkeyOf(key: unknown): string | null {
    if (!key) return null;
    if (typeof key === "string") return key;
    if (typeof key === "object") {
        if ("pubkey" in key && typeof (key as any).pubkey === "string") {
            return (key as any).pubkey;
        }
        if ("toString" in key && typeof (key as any).toString === "function") {
            const str = (key as any).toString();
            if (typeof str === "string" && str !== "[object Object]") {
                return str;
            }
        }
    }
    return null;
}

export function normalizeTransactionInstructions(txItem: any): NormalizedInstruction[] {
    if (!txItem) return [];

    const tx = txItem.transaction ?? txItem;
    const meta = txItem.meta ?? tx?.meta;
    const message = tx?.message;

    if (!message) return [];

    const slot = Number(txItem.slot ?? tx?.slot ?? 0);
    const blockTime = Number(txItem.blockTime ?? tx?.blockTime ?? 0);

    // Extract signatures
    const signatures: string[] = Array.isArray(tx.signatures)
        ? tx.signatures
        : Array.isArray(txItem.signatures)
        ? txItem.signatures
        : [];
    const signature =
        typeof signatures[0] === "string"
            ? signatures[0]
            : typeof txItem.signature === "string"
            ? txItem.signature
            : "unknown";

    // 1. Resolve full account keys list (static + loaded addresses from ALTs)
    const rawStaticKeys: unknown[] = Array.isArray(message.accountKeys)
        ? message.accountKeys
        : [];
    const staticKeys: string[] = rawStaticKeys
        .map(pubkeyOf)
        .filter((k): k is string => Boolean(k));

    const loadedWritable: string[] = Array.isArray(meta?.loadedAddresses?.writable)
        ? meta.loadedAddresses.writable.map(pubkeyOf).filter((k: any): k is string => Boolean(k))
        : [];

    const loadedReadonly: string[] = Array.isArray(meta?.loadedAddresses?.readonly)
        ? meta.loadedAddresses.readonly.map(pubkeyOf).filter((k: any): k is string => Boolean(k))
        : [];

    const allKeys: string[] = [...staticKeys, ...loadedWritable, ...loadedReadonly];

    if (allKeys.length === 0) return [];

    const feePayer = staticKeys[0] ?? null;

    // Determine signers
    let signers: string[] = [];
    const parsedSigners = rawStaticKeys
        .filter(
            (k: any) =>
                k &&
                typeof k === "object" &&
                k.signer === true &&
                pubkeyOf(k) !== null
        )
        .map((k) => pubkeyOf(k)!)
        .filter(Boolean);

    if (parsedSigners.length > 0) {
        signers = parsedSigners;
    } else {
        const numRequiredSignatures = Number(
            message.header?.numRequiredSignatures ?? 0
        );
        signers = staticKeys.slice(0, Math.max(0, numRequiredSignatures));
    }

    const normalized: NormalizedInstruction[] = [];

    function resolveProgramId(ix: any): string | null {
        if (typeof ix.programId === "string") return ix.programId;
        if (ix.programId) {
            const pk = pubkeyOf(ix.programId);
            if (pk) return pk;
        }
        if (typeof ix.programIdIndex === "number") {
            return allKeys[ix.programIdIndex] ?? null;
        }
        return null;
    }

    function resolveAccounts(ix: any): string[] {
        if (!Array.isArray(ix.accounts)) return [];
        return ix.accounts
            .map((acc: any) => {
                if (typeof acc === "number") {
                    return allKeys[acc] ?? "";
                }
                return pubkeyOf(acc) ?? "";
            })
            .filter(Boolean);
    }

    // 2. Normalize Top-Level Instructions
    const topInstructions = Array.isArray(message.instructions)
        ? message.instructions
        : [];

    topInstructions.forEach((ix: any, index: number) => {
        const programId = resolveProgramId(ix);
        if (!programId) return;

        const accounts = resolveAccounts(ix);
        const data = typeof ix.data === "string" ? ix.data : "";

        normalized.push({
            signature,
            slot,
            blockTime,
            source: "top-level",
            parentIndex: null,
            instructionIndex: index,
            programId,
            accounts,
            data,
            feePayer,
            signers,
        });
    });

    // 3. Normalize Inner Instructions (CPI)
    const innerGroups = Array.isArray(meta?.innerInstructions)
        ? meta.innerInstructions
        : [];

    for (const group of innerGroups) {
        const parentIndex = typeof group.index === "number" ? group.index : null;
        const innerList = Array.isArray(group.instructions) ? group.instructions : [];

        innerList.forEach((ix: any, index: number) => {
            const programId = resolveProgramId(ix);
            if (!programId) return;

            const accounts = resolveAccounts(ix);
            const data = typeof ix.data === "string" ? ix.data : "";

            normalized.push({
                signature,
                slot,
                blockTime,
                source: "inner",
                parentIndex,
                instructionIndex: index,
                programId,
                accounts,
                data,
                feePayer,
                signers,
            });
        });
    }

    return normalized;
}
