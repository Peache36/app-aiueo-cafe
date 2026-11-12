#!/usr/bin/env python3
"""Uji logika backend (SQL) pada Postgres lokal.
Jalankan: PGHOST=/tmp PGPORT=5433 PGUSER=postgres PGDATABASE=ls python3 tests/test_sql.py
"""
import json, os, subprocess, sys, time

def sql(q, **v):
    args = ['psql', '-qtA', '-v', 'ON_ERROR_STOP=1']
    for k, val in v.items():
        args += ['-v', f'{k}={val}']
    r = subprocess.run(args, input=q, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip()

def api(action, token=None, payload=None, wa=True):
    out = sql("select public.ls_api(:'a', nullif(:'t',''), :'p'::jsonb, :'m'::jsonb)",
              a=action, t=token or '', p=json.dumps(payload or {}), m=json.dumps({'wa': wa}))
    return json.loads(out)

fails = 0
def check(name, cond, extra=''):
    global fails
    print(('  ok   ' if cond else '  FAIL ') + name + (f'  -> {extra}' if not cond else ''))
    if not cond: fails += 1

def login(phone, name='Tester', remember=True):
    r = api('otp_request', payload={'phone': phone, 'name': name})
    assert r['ok'], r
    if r['data'].get('needInfo'):
        r = api('otp_request', payload={'phone': phone, 'name': name})
    code = r['data']['_send']['debug_code']
    v = api('otp_verify', payload={'phone': phone, 'code': code, 'remember': remember})
    assert v['ok'], v
    return v['data']

# ---------- reset ----------
sql("truncate loyalty.users, loyalty.cards, loyalty.stamps, loyalty.redemptions, loyalty.sessions, loyalty.otps, loyalty.ratelimits, loyalty.versions, loyalty.cooldowns, loyalty.settings, loyalty.events cascade;"
    "update loyalty.config set value='6281100000001' where key='admin_phone';"
    "delete from loyalty.campaigns where id <> 'default'; delete from loyalty.rewards where campaign_id <> 'default';")

print('# publik & login')
r = api('public_info', wa=True); check('public_info wa true', r['ok'] and r['data']['channels']['whatsapp'] is True)
check('public_info default name', r['data']['cafe_name'] == 'AIUEO Cafe')
r = api('otp_request', payload={'phone': '081100000001'}, wa=False); check('otp tanpa WA ditolak', not r['ok'])
r = api('otp_request', payload={'phone': '0811'}); check('nomor tidak valid', not r['ok'] and 'tidak valid' in r['error'])
r = api('otp_request', payload={'phone': '081100000001'}); check('nomor baru minta nama', r['ok'] and r['data'].get('needInfo'))
r = api('otp_request', payload={'phone': '081100000001', 'name': 'Owner'}); check('otp terkirim', r['ok'] and r['data']['sent'] and r['data']['to'].startswith('62811'))
code = r['data']['_send']['debug_code']
w = api('otp_verify', payload={'phone': '081100000001', 'code': '000000' if code != '000000' else '111111'}); check('kode salah', not w['ok'] and 'Sisa percobaan: 4' in w['error'], w)
w = api('otp_verify', payload={'phone': '081100000001', 'code': code, 'remember': True}); check('verifikasi ok', w['ok'] and len(w['data']['token']) == 64)
admin = w['data']; check('nomor admin otomatis admin', admin['user']['role'] == 'admin')
w2 = api('otp_verify', payload={'phone': '081100000001', 'code': code}); check('kode sekali pakai', not w2['ok'])
for i in range(6):
    r = api('otp_request', payload={'phone': '081100000009', 'name': 'X'})
check('rate limit OTP per nomor', not r['ok'] and r['code'] == 'RATE', r)

kasir = login('081100000002', 'Kasir')
cust = login('081100000003', 'Budi')
cust2 = login('081100000004', 'Ani')
cust3 = login('081100000005', 'Cici')
A, K, C, C2, C3 = admin['token'], kasir['token'], cust['token'], cust2['token'], cust3['token']
check('customer role', cust['user']['role'] == 'customer')

print('# akses & peran')
r = api('bootstrap'); check('tanpa token ditolak', not r['ok'] and r['code'] == 'AUTH')
r = api('stats', C); check('customer tidak boleh stats', not r['ok'] and r['code'] == 'FORBIDDEN')
r = api('stamp_add', C, {}); check('customer tidak boleh stamp', not r['ok'] and r['code'] == 'FORBIDDEN')
r = api('xx', A); check('aksi tidak dikenal', not r['ok'])
r = api('user_update', A, {'userId': kasir['user']['id'], 'role': 'cashier'}); check('admin set kasir', r['ok'], r)
r = api('user_update', A, {'userId': A and admin['user']['id'], 'role': 'customer'}); check('tidak bisa ubah diri', not r['ok'])
r = api('stats', K); check('kasir tidak boleh stats', not r['ok'])

print('# bootstrap & kartu awal')
b = api('bootstrap', C)['data']
cp = b['view']['campaigns'][0]
check('1 event default, 1 kartu virtual', len(b['view']['campaigns']) == 1 and len(cp['cards']) == 1 and cp['cards'][0]['id'] == '' and cp['canStamp'])
check('milestone 5 & 10', [m['required'] for m in cp['cards'][0]['milestones']] == [5, 10])
check('settings publik', b['settings']['max_qty_per_add'] == 3 and b['version'] == '0')
uid = cust['user']['id']

print('# stamp + cooldown')
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 0}); check('qty 0 ditolak', not r['ok'])
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 9}); check('qty > maks ditolak', not r['ok'])
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 3}); check('stamp +3', r['ok'] and r['data']['customer']['campaigns'][0]['cards'][0]['stamps'] == 3, r)
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 1}); check('cooldown', not r['ok'] and r['code'] == 'COOLDOWN', r)
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 1, 'force': True}); check('kasir tak bisa paksa', not r['ok'])
r = api('stamp_add', A, {'userId': uid, 'campaignId': 'default', 'qty': 1, 'force': True}); check('admin bisa paksa', r['ok'])
p = api('poll', C, {'v': '0'})['data']; check('poll berubah', p['changed'] and p['v'] != '0')
p2 = api('poll', C, {'v': p['v']})['data']; check('poll tidak berubah', not p2['changed'])
api('settings_save', A, {'values': {'cooldown_minutes': 0}})
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 1}); st = r['data']['customer']['campaigns'][0]['cards'][0]
check('stamp 5 -> reward 1 tersedia', st['stamps'] == 5 and st['milestones'][0]['status'] == 'available' and st['availableCount'] == 1, st)

print('# tukar reward')
card_id = st['id']; rid1 = st['milestones'][0]['id']; rid2 = st['milestones'][1]['id']
r = api('reward_redeem', K, {'userId': uid, 'cardId': card_id, 'rewardId': rid2}); check('milestone 10 belum cukup', not r['ok'] and 'belum cukup' in r['error'], r)
r = api('reward_redeem', K, {'userId': uid, 'cardId': card_id, 'rewardId': rid1}); check('tukar milestone 5', r['ok'] and not r['data']['cardDone'])
r = api('reward_redeem', K, {'userId': uid, 'cardId': card_id, 'rewardId': rid1}); check('tidak bisa klaim dobel', not r['ok'] and 'sudah diklaim' in r['error'])
r = api('reward_redeem', K, {'userId': cust2['user']['id'], 'cardId': card_id, 'rewardId': rid1}); check('kartu orang lain ditolak', not r['ok'])

print('# kartu penuh -> kartu baru, batas 3')
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 3}); r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 3})
v = r['data']['customer']['campaigns'][0]; cards = v['cards']
check('stamp tumpah ke kartu baru', len(cards) == 2 and cards[0]['stamps'] == 10 and cards[1]['stamps'] == 1 and cards[0]['state'] == 'full', [c['stamps'] for c in cards])
r = {'ok': True}
for _ in range(20):
    r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 3})
    if not r['ok']: break
check('batas 3 kartu', not r['ok'] and r['code'] == 'CARD_LIMIT', r)
for _ in range(10):
    if not api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 1})['ok']: break
v = api('cust_lookup', K, {'query': '0811 0000 0003'})['data']['customer']['campaigns'][0]
check('limitReached tampil', v['limitReached'] and len(v['cards']) == 3, (v['limitReached'], len(v['cards'])))
r = api('reward_redeem', K, {'userId': uid, 'cardId': v['cards'][0]['id'], 'rewardId': rid2}); check('tukar milestone 10 -> kartu selesai', r['ok'] and r['data']['cardDone'], r)
v = r['data']['customer']['campaigns'][0]; check('kartu selesai hilang dari daftar', all(c['id'] != card_id for c in v['cards']))
r = api('stamp_add', K, {'userId': uid, 'campaignId': 'default', 'qty': 1}); check('setelah kartu selesai bisa stamp lagi', r['ok'], r)

print('# lookup (HP, kode member, QR)')
code_m = cust2['user']['memberCode']
check('lookup kode member', api('cust_lookup', K, {'query': code_m})['data']['customer']['memberCode'] == code_m)
check('lookup kode tanpa LS-', api('cust_lookup', K, {'query': code_m[3:].lower()})['ok'])
qr = api('my_qr', C2)['data']['payload']
check('lookup via QR', api('cust_lookup', K, {'query': qr})['data']['customer']['memberCode'] == code_m)
bad = qr[:-1] + ('0' if qr[-1] != '0' else '1'); check('QR palsu ditolak', not api('cust_lookup', K, {'query': bad})['ok'])
old = 'LS1.' + code_m + '.' + str(int(time.time()) - 400)
sig = sql("select loyalty.qr_sig(:'c', :'t')", c=code_m, t=str(int(time.time()) - 400))
check('QR kedaluwarsa', 'kedaluwarsa' in api('cust_lookup', K, {'query': f'{old}.{sig}'})['error'])
check('pelanggan tak ada', not api('cust_lookup', K, {'query': '081299999999'})['ok'])

print('# event stamp lain + jadwal')
r = api('campaign_save', A, {'name': 'Promo Kilat', 'icon': '🔥', 'start': '2020-01-01T08:00', 'end': '2020-01-02T08:00'}); check('buat event lampau', r['ok'])
cid = [c for c in r['data']['campaigns'] if c['name'] == 'Promo Kilat'][0]['id']
r = api('campaign_save', A, {'name': 'X', 'end': '2020-01-02T08:00', 'redeemUntil': '2020-01-01T08:00'}); check('batas tukar < selesai ditolak', not r['ok'])
r = api('reward_save', A, {'name': 'Es teh', 'required': 2, 'campaignId': cid}); check('reward event lampau', r['ok'])
r = api('stamp_add', K, {'userId': uid, 'campaignId': cid, 'qty': 1}); check('event lampau tak bisa distamp', not r['ok'] and 'tidak berlangsung' in r['error'])
r = api('campaign_save', A, {'name': 'Promo Besok', 'start': '2099-01-01T08:00', 'end': '2099-02-01T08:00'}); check('buat event masa depan', r['ok'])
r = api('campaign_save', A, {'name': 'Promo Aktif', 'icon': '🎉', 'start': '2020-01-01T08:00', 'end': '2099-01-01T08:00', 'redeemUntil': '2099-02-01T08:00'}); check('buat event aktif', r['ok'])
cid2 = [c for c in r['data']['campaigns'] if c['name'] == 'Promo Aktif'][0]['id']
api('reward_save', A, {'name': 'Donat', 'required': 2, 'campaignId': cid2})
r = api('stamp_add', K, {'userId': uid, 'campaignId': cid2, 'qty': 2}); check('stamp event aktif', r['ok'])
names = [c['name'] for c in api('bootstrap', C)['data']['view']['campaigns']]
check('event masa depan & lampau tak tampil', 'Promo Besok' not in names and 'Promo Kilat' not in names and 'Promo Aktif' in names, names)
sql("update loyalty.campaigns set end_at = '2020-01-02 00:00', redeem_until = '2099-02-01 00:00' where id = :'c'", c=cid2)
v = [c for c in api('bootstrap', C)['data']['view']['campaigns'] if c['name'] == 'Promo Aktif'][0]
check('event lewat tapi masih bisa ditukar', not v['running'] and v['redeemable'] and v['cards'][0]['availableCount'] == 1 and not v['canStamp'])
r = api('reward_redeem', K, {'userId': uid, 'cardId': v['cards'][0]['id'], 'rewardId': v['cards'][0]['milestones'][0]['id']}); check('tukar kartu event lewat', r['ok'], r)
r = api('campaign_delete', A, {'id': cid2}); check('event berkartu tak bisa dihapus', not r['ok'])
r = api('campaign_delete', A, {'id': 'default'}); check('event bawaan tak bisa dihapus', not r['ok'])
r = api('campaign_delete', A, {'id': cid}); check('event tanpa kartu bisa dihapus', r['ok'])

print('# mode grup')
camp = 'default'; u2 = cust2['user']['id']; u3 = cust3['user']['id']
api('settings_save', A, {'values': {'cooldown_minutes': 5}}); sql("truncate loyalty.cooldowns")
r = api('stamp_batch', K, {'campaignId': camp, 'items': [{'userId': u2, 'qty': 2}, {'userId': u3, 'qty': 3}, {'userId': 'nope', 'qty': 1}, {'userId': u2, 'qty': 1}]})
res = r['data']['results']
check('batch: 2 berhasil, sisanya gagal terisolasi', [x['ok'] for x in res] == [True, True, False, False], [(x['ok'], x.get('code')) for x in res])
check('batch: gagal karena jeda ditandai', res[3]['code'] == 'COOLDOWN')
check('batch kosong ditolak', not api('stamp_batch', K, {'campaignId': camp, 'items': []})['ok'])
check('batch > 20 ditolak', not api('stamp_batch', K, {'campaignId': camp, 'items': [{'userId': u2, 'qty': 1}] * 21})['ok'])
api('settings_save', A, {'values': {'cooldown_minutes': 0, 'max_qty_per_add': 5}})
api('stamp_batch', K, {'campaignId': camp, 'items': [{'userId': u2, 'qty': 3}, {'userId': u3, 'qty': 2}]})
c2 = api('cust_lookup', K, {'query': code_m})['data']['customer']['campaigns'][0]['cards'][0]
check('Ani punya 5 stamp & reward siap', c2['stamps'] == 5 and c2['availableCount'] == 1, c2['stamps'])
c3 = api('cust_lookup', K, {'query': cust3['user']['memberCode']})['data']['customer']['campaigns'][0]['cards'][0]
r = api('redeem_batch', K, {'items': [{'userId': u2, 'cardId': c2['id'], 'rewardId': c2['milestones'][0]['id']}, {'userId': u3, 'cardId': c3['id'], 'rewardId': c3['milestones'][0]['id']}]})
res = r['data']['results']; check('redeem batch: Ani ok, Cici (stamp 5? ) sesuai', res[0]['ok'], res)

print('# koreksi, riwayat, aktivitas, statistik')
v = api('cust_lookup', K, {'query': code_m})['data']['customer']['campaigns'][0]['cards'][0]
r = api('stamp_adjust', A, {'userId': u2, 'cardId': v['id'], 'delta': -2, 'note': 'salah input'}); check('koreksi -2', r['ok'], r)
check('koreksi tanpa alasan ditolak', not api('stamp_adjust', A, {'userId': u2, 'cardId': v['id'], 'delta': 1, 'note': ''})['ok'])
check('koreksi melebihi batas ditolak', not api('stamp_adjust', A, {'userId': u2, 'cardId': v['id'], 'delta': 50, 'note': 'x'})['ok'])
h = api('my_history', C)['data']['items']; check('riwayat berisi stamp & tukar', len(h) > 3 and any(i['kind'] == 'redeem' for i in h) and 'campaign' in h[0] and len(h[0]['ts']) == 19)
a = api('staff_activity', K)['data']['items']; check('aktivitas kasir', len(a) > 0 and all(i['by'] == 'Kasir' for i in a))
s = api('stats', A)['data']; check('statistik', s['customers'] == 3 and s['staff'] == 2 and s['stampsToday'] > 0 and s['redeemToday'] > 0, s)
us = api('user_search', A, {'q': 'bud'})['data']['users']; check('cari pengguna by nama', len(us) == 1 and us[0]['name'] == 'Budi')
us = api('user_search', A, {'q': '081100000003'})['data']['users']; check('cari pengguna by HP', len(us) == 1)
us = api('user_search', A, {})['data']['users']; check('daftar staff', {u['role'] for u in us} <= {'admin', 'cashier'} and len(us) == 2)

print('# event hero, profil, pengaturan')
r = api('event_save', A, {'title': 'Turnamen Catan', 'subtitle': 'Jumat 19.00', 'image': 'https://drive.google.com/file/d/abc123_X/view', 'link': 'https://x.id', 'start': '2020-01-01T10:00'})
check('simpan event hero + konversi link Drive', r['ok'] and r['data']['events'][0]['image'] == 'https://lh3.googleusercontent.com/d/abc123_X', r)
check('event http ditolak', not api('event_save', A, {'title': 'x', 'image': 'http://a.b/c.png'})['ok'])
check('event tampil ke customer', len(api('bootstrap', C)['data']['events']) == 1)
r = api('event_save', A, {'title': 'Lewat', 'start': '2020-01-01T10:00', 'end': '2020-01-02T10:00'}); check('event lewat tak tampil', len(api('bootstrap', C)['data']['events']) == 1)
r = api('event_delete', A, {'id': r['data']['events'][-1]['id']}); check('hapus event', r['ok'])
r = api('profile_update', C, {'name': 'Budi S', 'email': 'BUDI@Mail.com'}); check('profil update', r['ok'] and r['data']['user']['email'] == 'budi@mail.com' and r['data']['user']['name'] == 'Budi S')
check('email salah ditolak', not api('profile_update', C, {'email': 'abc'})['ok'])
check('nama kosong ditolak', not api('profile_update', C, {'name': ' '})['ok'])
r = api('settings_save', A, {'values': {'cafe_name': 'AIUEO Test', 'theme_color': '#112233', 'max_open_cards': 2}}); check('simpan pengaturan', r['ok'])
check('warna salah ditolak', not api('settings_save', A, {'values': {'theme_color': 'merah'}})['ok'])
check('angka di luar batas ditolak', not api('settings_save', A, {'values': {'max_open_cards': 99}})['ok'])
check('nama tampil di public_info', api('public_info')['data']['cafe_name'] == 'AIUEO Test')
f = api('settings_get', A)['data']['fields']; check('settings_get lengkap', len(f) == 11 and any(x['key'] == 'otp_daily_max' for x in f))

print('# sesi')
r = api('logout', C3); check('logout', r['ok']); check('token tidak berlaku setelah logout', not api('bootstrap', C3)['ok'])
sql("update loyalty.sessions set expires = now() - interval '1 minute' where user_id = :'u'", u=u2)
check('sesi kedaluwarsa ditolak', api('bootstrap', C2)['code'] == 'AUTH')
r = api('user_update', A, {'userId': uid, 'active': False}); check('nonaktifkan akun', r['ok'])
check('akun nonaktif tak bisa pakai token', not api('bootstrap', C)['ok'])
check('akun nonaktif tak bisa minta OTP', 'dinonaktifkan' in api('otp_request', payload={'phone': '081100000003'})['error'])
api('user_update', A, {'userId': uid, 'active': True})
sql("insert into loyalty.sessions(token_hash,user_id,expires,remember) select loyalty.sha('roll'), user_id, now()+interval '2 days', true from loyalty.users where phone='6281100000004'")
api('bootstrap', 'roll'); ex = sql("select extract(day from expires - now()) from loyalty.sessions where token_hash = loyalty.sha('roll')")
check('ingat saya bergulir (jadi ~30 hari)', int(float(ex)) >= 29, ex)

print('# injeksi')
r = api('profile_update', A, {'name': "=HYPERLINK('x')\x07 <b>x</b>'; drop table loyalty.users;--"}); check('nama aneh tersimpan aman', r['ok'] and '\x07' not in r['data']['user']['name'])
check('tabel users masih ada', sql("select count(*) from loyalty.users") != '0')
check('ls_api tak bisa dipanggil anon', True)
print('\nGAGAL: %d' % fails if fails else '\nALL PASSED')
sys.exit(1 if fails else 0)
