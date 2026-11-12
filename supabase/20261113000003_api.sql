-- ============================================================
--  Bagian 3: login (OTP WhatsApp), sesi, admin, dan pintu API
-- ============================================================

-- ---------- sesi ----------
create or replace function loyalty.auth(p_token text) returns loyalty.users
language plpgsql as $$
declare s loyalty.sessions; u loyalty.users;
begin
  if p_token is null or p_token = '' then perform loyalty.err('Silakan masuk terlebih dahulu', 'AUTH'); end if;
  select * into s from loyalty.sessions where token_hash = loyalty.sha(p_token);
  if not found or s.expires < now() then perform loyalty.err('Sesi berakhir, silakan masuk lagi', 'AUTH'); end if;
  select * into u from loyalty.users where user_id = s.user_id;
  if not found or not u.active then perform loyalty.err('Akun tidak aktif', 'AUTH'); end if;
  -- "Ingat saya" bergulir: perpanjang bila sisa < 7 hari
  if s.remember and s.expires - now() < interval '7 days' then
    update loyalty.sessions set expires = now() + make_interval(days => loyalty.setn('session_days_remember'))
     where token_hash = s.token_hash;
  end if;
  return u;
end $$;

create or replace function loyalty.err_obj(p_msg text, p_code text default 'APP') returns jsonb
language sql immutable as $$ select jsonb_build_object('__error', p_msg, '__code', p_code) $$;

-- ---------- login ----------
create or replace function loyalty.r_public_info(p_meta jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('cafe_name', loyalty.sett('cafe_name'), 'tagline', loyalty.sett('tagline'),
    'theme_color', loyalty.sett('theme_color'), 'session_days_remember', loyalty.setn('session_days_remember'),
    'channels', jsonb_build_object('whatsapp', coalesce((p_meta ->> 'wa')::boolean, false)))
$$;

-- membuat OTP; pengiriman WhatsApp dilakukan Edge Function lewat field "_send" (dibuang sebelum ke browser)
create or replace function loyalty.r_otp_request(p jsonb, p_meta jsonb) returns jsonb
language plpgsql as $$
declare
  v_phone text := loyalty.norm_phone(p ->> 'phone'); u loyalty.users; nm text := ''; code text; ttl int := loyalty.setn('otp_ttl_minutes');
  cafe text := loyalty.sett('cafe_name');
begin
  if not coalesce((p_meta ->> 'wa')::boolean, false) then
    perform loyalty.err('Pengiriman kode WhatsApp belum diaktifkan. Hubungi kasir/admin.');
  end if;
  perform loyalty.rate_limit('OTPREQ_' || v_phone, 5, 900);
  select * into u from loyalty.users where users.phone = v_phone;
  if found and not u.active then perform loyalty.err('Akun ini dinonaktifkan. Hubungi kasir/admin.'); end if;
  if not found then
    nm := loyalty.clean(p ->> 'name', 60);
    if nm = '' then return jsonb_build_object('needInfo', true); end if;
  end if;
  perform loyalty.rate_limit('OTPDAY', loyalty.setn('otp_daily_max'), 86400,
    'Layanan kode OTP sedang dibatasi hari ini. Coba lagi besok atau hubungi kasir.');

  code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into loyalty.otps (phone, code_hash, expires, attempts, name)
  values (v_phone, loyalty.otp_hash(v_phone, code), now() + make_interval(mins => ttl), 0, nm)
  on conflict (phone) do update set code_hash = excluded.code_hash, expires = excluded.expires, attempts = 0, name = excluded.name;

  return jsonb_build_object('sent', true, 'channel', 'whatsapp', 'ttl', ttl, 'to', loyalty.mask_phone(v_phone),
    '_send', jsonb_build_object('phone', v_phone,
      'message', 'Kode login ' || cafe || ': ' || code || '. Berlaku ' || ttl || ' menit. Jangan bagikan kode ini kepada siapa pun.',
      'debug_code', code));
end $$;

create or replace function loyalty.unique_member_code() returns text
language plpgsql as $$
declare chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; i int; t int;
begin
  for t in 1..20 loop
    c := 'LS-';
    for i in 1..6 loop c := c || substr(chars, 1 + floor(random() * length(chars))::int, 1); end loop;
    if not exists (select 1 from loyalty.users where member_code = c) then return c; end if;
  end loop;
  perform loyalty.err('Gagal membuat kode member');
  return null;
end $$;

create or replace function loyalty.r_otp_verify(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_phone text := loyalty.norm_phone(p ->> 'phone'); code text := regexp_replace(coalesce(p ->> 'code', ''), '\D', '', 'g');
  o loyalty.otps; u loyalty.users; remember boolean := loyalty.jbool(p, 'remember', false);
  token text; exp_at timestamptz; admin_phone text := coalesce(loyalty.cfg('admin_phone'), '');
begin
  select * into o from loyalty.otps where otps.phone = v_phone for update;
  if not found or o.expires < now() then return loyalty.err_obj('Kode kedaluwarsa. Minta kode baru.'); end if;
  if o.attempts >= 5 then
    delete from loyalty.otps where otps.phone = v_phone;
    return loyalty.err_obj('Terlalu banyak percobaan. Minta kode baru.');
  end if;
  if length(code) <> 6 or o.code_hash <> loyalty.otp_hash(v_phone, code) then
    update loyalty.otps set attempts = attempts + 1 where otps.phone = v_phone;   -- tetap tersimpan (tidak raise)
    return loyalty.err_obj('Kode salah. Sisa percobaan: ' || (5 - (o.attempts + 1)));
  end if;
  delete from loyalty.otps where otps.phone = v_phone;

  select * into u from loyalty.users where users.phone = v_phone;
  if not found then
    insert into loyalty.users (user_id, phone, name, role, member_code)
    values (loyalty.new_id('U'), v_phone, coalesce(nullif(o.name, ''), 'Pelanggan'),
            case when v_phone = admin_phone and admin_phone <> '' then 'admin' else 'customer' end,
            loyalty.unique_member_code())
    on conflict (phone) do nothing;
    select * into u from loyalty.users where users.phone = v_phone;
  end if;
  if not u.active then perform loyalty.err('Akun ini dinonaktifkan.'); end if;
  update loyalty.users set last_login = now(),
         role = case when v_phone = admin_phone and admin_phone <> '' then 'admin' else role end
   where user_id = u.user_id returning * into u;

  token := encode(extensions.gen_random_bytes(32), 'hex');
  exp_at := now() + case when remember then make_interval(days => loyalty.setn('session_days_remember'))
                         else make_interval(hours => loyalty.setn('session_hours_default')) end;
  insert into loyalty.sessions (token_hash, user_id, expires, remember, device)
  values (loyalty.sha(token), u.user_id, exp_at, remember, loyalty.clean(p ->> 'device', 80));
  if random() < 0.02 then perform loyalty.cleanup(); end if;
  return jsonb_build_object('token', token, 'expires', floor(extract(epoch from exp_at) * 1000)::bigint, 'user', loyalty.pub_user(u));
end $$;

-- ---------- pelanggan ----------
create or replace function loyalty.event_pub(e loyalty.events) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'subtitle', e.subtitle, 'badge', e.badge, 'image', e.image_url,
    'link', e.link, 'start', loyalty.local_iso(e.start_at), 'end', loyalty.local_iso(e.end_at), 'active', e.active, 'sort', e.sort)
$$;

create or replace function loyalty.active_events() returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(loyalty.event_pub(e) order by e.sort, e.created_at), '[]'::jsonb)
  from loyalty.events e
  where e.active and (e.start_at is null or e.start_at <= loyalty.now_min()) and (e.end_at is null or e.end_at >= loyalty.now_min())
$$;

create or replace function loyalty.r_bootstrap(u loyalty.users) returns jsonb
language sql stable as $$
  select jsonb_build_object('user', loyalty.pub_user(u), 'view', loyalty.cust_view(u.user_id),
    'settings', loyalty.pub_settings(), 'events', loyalty.active_events(), 'version', loyalty.ver(u.user_id))
$$;

create or replace function loyalty.r_poll(p jsonb, u loyalty.users) returns jsonb
language plpgsql stable as $$
declare v text := loyalty.ver(u.user_id);
begin
  if coalesce(p ->> 'v', '') = v then return jsonb_build_object('changed', false, 'v', v); end if;
  return jsonb_build_object('changed', true, 'v', v, 'view', loyalty.cust_view(u.user_id));
end $$;

create or replace function loyalty.r_my_qr(u loyalty.users) returns jsonb
language plpgsql stable as $$
declare ts text := floor(extract(epoch from now()))::bigint::text;
begin
  return jsonb_build_object('payload', 'LS1.' || u.member_code || '.' || ts || '.' || loyalty.qr_sig(u.member_code, ts),
    'ttl', 120, 'code', u.member_code);
end $$;

create or replace function loyalty.r_my_history(u loyalty.users) returns jsonb
language sql stable as $$
  with items as (
    select s.type as kind, s.qty, s.note, s.ts, s.campaign_id from loyalty.stamps s where s.user_id = u.user_id
    union all
    select 'redeem', r.stamps_used, r.reward_name, r.ts, r.campaign_id from loyalty.redemptions r where r.user_id = u.user_id
  ), top as (select * from items order by ts desc limit 40)
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
    'kind', t.kind, 'qty', t.qty, 'note', t.note, 'ts', loyalty.local_str(t.ts),
    'campaign', coalesce((select c.name from loyalty.campaigns c where c.id = t.campaign_id), '')) order by t.ts desc), '[]'::jsonb))
  from top t
$$;

create or replace function loyalty.r_profile_update(p jsonb, u loyalty.users) returns jsonb
language plpgsql as $$
declare n text; e text;
begin
  if p ? 'name' then
    n := loyalty.clean(p ->> 'name', 60);
    if n = '' then perform loyalty.err('Nama tidak boleh kosong'); end if;
    update loyalty.users set name = n where user_id = u.user_id;
  end if;
  if p ? 'email' then
    e := lower(btrim(coalesce(p ->> 'email', '')));
    if e <> '' and (e !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(e) > 120) then perform loyalty.err('Format email tidak valid'); end if;
    update loyalty.users set email = e where user_id = u.user_id;
  end if;
  select * into u from loyalty.users where user_id = u.user_id;
  return jsonb_build_object('user', loyalty.pub_user(u));
end $$;

-- ---------- staff ----------
create or replace function loyalty.r_staff_activity(u loyalty.users) returns jsonb
language sql stable as $$
  with items as (
    select s.type as kind, s.customer_name as name, s.qty, s.by_name, s.note, s.ts, s.campaign_id
      from loyalty.stamps s where u.role = 'admin' or s.by_user = u.user_id
    union all
    select 'redeem', r.customer_name, r.stamps_used, r.by_name, r.reward_name, r.ts, r.campaign_id
      from loyalty.redemptions r where u.role = 'admin' or r.by_user = u.user_id
  ), top as (select * from items order by ts desc limit 25)
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
    'kind', t.kind, 'name', t.name, 'qty', t.qty, 'by', t.by_name, 'note', t.note, 'ts', loyalty.local_str(t.ts),
    'campaign', coalesce((select c.name from loyalty.campaigns c where c.id = t.campaign_id), '')) order by t.ts desc), '[]'::jsonb))
  from top t
$$;

-- ---------- admin: event hero ----------
create or replace function loyalty.r_events_list() returns jsonb
language sql stable as $$
  select jsonb_build_object('events', coalesce(jsonb_agg(loyalty.event_pub(e) order by e.sort, e.created_at), '[]'::jsonb))
  from loyalty.events e
$$;

create or replace function loyalty.r_event_save(p jsonb) returns jsonb
language plpgsql as $$
declare v_title text := loyalty.clean(p ->> 'title', 80); st timestamp := loyalty.dt(p ->> 'start'); en timestamp := loyalty.dt(p ->> 'end');
  v_badge text := coalesce(nullif(loyalty.clean(p ->> 'badge', 30), ''), 'Sedang Berlangsung');
  img text := loyalty.norm_url(p ->> 'image', true); lnk text := loyalty.norm_url(p ->> 'link', false);
  act boolean := loyalty.jbool(p, 'active', true); srt int := round(coalesce(loyalty.jnum(p, 'sort'), 0));
  sub text := loyalty.clean(p ->> 'subtitle', 140);
begin
  if v_title = '' then perform loyalty.err('Judul event wajib diisi'); end if;
  if st is not null and en is not null and en < st then perform loyalty.err('Waktu selesai harus setelah waktu mulai'); end if;
  if coalesce(p ->> 'id', '') <> '' then
    update loyalty.events set title = v_title, subtitle = sub, badge = v_badge, image_url = img, link = lnk,
      start_at = st, end_at = en, active = act, sort = srt where id = p ->> 'id';
    if not found then perform loyalty.err('Event tidak ditemukan'); end if;
  else
    insert into loyalty.events (id, title, subtitle, badge, image_url, link, start_at, end_at, active, sort)
    values (loyalty.new_id('E'), v_title, sub, v_badge, img, lnk, st, en, act, srt);
  end if;
  return loyalty.r_events_list();
end $$;

create or replace function loyalty.r_event_delete(p jsonb) returns jsonb
language plpgsql as $$
begin
  delete from loyalty.events where id = p ->> 'id';
  return loyalty.r_events_list();
end $$;

-- ---------- admin: event stamp & reward ----------
create or replace function loyalty.campaign_pub(c loyalty.campaigns) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'description', c.description, 'icon', c.icon,
    'start', loyalty.local_iso(c.start_at), 'end', loyalty.local_iso(c.end_at), 'redeemUntil', loyalty.local_iso(c.redeem_until),
    'active', c.active, 'sort', c.sort)
$$;

create or replace function loyalty.r_campaigns_list() returns jsonb
language sql stable as $$
  select jsonb_build_object('campaigns', coalesce(jsonb_agg(loyalty.campaign_pub(c) order by c.sort, c.created_at), '[]'::jsonb))
  from loyalty.campaigns c
$$;

create or replace function loyalty.r_campaign_save(p jsonb) returns jsonb
language plpgsql as $$
declare nm text := loyalty.clean(p ->> 'name', 60); st timestamp := loyalty.dt(p ->> 'start'); en timestamp := loyalty.dt(p ->> 'end');
  un timestamp := loyalty.dt(p ->> 'redeemUntil'); act boolean := loyalty.jbool(p, 'active', true);
  srt int := round(coalesce(loyalty.jnum(p, 'sort'), 0)); ic text := coalesce(nullif(loyalty.clean(p ->> 'icon', 4), ''), '☕');
  ds text := loyalty.clean(p ->> 'description', 140);
begin
  if nm = '' then perform loyalty.err('Nama event stamp wajib diisi'); end if;
  if st is not null and en is not null and en < st then perform loyalty.err('Waktu selesai harus setelah waktu mulai'); end if;
  if un is not null and en is not null and un < en then perform loyalty.err('Batas penukaran reward tidak boleh sebelum event selesai'); end if;
  if un is not null and en is null then perform loyalty.err('Batas penukaran hanya dipakai jika event punya waktu selesai'); end if;
  if coalesce(p ->> 'id', '') <> '' then
    update loyalty.campaigns set name = nm, description = ds, icon = ic, start_at = st, end_at = en, redeem_until = un,
      active = act, sort = srt where id = p ->> 'id';
    if not found then perform loyalty.err('Event stamp tidak ditemukan'); end if;
  else
    insert into loyalty.campaigns (id, name, description, icon, start_at, end_at, redeem_until, active, sort)
    values (loyalty.new_id('P'), nm, ds, ic, st, en, un, act, srt);
  end if;
  return loyalty.r_campaigns_list();
end $$;

create or replace function loyalty.r_campaign_delete(p jsonb) returns jsonb
language plpgsql as $$
begin
  if p ->> 'id' = 'default' then perform loyalty.err('Event bawaan tidak bisa dihapus. Nonaktifkan saja.'); end if;
  if exists (select 1 from loyalty.cards where campaign_id = p ->> 'id') then
    perform loyalty.err('Event ini sudah punya kartu pelanggan. Nonaktifkan saja agar riwayat aman.');
  end if;
  delete from loyalty.campaigns where id = p ->> 'id';   -- reward ikut terhapus (cascade)
  return loyalty.r_campaigns_list();
end $$;

create or replace function loyalty.reward_pub(r loyalty.rewards) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description, 'required', r.stamps_required,
    'active', r.active, 'sort', r.sort, 'campaignId', r.campaign_id)
$$;

create or replace function loyalty.r_rewards_list() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'rewards', (select coalesce(jsonb_agg(loyalty.reward_pub(r) order by r.stamps_required, r.sort, r.id), '[]'::jsonb) from loyalty.rewards r),
    'campaigns', loyalty.r_campaigns_list() -> 'campaigns')
$$;

create or replace function loyalty.r_reward_save(p jsonb) returns jsonb
language plpgsql as $$
declare nm text := loyalty.clean(p ->> 'name', 80); req int := round(coalesce(loyalty.jnum(p, 'required'), 0));
  act boolean := loyalty.jbool(p, 'active', true); srt int := round(coalesce(loyalty.jnum(p, 'sort'), 0));
  ds text := loyalty.clean(p ->> 'description', 140);
begin
  if nm = '' then perform loyalty.err('Nama reward wajib diisi'); end if;
  if not (req >= 1 and req <= 100) then perform loyalty.err('Jumlah stamp milestone harus 1–100'); end if;
  if not exists (select 1 from loyalty.campaigns where id = p ->> 'campaignId') then perform loyalty.err('Pilih event stamp untuk reward ini'); end if;
  if coalesce(p ->> 'id', '') <> '' then
    update loyalty.rewards set name = nm, description = ds, stamps_required = req, campaign_id = p ->> 'campaignId',
      active = act, sort = srt where id = p ->> 'id';
    if not found then perform loyalty.err('Reward tidak ditemukan'); end if;
  else
    insert into loyalty.rewards (id, name, description, stamps_required, campaign_id, active, sort)
    values (loyalty.new_id('W'), nm, ds, req, p ->> 'campaignId', act, srt);
  end if;
  return loyalty.r_rewards_list();
end $$;

create or replace function loyalty.r_reward_delete(p jsonb) returns jsonb
language plpgsql as $$
begin
  delete from loyalty.rewards where id = p ->> 'id';
  return loyalty.r_rewards_list();
end $$;

-- ---------- admin: pengaturan, statistik, pengguna ----------
create or replace function loyalty.r_settings_get() returns jsonb
language sql stable as $$
  select jsonb_build_object('fields', coalesce(jsonb_agg(jsonb_build_object(
    'key', d.key, 'label', d.label, 'type', d.t,
    'value', case when d.t = 'n' then to_jsonb(loyalty.setn(d.key)) else to_jsonb(loyalty.sett(d.key)) end,
    'min', d.vmin, 'max', d.vmax) order by d.ord), '[]'::jsonb))
  from (select s.*, row_number() over () as ord from loyalty.setting_defs() s) d
$$;

create or replace function loyalty.r_settings_save(p jsonb) returns jsonb
language plpgsql as $$
declare vals jsonb := coalesce(p -> 'values', '{}'::jsonb); d record; v text; n numeric;
begin
  for d in select * from loyalty.setting_defs() loop
    continue when not (vals ? d.key);
    v := vals ->> d.key;
    if d.t = 'n' then
      n := loyalty.jnum(vals, d.key);
      if n is null or round(n) < d.vmin or round(n) > d.vmax then
        perform loyalty.err(d.label || ' harus antara ' || d.vmin || ' dan ' || d.vmax);
      end if;
      v := round(n)::int::text;
    elsif d.t = 'c' then
      if coalesce(v, '') !~ '^#[0-9a-fA-F]{6}$' then perform loyalty.err('Format warna tidak valid'); end if;
    else
      v := loyalty.clean(v, d.vmax);
      if v = '' and d.key <> 'reward_terms' then perform loyalty.err(d.label || ' tidak boleh kosong'); end if;
    end if;
    insert into loyalty.settings (key, value) values (d.key, v)
    on conflict (key) do update set value = excluded.value;
  end loop;
  return loyalty.r_settings_get();
end $$;

create or replace function loyalty.r_stats() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'customers', (select count(*) from loyalty.users where role = 'customer'),
    'staff', (select count(*) from loyalty.users where role <> 'customer'),
    'stampsToday', coalesce((select sum(qty) from loyalty.stamps
        where type = 'earn' and (ts at time zone loyalty.tz())::date = loyalty.now_min()::date), 0),
    'redeemToday', (select count(*) from loyalty.redemptions where (ts at time zone loyalty.tz())::date = loyalty.now_min()::date),
    'redeemMonth', (select count(*) from loyalty.redemptions
        where date_trunc('month', ts at time zone loyalty.tz()) = date_trunc('month', loyalty.now_min())))
$$;

create or replace function loyalty.r_user_search(p jsonb) returns jsonb
language plpgsql stable as $$
declare q text := lower(btrim(coalesce(p ->> 'q', ''))); digits text; out jsonb;
begin
  digits := regexp_replace(q, '\D', '', 'g');
  if left(digits, 1) = '0' then digits := '62' || substr(digits, 2); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.user_id, 'name', x.name, 'phone', x.phone, 'role', x.role,
           'active', x.active, 'stamps', x.total_earned, 'memberCode', x.member_code)), '[]'::jsonb) into out
  from (select * from loyalty.users u
         where case when q = '' then u.role <> 'customer'
                    else lower(u.name) like '%' || replace(replace(q, '%', ''), '_', '') || '%'
                         or (digits <> '' and u.phone like '%' || digits || '%')
                         or lower(u.member_code) like '%' || replace(replace(q, '%', ''), '_', '') || '%' end
         order by u.created_at limit 20) x;
  return jsonb_build_object('users', out);
end $$;

create or replace function loyalty.r_user_update(p jsonb, admin loyalty.users) returns jsonb
language plpgsql as $$
declare u loyalty.users;
begin
  select * into u from loyalty.users where user_id = p ->> 'userId';
  if not found then perform loyalty.err('Pengguna tidak ditemukan'); end if;
  if u.user_id = admin.user_id then perform loyalty.err('Anda tidak bisa mengubah akun sendiri'); end if;
  if p ? 'role' then
    if (p ->> 'role') not in ('customer', 'cashier', 'admin') then perform loyalty.err('Peran tidak valid'); end if;
    update loyalty.users set role = p ->> 'role' where user_id = u.user_id;
  end if;
  if p ? 'active' then
    update loyalty.users set active = loyalty.jbool(p, 'active', true) where user_id = u.user_id;
    if not loyalty.jbool(p, 'active', true) then delete from loyalty.sessions where user_id = u.user_id; end if;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================
--  PINTU API
-- ============================================================
create or replace function loyalty.dispatch(p_action text, p_token text, p jsonb, p_meta jsonb) returns jsonb
language plpgsql as $$
declare
  u loyalty.users;
  anyone  text[] := array['bootstrap','poll','my_qr','my_history','profile_update','logout','logout_all'];
  staff   text[] := array['cust_lookup','stamp_add','reward_redeem','stamp_batch','redeem_batch','staff_activity'];
  admins  text[] := array['campaigns_list','campaign_save','campaign_delete','rewards_list','reward_save','reward_delete',
                          'stamp_adjust','events_list','event_save','event_delete','settings_get','settings_save','stats',
                          'user_search','user_update'];
begin
  -- rute publik
  if p_action = 'public_info' then return loyalty.r_public_info(p_meta); end if;
  if p_action = 'otp_request' then return loyalty.r_otp_request(p, p_meta); end if;
  if p_action = 'otp_verify'  then return loyalty.r_otp_verify(p); end if;

  if not (p_action = any (anyone || staff || admins)) then perform loyalty.err('Aksi tidak dikenal'); end if;
  u := loyalty.auth(p_token);
  if p_action = any (admins) and u.role <> 'admin' then perform loyalty.err('Anda tidak punya akses', 'FORBIDDEN'); end if;
  if p_action = any (staff) and u.role not in ('cashier', 'admin') then perform loyalty.err('Anda tidak punya akses', 'FORBIDDEN'); end if;

  if p_action = 'logout' then
    delete from loyalty.sessions where token_hash = loyalty.sha(p_token);
    return '{}'::jsonb;
  elsif p_action = 'logout_all' then
    delete from loyalty.sessions where user_id = u.user_id;
    return '{}'::jsonb;
  end if;

  return case p_action
    when 'bootstrap'        then loyalty.r_bootstrap(u)
    when 'poll'             then loyalty.r_poll(p, u)
    when 'my_qr'            then loyalty.r_my_qr(u)
    when 'my_history'       then loyalty.r_my_history(u)
    when 'profile_update'   then loyalty.r_profile_update(p, u)
    when 'cust_lookup'      then jsonb_build_object('customer', loyalty.cust_view((loyalty.resolve_customer(p ->> 'query')).user_id))
    when 'stamp_add'        then loyalty.stamp_core(p, u, loyalty.jbool(p, 'force', false))
    when 'reward_redeem'    then loyalty.redeem_core(p, u)
    when 'stamp_batch'      then loyalty.r_stamp_batch(p, u)
    when 'redeem_batch'     then loyalty.r_redeem_batch(p, u)
    when 'staff_activity'   then loyalty.r_staff_activity(u)
    when 'stamp_adjust'     then loyalty.r_stamp_adjust(p, u)
    when 'campaigns_list'   then loyalty.r_campaigns_list()
    when 'campaign_save'    then loyalty.r_campaign_save(p)
    when 'campaign_delete'  then loyalty.r_campaign_delete(p)
    when 'rewards_list'     then loyalty.r_rewards_list()
    when 'reward_save'      then loyalty.r_reward_save(p)
    when 'reward_delete'    then loyalty.r_reward_delete(p)
    when 'events_list'      then loyalty.r_events_list()
    when 'event_save'       then loyalty.r_event_save(p)
    when 'event_delete'     then loyalty.r_event_delete(p)
    when 'settings_get'     then loyalty.r_settings_get()
    when 'settings_save'    then loyalty.r_settings_save(p)
    when 'stats'            then loyalty.r_stats()
    when 'user_search'      then loyalty.r_user_search(p)
    when 'user_update'      then loyalty.r_user_update(p, u)
  end;
end $$;

-- Satu-satunya fungsi yang dipanggil Edge Function (service_role).
create or replace function public.ls_api(p_action text, p_token text default null, p_payload jsonb default '{}', p_meta jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = loyalty, extensions, pg_temp as $$
declare r jsonb; code text;
begin
  r := loyalty.dispatch(coalesce(p_action, ''), p_token, coalesce(p_payload, '{}'::jsonb), coalesce(p_meta, '{}'::jsonb));
  if r ? '__error' then
    return jsonb_build_object('ok', false, 'error', r ->> '__error', 'code', coalesce(r ->> '__code', 'APP'));
  end if;
  return jsonb_build_object('ok', true, 'data', coalesce(r, '{}'::jsonb));
exception
  when sqlstate 'LS001' then
    get stacked diagnostics code = pg_exception_detail;
    return jsonb_build_object('ok', false, 'error', sqlerrm, 'code', coalesce(code, 'APP'));
  when others then
    raise warning 'ls_api % gagal: % (%)', p_action, sqlerrm, sqlstate;
    return jsonb_build_object('ok', false, 'error', 'Terjadi kesalahan di server. Coba lagi.', 'code', 'ERR');
end $$;

revoke all on function public.ls_api(text, text, jsonb, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.ls_api(text, text, jsonb, jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ls_api(text, text, jsonb, jsonb) to service_role;
  end if;
end $$;

-- ============================================================
--  DATA AWAL
-- ============================================================
insert into loyalty.campaigns (id, name, description, icon, sort)
values ('default', 'Kartu Reguler', 'Berlaku sepanjang waktu', '☕', 0)
on conflict (id) do nothing;

insert into loyalty.rewards (id, name, description, stamps_required, campaign_id, sort)
select * from (values
  ('Wawal1', 'Gratis 1 cookies', 'Pilih cookies favorit', 5, 'default', 1),
  ('Wawal2', 'Gratis 1 minuman', 'Semua menu minuman', 10, 'default', 2)
) v(id, name, description, stamps_required, campaign_id, sort)
where not exists (select 1 from loyalty.rewards);
