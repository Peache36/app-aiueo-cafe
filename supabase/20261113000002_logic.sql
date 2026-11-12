-- ============================================================
--  Bagian 2: kartu, event stamp, reward, stamp & tukar
-- ============================================================

-- ---------- status waktu event ----------
create or replace function loyalty.camp_running(c loyalty.campaigns) returns boolean
language sql stable as $$
  select c.active
     and (c.start_at is null or c.start_at <= loyalty.now_min())
     and not (c.end_at is not null and c.end_at < loyalty.now_min())
$$;

create or replace function loyalty.camp_until(c loyalty.campaigns) returns timestamp
language sql immutable as $$ select coalesce(c.redeem_until, c.end_at) $$;

create or replace function loyalty.camp_redeemable(c loyalty.campaigns) returns boolean
language sql stable as $$
  select c.active
     and (c.start_at is null or c.start_at <= loyalty.now_min())
     and (loyalty.camp_until(c) is null or loyalty.camp_until(c) >= loyalty.now_min())
$$;

-- daftar reward aktif sebuah event, urut stamp terkecil dulu
create or replace function loyalty.rewards_json(p_campaign text) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'name', r.name, 'description', r.description, 'required', r.stamps_required)
         order by r.stamps_required, r.sort, r.id), '[]'::jsonb)
  from loyalty.rewards r where r.campaign_id = p_campaign and r.active
$$;

create or replace function loyalty.card_view(p_id text, p_stamps int, p_claimed text[], p_number int, p_rs jsonb, p_max int)
returns jsonb language plpgsql stable as $$
declare ms jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r ->> 'id', 'name', r ->> 'name', 'description', r ->> 'description',
      'required', (r ->> 'required')::int,
      'status', case when (r ->> 'id') = any (p_claimed) then 'claimed'
                     when p_stamps >= (r ->> 'required')::int then 'available' else 'locked' end,
      'remaining', greatest(0, (r ->> 'required')::int - p_stamps)) order by ord), '[]'::jsonb)
    into ms
  from jsonb_array_elements(p_rs) with ordinality as t(r, ord);

  return jsonb_build_object(
    'id', coalesce(p_id, ''), 'number', p_number, 'stamps', p_stamps, 'maxRequired', p_max,
    'filled', least(p_stamps, p_max),
    'state', case when p_max > 0 and p_stamps >= p_max then 'full' else 'open' end,
    'milestones', ms,
    'availableCount', (select count(*) from jsonb_array_elements(ms) m where m ->> 'status' = 'available'),
    'next', (select m from jsonb_array_elements(ms) m where m ->> 'status' = 'locked' limit 1));
end $$;

create or replace function loyalty.pub_user(u loyalty.users) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', u.user_id, 'phone', u.phone, 'name', u.name, 'email', u.email, 'role', u.role,
    'memberCode', u.member_code, 'stamps', 0, 'totalEarned', u.total_earned, 'totalRedeemed', u.total_redeemed)
$$;

-- seluruh kartu pelanggan, dikelompokkan per event stamp
create or replace function loyalty.cust_view(p_uid text) returns jsonb
language plpgsql stable as $$
declare
  u loyalty.users; c loyalty.campaigns; k record;
  lim int := loyalty.setn('max_open_cards');
  rs jsonb; max_req int; running boolean; redeemable boolean;
  views jsonb; v jsonb; i int; has_open boolean; limit_reached boolean;
  out jsonb := '[]'::jsonb;
begin
  select * into u from loyalty.users where user_id = p_uid;
  for c in select * from loyalty.campaigns where active order by sort, created_at, id loop
    rs := loyalty.rewards_json(c.id);
    max_req := coalesce((rs -> -1 ->> 'required')::int, 0);
    running := loyalty.camp_running(c);
    redeemable := loyalty.camp_redeemable(c);
    views := '[]'::jsonb; i := 0;
    if running or redeemable then
      for k in select * from loyalty.cards
               where user_id = p_uid and campaign_id = c.id and status = 'active'
               order by created_at, card_id loop
        i := i + 1;
        v := loyalty.card_view(k.card_id, k.stamps, k.claimed_ids, i, rs, max_req);
        if running or (v ->> 'availableCount')::int > 0 then   -- event lewat: hanya kartu yang bisa ditukar
          views := views || jsonb_build_array(v);
        end if;
      end loop;
    end if;
    has_open := jsonb_path_exists(views, '$[*] ? (@.state == "open")');
    limit_reached := running and max_req > 0 and not has_open and jsonb_array_length(views) >= lim;
    if running and max_req > 0 and not has_open and not limit_reached then
      views := views || jsonb_build_array(loyalty.card_view('', 0, '{}', jsonb_array_length(views) + 1, rs, max_req));
    end if;
    if not running and jsonb_array_length(views) = 0 then continue; end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', c.id, 'name', c.name, 'description', c.description, 'icon', c.icon,
      'start', loyalty.local_iso(c.start_at), 'end', loyalty.local_iso(c.end_at),
      'redeemUntil', loyalty.local_iso(loyalty.camp_until(c)),
      'running', running, 'redeemable', redeemable, 'canStamp', running and max_req > 0,
      'limitReached', limit_reached, 'maxCards', lim, 'maxRequired', max_req, 'cards', views));
  end loop;
  return jsonb_build_object('id', u.user_id, 'name', u.name, 'phone', u.phone, 'memberCode', u.member_code,
    'totalEarned', u.total_earned, 'totalRedeemed', u.total_redeemed, 'campaigns', out);
end $$;

-- ============================================================
--  STAMP, TUKAR, KOREKSI
-- ============================================================
create or replace function loyalty.stamp_core(p jsonb, staff loyalty.users, p_force boolean)
returns jsonb language plpgsql as $$
declare
  qty int; maxq int := loyalty.setn('max_qty_per_add');
  u loyalty.users; camp loyalty.campaigns; rs jsonb; max_req int;
  cd int := loyalty.setn('cooldown_minutes'); lim int := loyalty.setn('max_open_cards');
  cd_at timestamptz; mins int;
  cur_id text; cur_stamps int; open_cnt int; created int := 0; remaining int; put int;
  note text := loyalty.clean(p ->> 'note', 80);
begin
  qty := round(coalesce(loyalty.jnum(p, 'qty'), 0));
  if not (qty >= 1 and qty <= maxq) then perform loyalty.err('Jumlah stamp harus 1–' || maxq); end if;

  perform pg_advisory_xact_lock(hashtext('ls_u_' || coalesce(p ->> 'userId', '')));
  select * into u from loyalty.users where user_id = p ->> 'userId';
  if not found or not u.active then perform loyalty.err('Pelanggan tidak ditemukan'); end if;
  select * into camp from loyalty.campaigns where id = p ->> 'campaignId';
  if not found or not camp.active then perform loyalty.err('Event stamp tidak ditemukan'); end if;
  if not loyalty.camp_running(camp) then perform loyalty.err('Event "' || camp.name || '" sedang tidak berlangsung'); end if;
  rs := loyalty.rewards_json(camp.id);
  if jsonb_array_length(rs) = 0 then perform loyalty.err('Event ini belum punya reward. Atur dulu di menu Admin.'); end if;
  max_req := (rs -> -1 ->> 'required')::int;

  if cd > 0 and not (p_force and staff.role = 'admin') then
    select at into cd_at from loyalty.cooldowns where user_id = u.user_id and campaign_id = camp.id;
    if found and cd_at + make_interval(mins => cd) > now() then
      mins := greatest(1, ceil(extract(epoch from (cd_at + make_interval(mins => cd) - now())) / 60)::int);
      perform loyalty.err('Pelanggan ini baru dapat stamp di event ini. Tunggu ±' || mins || ' menit lagi.', 'COOLDOWN');
    end if;
  end if;

  select count(*) into open_cnt from loyalty.cards
   where user_id = u.user_id and campaign_id = camp.id and status = 'active';
  select card_id, stamps into cur_id, cur_stamps from loyalty.cards
   where user_id = u.user_id and campaign_id = camp.id and status = 'active' and stamps < max_req
   order by created_at, card_id limit 1 for update;

  remaining := qty;
  while remaining > 0 loop
    if cur_id is null then
      if open_cnt + created >= lim then
        perform loyalty.err('Pelanggan sudah punya ' || lim || ' kartu yang belum selesai di event ini. Tukar reward dulu.', 'CARD_LIMIT');
      end if;
      created := created + 1;
      cur_id := loyalty.new_id('C'); cur_stamps := 0;
      insert into loyalty.cards (card_id, user_id, campaign_id, stamps) values (cur_id, u.user_id, camp.id, 0);
    end if;
    put := least(max_req - cur_stamps, remaining);
    update loyalty.cards set stamps = stamps + put where card_id = cur_id;
    insert into loyalty.stamps (id, user_id, customer_name, qty, type, by_user, by_name, note, campaign_id, card_id)
    values (loyalty.new_id('S'), u.user_id, u.name, put, 'earn', staff.user_id, staff.name, note, camp.id, cur_id);
    remaining := remaining - put;
    cur_stamps := cur_stamps + put;
    if cur_stamps >= max_req then cur_id := null; end if;
  end loop;

  update loyalty.users set total_earned = total_earned + qty, last_stamp_at = now() where user_id = u.user_id;
  if cd > 0 then
    insert into loyalty.cooldowns (user_id, campaign_id, at) values (u.user_id, camp.id, now())
    on conflict (user_id, campaign_id) do update set at = excluded.at;
  end if;
  perform loyalty.touch(u.user_id);
  return jsonb_build_object('customer', loyalty.cust_view(u.user_id), 'newCards', created);
end $$;

-- klaim satu reward pada satu kartu (stamp tidak dikurangi; kartu selesai bila semua reward diklaim)
create or replace function loyalty.redeem_core(p jsonb, staff loyalty.users)
returns jsonb language plpgsql as $$
declare
  u loyalty.users; card loyalty.cards; camp loyalty.campaigns; r jsonb; rs jsonb;
  claimed text[]; done boolean;
begin
  perform pg_advisory_xact_lock(hashtext('ls_u_' || coalesce(p ->> 'userId', '')));
  select * into u from loyalty.users where user_id = p ->> 'userId';
  if not found then perform loyalty.err('Pelanggan tidak ditemukan'); end if;
  select * into card from loyalty.cards where card_id = p ->> 'cardId' for update;
  if not found or card.user_id <> u.user_id or card.status <> 'active' then perform loyalty.err('Kartu tidak ditemukan'); end if;
  select * into camp from loyalty.campaigns where id = card.campaign_id;
  if not found or not loyalty.camp_redeemable(camp) then perform loyalty.err('Masa penukaran kartu ini sudah berakhir'); end if;
  rs := loyalty.rewards_json(card.campaign_id);
  select x into r from jsonb_array_elements(rs) x where x ->> 'id' = p ->> 'rewardId';
  if r is null then perform loyalty.err('Reward tidak ditemukan atau sudah dinonaktifkan'); end if;
  claimed := card.claimed_ids;
  if (r ->> 'id') = any (claimed) then perform loyalty.err('Reward ini sudah diklaim di kartu tersebut'); end if;
  if card.stamps < (r ->> 'required')::int then
    perform loyalty.err('Stamp belum cukup (' || card.stamps || '/' || (r ->> 'required') || ')');
  end if;
  claimed := claimed || (r ->> 'id');
  select bool_and((x ->> 'id') = any (claimed)) into done from jsonb_array_elements(rs) x;
  update loyalty.cards set claimed_ids = claimed,
         status = case when done then 'done' else 'active' end,
         completed_at = case when done then now() else null end
   where card_id = card.card_id;
  update loyalty.users set total_redeemed = total_redeemed + 1 where user_id = u.user_id;
  insert into loyalty.redemptions (id, user_id, customer_name, reward_name, stamps_used, by_user, by_name, reward_id, campaign_id, card_id)
  values (loyalty.new_id('R'), u.user_id, u.name, r ->> 'name', (r ->> 'required')::int, staff.user_id, staff.name,
          r ->> 'id', card.campaign_id, card.card_id);
  perform loyalty.touch(u.user_id);
  return jsonb_build_object('customer', loyalty.cust_view(u.user_id), 'cardDone', done);
end $$;

-- ---------- mode grup: tiap orang diproses sendiri, kegagalan satu orang tidak membatalkan yang lain ----------
create or replace function loyalty.batch_items(p jsonb) returns jsonb
language plpgsql as $$
declare items jsonb := p -> 'items';
begin
  if items is null or jsonb_typeof(items) <> 'array' or jsonb_array_length(items) = 0 then
    perform loyalty.err('Belum ada pelanggan di grup');
  end if;
  if jsonb_array_length(items) > 20 then perform loyalty.err('Maksimal 20 pelanggan sekali proses'); end if;
  return items;
end $$;

create or replace function loyalty.r_stamp_batch(p jsonb, staff loyalty.users) returns jsonb
language plpgsql as $$
declare items jsonb := loyalty.batch_items(p); it jsonb; r jsonb; res jsonb := '[]'::jsonb; code text;
begin
  for it in select value from jsonb_array_elements(items) loop
    begin
      r := loyalty.stamp_core(jsonb_build_object('userId', it ->> 'userId', 'campaignId', p ->> 'campaignId',
             'qty', it -> 'qty', 'note', p ->> 'note'), staff, loyalty.jbool(p, 'force', false));
      res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', true) || r);
    exception
      when sqlstate 'LS001' then
        get stacked diagnostics code = pg_exception_detail;
        res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', false, 'error', sqlerrm, 'code', coalesce(code, 'APP')));
      when others then
        raise warning 'stamp_batch item failed: % (%)', sqlerrm, sqlstate;
        res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', false, 'error', 'Gagal diproses', 'code', 'ERR'));
    end;
  end loop;
  return jsonb_build_object('results', res);
end $$;

create or replace function loyalty.r_redeem_batch(p jsonb, staff loyalty.users) returns jsonb
language plpgsql as $$
declare items jsonb := loyalty.batch_items(p); it jsonb; r jsonb; res jsonb := '[]'::jsonb; code text;
begin
  for it in select value from jsonb_array_elements(items) loop
    begin
      r := loyalty.redeem_core(jsonb_build_object('userId', it ->> 'userId', 'cardId', it ->> 'cardId', 'rewardId', it ->> 'rewardId'), staff);
      res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', true) || r);
    exception
      when sqlstate 'LS001' then
        get stacked diagnostics code = pg_exception_detail;
        res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', false, 'error', sqlerrm, 'code', coalesce(code, 'APP')));
      when others then
        raise warning 'redeem_batch item failed: % (%)', sqlerrm, sqlstate;
        res := res || jsonb_build_array(jsonb_build_object('userId', it ->> 'userId', 'ok', false, 'error', 'Gagal diproses', 'code', 'ERR'));
    end;
  end loop;
  return jsonb_build_object('results', res);
end $$;

create or replace function loyalty.r_stamp_adjust(p jsonb, admin loyalty.users) returns jsonb
language plpgsql as $$
declare
  delta int := round(coalesce(loyalty.jnum(p, 'delta'), 0)); note text := loyalty.clean(p ->> 'note', 80);
  u loyalty.users; card loyalty.cards; rs jsonb; max_req int; nxt int;
begin
  if delta = 0 or abs(delta) > 100 then perform loyalty.err('Jumlah koreksi tidak valid'); end if;
  if note = '' then perform loyalty.err('Alasan koreksi wajib diisi'); end if;
  perform pg_advisory_xact_lock(hashtext('ls_u_' || coalesce(p ->> 'userId', '')));
  select * into u from loyalty.users where user_id = p ->> 'userId';
  if not found then perform loyalty.err('Pelanggan tidak ditemukan'); end if;
  select * into card from loyalty.cards where card_id = p ->> 'cardId' for update;
  if not found or card.user_id <> u.user_id or card.status <> 'active' then perform loyalty.err('Pilih kartu yang akan dikoreksi'); end if;
  rs := loyalty.rewards_json(card.campaign_id);
  max_req := coalesce((rs -> -1 ->> 'required')::int, 0);
  nxt := card.stamps + delta;
  if nxt < 0 or nxt > max_req then perform loyalty.err('Stamp kartu harus antara 0 dan ' || max_req); end if;
  update loyalty.cards set stamps = nxt where card_id = card.card_id;
  insert into loyalty.stamps (id, user_id, customer_name, qty, type, by_user, by_name, note, campaign_id, card_id)
  values (loyalty.new_id('S'), u.user_id, u.name, delta, 'adjust', admin.user_id, admin.name, note, card.campaign_id, card.card_id);
  perform loyalty.touch(u.user_id);
  return jsonb_build_object('customer', loyalty.cust_view(u.user_id));
end $$;

create or replace function loyalty.resolve_customer(p_q text) returns loyalty.users
language plpgsql as $$
declare q text := btrim(coalesce(p_q, '')); u loyalty.users; parts text[]; age numeric;
begin
  if q = '' then perform loyalty.err('Masukkan nomor HP atau kode member'); end if;
  if left(q, 4) = 'LS1.' then
    parts := string_to_array(q, '.');
    if array_length(parts, 1) <> 4 or parts[4] <> loyalty.qr_sig(parts[2], parts[3]) then perform loyalty.err('QR tidak valid'); end if;
    if parts[3] !~ '^[0-9]+$' then perform loyalty.err('QR tidak valid'); end if;
    age := extract(epoch from now()) - parts[3]::numeric;
    if age > 150 or age < -60 then perform loyalty.err('QR kedaluwarsa. Minta pelanggan menyegarkan QR-nya.'); end if;
    select * into u from loyalty.users where member_code = parts[2];
  elsif q ~* '^(LS-)?[A-Za-z0-9]{6}$' then
    select * into u from loyalty.users where member_code = 'LS-' || upper(regexp_replace(q, '^LS-', '', 'i'));
  else
    select * into u from loyalty.users where phone = loyalty.norm_phone(q);
  end if;
  if u.user_id is null then perform loyalty.err('Pelanggan tidak ditemukan'); end if;
  if not u.active then perform loyalty.err('Akun pelanggan dinonaktifkan'); end if;
  return u;
end $$;
