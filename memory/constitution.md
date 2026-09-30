# Rahasia Constitution

Rahasia adalah tool pribadi untuk menyaring wallet LP Meteora DLMM yang layak dipantau.
Constitution ini mengikat semua spec, plan, tasks, dan kode. Jika ada konflik, constitution menang.

## Articles

### I. Read-Only, Tanpa Rahasia (NON-NEGOTIABLE)
- Sistem TIDAK PERNAH menyimpan private key, seed phrase, atau menandatangani/mengirim transaksi.
- Sistem hanya membaca data dan menulis artifact lokal.
- API key hanya di `.env` (tidak pernah di-commit, tidak pernah di-log). `.env.example` hanya berisi nama variabel.
- Folder `data/` dan dataset hasil generate tidak pernah di-commit.

### II. Keputusan Trade Tetap Manual
- Output sistem adalah alat bantu screening, bukan sinyal beli/jual.
- Pemantauan wallet dan eksekusi trade dilakukan manual oleh pemilik.
- Auto copy trade di luar scope. Fitur itu baru boleh dibahas lewat amandemen constitution, bukan lewat spec fitur biasa.
- Setiap artifact skor wajib memuat field `semantics` yang menjelaskan arti skor dan peringatan bahwa skor bukan jaminan hasil.

### III. Hierarki Sumber Data
- LP Agent dan Fabriq adalah sumber data utama. Verifikasi on-chain tidak diwajibkan.
- Jangan menambah API, RPC, atau layanan berbayar baru jika data sudah tersedia dari LP Agent atau Fabriq.
- Risiko yang diterima: data pihak ketiga bisa terlambat atau salah. Setiap artifact wajib mencatat `generatedAt`, `version`, dan sumber datanya.
- Sumber data baru hanya boleh masuk lewat plan yang menjelaskan kenapa LP Agent dan Fabriq tidak cukup.

### IV. Semua Parameter Screening Bisa Dikustomisasi
- Semua threshold, bobot, dan window (minimum ukuran wallet, minimum hari trading, minimum posisi, jendela riwayat, bobot skor, cutoff percentile, dll.) berada di SATU file konfigurasi.
- Dilarang ada angka ajaib di kode. Nilai default didokumentasikan di file konfigurasi.
- Setiap artifact output menyimpan salinan konfigurasi yang dipakai, supaya hasil bisa dijelaskan dan diulang.
- Parameter baru yang ditambahkan fitur wajib masuk file konfigurasi dengan default dan deskripsi.

### V. Deterministik dan Bisa Diulang
- Input dan konfigurasi yang sama harus menghasilkan output yang sama.
- Hasil diurutkan secara deterministik (mis. berdasarkan alamat wallet). Tidak ada `Math.random`. Waktu hanya boleh dipakai untuk `generatedAt`.
- Penulisan artifact bersifat atomic (tulis ke file sementara, lalu rename).
- Tiap tahap pipeline membaca artifact dan menulis artifact. Tidak ada state tersembunyi antar tahap.

### VI. Struktur dan Kebersihan Artifact
- Kode V1 tinggal di `scripts/v1/`, data di `data/v1/`. Fitur baru tidak mengubah format artifact yang sudah ada tanpa dicatat di plan.
- Menjaga pipeline lama (`scripts/pipeline/**`, `wallets-master.json`) tetap utuh adalah kebiasaan, bukan gerbang otomatis. Jika sebuah fitur perlu mengubahnya, plan harus menyebutkannya secara eksplisit.
- Satu file, satu tanggung jawab. Logika skor dipisah dari I/O (baca/tulis file).

### VII. Pengujian Sementara, Validasi Manual
- Script audit dan tes hanya alat verifikasi sementara. Setelah fitur selesai dan hasilnya dicek, file audit DIHAPUS sebelum commit.
- Script audit tidak boleh menjadi dependensi pipeline utama.
- Kriteria kelayakan fitur ditulis sebagai acceptance scenario di `spec.md` (bertahan setelah audit dihapus).
- Validasi ke depan (apakah wallet shortlist masih bagus) dilakukan manual oleh pemilik. Tidak ada gerbang otomatis.

### VIII. Sederhana dan Sesuai Scope
- Tidak ada fitur spekulatif ("mungkin nanti butuh"). Setiap fitur harus punya user story dengan acceptance criteria.
- Di luar scope sampai ada spec sendiri: realtime tracker, notifikasi, ML/clustering, backtesting, eksekusi trade.
- Pakai TypeScript dan Node dengan dependensi seminimal mungkin. Dependensi baru harus disetujui di plan.

### IX. Pembagian Kerja Agent dan Aturan Kode yang Ketat
- **Perancang** (Claude, GPT): menulis constitution, spec, plan, dan tasks. Semua formula, threshold, dan algoritma ditentukan di sini.
- **Pelaksana** (Antigravity, GLM): hanya menulis kode dari `tasks.md`. Dilarang mengubah algoritma, menambah fitur, atau "memperbaiki" formula atas inisiatif sendiri.
- Jika spec atau plan ambigu, pelaksana BERHENTI dan menandai `[NEEDS CLARIFICATION: ...]`. Dilarang menebak.
- Aturan kode untuk pelaksana:
  - TypeScript strict, tipe eksplisit untuk semua input dan output fungsi, tanpa `any` baru.
  - Fungsi perhitungan skor harus murni (tanpa I/O, tanpa efek samping).
  - Setiap formula diberi komentar yang merujuk ke ID requirement (mis. `// FR-004`).
  - Tidak menambah dependensi, mengubah struktur folder, atau mengubah file di luar task yang diberikan.
  - Setiap task selesai dengan laporan singkat: file yang diubah dan hal yang tidak bisa dikerjakan.

## Governance

- Constitution mengalahkan semua dokumen dan praktik lain. Pelanggaran terhadapnya dianggap CRITICAL saat `analyze`.
- Yang diperbaiki adalah spec, plan, atau tasks, bukan prinsipnya. Jika prinsipnya memang salah, lakukan amandemen terpisah.
- Amandemen dilakukan oleh pemilik, dicatat dengan versi dan tanggal, dan menyebut dampaknya ke spec yang sudah ada.
- Versioning: MAJOR untuk prinsip dihapus/diubah artinya, MINOR untuk article baru, PATCH untuk perbaikan redaksi.

**Version**: 1.0.0 | **Ratified**: 2026-09-30 | **Last Amended**: 2026-09-30
