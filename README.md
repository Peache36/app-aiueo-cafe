# AIUEO Cafe — Loyalty Stamp (Supabase + Netlify)

Struktur: `supabase/` (database + Edge Function), `web/` (aplikasi, di-deploy ke Netlify), `tests/`.

## 1. Supabase
1. Buat project di supabase.com (region **Singapore**).
2. SQL Editor → jalankan berurutan isi file `supabase/migrations/…0001_schema.sql`, `…0002_logic.sql`, `…0003_api.sql`.
3. Set nomor Admin (format 62…):
   `update loyalty.config set value='6281234567890' where key='admin_phone';`
   Login pertama dengan nomor itu otomatis menjadi Admin.
4. Deploy Edge Function `api` (Supabase CLI):
   `supabase link --project-ref <REF>` lalu `supabase functions deploy api --no-verify-jwt`
5. Secrets (Dashboard → Edge Functions → Secrets, atau `supabase secrets set`):
   - `FONNTE_TOKEN` = token Fonnte (untuk kirim OTP WhatsApp)
   - `ALLOWED_ORIGIN` = URL Netlify Anda, mis. `https://aiueo-cafe.netlify.app`
   - `DEBUG_OTP` = `true` hanya untuk uji coba (OTP hanya tampil di log fungsi); hapus saat live.
6. Cek: buka `https://<REF>.supabase.co/functions/v1/api` → harus tampil `{"ok":true,...}`.

## 2. Netlify
1. Edit `web/config.js`: isi `LS_API_URL` dengan URL fungsi di atas.
2. Netlify → Add new site → Deploy manually → seret folder `web` (atau zip isinya).
3. Buka situs di HP → "Pasang"/"Tambah ke Layar Utama". Ikon, splash, dan favicon memakai logo AIUEO.

## Catatan
- Navigasi, notifikasi, dan dialog ada di atas/tengah layar (tidak tertutup watermark Netlify).
- Pemindai QR kasir memuat jsQR dari CDN (perlu internet). Pembuat QR pelanggan sudah lokal.
- Backup: aktifkan backup harian Supabase (plan Pro) atau jadwalkan `pg_dump`.
- Uji database lokal: `python3 tests/test_sql.py` (98 pemeriksaan).
