import type {
  Wallet,
  WalletDataset,
  WalletIntelligenceV1,
  WalletIntelligenceV1Dataset,
  WalletScoreData,
  WalletScoresDataset,
} from "../types";

export async function loadWalletDataset(): Promise<WalletDataset> {
  const response = await fetch(`/data/wallets-14d.json?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Failed to load wallet dataset (${response.status})`);
  }
  return response.json();
}

export async function loadWalletScores(): Promise<WalletScoresDataset | null> {
  try {
    const response = await fetch(`/data/wallet-scores.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn(`[walletData] Failed to load wallet scores (${response.status})`);
      return null;
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.scores)) {
      console.warn("[walletData] Invalid wallet scores payload format");
      return null;
    }
    return data as WalletScoresDataset;
  } catch (err) {
    console.warn("[walletData] Error fetching wallet scores, proceeding unscored:", err);
    return null;
  }
}

export function buildWalletScoreMap(
  scoresDataset: WalletScoresDataset | null,
): Map<string, WalletScoreData> {
  const map = new Map<string, WalletScoreData>();
  if (!scoresDataset?.scores || !Array.isArray(scoresDataset.scores)) {
    return map;
  }

  for (const item of scoresDataset.scores) {
    if (!item || typeof item.wallet !== "string") {
      continue;
    }
    const address = item.wallet;
    if (map.has(address)) {
      console.error(
        `[walletData] Data corruption: duplicate score record detected for wallet ${address}`,
      );
      // Do not overwrite earlier record with later duplicate
      continue;
    }
    map.set(address, item);
  }

  return map;
}

export function joinWalletsWithScores(
  wallets: Wallet[],
  scoresDataset: WalletScoresDataset | null,
): Wallet[] {
  if (!wallets || wallets.length === 0) {
    return [];
  }

  const scoreMap = buildWalletScoreMap(scoresDataset);
  let matchedCount = 0;

  const joined = wallets.map((wallet) => {
    const score = scoreMap.get(wallet.owner);
    if (score !== undefined) {
      matchedCount++;
      return {
        ...wallet,
        score,
      };
    }
    // Unscored wallet: preserve exactly as existing wallet, score remains undefined
    return wallet;
  });

  if (import.meta.env?.DEV) {
    console.debug(
      `[walletData] Score join completed: ${wallets.length} wallets, ` +
        `${scoreMap.size} scores loaded, ${matchedCount} matched, ` +
        `${wallets.length - matchedCount} unscored.`,
    );
  }

  return joined;
}

export async function loadWalletIntelligenceV1(): Promise<WalletIntelligenceV1Dataset | null> {
  try {
    const response = await fetch(`/data/wallet-intelligence-v1.json?t=${Date.now()}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      console.warn(`[walletData] Failed to load V1 wallet intelligence (${response.status})`);
      return null;
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.wallets)) {
      console.warn("[walletData] Invalid V1 wallet intelligence payload format");
      return null;
    }
    return data as WalletIntelligenceV1Dataset;
  } catch (err) {
    console.warn("[walletData] Error fetching V1 wallet intelligence, proceeding without V1 data:", err);
    return null;
  }
}

export function buildWalletIntelligenceV1Map(
  intelDataset: WalletIntelligenceV1Dataset | null,
): Map<string, WalletIntelligenceV1> {
  const map = new Map<string, WalletIntelligenceV1>();
  if (!intelDataset?.wallets || !Array.isArray(intelDataset.wallets)) {
    return map;
  }

  for (const item of intelDataset.wallets) {
    if (!item || typeof item.wallet !== "string") {
      continue;
    }
    const address = item.wallet;
    if (map.has(address)) {
      console.error(
        `[walletData] Data corruption: duplicate V1 intelligence record for wallet ${address}`,
      );
      continue;
    }
    map.set(address, item);
  }

  return map;
}

export function joinWalletsWithIntelligenceV1(
  wallets: Wallet[],
  intelDataset: WalletIntelligenceV1Dataset | null,
): Wallet[] {
  if (!wallets || wallets.length === 0) {
    return [];
  }

  const intelMap = buildWalletIntelligenceV1Map(intelDataset);
  let matchedCount = 0;

  const joined = wallets.map((wallet) => {
    const intelligenceV1 = intelMap.get(wallet.owner);
    if (intelligenceV1 !== undefined) {
      matchedCount++;
      return {
        ...wallet,
        intelligenceV1,
      };
    }
    // Unjoined/unscored wallet: remains null, no fabricated zero scores
    return {
      ...wallet,
      intelligenceV1: null,
    };
  });

  if (import.meta.env?.DEV) {
    console.debug(
      `[walletData] V1 intelligence join completed: ${wallets.length} wallets, ` +
        `${intelMap.size} records loaded, ${matchedCount} matched, ` +
        `${wallets.length - matchedCount} unjoined.`,
    );
  }

  return joined;
}

