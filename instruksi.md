# INSTRUKSI ANTIGRAVITY — LP AGENT CONTROL PIPELINE (LPCTRL-2 s/d SELESAI)

## 0. Tujuan

Lanjutkan fitur **Update Wallet List dari LP Agent** pada project Meteora Scanner.

Fitur dasar LP Agent (`LPCTRL-1`) sudah berhasil dibuat dan diuji manual oleh user:
- Control server dapat menjalankan scraper LP Agent.
- Endpoint start / status / stop LP Agent sudah ada.
- Scraper berhasil connect ke Brave CDP.
- Scraper berhasil menangkap request Smart LP.
- Scraper sudah mempunyai checkpoint.
- Scraper sudah mendukung multi-worker / concurrency manual tanpa hard maximum.
- Worker pool LP Agent sudah berhasil menyelesaikan scrape:
  - `Pages: 48/48`
  - `Wallets: 570`
  - status akhir `completed`.
- Checkpoint dibersihkan setelah scrape sukses.

**JANGAN mengulang LPCTRL-1 dari nol.**
Gunakan kondisi file lokal saat ini sebagai source of truth dan lanjutkan dari implementasi yang sudah ada.

Target akhir:

```text
Update Wallet List
        ↓
LP Agent scrape
        ↓
merge LP Agent → master
        ↓
Fabriq enrich wallet missing/stale
        ↓
merge Fabriq → master
        ↓
publish frontend dataset
        ↓
UI reload dataset
```

User harus dapat menjalankan seluruh pipeline dari modal frontend.

---

# 1. ATURAN KERJA UNTUK AGENT

## WAJIB

1. **Hanya edit / write code.**
2. **JANGAN menjalankan testing.**
3. **JANGAN menjalankan**:
   - `npm run ...`
   - `npm build`
   - `npm test`
   - `curl`
   - `node --check`
   - browser automation
   - Brave
   - kill process
   - server
4. User akan melakukan testing manual sendiri.
5. Jangan melakukan commit / push Git.
6. Jangan menghapus perubahan lokal user yang sudah ada.
7. Baca file lokal terlebih dahulu sebelum mengubahnya.
8. Jika struktur lokal sudah berbeda dari contoh instruksi ini, adaptasikan perubahan ke struktur aktual tanpa menghapus fitur yang sudah berjalan.
9. Jangan mengubah logic LP Agent scraping yang sudah berhasil kecuali diperlukan untuk progress parser.
10. Jangan menambahkan hard maximum untuk worker.
11. Minimum worker tetap `1`.
12. Semua angka worker harus mengikuti input user.
13. Jangan expose cookie, JWT, Authorization header, atau token ke frontend/log tambahan.
14. Control server tetap bind ke `127.0.0.1`.
15. Tidak boleh menambahkan endpoint arbitrary shell / command execution.
16. Jangan menyentuh fitur copy trade.
17. Setelah selesai, hanya laporkan:
    - file yang dibuat,
    - file yang diubah,
    - ringkasan singkat perubahan.
18. Jangan menjalankan verifikasi/testing.

---

# 2. KONDISI YANG SUDAH ADA DAN HARUS DIPERTAHANKAN

Project root:

```text
Meteora Scanner/
```

File penting:

```text
scripts/control/server.mjs
scripts/lpagent/scrape-smart-lp.mjs

scripts/pipeline/merge-wallets.ts
scripts/pipeline/merge-fabriq.ts
scripts/pipeline/publish-wallets.ts

data/raw/lpagent/smart-lp-latest.json
data/master/wallets-master.json

frontend/src/App.tsx
frontend/src/components/FabriqControlModal.tsx
frontend/src/lib/fabriqControl.ts
frontend/src/styles.css
```

Package scripts yang sudah tersedia kurang lebih:

```json
{
  "scrape:lpagent": "node scripts/lpagent/scrape-smart-lp.mjs",
  "refresh:lpagent": "node scripts/lpagent/scrape-smart-lp.mjs && node --experimental-strip-types scripts/pipeline/merge-wallets.ts data/raw/lpagent/smart-lp-latest.json",
  "merge:wallets": "node --experimental-strip-types scripts/pipeline/merge-wallets.ts",
  "enrich:fabriq": "node scripts/fabriq/enrich-wallets.mjs",
  "merge:fabriq": "node --experimental-strip-types scripts/pipeline/merge-fabriq.ts",
  "publish:wallets": "node --experimental-strip-types scripts/pipeline/publish-wallets.ts",
  "control": "node scripts/control/server.mjs"
}
```

LP Agent scraper saat ini:
- mencari tab `lpagent`,
- mengambil filter aktif dari browser,
- capture `/api/v1/smart-lp`,
- pagination,
- checkpoint per page,
- deduplicate wallet berdasarkan owner,
- output:
  `data/raw/lpagent/smart-lp-latest.json`,
- mendukung env:

```text
LPAGENT_CONCURRENCY
```

Worker **tidak memiliki upper limit buatan aplikasi**.

Control server juga sudah mempunyai state / child LP Agent hasil LPCTRL-1.

---

# 3. TARGET STATE LP AGENT FINAL

Di `scripts/control/server.mjs`, state LP Agent final minimal harus mampu menyimpan:

```js
{
  status:
    "idle" |
    "running" |
    "stopping" |
    "stopped" |
    "completed" |
    "error",

  stage:
    "idle" |
    "scrape" |
    "merge_wallets" |
    "fabriq_enrich" |
    "fabriq_merge" |
    "publish" |
    "completed" |
    "stopped" |
    "error",

  concurrency: number,
  fabriqConcurrency: number,

  startedAt: string | null,
  finishedAt: string | null,

  exitCode: number | null,
  error: string | null,

  // LP Agent scrape progress
  completedPages: number,
  totalPages: number,
  wallets: number,
  progressPercent: number,

  // merge-wallets result
  inputRows: number,
  uniqueIncoming: number,
  updatedExisting: number,
  addedNew: number,
  masterWallets: number,

  // Fabriq auto-enrichment result
  fabriqTotal: number,
  fabriqCompleted: number,
  fabriqSuccess: number,
  fabriqFailed: number,
  fabriqSkipped: number,

  runtimeSeconds: number,

  logs: string[],

  running: boolean
}
```

`running` boleh dihitung di `lpAgentPublicState()` dan tidak harus disimpan secara permanen pada object internal.

---

# 4. LPCTRL-2 — LIVE PROGRESS LP AGENT

## File

```text
scripts/control/server.mjs
```

## Tujuan

Endpoint:

```text
GET /api/lpagent/status
```

harus dapat memberikan live progress seperti:

```json
{
  "status": "running",
  "stage": "scrape",
  "concurrency": 5,
  "completedPages": 19,
  "totalPages": 48,
  "wallets": 228,
  "progressPercent": 40,
  "running": true
}
```

## 4.1 Tambahkan field progress

Tambahkan ke state LP Agent:

```js
completedPages: 0,
totalPages: 0,
wallets: 0,
progressPercent: 0,
runtimeSeconds: 0,
```

Pastikan seluruh field progress di-reset pada **run baru**.

## 4.2 Jangan double-count page

Karena scraper multi-worker, progress parser jangan hanya melakukan:

```js
completedPages++;
```

secara buta.

Gunakan tracking internal seperti:

```js
let lpAgentBaseCompletedPages = 0;
let lpAgentSavedPagesThisRun = new Set();
```

Saat run LP Agent baru dimulai:

```js
lpAgentBaseCompletedPages = 0;
lpAgentSavedPagesThisRun = new Set();
```

Saat membaca:

```text
[CHECKPOINT] 2 completed pages found
```

set:

```js
lpAgentBaseCompletedPages = 2;
lpAgentState.completedPages = 2;
```

Saat membaca:

```text
[W2] [CHECKPOINT] page 17 saved
```

ambil page number.

Jika page belum ada di `lpAgentSavedPagesThisRun`, tambahkan ke Set.

Lalu:

```js
lpAgentState.completedPages =
  lpAgentBaseCompletedPages +
  lpAgentSavedPagesThisRun.size;
```

Clamp ke `totalPages` jika `totalPages > 0`.

Ini mencegah double count jika sebuah log page muncul dua kali.

## 4.3 Buat helper progress

Tambahkan helper:

```js
function syncLpAgentProgress() {
  if (lpAgentState.totalPages > 0) {
    lpAgentState.progressPercent =
      Math.min(
        100,
        Math.round(
          (
            lpAgentState.completedPages /
            lpAgentState.totalPages
          ) * 100
        )
      );
  } else {
    lpAgentState.progressPercent = 0;
  }
}
```

Panggil setiap ada perubahan `completedPages` atau `totalPages`.

## 4.4 Parse seluruh log penting

Buat / lanjutkan:

```js
function parseLpAgentLine(line) {}
```

Parser minimal harus mengenali:

### A. Checkpoint existing

```text
[CHECKPOINT] 2 completed pages found
```

Update:
- `lpAgentBaseCompletedPages`
- `completedPages`

### B. Known total pages

```text
[CHECKPOINT] known total pages: 48
```

Update:
- `totalPages`

### C. Worker page fetching

```text
[W3] [PAGE 12/48] fetching
```

Update:
- `totalPages`.

### D. Discovery page

Support juga format awal:

```text
[PAGE 1] fetching
```

atau:

```text
[W1] [PAGE 1] fetching
```

Jangan error jika denominator belum diketahui.

### E. Page saved

Support:

```text
[W2] [CHECKPOINT] page 17 saved
```

serta format sequential:

```text
[CHECKPOINT] page 1 saved
```

Gunakan Set page number supaya tidak double count.

### F. Wallet count

```text
[TOTAL] 570 unique wallets
```

Update:

```js
lpAgentState.wallets
```

### G. Final pages

```text
Pages   : 48/48
```

Ini authoritative final value.

Set:

```js
completedPages = 48;
totalPages = 48;
progressPercent = 100;
```

### H. Final wallet count

```text
Wallets : 570
```

Set:

```js
lpAgentState.wallets = 570;
```

## 4.5 Runtime

LP Agent harus mempunyai `runtimeSeconds`.

Jangan membuat interval leak.

Prefer hitung runtime dinamis dari `startedAt` di `lpAgentPublicState()` saat status running/stopping, lalu simpan nilai final saat completed/stopped/error.

## 4.6 Chunk buffering

Current process output jangan diasumsikan selalu datang per-line lengkap.

Buat stdout/stderr line buffering agar parser tidak rusak jika log terpotong di tengah chunk.

Pattern yang diinginkan:

```js
let stdoutBuffer = "";
let stderrBuffer = "";

function consumeChunk(buffer, chunk, onLine) {
  buffer += String(chunk);

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trimEnd();

    if (trimmed) {
      onLine(trimmed);
    }
  }

  return buffer;
}
```

Flush sisa buffer ketika child exit.

Gunakan parser setelah line lengkap:

```js
addLpAgentLog(line);
parseLpAgentLine(line);
```

Jangan log/parsing partial line.

---

# 5. LPCTRL-3 — FRONTEND API CLIENT LP AGENT

## Buat file baru

```text
frontend/src/lib/lpAgentControl.ts
```

Jangan campur type LP Agent ke `fabriqControl.ts`.

## 5.1 Base URL

```ts
export const LPAGENT_API_BASE =
  "http://127.0.0.1:8787";
```

## 5.2 Type

Buat `LpAgentStatus`, `LpAgentStage`, dan `LpAgentState` mengikuti state backend final.

Minimal fields:

```ts
export interface LpAgentState {
  status: LpAgentStatus;
  stage: LpAgentStage;

  concurrency: number;
  fabriqConcurrency: number;

  startedAt: string | null;
  finishedAt: string | null;

  exitCode: number | null;
  error: string | null;

  completedPages: number;
  totalPages: number;
  wallets: number;
  progressPercent: number;

  inputRows: number;
  uniqueIncoming: number;
  updatedExisting: number;
  addedNew: number;
  masterWallets: number;

  fabriqTotal: number;
  fabriqCompleted: number;
  fabriqSuccess: number;
  fabriqFailed: number;
  fabriqSkipped: number;

  runtimeSeconds: number;

  logs: string[];
  running: boolean;
}
```

## 5.3 Functions

Implement:

```ts
getLpAgentStatus()
startLpAgentRefresh()
stopLpAgentRefresh()
```

`startLpAgentRefresh()` menerima:

```ts
{
  concurrency: number;
  fabriqConcurrency: number;
}
```

POST ke:

```text
/api/lpagent/refresh
```

body:

```json
{
  "concurrency": 5,
  "fabriqConcurrency": 10
}
```

Tidak ada hard max frontend.

Sanitasi frontend cukup minimum `1`.

---

# 6. LPCTRL-4 — AUTO MERGE WALLET SETELAH SCRAPE

## File

```text
scripts/control/server.mjs
```

Jika LP Agent scrape exit `0`, jangan langsung set status `completed`.

Flow:

```text
scrape
  ↓
merge_wallets
```

## 6.1 Stage

```js
lpAgentState.stage = "merge_wallets";
```

## 6.2 Jalankan merge-wallets

Gunakan child process yang tetap dapat dihentikan oleh LP Agent stop.

Preferred direct command:

```text
node --experimental-strip-types
scripts/pipeline/merge-wallets.ts
data/raw/lpagent/smart-lp-latest.json
```

Gunakan `process.execPath` dengan args predefined.

## 6.3 Buat reusable LP child helper

Refactor LP child execution menjadi helper, misalnya:

```js
runLpAgentChildProcess(
  command,
  args,
  env,
  lineParser
)
```

Helper harus:
- assign `lpAgentChild`,
- stream stdout/stderr,
- line buffering,
- append log,
- optional parser,
- resolve `{ code, signal }`,
- clear child dengan aman,
- hanya menjalankan predefined command server.

## 6.4 Parse merge result

`merge-wallets.ts` output existing:

```text
Input rows       : N
Unique incoming  : N
Updated existing : N
Added new        : N
Master wallets   : N
```

Buat parser:

```js
parseMergeWalletsLine(line)
```

Update:

```js
inputRows
uniqueIncoming
updatedExisting
addedNew
masterWallets
```

## 6.5 Jika merge gagal

Jika exit code non-zero:

```js
status = "error";
stage = "error";
```

Set error spesifik dan **jangan lanjut ke Fabriq**.

---

# 7. LPCTRL-5 — AUTO ENRICH FABRIQ UNTUK WALLET BARU / STALE

Setelah `merge_wallets` sukses:

```text
merge_wallets
  ↓
fabriq_enrich
```

Tujuan: wallet baru dari LP Agent langsung mempunyai data Fabriq sebelum frontend dipublish.

## 7.1 Worker Fabriq terpisah

Request final:

```json
{
  "concurrency": 5,
  "fabriqConcurrency": 10
}
```

Makna:

```text
concurrency       = LP Agent page workers
fabriqConcurrency = Fabriq wallet workers
```

Keduanya minimum `1`, tanpa upper limit.

## 7.2 Jangan Full Refresh

Auto-Fabriq setelah LP Agent harus stale/missing normal, bukan full refresh.

Jalankan:

```text
npm run enrich:fabriq
```

dengan env:

```text
FABRIQ_CONCURRENCY=<fabriqConcurrency>
```

**JANGAN set `FABRIQ_REFRESH_BEFORE` untuk pipeline LP Agent.**

## 7.3 Stage

```js
lpAgentState.stage =
  "fabriq_enrich";
```

## 7.4 Parse progress Fabriq ke LP state

Jangan mencampur state Fabriq manual dengan `lpAgentState`.

Buat parser context LP pipeline:

```js
parseLpPipelineFabriqLine(line)
```

Minimal parse:

```text
[DATASET] 1600 total wallets
[STALE/MISSING] 142 wallets need Fabriq
[W1] [OK] ...
[W1] [FAIL] ...
Total   : 1600
Success : ...
Failed  : ...
Skipped : ...
```

Update:

```js
fabriqTotal
fabriqCompleted
fabriqSuccess
fabriqFailed
fabriqSkipped
```

Final summary authoritative.

`fabriqCompleted` tidak boleh melebihi `fabriqTotal`.

## 7.5 Safety gate

**JANGAN lanjut ke merge/publish jika Fabriq enrichment masih memiliki failure.**

Jika:

```text
exitCode !== 0
```

atau final:

```text
fabriqFailed > 0
```

maka set status/stage error.

Contoh message:

```text
Fabriq enrichment finished with 3 failed wallets; merge/publish aborted.
```

---

# 8. LPCTRL-5B — MERGE FABRIQ

Setelah Fabriq enrich sukses dan `fabriqFailed === 0`:

```js
lpAgentState.stage =
  "fabriq_merge";
```

Jalankan predefined command:

```text
npm run merge:fabriq
```

atau direct Node command existing yang setara.

Jika exit non-zero:
- status error,
- jangan publish.

---

# 9. LPCTRL-6 — AUTO PUBLISH FRONTEND

Setelah `fabriq_merge` sukses:

```js
lpAgentState.stage = "publish";
```

Jalankan:

```text
npm run publish:wallets
```

Jika sukses:

```js
lpAgentState.status = "completed";
lpAgentState.stage = "completed";
lpAgentState.exitCode = 0;
lpAgentState.finishedAt =
  new Date().toISOString();
```

Set final progress `100`.

Log final:

```text
[CONTROL] LP Agent wallet pipeline completed successfully.
```

---

# 10. FINAL BACKEND FLOW

Final orchestrator:

```js
async function startLpAgentRefresh({
  concurrency,
  fabriqConcurrency
}) {
  validate not already running

  reset LP state
  status = running
  stage = scrape

  // 1. scrape
  result = run scraper
  if stopped -> stopped
  if error -> error

  // 2. wallet merge
  stage = merge_wallets
  result = merge-wallets
  if stopped -> stopped
  if error -> error

  // 3. fabriq enrich
  stage = fabriq_enrich
  result = enrich-fabriq
  if stopped -> stopped
  if exit error -> error
  if fabriqFailed > 0 -> error

  // 4. fabriq merge
  stage = fabriq_merge
  result = merge-fabriq
  if stopped -> stopped
  if error -> error

  // 5. publish
  stage = publish
  result = publish-wallets
  if stopped -> stopped
  if error -> error

  // final
  status = completed
  stage = completed
}
```

---

# 11. STOP BEHAVIOR

Endpoint existing:

```text
POST /api/lpagent/stop
```

harus dapat stop child aktif pada stage manapun:

```text
scrape
merge_wallets
fabriq_enrich
fabriq_merge
publish
```

Jangan hanya bisa stop scraper.

`lpAgentChild` harus selalu menunjuk child aktif pipeline.

Saat stop dipanggil:

```js
lpAgentState.status =
  "stopping";
```

Setelah child benar-benar exit:

```js
lpAgentState.status =
  "stopped";

lpAgentState.stage =
  "stopped";

lpAgentState.finishedAt =
  new Date().toISOString();
```

`running` baru false setelah child exit.

Respons langsung `/stop` boleh masih:

```json
{
  "status": "stopping",
  "running": true
}
```

Itu expected.

---

# 12. PROCESS CONTROL

Untuk LP pipeline, prefer direct `process.execPath` untuk script Node/TS yang dapat dijalankan langsung.

Jangan membuat arbitrary shell dari request user.

Jika implementasi existing sudah punya process-group handling yang aman, reuse.

Jangan memperburuk stop behavior Fabriq existing.

---

# 13. API LP AGENT FINAL

Endpoint minimal:

```text
GET  /api/lpagent/status
POST /api/lpagent/refresh
POST /api/lpagent/stop
```

Tidak wajib membuat `/resume`.

Karena scraper mempunyai checkpoint, jika user stop ketika scrape lalu menjalankan update lagi, scraper akan resume dari checkpoint.

## POST /api/lpagent/refresh

Request:

```json
{
  "concurrency": 5,
  "fabriqConcurrency": 10
}
```

Sanitize:

```text
LP concurrency      >= 1
Fabriq concurrency  >= 1
No upper limit
```

Jika pipeline lain sedang jalan:
- return `409`.

---

# 14. MUTUAL EXCLUSION DENGAN FABRIQ MANUAL

Saat Fabriq manual pipeline running/stopping, LP Agent pipeline tidak boleh start.

Saat LP Agent pipeline running/stopping, Fabriq manual refresh/resume tidak boleh start.

Return `409`.

Tujuannya mencegah:
- concurrent write master file,
- merge collision,
- publish collision,
- dua Fabriq enrichment bersamaan.

Jangan hanya cek child process; cek state kedua pipeline juga.

---

# 15. FRONTEND — MODAL UPDATE DATA

## File

```text
frontend/src/components/FabriqControlModal.tsx
```

Boleh tetap memakai nama component ini agar refactor kecil.

Isi modal harus menjadi generic **Update Wallet Data**.

---

# 16. JANGAN PAKAI CONDITIONAL HOOK

Pastikan seluruh React hooks selalu dipanggil sebelum:

```tsx
if (!isOpen) {
  return null;
}
```

Jangan menaruh `useMemo()` setelah early return.

Jika `stageBadgeText` tidak perlu memo, gunakan variable biasa.

---

# 17. FRONTEND STATE LP AGENT

Import dari:

```text
frontend/src/lib/lpAgentControl.ts
```

Tambahkan state:

```tsx
const [lpAgentState, setLpAgentState] =
  useState<LpAgentState | null>(null);

const [lpConcurrency, setLpConcurrency] =
  useState(5);

const [lpFabriqConcurrency, setLpFabriqConcurrency] =
  useState(10);
```

Tidak ada `max`.

Input:

```tsx
type="number"
min={1}
step={1}
```

Sanitize minimum `1`.

---

# 18. FRONTEND POLLING LP AGENT

Tidak perlu SSE baru untuk LP Agent.

Gunakan polling ringan:
- initial `getLpAgentStatus()`,
- jika running/stopping poll sekitar setiap `1000 ms`,
- stop polling aktif saat tidak running.

Pastikan cleanup interval pada unmount.

Jangan membuat banyak interval bersamaan.

---

# 19. UI IDLE — DUA CONTROL CARD

Saat tidak ada pipeline berjalan, modal menampilkan dua bagian utama.

## Card 1 — Wallet List

Contoh:

```text
Wallet List
Source: LP Agent Smart LP

Pull the latest filtered Solana Smart LP wallets,
merge them into the master dataset, enrich missing
Fabriq data, then publish the frontend dataset.

Before updating:
Open LP Agent in Brave and make sure the desired
Solana filter/table is already active.

LP Agent Workers
[ 5 ]

Fabriq Workers
[ 10 ]

[ Update Wallet List ]
```

Worker input manual, tanpa preset dan tanpa max.

## Card 2 — Fabriq Analytics

Pertahankan control Fabriq manual existing:
- stale refresh,
- full refresh,
- custom workers,
- stop,
- resume,
- logs.

Jangan merusak flow Fabriq existing.

---

# 20. UI LP AGENT RUNNING

Saat LP Agent pipeline running:

Header:

```text
Updating Wallet List
```

Stage labels:

```text
scrape         → Scraping LP Agent...
merge_wallets  → Merging Wallet List...
fabriq_enrich  → Enriching Fabriq...
fabriq_merge   → Merging Fabriq Data...
publish        → Publishing Frontend...
```

---

# 21. UI STEPPER LP AGENT

Buat 5 step:

```text
1. LP Agent
2. Merge Wallets
3. Fabriq Enrich
4. Merge Fabriq
5. Publish
```

State:
- active,
- done,
- pending.

Gunakan visual language modal existing.

---

# 22. UI PROGRESS BERDASARKAN STAGE

## Stage `scrape`

Progress utama:

```text
19 / 48 pages
40%
```

Stats:

```text
Wallets    228
LP Workers 5
Runtime    00:31
```

## Stage `merge_wallets`

Progress bar boleh indeterminate.

Text:

```text
Merging 570 scanned wallets into master...
```

## Stage `fabriq_enrich`

Tampilkan Fabriq completed/total dan stats:

```text
Success
Skipped
Failed
Fabriq Workers
```

Jika denominator belum diketahui, gunakan indeterminate bar.

## Stage `fabriq_merge`

```text
Merging Fabriq enrichment into master...
```

Indeterminate.

## Stage `publish`

```text
Publishing frontend wallet dataset...
```

Indeterminate.

---

# 23. UI STOP

Saat LP pipeline running:

```text
[ Stop Update ]
```

memanggil:

```ts
stopLpAgentRefresh()
```

Jika stopping:

```text
Stopping Process...
```

Disable button sampai status berubah.

---

# 24. UI STOPPED

Tampilkan:

```text
Update stopped.
```

Jika stop saat scrape:

```text
LP Agent checkpoint is preserved.
Starting Update Wallet List again will resume
completed scrape pages.
```

Tombol:

```text
[ Start / Resume Update ]
[ Close ]
```

Tidak perlu endpoint resume khusus.

---

# 25. UI COMPLETE

Tampilkan:

```text
Wallet List Updated Successfully
```

Stats:

```text
Scanned Wallets      570
Unique Incoming      ...
Updated Existing     ...
New Wallets          ...
Master Wallets       ...
Fabriq Success       ...
Fabriq Failed        0
```

Text:

```text
Frontend dataset published successfully.
```

Button:

```text
[ Done ]
```

---

# 26. UI ERROR

Tampilkan:
- stage terakhir,
- `error`,
- log terminal expandable.

Jangan menyembunyikan error.

Boleh ada:

```text
[ Try Again ]
[ Close ]
```

---

# 27. LOG VIEW

Reuse log UI existing.

Fabriq manual menggunakan Fabriq logs.

LP Agent mode menggunakan:

```ts
lpAgentState.logs
```

LP log panel harus mencakup downstream merge/Fabriq/publish log.

Autoscroll tetap bekerja.

---

# 28. AUTO REFRESH FRONTEND DATASET

Ketika LP Agent status berubah ke `completed`, panggil reload dataset **hanya sekali per completion transition**.

Gunakan previous-status ref.

Jangan reload setiap polling tick ketika status masih `completed`.

---

# 29. APP.TSX — TOP REFRESH BUTTON

## File

```text
frontend/src/App.tsx
```

Refresh button dianggap aktif jika salah satu pipeline berjalan:

```ts
const dataUpdateRunning =
  fabriqRunning ||
  lpAgentRunning;
```

Gunakan untuk:
- spinner icon,
- active dot,
- title.

Running title:

```text
Wallet data update is running — click to view progress
```

Idle:

```text
Update wallet data
```

---

# 30. APP.TSX — BACKGROUND LP STATUS

Karena modal bisa ditutup saat pipeline masih berjalan, App harus tahu LP pipeline sedang aktif.

Implement polling ringan LP status di App.

Behavior:
- fetch initial LP status,
- jika running/stopping, poll sekitar 2 detik,
- update `lpAgentRunning`,
- completion transition refresh dataset satu kali.

Hindari duplicate dataset reload antara App dan modal.

Preferred: App menjadi owner auto-reload dataset; modal fokus tampilan/control.

Jangan menambah duplicate Fabriq SSE jika bisa dihindari.

---

# 31. FRONTEND FABRIQ WORKER INPUT

Jika local code masih mempunyai preset:

```text
1 / 2 / 5 / 10
```

ganti menjadi number input manual untuk Start dan Resume Fabriq.

Input:

```tsx
type="number"
min={1}
step={1}
```

Tidak ada `max`.

Jika user sudah mengubah bagian ini secara lokal, jangan rollback.

---

# 32. STYLING

## File

```text
frontend/src/styles.css
```

Tambahkan styling secukupnya untuk:
- update control cards,
- LP Agent source badge,
- two worker input rows,
- LP pipeline stepper 5 tahap,
- progress metrics,
- warning box LP Agent,
- running/complete/error state.

Gunakan variable/theme existing.

Jangan mengubah desain global.

Modal tetap usable di layar kecil:
- stack cards,
- wrap stats,
- scroll body jika tinggi melebihi viewport.

---

# 33. BACKEND STATE RESET

Pada LP run baru reset:

```js
completedPages = 0;
totalPages = 0;
wallets = 0;
progressPercent = 0;

inputRows = 0;
uniqueIncoming = 0;
updatedExisting = 0;
addedNew = 0;
masterWallets = 0;

fabriqTotal = 0;
fabriqCompleted = 0;
fabriqSuccess = 0;
fabriqFailed = 0;
fabriqSkipped = 0;

error = null;
exitCode = null;
finishedAt = null;
logs = [];
```

Preserve worker pilihan run saat itu.

---

# 34. ERROR HANDLING PER STAGE

Gunakan error spesifik:

```text
LP Agent scrape failed with exit code X
Wallet merge failed with exit code X
Fabriq enrichment failed with exit code X
Fabriq enrichment completed with N failed wallets
Fabriq merge failed with exit code X
Publish failed with exit code X
```

Jangan semuanya generic `Pipeline failed`.

---

# 35. JANGAN PUBLISH PARTIAL DATA

Pipeline hanya boleh `completed` jika:

```text
LP scrape       success
Wallet merge    success
Fabriq enrich   success
Fabriq failed   = 0
Fabriq merge    success
Publish         success
```

Jika salah satu gagal:
- stop pipeline,
- state error,
- jangan lanjut stage berikutnya.

---

# 36. MASTER WALLET BEHAVIOR

Jangan mengubah semantics `merge-wallets.ts`.

Current behavior harus dipertahankan:

```text
incoming LP Agent scan
+
existing historical master wallets
=
upsert master
```

Wallet yang tidak muncul di scan terbaru tidak otomatis dihapus.

Wallet baru ditambahkan.
Wallet lama di-update.
Historical local metadata dipertahankan.
Existing Fabriq data jangan hilang ketika LP Agent merge.

---

# 37. LP AGENT FILTER BEHAVIOR

Jangan membuat filter LP Agent baru di frontend.

Sistem tetap memakai filter yang aktif pada tab LP Agent di Brave.

UI hanya menampilkan warning:

```text
Before updating, open LP Agent in the Brave
remote-debugging session and make sure the desired
Solana Smart LP filter is already active.
```

Jangan mencoba bypass login / Cloudflare.

---

# 38. FILE YANG DIPERKIRAKAN DIUBAH

Minimal:

```text
scripts/control/server.mjs

frontend/src/components/FabriqControlModal.tsx
frontend/src/App.tsx
frontend/src/styles.css
```

Buat:

```text
frontend/src/lib/lpAgentControl.ts
```

Hanya ubah:

```text
scripts/lpagent/scrape-smart-lp.mjs
```

jika diperlukan untuk output progress yang konsisten / compatibility parser.

Jangan rewrite scraper yang sudah berhasil.

---

# 39. FILE YANG TIDAK PERLU DIUBAH KECUALI BENAR-BENAR PERLU

```text
scripts/pipeline/merge-wallets.ts
scripts/pipeline/merge-fabriq.ts
scripts/pipeline/publish-wallets.ts
frontend/src/types.ts
```

Parser controller harus menyesuaikan output existing scripts sebisa mungkin.

---

# 40. EXPECTED API STATE — SCRAPING

Contoh:

```json
{
  "status": "running",
  "stage": "scrape",
  "concurrency": 5,
  "fabriqConcurrency": 10,
  "completedPages": 19,
  "totalPages": 48,
  "wallets": 228,
  "progressPercent": 40,
  "inputRows": 0,
  "uniqueIncoming": 0,
  "updatedExisting": 0,
  "addedNew": 0,
  "masterWallets": 0,
  "fabriqTotal": 0,
  "fabriqCompleted": 0,
  "fabriqSuccess": 0,
  "fabriqFailed": 0,
  "fabriqSkipped": 0,
  "running": true
}
```

---

# 41. EXPECTED API STATE — MERGED

Contoh:

```json
{
  "status": "running",
  "stage": "fabriq_enrich",
  "completedPages": 48,
  "totalPages": 48,
  "wallets": 570,
  "progressPercent": 100,
  "inputRows": 570,
  "uniqueIncoming": 570,
  "updatedExisting": 530,
  "addedNew": 40,
  "masterWallets": 1498,
  "running": true
}
```

Angka hanya contoh.

---

# 42. EXPECTED FINAL STATE

Contoh:

```json
{
  "status": "completed",
  "stage": "completed",
  "concurrency": 5,
  "fabriqConcurrency": 10,
  "completedPages": 48,
  "totalPages": 48,
  "wallets": 570,
  "progressPercent": 100,
  "inputRows": 570,
  "uniqueIncoming": 570,
  "updatedExisting": 530,
  "addedNew": 40,
  "masterWallets": 1498,
  "fabriqTotal": 1498,
  "fabriqCompleted": 1498,
  "fabriqSuccess": 1498,
  "fabriqFailed": 0,
  "exitCode": 0,
  "error": null,
  "running": false
}
```

Angka hanya contoh.

---

# 43. ACCEPTANCE CRITERIA CODE

Agent **tidak perlu menjalankan test**, tetapi code harus memenuhi:

1. LP Agent status mempunyai live page progress.
2. Tidak double-count page multi-worker.
3. Worker LP Agent manual tanpa max.
4. Worker Fabriq manual tanpa max.
5. Setelah scrape sukses otomatis merge wallet.
6. Setelah merge wallet otomatis Fabriq stale/missing.
7. Jika Fabriq ada failure, pipeline berhenti dan tidak publish.
8. Setelah Fabriq sukses otomatis merge Fabriq.
9. Setelah merge otomatis publish.
10. Status baru `completed` setelah publish sukses.
11. Stop dapat bekerja pada stage pipeline aktif.
12. Fabriq manual dan LP pipeline tidak dapat berjalan bersamaan.
13. Frontend mempunyai control LP Agent pada modal update.
14. UI menunjukkan LP Agent page progress.
15. UI menunjukkan stage pipeline.
16. UI menunjukkan hasil added / updated / master.
17. UI mempunyai custom LP workers.
18. UI mempunyai custom Fabriq workers.
19. Tidak ada hard upper worker limit.
20. Dataset frontend direload setelah pipeline selesai.
21. Modal tidak blank karena conditional hook.
22. Existing Fabriq manual refresh tetap tersedia.
23. Existing LP Agent checkpoint behavior tetap tersedia.
24. Tidak ada credential/token yang dikirim ke frontend.
25. Control API tetap local-only.

---

# 44. JANGAN DIKERJAKAN

Jangan mengerjakan:
- scheduling otomatis,
- cron,
- database baru,
- wallet deletion,
- copy trading,
- LP Agent filter builder,
- Cloudflare bypass,
- credential storage,
- remote control dari internet,
- deployment,
- redesign seluruh dashboard,
- refactor besar unrelated,
- optimization dataset 25 MB,
- portfolio migration,
- CSV fix,
- all-time PnL outlier guard.

Scope hanya **LPCTRL-2 sampai LPCTRL final**.

---

# 45. OUTPUT AGENT SETELAH EDIT

Setelah seluruh perubahan selesai:

**JANGAN testing.**

Balas hanya format:

```text
IMPLEMENTATION COMPLETE

Created:
- ...

Modified:
- ...

Summary:
- LP Agent live progress added
- automatic merge-wallets added
- automatic Fabriq stale/missing enrichment added
- automatic merge-fabriq + publish added
- LP Agent UI control added
- custom LP/Fabriq workers added
- dataset reload on completion added

Testing:
- Not run, per instruction
```

Jangan menjalankan command verifikasi apa pun.
