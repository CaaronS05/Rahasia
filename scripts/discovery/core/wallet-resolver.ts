import type { DecodedLpInstruction } from "./lp-instruction-decoder.ts";

export interface ResolvedWalletResult {
    wallet: string;
    walletAccountName: string;
    walletResolutionMethod: "idl_signer";
}

const PREFERRED_AUTHORITY_NAMES = [
    "owner",
    "sender",
    "user",
    "authority",
    "position_authority",
];

const EXCLUDED_SIGNER_NAMES = new Set([
    "payer",
    "rent_payer",
    "position",
    "position_v2",
    "base",
    "operator",
    "program",
    "event_authority",
]);

export function resolveLpWallet(
    decoded: DecodedLpInstruction
): ResolvedWalletResult | null {
    if (decoded.status !== "ACCEPTED" || !decoded.idlInstruction) {
        return null;
    }

    const flatAccounts = decoded.idlInstruction.flatAccounts || [];
    const mapped = decoded.mappedAccounts;

    // Find all accounts marked signer: true in the IDL definition
    const idlSigners = flatAccounts.filter((acc) => acc.signer);

    // Filter out known non-owner/rent/keypair signers
    const candidateSigners = idlSigners.filter(
        (acc) => !EXCLUDED_SIGNER_NAMES.has(acc.name)
    );

    // Match candidate signers against preferred LP authority names
    const matchingSigners: { name: string; address: string }[] = [];

    for (const pref of PREFERRED_AUTHORITY_NAMES) {
        const found = candidateSigners.find((c) => c.name === pref);
        if (found && mapped[found.name]) {
            matchingSigners.push({
                name: found.name,
                address: mapped[found.name],
            });
        }
    }

    // If no matching authority by preferred names, check other candidate signers
    if (matchingSigners.length === 0) {
        for (const candidate of candidateSigners) {
            if (mapped[candidate.name]) {
                matchingSigners.push({
                    name: candidate.name,
                    address: mapped[candidate.name],
                });
            }
        }
    }

    // Must have exactly ONE unambiguous authority candidate
    if (matchingSigners.length === 1) {
        const candidate = matchingSigners[0];
        return {
            wallet: candidate.address,
            walletAccountName: candidate.name,
            walletResolutionMethod: "idl_signer",
        };
    }

    // If ambiguous or no signer found, do not guess
    return null;
}
