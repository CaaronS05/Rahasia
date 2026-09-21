# Meteora Wallet Scanner — Useful Commands

Dokumen ini berisi command penting untuk menjalankan, mengecek, dan maintenance project Meteora Wallet Scanner.

---

## 1. Masuk ke Root Project

```bash
cd "/Users/aaronmacbook/Documents/Aaron/Project/Meteora Scanner"
```

Cek lokasi:

```bash
pwd
```

---

## 2. Full Pipeline

Menjalankan seluruh alur:

```bash
npm run pipeline
```

Flow:

```text
LP Agent scrape
→ merge LP Agent ke master
→ cek Fabriq missing/stale
→ enrich Fabriq bila diperlukan
→ merge Fabriq ke master
→ publish ke frontend
```

Sebelum menjalankan pipeline:

1. Brave sudah berjalan dengan remote debugging.
2. LP Agent sudah login.
3. Filter Smart LP sudah diatur.
4. Tabel Solana Smart LP sudah tampil benar.
5. Fabriq sudah login di Brave.

---

## 3. LP Agent

### Scrape LP Agent saja

```bash
npm run scrape:lpagent
```

Output:

```text
data/raw/lpagent/smart-lp-latest.json
```

Checkpoint sementara:

```text
data/checkpoints/lpagent.jsonl
```

Checkpoint akan otomatis dihapus setelah scrape berhasil selesai.

### Merge hasil LP Agent ke master

```bash
npm run merge:wallets -- data/raw/lpagent/smart-lp-latest.json
```

Master:

```text
data/master/wallets-master.json
```

---

## 4. Fabriq

### Jalankan enrichment Fabriq

```bash
npm run enrich:fabriq
```

Fabriq hanya mengambil wallet yang:

```text
- belum punya data Fabriq
- atau data Fabriq sudah stale
```

Default stale threshold:

```text
24 jam
```

Output:

```text
data/raw/fabriq/fabriq-enriched.json
```

### Merge Fabriq ke master

```bash
npm run merge:fabriq
```

---

## 5. Publish Data ke Frontend

```bash
npm run publish:wallets
```

Source:

```text
data/master/wallets-master.json
```

Target:

```text
frontend/public/data/wallets-14d.json
```

Jangan edit file frontend dataset secara manual.

---

## 6. Cek Jumlah Wallet

### Total wallet master

```bash
node -e '
const d=require("./data/master/wallets-master.json");
console.log("Total:", d.wallets.length);
'
```

### Cek wallet dengan dan tanpa Fabriq

```bash
node -e '
const d=require("./data/master/wallets-master.json");

const withFabriq=d.wallets.filter(
  w=>w?.fabriq?.fetchedAt
);

console.log("Total:",d.wallets.length);
console.log("With Fabriq:",withFabriq.length);
console.log("Without Fabriq:",d.wallets.length-withFabriq.length);
'
```

### Cek Fabriq fresh / stale

```bash
node -e '
const d=require("./data/master/wallets-master.json");
const H=24;
const now=Date.now();

const stale=d.wallets.filter(w=>{
  const t=Date.parse(w?.fabriq?.fetchedAt ?? "");
  return !Number.isFinite(t) || now-t >= H*3600000;
});

console.log("Total:",d.wallets.length);
console.log("Fresh:",d.wallets.length-stale.length);
console.log("Stale/Missing:",stale.length);
'
```

---

## 7. Cek Raw Data

### LP Agent

```bash
ls -lh data/raw/lpagent/
```

### Fabriq

```bash
ls -lh data/raw/fabriq/
```

### Master

```bash
ls -lh data/master/
```

---

## 8. Frontend

Masuk ke frontend:

```bash
cd frontend
```

Install dependency:

```bash
npm install
```

Jalankan development server:

```bash
npm run dev
```

Build production:

```bash
npm run build
```

Kembali ke root:

```bash
cd ..
```

---

## 9. Syntax Check

### JavaScript / MJS

```bash
node --check scripts/lpagent/scrape-smart-lp.mjs
node --check scripts/fabriq/enrich-wallets.mjs
node --check scripts/pipeline/run-pipeline.mjs
```

### TypeScript Pipeline

```bash
node --experimental-strip-types --check scripts/pipeline/merge-wallets.ts
node --experimental-strip-types --check scripts/pipeline/merge-fabriq.ts
node --experimental-strip-types --check scripts/pipeline/publish-wallets.ts
```

---

## 10. Brave Remote Debugging

Start Brave di macOS:

```bash
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Documents/fabriq-playwright-profile"
```

Cek remote debugging:

```bash
curl http://127.0.0.1:9222/json/version
```

---

## 11. Git

Cek status:

```bash
git status
```

Versi singkat:

```bash
git status --short
```

Lihat branch:

```bash
git branch
```

Commit perubahan:

```bash
git add .
git commit -m "update wallet data pipeline"
```

Push branch aktif:

```bash
git push -u origin HEAD
```

Lihat commit terakhir:

```bash
git log -1 --oneline
```

---

## 12. Cek Struktur Project

```bash
find . \
  -path "./node_modules" -prune -o \
  -path "./frontend/node_modules" -prune -o \
  -maxdepth 3 -print | sort
```

---

## 13. Legacy Scanner

Scanner lama disimpan di:

```text
archive/old-meteora-scanner/
```

Jalankan hanya jika memang diperlukan:

```bash
npm run legacy:scan
```

Legacy scanner bukan bagian dari pipeline utama saat ini.

---

## 14. Lokasi File Penting

```text
scripts/lpagent/scrape-smart-lp.mjs
    LP Agent scraper

scripts/fabriq/enrich-wallets.mjs
    Fabriq enrichment

scripts/pipeline/merge-wallets.ts
    Merge LP Agent → master

scripts/pipeline/merge-fabriq.ts
    Merge Fabriq → master

scripts/pipeline/publish-wallets.ts
    Master → frontend

scripts/pipeline/run-pipeline.mjs
    Full pipeline orchestrator

data/master/wallets-master.json
    Source of truth

frontend/public/data/wallets-14d.json
    Dataset yang dibaca UI
```

---

## 15. Command yang Paling Sering Dipakai

Untuk penggunaan normal:

```bash
npm run pipeline
```

Untuk hanya menjalankan frontend:

```bash
cd frontend
npm run dev
```

Untuk mengecek kondisi master:

```bash
node -e '
const d=require("./data/master/wallets-master.json");
const f=d.wallets.filter(w=>w?.fabriq?.fetchedAt);
console.log("Total:",d.wallets.length);
console.log("With Fabriq:",f.length);
console.log("Without Fabriq:",d.wallets.length-f.length);
'
```

---

## Current Pipeline Status

Pipeline discovery + enrichment + frontend sudah berhasil diuji end-to-end.

```text
LP Agent
→ Master
→ Fabriq
→ Master
→ Frontend
```

Tahap berikutnya di project:

```text
Wallet shortlist / watchlist
→ realtime wallet tracker
→ detect Meteora DLMM actions
→ OPEN / ADD / REMOVE / CLOSE
→ copy-trade engine
```
