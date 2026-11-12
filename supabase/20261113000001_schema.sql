-- ============================================================
--  AIUEO Cafe — Loyalty Stamp  (Supabase / PostgreSQL)
--  Bagian 1: skema data + fungsi bantu
--  Semua tabel ada di schema "loyalty" yang TIDAK terbuka lewat API publik.
--  Satu-satunya pintu masuk: public.ls_api(...) yang hanya bisa dipanggil
--  oleh Edge Function (service_role).
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists loyalty;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema loyalty from anon, authenticated;
  end if;
end $$;

-- ---------- konfigurasi privat (rahasia & zona waktu) ----------
create table if not exists loyalty.config (
  key   text primary key,
  value text not null default ''
);
insert into loyalty.config (key, value) values
  ('hmac_secret', encode(extensions.gen_random_bytes(32), 'hex')),
  ('timezone',    'Asia/Makassar'),
  ('admin_phone', '')
on conflict (key) do nothing;

-- ---------- pengguna ----------
create table if not exists loyalty.users (
  user_id        text primary key,
  phone          text not null unique,
  name           text not null,
  email          text not null default '',
  role           text not null default 'customer' check (role in ('customer', 'cashier', 'admin')),
  member_code    text not null unique,
  total_earned   int  not null default 0,
  total_redeemed int  not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  last_login     timestamptz,
  last_stamp_at  timestamptz
);

-- ---------- event stamp (campaign) & reward ----------
create table if not exists loyalty.campaigns (
  id           text primary key,
  name         text not null,
  description  text not null default '',
  icon         text not null default '☕',
  start_at     timestamp,          -- waktu lokal kafe (tanpa zona)
  end_at       timestamp,
  redeem_until timestamp,
  active       boolean not null default true,
  sort         int not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists loyalty.rewards (
  id              text primary key,
  name            text not null,
  description     text not null default '',
  stamps_required int  not null check (stamps_required between 1 and 100),
  campaign_id     text not null references loyalty.campaigns (id) on delete cascade,
  active          boolean not null default true,
  sort            int not null default 0,
  created_at      timestamptz not null default now()
);
create index if not exists rewards_campaign_idx on loyalty.rewards (campaign_id);

create table if not exists loyalty.cards (
  card_id      text primary key,
  user_id      text not null references loyalty.users (user_id) on delete cascade,
  campaign_id  text not null references loyalty.campaigns (id),
  stamps       int  not null default 0,
  claimed_ids  text[] not null default '{}',
  status       text not null default 'active' check (status in ('active', 'done')),
  created_at   timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create index if not exists cards_user_idx on loyalty.cards (user_id, campaign_id, status);

-- ---------- riwayat ----------
create table if not exists loyalty.stamps (
  id            text primary key,
  user_id       text not null references loyalty.users (user_id) on delete cascade,
  customer_name text not null default '',
  qty           int  not null,
  type          text not null check (type in ('earn', 'adjust')),
  by_user       text not null default '',
  by_name       text not null default '',
  note          text not null default '',
  ts            timestamptz not null default clock_timestamp(),
  campaign_id   text not null default 'default',
  card_id       text not null default ''
);
create index if not exists stamps_user_ts_idx on loyalty.stamps (user_id, ts desc);
create index if not exists stamps_ts_idx on loyalty.stamps (ts desc);

create table if not exists loyalty.redemptions (
  id            text primary key,
  user_id       text not null references loyalty.users (user_id) on delete cascade,
  customer_name text not null default '',
  reward_name   text not null default '',
  stamps_used   int  not null default 0,
  by_user       text not null default '',
  by_name       text not null default '',
  ts            timestamptz not null default clock_timestamp(),
  reward_id     text not null default '',
  campaign_id   text not null default 'default',
  card_id       text not null default ''
);
create index if not exists redemptions_user_ts_idx on loyalty.redemptions (user_id, ts desc);
create index if not exists redemptions_ts_idx on loyalty.redemptions (ts desc);

-- ---------- hero card event ----------
create table if not exists loyalty.events (
  id         text primary key,
  title      text not null,
  subtitle   text not null default '',
  badge      text not null default 'Sedang Berlangsung',
  image_url  text not null default '',
  link       text not null default '',
  start_at   timestamp,
  end_at     timestamp,
  active     boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- sesi, OTP, pembatasan, versi polling, jeda ----------
create table if not exists loyalty.sessions (
  token_hash text primary key,
  user_id    text not null references loyalty.users (user_id) on delete cascade,
  expires    timestamptz not null,
  remember   boolean not null default false,
  device     text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on loyalty.sessions (user_id);
create index if not exists sessions_exp_idx on loyalty.sessions (expires);

create table if not exists loyalty.otps (
  phone     text primary key,
  code_hash text not null,
  expires   timestamptz not null,
  attempts  int not null default 0,
  name      text not null default ''
);

create table if not exists loyalty.ratelimits (
  key      text primary key,
  n        int not null default 0,
  reset_at timestamptz not null
);

create table if not exists loyalty.versions (
  user_id text primary key,
  v       text not null
);

create table if not exists loyalty.cooldowns (
  user_id     text not null,
  campaign_id text not null,
  at          timestamptz not null,
  primary key (user_id, campaign_id)
);

create table if not exists loyalty.settings (
  key   text primary key,
  value text not null default ''
);

-- ============================================================
--  FUNGSI BANTU
-- ============================================================
create or replace function loyalty.err(p_msg text, p_code text default 'APP')
returns void language plpgsql as $$
begin
  raise exception '%', p_msg using errcode = 'LS001', detail = p_code;
end $$;

create or replace function loyalty.cfg(p_key text) returns text
language sql stable as $$ select value from loyalty.config where key = p_key $$;

create or replace function loyalty.tz() returns text
language sql stable as $$ select coalesce(loyalty.cfg('timezone'), 'Asia/Makassar') $$;

-- waktu lokal kafe, dibulatkan ke menit (dipakai membandingkan jadwal event)
create or replace function loyalty.now_min() returns timestamp
language sql stable as $$ select date_trunc('minute', now() at time zone loyalty.tz()) $$;

create or replace function loyalty.local_str(p_ts timestamptz) returns text
language sql stable as $$ select to_char(p_ts at time zone loyalty.tz(), 'YYYY-MM-DD HH24:MI:SS') $$;

create or replace function loyalty.local_iso(p_ts timestamp) returns text
language sql immutable as $$ select coalesce(to_char(p_ts, 'YYYY-MM-DD"T"HH24:MI'), '') $$;

create or replace function loyalty.sha(p_s text) returns text
language sql immutable as $$ select encode(extensions.digest(p_s, 'sha256'), 'hex') $$;

create or replace function loyalty.qr_sig(p_code text, p_ts text) returns text
language sql stable as $$
  select left(encode(extensions.hmac(p_code || '.' || p_ts, loyalty.cfg('hmac_secret'), 'sha256'), 'hex'), 12)
$$;

create or replace function loyalty.otp_hash(p_phone text, p_code text) returns text
language sql stable as $$ select loyalty.sha(loyalty.cfg('hmac_secret') || p_phone || p_code) $$;

create or replace function loyalty.new_id(p_prefix text) returns text
language sql volatile as $$ select p_prefix || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12) $$;

create or replace function loyalty.clean(p_v text, p_max int default 200) returns text
language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(p_v, ''), '[[:cntrl:]]', ' ', 'g')), p_max)
$$;

create or replace function loyalty.jnum(p jsonb, p_key text) returns numeric
language sql immutable as $$
  select case when (p ->> p_key) ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> p_key)::numeric else null end
$$;

create or replace function loyalty.jbool(p jsonb, p_key text, p_default boolean) returns boolean
language sql immutable as $$
  select case when p ->> p_key in ('true', 'false') then (p ->> p_key)::boolean else p_default end
$$;

create or replace function loyalty.norm_phone(p text) returns text
language plpgsql as $$
declare s text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
begin
  if left(s, 1) = '+' then s := substr(s, 2); end if;
  if left(s, 1) = '0' then s := '62' || substr(s, 2);
  elsif left(s, 1) = '8' then s := '62' || s; end if;
  if s !~ '^62[0-9]{8,12}$' then perform loyalty.err('Nomor HP tidak valid'); end if;
  return s;
end $$;

create or replace function loyalty.mask_phone(p text) returns text
language sql immutable as $$ select left(p, 5) || '****' || right(p, 3) $$;

-- tanggal/waktu dari form (yyyy-MM-ddTHH:mm) -> timestamp lokal; kosong -> null
create or replace function loyalty.dt(p_v text) returns timestamp
language plpgsql as $$
declare v text := replace(btrim(coalesce(p_v, '')), 'T', ' ');
begin
  if v = '' then return null; end if;
  if v !~ '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$' then perform loyalty.err('Format tanggal/waktu tidak valid'); end if;
  return v::timestamp;
exception when datetime_field_overflow or invalid_datetime_format then
  perform loyalty.err('Format tanggal/waktu tidak valid');
  return null;
end $$;

create or replace function loyalty.norm_url(p_u text, p_is_image boolean) returns text
language plpgsql as $$
declare u text := btrim(coalesce(p_u, '')); m text[];
begin
  if u = '' then return ''; end if;
  if u !~* '^https://' then perform loyalty.err('Link harus diawali https://'); end if;
  if length(u) > 500 then perform loyalty.err('Link terlalu panjang'); end if;
  if p_is_image then
    m := regexp_match(u, 'drive\.google\.com/file/d/([\w-]+)');
    if m is null then m := regexp_match(u, 'drive\.google\.com/(?:open|uc)\?(?:[^#]*&)?id=([\w-]+)'); end if;
    if m is not null then return 'https://lh3.googleusercontent.com/d/' || m[1]; end if;
  end if;
  return u;
end $$;

-- pembatasan permintaan (dihitung di tabel; tahan restart)
create or replace function loyalty.rate_limit(p_key text, p_max int, p_window_sec int,
  p_msg text default 'Terlalu banyak permintaan. Coba lagi beberapa menit lagi.') returns void
language plpgsql as $$
declare cnt int;
begin
  insert into loyalty.ratelimits (key, n, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_sec))
  on conflict (key) do update set
    n        = case when loyalty.ratelimits.reset_at < now() then 1 else loyalty.ratelimits.n + 1 end,
    reset_at = case when loyalty.ratelimits.reset_at < now() then now() + make_interval(secs => p_window_sec) else loyalty.ratelimits.reset_at end
  returning n into cnt;
  if cnt > p_max then perform loyalty.err(p_msg, 'RATE'); end if;
end $$;

create or replace function loyalty.touch(p_uid text) returns void
language sql volatile as $$
  insert into loyalty.versions (user_id, v)
  values (p_uid, floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text)
  on conflict (user_id) do update set v = excluded.v
$$;

create or replace function loyalty.ver(p_uid text) returns text
language sql stable as $$ select coalesce((select v from loyalty.versions where user_id = p_uid), '0') $$;

create or replace function loyalty.cleanup() returns void
language sql volatile as $$
  delete from loyalty.sessions where expires < now();
  delete from loyalty.otps where expires < now();
  delete from loyalty.ratelimits where reset_at < now();
  delete from loyalty.cooldowns where at < now() - interval '1 day';
$$;

-- ---------- pengaturan ----------
create or replace function loyalty.setting_defs()
returns table (key text, t text, d text, label text, vmin int, vmax int)
language sql immutable as $$
  select * from (values
    ('cafe_name',             's',    'AIUEO Cafe',                         'Nama kafe',                                                     null::int, 60),
    ('tagline',               's',    'Kumpulkan stamp, nikmati reward',    'Tagline',                                                       null, 120),
    ('theme_color',           'c',    '#15803D',                            'Warna tema',                                                    null, null),
    ('reward_terms',          'text', 'Berlaku untuk semua menu minuman.',  'Syarat & ketentuan reward (tampil di kartu)',                   null, 300),
    ('max_qty_per_add',       'n',    '3',                                  'Maks. stamp sekali input',                                      1, 20),
    ('cooldown_minutes',      'n',    '5',                                  'Jeda antar stamp per pelanggan per event (menit, 0 = tanpa jeda)', 0, 360),
    ('max_open_cards',        'n',    '3',                                  'Maks. kartu belum selesai per pelanggan per event',             1, 10),
    ('otp_ttl_minutes',       'n',    '5',                                  'Masa berlaku OTP (menit)',                                      2, 15),
    ('otp_daily_max',         'n',    '300',                                'Batas total kode OTP yang dikirim per hari',                    10, 5000),
    ('session_days_remember', 'n',    '30',                                 'Lama "Ingat saya" (hari)',                                      1, 365),
    ('session_hours_default', 'n',    '12',                                 'Lama sesi tanpa "Ingat saya" (jam)',                            1, 72)
  ) as v(key, t, d, label, vmin, vmax)
$$;

create or replace function loyalty.sett(p_key text) returns text
language sql stable as $$
  select coalesce(
    (select s.value from loyalty.settings s where s.key = p_key and (s.value <> '' or p_key = 'reward_terms')),
    (select d.d from loyalty.setting_defs() d where d.key = p_key))
$$;

create or replace function loyalty.setn(p_key text) returns int
language plpgsql stable as $$
declare v text; dflt text;
begin
  select s.value into v from loyalty.settings s where s.key = p_key;
  if v ~ '^-?[0-9]+$' then return v::int; end if;
  select d.d into dflt from loyalty.setting_defs() d where d.key = p_key;
  return dflt::int;
end $$;

create or replace function loyalty.pub_settings() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'cafe_name', loyalty.sett('cafe_name'), 'tagline', loyalty.sett('tagline'),
    'theme_color', loyalty.sett('theme_color'), 'reward_terms', loyalty.sett('reward_terms'),
    'max_qty_per_add', loyalty.setn('max_qty_per_add'))
$$;
