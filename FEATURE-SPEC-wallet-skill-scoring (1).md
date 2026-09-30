# Feature Spec: Wallet Skill Scoring & Per-Position Behaviour Tracking

## 1. Konteks Project

Project ini adalah **Meteora Wallet Scanner** — pipeline untuk menemukan, menganalisis, dan
mengikuti wallet-wallet yang profitable sebagai Liquidity Provider (LP) di Meteora DLMM
(Solana). Arsitektur pipeline yang sudah berjalan saat ini:

```text
LP Agent (scrape)
   ↓
data/raw/lpagent/
   ↓
merge-wallets.ts
   ↓
data/master/wallets-master.json   ← agregat per-wallet (LP Agent + Fabriq)
   ↓
Fabriq enrichment
   ↓
merge-fabriq.ts
   ↓
publish-wallets.ts
   ↓
frontend/public/data/wallets-14d.json
   ↓
Wallet Explorer UI (React)
```

Terpisah dari pipeline utama, ada modul **WALDISC** (`scripts/discovery/`) yang sudah bisa:
- Scan histori transaksi 1 pool Meteora DLMM tertentu dari on-chain (Solana RPC).
- Decode instruksi mentah memakai IDL resmi Meteora DLMM (discriminator 8-byte Anchor).
- Klasifikasi instruksi ke kategori LP lifecycle: `initialize`, `add`, `remove`, `claim_fee`,
  `claim_reward`, `close`, `rebalance` (lihat `lp-instruction-decoder.ts`).
- Resolve wallet pemilik posisi dari IDL signer semantics (bukan asumsi fee-payer).
- Verifikasi ulang posisi lewat on-chain account (`PositionV2`) untuk memastikan
  pool & owner match dan tidak salah decode.
- Output ke `data/discovery/waldisc-1/<POOL>/{summary.json, wallets.json, lp-events.json,
  unknown-discriminators.json}`.

**Masalah saat ini:** `wallets-master.json` (dari LP Agent + Fabriq) hanya berisi data
**agregat per-wallet** — total PnL, win rate, profit factor, ROI, pnl_chart harian. Data ini
bagus untuk ranking kasar, tapi **tidak cukup untuk mempelajari behaviour LP** karena:
- Tidak tahu apakah profit datang dari banyak posisi kecil yang konsisten, atau dari 1-2
  posisi jackpot yang menutupi banyak posisi rugi.
- Tidak tahu strategi liquidity shape yang dipakai (spot/curve/bid-ask, lebar range bin).
- Tidak tahu timing entry wallet relatif terhadap umur pool (sniper vs LP jangka panjang).
- Data berasal dari scraping pihak ketiga (LP Agent, Fabriq) yang bisa stale/delay, sementara
  WALDISC sudah punya jalur verifikasi langsung ke on-chain per event/posisi.

## 2. Tujuan Fitur

Membangun **skill score per wallet** yang berbasis data granular per-posisi (bukan cuma
agregat), sehingga hasil ranking benar-benar mencerminkan **konsistensi & skill LP**, bukan
keberuntungan sesaat. Skor ini akan jadi fondasi untuk fitur-fitur berikutnya (realtime
tracker, clustering, backtesting, copy-trade) — semua fitur itu bergantung pada kualitas
sinyal dari fitur ini.

## 3. Ruang Lingkup Fitur (High-Level)

Ada 3 sub-fitur yang saling berurutan:

### 3.1. Perluasan WALDISC: Multi-Pool, Multi-Wallet Position Scan
Perluas kapabilitas scan WALDISC (yang saat ini hanya bisa 1 pool) supaya bisa:
- Menerima daftar wallet target (dari `wallets-master.json` — misalnya top N by
  `roi_avg_inflow` atau `total_pnl_30d`) dan/atau daftar pool.
- Untuk tiap wallet, scan histori transaksi *across* pool-pool DLMM yang pernah dia masuki
  (bukan hanya 1 pool spesifik seperti WALDISC-1 saat ini).
- Menghasilkan **riwayat per-posisi granular**, bukan hanya event log flat.

### 3.2. Position Aggregation Layer
Mengubah `lp-events.json` (event-level: OPEN/ADD/REMOVE/CLOSE per transaksi) menjadi
**position-level records** — satu posisi = gabungan semua event dari `initialize_position`
sampai `close_position` untuk 1 akun position yang sama. Dari situ dihitung metrik per-posisi:
- Durasi hold (dari timestamp initialize sampai close).
- Bin range yang dipakai & seberapa lebar relatif terhadap harga pool.
- Net PnL posisi tersebut (inflow vs outflow vs fee vs reward).
- Berapa kali di-rebalance selama hidupnya.

### 3.3. Skill Scoring Engine
Menghitung skor komposit per wallet dari kombinasi data agregat (`wallets-master.json`) +
data granular per-posisi (hasil 3.2), lalu menghasilkan `wallet-scores.json` yang dikonsumsi
frontend.

## 4. Data yang Sudah Tersedia (Tidak Perlu Dikumpulkan Ulang)

Dari `data/master/wallets-master.json` (per wallet), field yang relevan untuk scoring:

```text
total_pnl, total_pnl_native, total_pnl_7d, total_pnl_30d
win_rate, win_rate_native
expected_value, expected_value_native
roi, roi_avg_inflow, roi_avg_inflow_native
apr, fee_percent
avg_pos_profit, avg_pos_profit_native
avg_monthly_profit_percent, avg_monthly_pnl
total_lp, win_lp, closed_lp, opening_lp, total_pool
avg_age_hour, first_activity, last_activity
pnl_chart[]            // time series harian: sum, cumulative_pnl, total_lp, win_lp, total_fee
fabriq.stats           // profitFactorUsd/Sol, positionWinUsd/Sol, avgWinLoss, dayWinUsd/Sol
fabriq.calendar         // breakdown harian tambahan dari Fabriq
```

Dari modul WALDISC (`scripts/discovery/core/`), kapabilitas teknis yang sudah ada dan bisa
dipakai ulang:

```text
meteora-idl.ts              // loader IDL resmi + discriminator map instruksi & event
lp-instruction-decoder.ts   // decode instruksi mentah -> category (add/remove/close/dst)
transaction-normalizer.ts   // normalisasi raw tx Solana jadi bentuk instruksi standar
wallet-resolver.ts          // resolve wallet owner dari IDL signer semantics
scan-pool-history.ts        // scan histori transaksi 1 pool dari RPC
rpc.ts                      // koneksi ke Solana RPC
```

## 5. Data yang PERLU Dikumpulkan / Dibangun Baru

Ini gap utama — semuanya bisa didapat dengan **memperluas kode WALDISC yang sudah ada**,
bukan membangun dari nol:

| Data Baru | Sumber | Kenapa Dibutuhkan |
|---|---|---|
| **Riwayat posisi granular per wallet** (bukan per pool tunggal) | Perluasan `scan-pool-history.ts` agar bisa iterasi banyak pool per wallet | Fondasi seluruh fitur ini — tanpa ini scoring tetap di level agregat |
| **Bin range / lebar liquidity per posisi** | Decode instruksi `add_liquidity*` — ambil parameter bin ID lower/upper dari instruction args (bukan hanya account keys) | Untuk klasifikasi strategi (spot/curve/bid-ask) dan mengukur presisi LP |
| **Timestamp `initialize_position` vs umur pool** | Bandingkan waktu posisi dibuka vs waktu `initialize` pool pertama kali muncul di histori scan | Membedakan sniper (masuk pool baru dalam hitungan menit) vs LP jangka panjang |
| **Jumlah rebalance per posisi** | Hitung instruksi `rebalance_liquidity` yang terjadi pada `position` account yang sama sebelum `close_position` | Sinyal LP aktif vs pasif |
| **Net PnL per posisi individual** (bukan agregat wallet) | Kombinasikan event `add` (inflow), `remove`/`close` (outflow), `claim_fee`, `claim_reward` pada 1 `position` account | Untuk mendeteksi apakah profit wallet berasal dari banyak posisi konsisten atau 1-2 outlier |
| **Metadata pool saat posisi dibuka** (bin_step, pair token, TVL/volume approx saat itu bila memungkinkan) | Gabungkan dengan `data/pools/` yang sudah ada | Memisahkan skill LP vs sekadar market beta (pool sedang rally) — dibahas sebagai fitur terpisah tapi datanya mulai dikumpulkan di sini |

**Catatan penting:** Data-data di atas SEMUA bisa diturunkan dari histori transaksi
on-chain yang sudah bisa diakses lewat RPC + IDL decoder yang sudah ada di WALDISC. Tidak
perlu API eksternal baru — hanya perlu memperluas cakupan scan dari "1 pool" menjadi
"banyak pool per wallet target", dan memperkaya decoder supaya membaca instruction
**arguments** (bin ID range dsb), bukan hanya account keys seperti implementasi WALDISC-1
saat ini.

## 6. Logic / Alur Proses Detail

```text
STEP 1 — Pilih Wallet Target
  Input: data/master/wallets-master.json
  Filter kandidat awal, contoh:
    - total_pnl_30d > 0
    - total_lp >= threshold (cukup sample size, hindari wallet dengan 2-3 posisi saja)
    - last_activity dalam N hari terakhir (masih aktif)
  Output: daftar wallet address kandidat (misal top 200)

STEP 2 — Kumpulkan Pool yang Pernah Disentuh Wallet Tersebut
  Untuk tiap wallet kandidat, cari daftar pool yang dia pernah LP di dalamnya.
  Sumber: bisa dari histori transaksi wallet langsung (getSignaturesForAddress wallet,
  lalu filter instruksi Meteora DLMM), lebih efisien daripada scan semua pool dari sisi pool.

STEP 3 — Scan & Decode Per Posisi (perluasan WALDISC)
  Untuk tiap (wallet, pool) pair:
    - Ambil histori transaksi terkait
    - Decode tiap instruksi pakai lp-instruction-decoder.ts (reuse)
    - Group event by `position` account (bukan hanya log flat seperti WALDISC-1)
    - Bentuk 1 record per posisi:
        {
          wallet, pool, position,
          openedAt, closedAt (atau null jika masih open),
          binRange: { lower, upper, binStep },
          rebalanceCount,
          events: [...] // urutan add/remove/claim_fee/claim_reward/close
          netInflow, netOutflow, netFee, netReward, netPnl
        }
  Output: data/discovery/positions/<wallet>.json

STEP 4 — Verifikasi On-Chain (reuse WALDISC hardening)
  Untuk posisi yang masih berstatus "open" / belum closed, verifikasi ulang lewat
  on-chain PositionV2 account (account.owner === METEORA_DLMM_PROGRAM_ID, pool match,
  owner match) — logic ini sudah ada di waldisc-1-test-one-pool.ts, tinggal reuse.

STEP 5 — Hitung Metrik Per Wallet dari Kumpulan Posisi
  Dari seluruh posisi 1 wallet:
    - winRatePosition = closed posisi profit / total closed posisi
    - pnlConcentration = seberapa besar % total profit disumbang oleh top-1 atau top-3 posisi
                          (indikator "jackpot" vs "konsisten")
    - avgHoldDuration, medianHoldDuration
    - avgBinRangeWidth (relatif terhadap price movement, bila data tersedia)
    - rebalanceFrequency = total rebalance / total posisi
    - entryTimingProfile = rata-rata selisih waktu posisi dibuka vs pool pertama kali aktif
                            (indikasi sniper vs bukan)
    - styleTag = klasifikasi sederhana berbasis aturan (lihat 6.1 di bawah), bukan ML

STEP 6 — Skill Score Composite
  Gabungkan metrik dari Step 5 + data agregat wallets-master.json (win_rate, profit factor
  dari Fabriq, roi_avg_inflow) jadi 1 skor 0-100, dengan pembobotan yang bisa dikonfigurasi
  (lihat 6.2).

STEP 7 — Publish
  Tulis hasil ke data/master/wallet-scores.json, lalu publish-wallets.ts (extend) menyalin
  subset relevan ke frontend/public/data/ untuk ditampilkan di Wallet Explorer.
```

### 6.1. Aturan Klasifikasi Style Tag (Rule-Based, Bukan ML — untuk versi awal)

```text
JIKA rata-rata durasi hold < X jam DAN entryTimingProfile kecil (masuk cepat setelah pool baru)
  → tag: "sniper"

JIKA rata-rata durasi hold > Y hari DAN total_pool kecil (fokus sedikit pool)
  → tag: "farmer"

JIKA rebalanceFrequency tinggi
  → tag: "active_range_trader"

DEFAULT
  → tag: "mixed" / "unclassified"
```
Threshold X, Y, dan batas rebalanceFrequency harus dibuat sebagai konstanta yang mudah
di-tuning, karena akan disesuaikan setelah melihat distribusi data riil.

### 6.2. Formula Skoring (Draf Awal, untuk Didiskusikan/Ditimbang Ulang)

```text
skillScore =
    w1 * normalize(roi_avg_inflow_native)              // profitabilitas relatif modal
  + w2 * normalize(fabriq.stats.profitFactorUsd.ratio)  // gross profit / gross loss
  + w3 * normalize(winRatePosition)                     // konsistensi menang per posisi
  + w4 * (1 - normalize(pnlConcentration))               // penalti jika profit dari 1-2 posisi saja
  + w5 * normalize(consistencyDailyPnl)                  // dari pnl_chart: rasio hari profit vs rugi
  + w6 * normalize(log(total_lp))                        // penalti sample size kecil (winrate 100% dari 3 posisi tidak reliable)

Semua normalize() di-scale 0-1 relatif terhadap distribusi seluruh wallet kandidat (percentile-based),
bukan hardcoded min-max, supaya tahan terhadap outlier ekstrem.
```

Bobot `w1..w6` awalnya bisa ditebak manual (misal semua 1/6), lalu di-adjust setelah
melihat apakah ranking hasilnya masuk akal secara manual-review terhadap beberapa wallet
yang sudah dikenal.

## 7. Skema Data Output

### 7.1. `data/discovery/positions/<wallet>.json`

```json
{
  "wallet": "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
  "scannedAt": "2026-09-27T10:00:00.000Z",
  "positions": [
    {
      "position": "<position_account_pubkey>",
      "pool": "<lb_pair_pubkey>",
      "binStep": 4,
      "openedAt": "2026-09-19T21:04:01.000Z",
      "closedAt": "2026-09-20T03:12:44.000Z",
      "status": "CLOSED",
      "binRange": { "lower": -12, "upper": 8 },
      "rebalanceCount": 2,
      "netInflowUsd": 500.12,
      "netOutflowUsd": 545.30,
      "netFeeUsd": 12.4,
      "netRewardUsd": 0,
      "netPnlUsd": 57.58,
      "eventsRef": "data/discovery/waldisc-events/<pool>/lp-events.json"
    }
  ]
}
```

### 7.2. `data/master/wallet-scores.json`

```json
{
  "generatedAt": "2026-09-27T10:00:00.000Z",
  "scores": [
    {
      "wallet": "9a9tgJJWAt6iBFfLhWeK2aAthuezy3dttT7gckKBert4",
      "skillScore": 78.4,
      "styleTag": "farmer",
      "winRatePosition": 0.81,
      "pnlConcentration": 0.22,
      "avgHoldDurationHours": 14.2,
      "rebalanceFrequency": 0.35,
      "sampleSize": 1788,
      "confidence": "high"
    }
  ]
}
```
`confidence` diturunkan dari `sampleSize` (misal < 20 posisi = "low", di bawah threshold ini
skor tidak boleh diranking tinggi meski angka mentahnya bagus — untuk menghindari false
positive dari sample kecil).

## 8. Arsitektur & Teknis

### 8.1. Prinsip Desain
- **Reuse WALDISC, jangan bangun ulang.** Decoder, IDL loader, normalizer, wallet resolver
  sudah ada dan sudah diaudit (lihat `WALDISC-1_FINAL_AUDIT_ANTIGRAVITY.md`) — perluas
  cakupannya (multi-pool, multi-wallet, baca instruction args) daripada menulis parser baru.
- **Jangan sentuh pipeline utama.** `scripts/pipeline/**`, `data/master/wallets-master.json`
  hasil LP Agent/Fabriq, dan `frontend/**` tetap seperti sekarang — fitur baru ini
  menghasilkan file terpisah (`wallet-scores.json`, `data/discovery/positions/`) yang
  nantinya di-**join** saat publish ke frontend, bukan menimpa data yang sudah ada.
- **Idempotent & incremental.** Scan per wallet harus bisa dijalankan ulang tanpa
  duplikasi — simpan checkpoint terakhir (block/signature) per wallet, mirip pola
  checkpoint yang sudah dipakai LP Agent scraper (`data/checkpoints/`).
- **Rate limit RPC.** Scan banyak wallet x banyak pool akan menghasilkan banyak request
  RPC. Perlu batching, retry/backoff, dan kemungkinan pemakaian provider RPC berbayar
  (Helius/Triton) untuk `getSignaturesForAddress` yang efisien, karena RPC publik Solana
  punya rate limit ketat.

### 8.2. Struktur File Baru yang Diusulkan

```text
scripts/
  scoring/
    select-candidate-wallets.ts     # Step 1
    scan-wallet-positions.ts        # Step 2-4, reuse core/ WALDISC
    aggregate-position-metrics.ts   # Step 5
    compute-skill-score.ts          # Step 6
    publish-wallet-scores.ts        # Step 7

  discovery/core/
    lp-instruction-decoder.ts       # DIPERLUAS: baca instruction args (bin range), bukan hanya accounts
    scan-pool-history.ts            # DIPERLUAS/DIREFAKTOR: scan-wallet-history.ts (per wallet, bukan per pool)

data/
  discovery/
    positions/<wallet>.json         # BARU
  master/
    wallet-scores.json              # BARU
```

### 8.3. Perubahan pada Decoder (Penting)

`lp-instruction-decoder.ts` saat ini hanya memetakan **account keys** (`mappedAccounts`)
dari instruksi — belum membaca **instruction arguments** (misalnya parameter bin ID lower/
upper pada `add_liquidity`). Untuk mendapat bin range, decoder perlu diperluas membaca
Borsh-encoded args sesuai definisi tiap instruksi di IDL (`idlInstruction.args` — field ini
kemungkinan sudah termuat dari `meteora-idl.ts`, tinggal decode sesuai layout-nya).

### 8.4. Non-Breaking Terhadap Pipeline Existing

```text
publish-wallets.ts (existing)
   +
publish-wallet-scores.ts (baru, terpisah)
   ↓
frontend/public/data/wallet-scores.json (baru)
   ↓
Frontend: WalletTable.tsx — tambah kolom "Skill Score" & "Style"
           (join by wallet address dengan data existing, tidak mengganti skema lama)
```

## 9. Definition of Done (Versi Awal / MVP)

```text
[1] Bisa scan histori posisi untuk minimal 1 wallet lintas banyak pool (bukan cuma 1 pool test).
[2] Posisi ter-group dengan benar per `position` account (initialize → ... → close).
[3] Bin range terbaca dari instruction args, bukan diasumsikan.
[4] Metrik per-wallet (winRatePosition, pnlConcentration, avgHoldDuration, dst) terhitung benar.
[5] wallet-scores.json terbentuk dengan skema di atas untuk minimal 50 wallet kandidat.
[6] Tidak ada file di pipeline/master/frontend existing yang ter-mutasi (verifikasi hash sebelum/sesudah, mengikuti pola audit di WALDISC-1).
[7] Style tag (sniper/farmer/active_range_trader) terisi dan hasilnya masuk akal secara manual-review terhadap beberapa wallet top yang sudah dikenal.
```

## 10. Yang Sengaja TIDAK Termasuk di Fitur Ini (Out of Scope)

Supaya tidak scope creep — ini akan jadi fitur terpisah setelah fitur ini selesai:
- Realtime tracker / notifikasi live saat wallet target buka posisi baru.
- Clustering/cohort otomatis berbasis ML (versi ini masih rule-based sederhana).
- Backtesting simulasi "kalau aku ikut wallet ini dari tanggal X".
- Join dengan data kondisi pool (volatilitas/TVL saat entry) untuk memisahkan skill vs beta
  pasar — datanya mulai dikumpulkan di sini (lihat tabel Section 5) tapi analisisnya
  menyusul di fitur terpisah.
