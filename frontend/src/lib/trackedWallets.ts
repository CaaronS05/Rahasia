const KEY = "lp-scanner:tracked-wallets";

export function loadTrackedWallets(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return [...new Set(
      parsed.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      ),
    )];
  } catch {
    return [];
  }
}

export function saveTrackedWallets(wallets: string[]) {
  localStorage.setItem(KEY, JSON.stringify([...new Set(wallets)]));
}
