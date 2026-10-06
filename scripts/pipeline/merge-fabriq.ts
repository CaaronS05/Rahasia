import {
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";

import path from "node:path";

type JsonObject = Record<string, any>;

const CANONICAL_PATH = path.resolve(
    "data/master/wallets-fabriq.json",
);

const FABRIQ_PATH = path.resolve(
    "data/raw/fabriq/fabriq-enriched.json",
);

function isObject(
    value: unknown,
): value is JsonObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    );
}

function normalizeCalendars(
    fabriq: JsonObject,
): JsonObject {
    const calendars: JsonObject = {};

    // Schema baru
    if (isObject(fabriq.calendars)) {
        for (
            const [month, calendar]
            of Object.entries(
                fabriq.calendars,
            )
        ) {
            if (isObject(calendar)) {
                calendars[month] =
                    calendar;
            }
        }
    }

    // Migrasi schema lama:
    //
    // month: "2026-09"
    // calendar: {...}
    if (
        typeof fabriq.month ===
        "string" &&
        isObject(fabriq.calendar)
    ) {
        calendars[fabriq.month] = {
            ...(isObject(
                calendars[
                fabriq.month
                ],
            )
                ? calendars[
                fabriq.month
                ]
                : {}),

            ...fabriq.calendar,
        };
    }

    return calendars;
}

function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (
        a === null ||
        typeof a !== "object" ||
        b === null ||
        typeof b !== "object"
    ) {
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
function parseCliArgs() {
    const args = process.argv.slice(2);
    let dryRun = false;

    for (const arg of args) {
        if (arg === "--dry-run") {
            dryRun = true;
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return { dryRun };
}

async function loadJson(
    filePath: string,
): Promise<any> {
    return JSON.parse(
        await readFile(filePath, "utf8"),
    );
}

function parseValidTimestamp(value: unknown): number | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : null;
}

function mergeNonDestructive(
    existingFabriq: JsonObject,
    incomingFabriq: JsonObject,
): JsonObject {
    const merged: JsonObject = { ...existingFabriq };

    for (const [k, v] of Object.entries(incomingFabriq)) {
        if (k === "calendars" || k === "calendar" || k === "month") continue;
        if (!(k in merged)) {
            merged[k] = v;
        }
    }

    const existingCalendars = normalizeCalendars(existingFabriq);
    const incomingCalendars = normalizeCalendars(incomingFabriq);
    const mergedCalendars: JsonObject = { ...existingCalendars };

    for (const [month, incomingCal] of Object.entries(incomingCalendars)) {
        if (!(month in mergedCalendars)) {
            mergedCalendars[month] = isObject(incomingCal) ? { ...incomingCal } : incomingCal;
            continue;
        }

        if (!isObject(mergedCalendars[month]) || !isObject(incomingCal)) {
            continue;
        }

        const targetMonthCal: JsonObject = { ...mergedCalendars[month] };
        for (const [date, dateVal] of Object.entries(incomingCal)) {
            if (!(date in targetMonthCal)) {
                targetMonthCal[date] = dateVal;
            }
        }
        mergedCalendars[month] = targetMonthCal;
    }

    merged.calendars = mergedCalendars;
    return merged;
}

function mergeNewerSnapshot(
    existingFabriq: JsonObject,
    incomingFabriq: JsonObject,
): JsonObject {
    const existingCalendars = normalizeCalendars(existingFabriq);
    const incomingCalendars = normalizeCalendars(incomingFabriq);

    const mergedCalendars: JsonObject = {
        ...existingCalendars,
    };

    for (const [month, calendar] of Object.entries(incomingCalendars)) {
        mergedCalendars[month] = {
            ...(isObject(mergedCalendars[month])
                ? mergedCalendars[month]
                : {}),
            ...(isObject(calendar) ? calendar : {}),
        };
    }

    return {
        ...existingFabriq,
        ...incomingFabriq,
        calendars: mergedCalendars,
    };
}

async function main() {
    const { dryRun } = parseCliArgs();

    if (!dryRun) {
        console.log("\nMERGE FABRIQ DATA");
        console.log("=================");
    }

    const [canonical, fabriqRaw] =
        await Promise.all([
            loadJson(CANONICAL_PATH),
            loadJson(FABRIQ_PATH),
        ]);

    if (!isObject(canonical)) {
        throw new Error(
            'Canonical file root is not an object.',
        );
    }

    if (!Array.isArray(canonical.wallets)) {
        throw new Error(
            'Canonical file does not contain a "wallets" array.',
        );
    }

    if (!isObject(fabriqRaw)) {
        throw new Error(
            'Fabriq file root is not an object.',
        );
    }

    if (!Array.isArray(fabriqRaw.results)) {
        throw new Error(
            'Fabriq file does not contain a "results" array.',
        );
    }

    let incomingOk = 0;
    const incomingFabriqByOwner =
        new Map<string, JsonObject>();

    for (const row of fabriqRaw.results) {
        if (!isObject(row)) continue;
        if (row.status !== "ok") continue;

        const owner = row.owner;
        if (
            typeof owner !== "string" ||
            !owner.trim()
        ) {
            continue;
        }

        if (!isObject(row.fabriq)) {
            continue;
        }

        incomingOk++;
        const trimmedOwner = owner.trim();
        incomingFabriqByOwner.set(
            trimmedOwner,
            row.fabriq,
        );
    }

    const canonicalBefore = canonical.wallets.length;
    const existingWalletsMap = new Map<string, JsonObject>();

    for (const wallet of canonical.wallets) {
        if (!isObject(wallet) || typeof wallet.owner !== "string") {
            continue;
        }
        existingWalletsMap.set(wallet.owner.trim(), wallet);
    }

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let staleSkipped = 0;
    let sameTimestamp = 0;
    let timestampUnsafe = 0;
    let timestampAmbiguous = 0;

    const acceptedTimestamps: number[] = [];
    const mergedWalletsMap = new Map<string, JsonObject>();

    // Process existing wallets
    for (const [owner, existingWallet] of existingWalletsMap.entries()) {
        const incomingFabriq = incomingFabriqByOwner.get(owner);
        if (!incomingFabriq) {
            unchanged++;
            mergedWalletsMap.set(owner, existingWallet);
            continue;
        }

        const existingFabriq = isObject(existingWallet.fabriq)
            ? existingWallet.fabriq
            : {};

        const canonicalTs = parseValidTimestamp(existingFabriq.fetchedAt);
        const incomingTs = parseValidTimestamp(incomingFabriq.fetchedAt);

        // CASE 1 — INCOMING OLDER
        if (canonicalTs !== null && incomingTs !== null && incomingTs < canonicalTs) {
            staleSkipped++;
            unchanged++;
            mergedWalletsMap.set(owner, existingWallet);
            continue;
        }

        let newFabriqPayload: JsonObject;

        // CASE 2 — INCOMING NEWER
        if (canonicalTs !== null && incomingTs !== null && incomingTs > canonicalTs) {
            newFabriqPayload = mergeNewerSnapshot(existingFabriq, incomingFabriq);
        }
        // CASE 3 — SAME FETCHEDAT
        else if (canonicalTs !== null && incomingTs !== null && incomingTs === canonicalTs) {
            sameTimestamp++;
            newFabriqPayload = mergeNonDestructive(existingFabriq, incomingFabriq);
        }
        // CASE 4 — CANONICAL TIMESTAMP MISSING
        else if (canonicalTs === null && incomingTs !== null) {
            newFabriqPayload = mergeNewerSnapshot(existingFabriq, incomingFabriq);
        }
        // CASE 5 — INCOMING TIMESTAMP MISSING
        else if (canonicalTs !== null && incomingTs === null) {
            timestampUnsafe++;
            newFabriqPayload = mergeNonDestructive(existingFabriq, incomingFabriq);
        }
        // CASE 6 — BOTH TIMESTAMPS MISSING
        else {
            timestampAmbiguous++;
            newFabriqPayload = mergeNonDestructive(existingFabriq, incomingFabriq);
        }

        const updatedWallet: JsonObject = {
            owner: existingWallet.owner,
            fabriq: newFabriqPayload,
        };

        if (existingWallet._local !== undefined) {
            updatedWallet._local = existingWallet._local;
        }

        if (deepEqual(existingWallet, updatedWallet)) {
            unchanged++;
            mergedWalletsMap.set(owner, existingWallet);
        } else {
            updated++;
            if (incomingTs !== null) {
                acceptedTimestamps.push(incomingTs);
            }
            mergedWalletsMap.set(owner, updatedWallet);
        }
    }

    // Process new incoming owners
    for (const [owner, incomingFabriq] of incomingFabriqByOwner.entries()) {
        if (mergedWalletsMap.has(owner)) {
            continue;
        }

        added++;
        const incomingTs = parseValidTimestamp(incomingFabriq.fetchedAt);
        if (incomingTs !== null) {
            acceptedTimestamps.push(incomingTs);
        }

        const normalizedCalendars = normalizeCalendars(incomingFabriq);
        const newFabriqPayload: JsonObject = {
            ...incomingFabriq,
            calendars: normalizedCalendars,
        };

        mergedWalletsMap.set(owner, {
            owner,
            fabriq: newFabriqPayload,
        });
    }

    // Sort canonical wallets by owner ascending
    const sortedWallets = [...mergedWalletsMap.values()].sort((a, b) =>
        String(a.owner).localeCompare(String(b.owner)),
    );

    const canonicalAfter = sortedWallets.length;
    const isContentChanged = added > 0 || updated > 0;

    let nextUpdatedAt = typeof canonical.updatedAt === "string" ? canonical.updatedAt : "";
    if (isContentChanged) {
        let latestTs = parseValidTimestamp(canonical.updatedAt) ?? 0;

        const incomingGenTs = parseValidTimestamp(fabriqRaw.generatedAt);
        if (incomingGenTs !== null && incomingGenTs > latestTs) {
            latestTs = incomingGenTs;
        }

        for (const ts of acceptedTimestamps) {
            if (ts > latestTs) {
                latestTs = ts;
            }
        }

        if (latestTs > 0) {
            nextUpdatedAt = new Date(latestTs).toISOString();
        }
    }

    const outputPayload = {
        version: canonical.version || "v1",
        updatedAt: nextUpdatedAt,
        walletCount: sortedWallets.length,
        wallets: sortedWallets,
    };

    if (dryRun) {
        console.log("\nFABRIQ CANONICAL MERGE DRY RUN\n");
        console.log(`INCOMING OK:`);
        console.log(incomingOk);
        console.log(`\nCANONICAL BEFORE:`);
        console.log(canonicalBefore);
        console.log(`\nADDED:`);
        console.log(added);
        console.log(`\nUPDATED:`);
        console.log(updated);
        console.log(`\nUNCHANGED:`);
        console.log(unchanged);
        console.log(`\nSTALE SKIPPED:`);
        console.log(staleSkipped);
        console.log(`\nSAME TIMESTAMP:`);
        console.log(sameTimestamp);
        console.log(`\nTIMESTAMP UNSAFE:`);
        console.log(timestampUnsafe);
        console.log(`\nTIMESTAMP AMBIGUOUS:`);
        console.log(timestampAmbiguous);
        console.log(`\nCANONICAL AFTER:`);
        console.log(canonicalAfter);
        console.log(`\nWALLETS-MASTER WRITTEN:`);
        console.log("NO");
        return;
    }

    if (isContentChanged) {
        const tempPath = `${CANONICAL_PATH}.tmp`;
        await writeFile(
            tempPath,
            JSON.stringify(outputPayload, null, 2) + "\n",
            "utf8",
        );
        await rename(tempPath, CANONICAL_PATH);
    }

    console.log(`Incoming OK     : ${incomingOk}`);
    console.log(`Canonical before: ${canonicalBefore}`);
    console.log(`Added           : ${added}`);
    console.log(`Updated         : ${updated}`);
    console.log(`Unchanged       : ${unchanged}`);
    console.log(`Stale skipped   : ${staleSkipped}`);
    console.log(`Same timestamp  : ${sameTimestamp}`);
    console.log(`Timestamp unsafe: ${timestampUnsafe}`);
    console.log(`Timestamp ambig : ${timestampAmbiguous}`);
    console.log(`Canonical after : ${canonicalAfter}`);
    console.log(`Output          : ${CANONICAL_PATH}`);
    console.log(`Status          : ${isContentChanged ? "updated" : "byte-identical (preserved)"}`);
}

main().catch((error) => {
    console.error("\nMERGE FABRIQ FAILED");

    console.error(
        error instanceof Error
            ? error.stack || error.message
            : error,
    );

    process.exitCode = 1;
});