export const shortWallet = (value: string, left = 6, right = 4) =>
  `${value.slice(0, left)}...${value.slice(-right)}`;

export const fmt = (value: number, digits = 2) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number.isFinite(value) ? value : 0);

export const compact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);

export const pct = (value: number, digits = 1) =>
  `${fmt(value * 100, digits)}%`;

export const sol = (value: number, digits = 2) =>
  `${value >= 0 ? "+" : ""}${fmt(value, digits)} SOL`;

export const duration = (hours: number) => {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${fmt(hours, hours < 10 ? 1 : 0)}h`;
  return `${fmt(hours / 24, 1)}d`;
};

export const timeAgo = (iso: string) => {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(diffMs / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

export const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

export const fullDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export const csvEscape = (value: string | number) => {
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replaceAll('"', '""')}"`;
  return str;
};
