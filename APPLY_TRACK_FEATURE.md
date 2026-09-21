# Track Feature — Apply Patch

Tujuan:

```text
Wallet Explorer / Portfolio
        ↓ tandai ★
       TRACK
        ↓
hanya wallet yang kamu pilih
```

Tracked wallet disimpan berdasarkan `owner` di browser `localStorage`, jadi tidak tercampur dengan master data dan tidak hilang ketika pipeline publish dataset baru.

---

# 1. COPY FILE BARU

Dari ZIP, copy:

```text
src/lib/trackedWallets.ts
src/pages/TrackPage.tsx
```

ke:

```text
frontend/src/lib/trackedWallets.ts
frontend/src/pages/TrackPage.tsx
```

---

# 2. CSS

Buka:

```text
TRACK_FEATURE_STYLES.css
```

COPY seluruh isinya ke PALING BAWAH:

```text
frontend/src/styles.css
```

---

# 3. App.tsx — imports

FILE:

```text
frontend/src/App.tsx
```

CARI import React hooks:

```tsx
import { useEffect, useMemo, useState } from "react";
```

Tidak perlu diganti.

LETAKKAN bersama import lokal:

```tsx
import { loadTrackedWallets, saveTrackedWallets } from "./lib/trackedWallets";
import { TrackPage } from "./pages/TrackPage";
```

---

# 4. App.tsx — Page type

CARI:

```tsx
type Page = "explore" | "portfolio";
```

GANTI:

```tsx
type Page = "explore" | "track" | "portfolio";
```

---

# 5. App.tsx — route /track

CARI function:

```tsx
function routeFromLocation()
```

Di dalam function itu, SETELAH pengecekan `/portfolio` dan SEBELUM return Explore, LETAKKAN:

```tsx
if (window.location.pathname === "/track") {
  return { page: "track" };
}
```

---

# 6. App.tsx — tracked state

CARI:

```tsx
const [globalSearch, setGlobalSearch] = useState("");
```

LETAKKAN tepat di bawahnya:

```tsx
const [trackedOwners, setTrackedOwners] = useState<Set<string>>(
  () => new Set(loadTrackedWallets()),
);
```

---

# 7. App.tsx — persist tracked state

CARI useEffect yang load wallet dataset.

SETELAH useEffect tersebut selesai, LETAKKAN:

```tsx
useEffect(() => {
  saveTrackedWallets([...trackedOwners]);
}, [trackedOwners]);
```

---

# 8. App.tsx — toggle function

CARI:

```tsx
function openWallet(wallet: Wallet) {
```

LETAKKAN TEPAT SEBELUM function tersebut:

```tsx
function toggleTrackedWallet(owner: string) {
  setTrackedOwners((current) => {
    const next = new Set(current);

    if (next.has(owner)) {
      next.delete(owner);
    } else {
      next.add(owner);
    }

    return next;
  });
}
```

---

# 9. App.tsx — navbar TRACK

CARI:

```tsx
<button>TRACK</button>
```

GANTI:

```tsx
<button
  className={route.page === "track" ? "active" : ""}
  onClick={() => navigate("/track")}
>
  TRACK
</button>
```

---

# 10. App.tsx — render TrackPage

CARI conditional render utama yang bentuknya kurang lebih:

```tsx
{route.page === "portfolio" ? (
  <PortfolioPage ... />
) : (
  <div className="explorer-page">
```

GANTI pola pembukanya menjadi:

```tsx
{route.page === "portfolio" ? (
  <PortfolioPage
    ...
  />
) : route.page === "track" ? (
  <TrackPage
    wallets={wallets}
    trackedOwners={trackedOwners}
    onToggleTrack={toggleTrackedWallet}
    onOpenWallet={openWallet}
  />
) : (
  <div className="explorer-page">
```

Jangan hapus isi Explorer yang sekarang.

---

# 11. App.tsx — pass tracking ke WalletTable Explorer

CARI WalletTable pada Explorer:

```tsx
<WalletTable
  wallets={sorted}
```

Di dalam props component itu, TAMBAHKAN:

```tsx
trackedOwners={trackedOwners}
onToggleTrack={toggleTrackedWallet}
```

---

# 12. App.tsx — pass tracking ke Portfolio

CARI:

```tsx
<PortfolioPage
```

Di dalam props component tersebut TAMBAHKAN:

```tsx
isTracked={
  selectedPortfolioWallet
    ? trackedOwners.has(selectedPortfolioWallet.owner)
    : false
}
onToggleTrack={toggleTrackedWallet}
```

---

# 13. WalletTable.tsx — import Star

FILE:

```text
frontend/src/components/WalletTable.tsx
```

CARI import lucide-react yang sudah berisi `Copy`, `Check`, dll.

TAMBAHKAN:

```tsx
Star,
```

---

# 14. WalletTable.tsx — Props

CARI:

```tsx
type Props = {
```

Di dalam type tersebut TAMBAHKAN:

```tsx
trackedOwners?: Set<string>;
onToggleTrack?: (owner: string) => void;
```

---

# 15. WalletTable.tsx — function parameters

CARI:

```tsx
export function WalletTable({
```

Di destructuring props TAMBAHKAN:

```tsx
trackedOwners = new Set(),
onToggleTrack,
```

---

# 16. WalletTable.tsx — star button

CARI:

```tsx
<div className="wallet-cell">
```

LETAKKAN tepat setelah pembuka div itu, SEBELUM wallet address:

```tsx
<button
  className={`track-wallet-button ${
    trackedOwners.has(wallet.owner) ? "tracked" : ""
  }`}
  title={
    trackedOwners.has(wallet.owner)
      ? "Remove from Track"
      : "Add to Track"
  }
  onClick={(event) => {
    event.stopPropagation();
    onToggleTrack?.(wallet.owner);
  }}
>
  <Star
    size={13}
    fill={
      trackedOwners.has(wallet.owner)
        ? "currentColor"
        : "none"
    }
  />
</button>
```

Hasil UI:

```text
☆ GF6pna...GUg9  copy
```

setelah klik:

```text
★ GF6pna...GUg9  copy
```

---

# 17. PortfolioPage.tsx — import Star

FILE:

```text
frontend/src/pages/PortfolioPage.tsx
```

Pada import lucide-react TAMBAHKAN:

```tsx
Star,
```

---

# 18. PortfolioPage.tsx — Props

CARI:

```tsx
type Props = {
```

TAMBAHKAN:

```tsx
isTracked: boolean;
onToggleTrack: (owner: string) => void;
```

---

# 19. PortfolioPage.tsx — destructuring

CARI:

```tsx
export function PortfolioPage({
```

TAMBAHKAN:

```tsx
isTracked,
onToggleTrack,
```

---

# 20. PortfolioPage.tsx — Track button

CARI bagian wallet header yang berisi:

```tsx
<h2>{shortWallet(wallet.owner)}</h2>
```

dan tombol copy.

SETELAH tombol copy, LETAKKAN:

```tsx
<button
  className={`portfolio-track-button ${
    isTracked ? "tracked" : ""
  }`}
  onClick={() => onToggleTrack(wallet.owner)}
>
  <Star
    size={13}
    fill={isTracked ? "currentColor" : "none"}
  />
  {isTracked ? "Tracked" : "Track"}
</button>
```

---

# 21. Sidebar — optional tapi disarankan

FILE:

```text
frontend/src/components/Sidebar.tsx
```

Ubah type activePage agar menerima:

```tsx
"explore" | "track" | "portfolio"
```

Pada item:

```text
Tracked Wallets
```

buat click menuju page:

```tsx
onNavigate("track")
```

Jika tidak ingin mengubah Sidebar sekarang, navbar TRACK tetap berfungsi.

---

# 22. Test

Dari:

```bash
cd "/Users/aaronmacbook/Documents/Aaron/Project/Meteora Scanner/frontend"
```

jalankan:

```bash
npm run build
npm run dev
```

Test flow:

```text
Wallet Explorer
→ klik ☆
→ menjadi ★
→ klik navbar TRACK
→ wallet muncul

TRACK
→ klik ★ lagi
→ wallet hilang dari track

Portfolio wallet
→ klik Track
→ muncul juga di TRACK
```

---

# Storage

Key browser:

```text
lp-scanner:tracked-wallets
```

Yang disimpan hanya array address:

```json
[
  "wallet-address-1",
  "wallet-address-2"
]
```

Tidak ada perubahan ke:

```text
data/master/wallets-master.json
frontend/public/data/wallets-14d.json
LP Agent
Fabriq
pipeline
```
