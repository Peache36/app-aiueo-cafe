/* AIUEO Cafe — Loyalty Stamp (Supabase + Netlify) */
const APP_VER = '7.0';
/* ============================ UTIL ============================ */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeUrl = u => /^https?:[/][/]/i.test(u || '') ? u : '';
const ICON = {
  home:'<svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  clock:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  user:'<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  scan:'<svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M4 12h16"/></svg>',
  cal:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  gear:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></svg>',
  cup:'<svg viewBox="0 0 24 24"><path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M12 3v2"/></svg>',
  dice:'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4.5"/><circle cx="9" cy="9" r="1.15" fill="currentColor"/><circle cx="15" cy="9" r="1.15" fill="currentColor"/><circle cx="12" cy="12" r="1.15" fill="currentColor"/><circle cx="9" cy="15" r="1.15" fill="currentColor"/><circle cx="15" cy="15" r="1.15" fill="currentColor"/></svg>',
  qr:'<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1"/></svg>'
};
const S = {token:null, user:null, view:null, campId:null, animFrom:null, settings:{}, events:[], pub:{channels:{whatsapp:false,email:true}}, tab:null, cust:null, qty:1};
const L = {channel:'whatsapp', phone:'', name:'', email:''};
const G = {on:false, members:[], qty:1, over:{}, results:null, cdFail:[], note:'', rd:[]};   /* Mode Grup (kasir) */
const timers = [];
/* Pustaka QR dimuat saat dibutuhkan (tidak memblokir tampilan awal). */
const _libs = {};
function loadLib(key, globalName, url){
  if (typeof window[globalName] === 'function') return Promise.resolve();   /* bukan sekadar ada: elemen ber-id sama juga muncul di window */
  if (!_libs[key]) _libs[key] = new Promise((res, rej) => {
    const el = document.createElement('script'); el.src = url; el.onload = res;
    el.onerror = () => { delete _libs[key]; rej(new Error('Gagal memuat pustaka QR. Periksa koneksi internet.')); };
    document.head.appendChild(el);
  });
  return _libs[key];
}
const needQr = () => loadLib('qr', 'qrcode', 'qr.js');
const needJsqr = () => loadLib('jsqr', 'jsQR', 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js');
const KEY = 'ls_token', PKEY = 'ls_phone';

function tokenGet(){ try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch(e){ return null; } }
function tokenSet(t, remember){ try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); (remember ? localStorage : sessionStorage).setItem(KEY, t); } catch(e){} }
function tokenClear(){ try { localStorage.removeItem(KEY); sessionStorage.removeItem(KEY); } catch(e){} S.token = null; }
function lastPhone(){ try { return localStorage.getItem(PKEY) || ''; } catch(e){ return ''; } }

/* ---- indikator proses: bar di atas layar + pemblokir tap untuk aksi tulis (anti spam klik) ---- */
const NET = {n: 0, blockers: 0, timer: null, btimer: null, inflight: {}};
const WRITE_RE = /(_add|_save|_delete|_update|_redeem|_adjust|_batch|^logout|^otp_)/;
function netUi(){
  const bar = document.getElementById('netbar');
  if (bar) bar.classList.toggle('on', NET.n > 0);
}
function netStart(action){
  if (action === 'poll') return function(){};
  NET.n++;
  clearTimeout(NET.timer); NET.timer = setTimeout(netUi, 120);
  let blocked = false;
  if (WRITE_RE.test(action)){
    blocked = true; NET.blockers++;
    clearTimeout(NET.btimer);
    NET.btimer = setTimeout(() => { const b = document.getElementById('blocker'); if (b && NET.blockers > 0) b.classList.add('on'); }, 250);
    const b0 = document.getElementById('blocker'); if (b0) b0.classList.add('lock');
  }
  return function(){
    NET.n = Math.max(0, NET.n - 1); netUi();
    if (blocked){
      NET.blockers = Math.max(0, NET.blockers - 1);
      if (!NET.blockers){
        clearTimeout(NET.btimer);
        const b = document.getElementById('blocker'); if (b) b.classList.remove('on', 'lock');
      }
    }
  };
}
function call(action, payload){
  payload = payload || {};
  /* permintaan identik yang masih berjalan dipakai bersama, jadi klik berulang tidak mengirim dua kali */
  let key = null;
  if (action !== 'poll'){
    try { key = action + '|' + JSON.stringify(payload); } catch(e){ key = null; }
    if (key && NET.inflight[key]) return NET.inflight[key];
  }
  const done = netStart(action);
  const p = LSAPI.post([action, S.token, payload]).then(r => {
    if (r && r.ok) return r.data;
    const e = new Error((r && r.error) || 'Tidak ada respons dari server'); e.code = r && r.code; throw e;
  });
  const fin = function(){ done(); if (key) delete NET.inflight[key]; };
  p.then(fin, fin);
  if (key) NET.inflight[key] = p;
  return p;
}
function toast(msg, type){
  const d = document.createElement('div'); d.textContent = msg; if (type) d.className = type;
  $('#toast').appendChild(d); setTimeout(() => d.remove(), 3200);
}
function handleErr(e){
  if (e && e.code === 'AUTH'){ tokenClear(); toast(e.message, 'err'); showLogin(); return; }
  toast((e && e.message) || 'Terjadi kesalahan', 'err');
}
async function run(btn, fn){
  if (btn && btn._busy) return;
  if (btn){ btn._busy = true; btn.disabled = true; btn.classList.add('loading'); }
  try { return await fn(); } catch(e){ handleErr(e); }
  finally { if (btn){ btn._busy = false; btn.disabled = false; btn.classList.remove('loading'); } }
}
function applyTheme(c){ if (/^#[0-9a-f]{6}$/i.test(c || '')) document.documentElement.style.setProperty('--primary', c); }
function stopTimers(){ while (timers.length) clearInterval(timers.pop()); }

/* modal stack */
const modals = [];
function openModal(html){
  const o = document.createElement('div'); o.className = 'overlay';
  o.innerHTML = '<div class="modal">' + html + '</div>';
  o.addEventListener('click', ev => { if (ev.target === o) closeModal(); });
  document.body.appendChild(o); modals.push(o); return o;
}
function closeModal(){
  const o = modals.pop(); if (!o) return;
  if (o._cleanup) o._cleanup();
  o.remove();
}
function askConfirm(msg, okText){
  return new Promise(res => {
    const o = openModal(`<h3>${esc(msg)}</h3><button class="btn" id="cy">${esc(okText || 'Ya, lanjut')}</button><button class="btn ghost" id="cn">Batal</button>`);
    o._cleanup = () => res(false);                 /* ditutup tanpa memilih (klik luar) = batal */
    o.querySelector('#cy').onclick = () => { o._cleanup = null; closeModal(); res(true); };
    o.querySelector('#cn').onclick = () => closeModal();
  });
}

/* ============================ INIT ============================ */
async function loadPub(){
  if (S.pubOk) return true;
  try { S.pub = await call('public_info'); S.pubOk = true; applyTheme(S.pub.theme_color); document.title = S.pub.cafe_name; return true; }
  catch(e){
    $('#app').innerHTML = '<div class="spin" style="text-align:center;padding:24px">Gagal terhubung ke server.<br><small>' + esc(e.message) + '</small><br><br><button class="btn sm" onclick="location.reload()">Coba lagi</button></div>';
    return false;
  }
}
async function init(){
  S.token = tokenGet();
  if (S.token){   /* sudah login: satu panggilan saja (bootstrap), tanpa public_info */
    try { await enterApp(); setTimeout(preloadLibs, 2500); return; }
    catch(e){ if (e.code !== 'AUTH') toast(e.message, 'err'); tokenClear(); }
  }
  showLogin();
}
function preloadLibs(){ (S.user && S.user.role === 'customer' ? needQr() : needJsqr()).catch(() => {}); }

async function enterApp(){
  let d;
  const pre = window.__boot; window.__boot = null;   /* bootstrap yang sudah dimulai lebih awal oleh index.html */
  if (pre && S.token){
    try { const r = await pre; if (r && r.ok) d = r.data; else if (r && r.code === 'AUTH'){ const e = new Error(r.error); e.code = 'AUTH'; throw e; } }
    catch(e){ if (e.code === 'AUTH') throw e; }
  }
  if (!d) d = await call('bootstrap');
  S.user = d.user; S.view = d.view; P.v = d.version; S.settings = d.settings; S.events = d.events;
  applyTheme(d.settings.theme_color);
  buildShell();
}

/* ============================ LOGIN ============================ */
async function showLogin(){
  stopPoll(); stopTimers();
  if (!(await loadPub())) return; while (modals.length) closeModal();
  L.phone = lastPhone(); L.name = ''; L.email = '';
  L.channel = 'whatsapp';
  $('#app').innerHTML = `<div class="login">
    <div class="login-hero"><img class="logo-big" src="logo.png" alt="AIUEO Cafe"><h1>${esc(S.pub.cafe_name)}</h1><p>${esc(S.pub.tagline)}</p></div>
    <div class="sheet" id="lg"></div></div>`;
  loginStep1(); hideSplash();
}

function loginStep1(needInfo){
  $('#lg').innerHTML = `<h2>Masuk / Daftar</h2><p class="sub">Kami kirim kode verifikasi lewat WhatsApp ke nomor Anda.</p>
    <label for="ph">Nomor HP (WhatsApp)</label>
    <input id="ph" type="tel" inputmode="tel" autocomplete="tel" placeholder="08xxxxxxxxxx" value="${esc(L.phone)}">
    ${needInfo ? `<label for="nm">Nama</label><input id="nm" autocomplete="name" maxlength="60" placeholder="Nama Anda" value="${esc(L.name)}">` : ''}
    <button class="btn" id="goOtp">Kirim Kode</button>`;
  const first = needInfo ? $('#nm') : $('#ph'); if (first && !first.value) first.focus();
  $('#goOtp').onclick = ev => run(ev.currentTarget, async () => {
    L.phone = $('#ph').value.trim();
    if ($('#nm')) L.name = $('#nm').value.trim();
    const req = {channel: 'whatsapp', phone: L.phone, name: L.name};
    const r = await call('otp_request', req);
    if (r.needInfo){ toast('Nomor baru — isi nama dulu'); return loginStep1(true); }
    L.req = req;
    loginStep2(r);
  });
  $('#lg').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') $('#goOtp').click(); });
}

function loginStep2(r){
  stopTimers();
  $('#lg').innerHTML = `<h2>Masukkan kode</h2><p class="sub">Kode 6 digit dikirim ke <b>${esc(r.to)}</b></p>
    <input id="otp" class="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••">
    <label class="chk"><input type="checkbox" id="rem" checked> Ingat saya di perangkat ini (${esc(S.pub.session_days_remember)} hari)</label>
    <button class="btn" id="vf">Masuk</button>
    <div class="row between" style="margin-top:8px"><button class="link" id="back">Ganti nomor</button><button class="link" id="resend" disabled>Kirim ulang (60)</button></div>`;
  const otp = $('#otp'); otp.focus();
  const verify = btn => run(btn, async () => {
    const code = otp.value.replace(/\D/g, '');
    if (code.length !== 6) return toast('Masukkan 6 digit kode', 'err');
    const rem = $('#rem').checked;
    const d = await call('otp_verify', {phone: L.phone, code, remember: rem, device: navigator.userAgent.slice(0, 80)});
    S.token = d.token; tokenSet(d.token, rem);
    try { localStorage.setItem(PKEY, L.phone); } catch(e){}
    await enterApp();
  });
  $('#vf').onclick = ev => verify(ev.currentTarget);
  otp.addEventListener('input', () => { otp.value = otp.value.replace(/\D/g, ''); if (otp.value.length === 6) verify($('#vf')); });
  $('#back').onclick = () => { stopTimers(); loginStep1(); };
  let left = 60; const rs = $('#resend');
  timers.push(setInterval(() => { left--; if (left <= 0){ rs.disabled = false; rs.textContent = 'Kirim ulang'; stopTimers(); } else rs.textContent = `Kirim ulang (${left})`; }, 1000));
  rs.onclick = ev => run(ev.currentTarget, async () => {
    const x = await call('otp_request', L.req);
    if (x.sent){ toast('Kode baru dikirim', 'ok'); loginStep2(x); }
  });
}

/* ============================ SHELL ============================ */
function tabsFor(role){
  if (role === 'customer') return [['home','Beranda','home'],['hist','Riwayat','clock'],['me','Profil','user']];
  if (role === 'cashier')  return [['kasir','Kasir','scan'],['me','Profil','user']];
  return [['kasir','Kasir','scan'],['events','Event','cal'],['admin','Admin','gear'],['me','Profil','user']];
}
const ROLE_LABEL = {customer:'Member', cashier:'Kasir', admin:'Admin'};

function buildShell(){
  stopTimers(); while (modals.length) closeModal();
  const u = S.user, tabs = tabsFor(u.role);
  $('#app').innerHTML = `<header class="appbar">
      <div class="brand"><img src="logo-sm.png" alt=""><div class="bt"><b>${esc((S.settings && S.settings.cafe_name) || 'AIUEO Cafe')}</b><small>${ROLE_LABEL[u.role]}</small></div><span class="chipid"></span></div>
      <nav class="nav">${tabs.map(t => `<button data-tab="${t[0]}">${ICON[t[2]]}<span>${t[1]}</span></button>`).join('')}</nav>
    </header>
    <div class="shell" id="shell"><div id="ptr"><span class="sp"></span></div>
    <header class="top"><div><small>Halo,</small><b>${esc(u.name)}${u.role === 'customer' ? `<span class="mc"> - ${esc(u.memberCode)}</span>` : ''}</b></div></header>
    <main id="view"></main></div>`;
  $('.nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); };
  go(tabs[0][0]);
  startPoll();
  initPtr();
  hideSplash();
}

function go(tab){
  S.tab = tab;
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  window.scrollTo(0, 0);
  const vw = $('#view'); if (vw){ vw.classList.remove('vin'); void vw.offsetWidth; vw.classList.add('vin'); }
  ({home:viewHome, hist:viewHistory, me:viewProfile, kasir:viewKasir, events:viewEvents, admin:viewAdmin})[tab]();
}

function slotsHtml(c, fromN){
  if (!c.maxRequired) return '';
  const at = {}; c.milestones.forEach(m => (at[m.required] = at[m.required] || []).push(m));
  let h = '<div class="slots">';
  for (let i = 1; i <= c.maxRequired; i++){
    const f = i <= c.filled, ms = at[i];
    const nw = fromN != null && i > fromN && i <= c.filled ? ` new" style="--d:${(i - fromN - 1) * 220}ms` : '';
    if (ms){
      const st = ms.every(m => m.status === 'claimed') ? 'claimed' : ms.some(m => m.status === 'available') ? 'available' : 'locked';
      h += `<div class="slot m ${f?'f':''} ${st}${nw}" title="${esc(ms.map(m => m.name).join(', '))}">${st==='claimed'?'✓':'🎁'}</div>`;
    } else h += f ? `<div class="slot f${nw}">${ICON.dice}</div>` : `<div class="slot">${i}</div>`;
  }
  return h + '</div>';
}
function milestonesHtml(c, canClaim){
  if (!c.milestones.length) return '';
  return '<div class="list">' + c.milestones.map(m => {
    const right = m.status === 'claimed' ? '<span class="pill">Sudah diklaim</span>'
      : m.status === 'available' ? (canClaim ? `<button class="btn sm" data-card="${esc(c.id)}" data-claim="${esc(m.id)}" data-nm="${esc(m.name)}">Tukar</button>` : '<span class="pill ok">Siap ditukar</span>')
      : `<small>${m.remaining} lagi</small>`;
    return `<div><span class="ico ${m.status==='claimed'?'g':m.status==='locked'?'lk':''}">${m.required}</span><div class="t"><b>${esc(m.name)}</b><small>${esc(m.description || '')}</small></div>${right}</div>`;
  }).join('') + '</div>';
}
const fmtD = v => v ? esc(String(v).replace('T', ' ')) : '';
function campInfo(camp){
  const t = [];
  if (!camp.running) t.push('Event selesai' + (camp.redeemUntil ? ' • tukar reward sebelum ' + fmtD(camp.redeemUntil) : ''));
  else {
    if (camp.end) t.push('Berlaku s/d ' + fmtD(camp.end));
    if (camp.redeemUntil && camp.redeemUntil !== camp.end) t.push('Tukar reward s/d ' + fmtD(camp.redeemUntil));
  }
  return t.join(' • ') || esc(camp.description || '');
}
function cardHtml(camp, c, staff){
  const from = S.animFrom && c.id ? S.animFrom[c.id] : null;
  const label = c.state === 'full' ? '<span class="pill ok">Penuh</span>' : !c.id ? '<span class="pill">Kartu baru</span>' : `<span class="pill">${c.stamps}/${c.maxRequired}</span>`;
  return `<div class="kcard ${c.state}"><div class="row between"><b>Kartu ${c.number}</b>${label}</div>
    ${slotsHtml(c, from)}
    ${c.availableCount ? `<div class="ready">🎁 ${c.availableCount} reward siap ditukar${staff ? '' : '<small>Tunjukkan QR ke kasir untuk menukar.</small>'}</div>` : ''}
    ${milestonesHtml(c, staff && camp.redeemable)}</div>`;
}

/* ============================ CUSTOMER ============================ */
function heroHtml(){
  const ev = S.events;
  if (!ev.length) return `<div class="nohero">Belum ada event yang sedang berlangsung ☕</div>`;
  return `<div class="hero-track" id="ht">${ev.map((e, i) => `<div class="hero ${ev.length===1?'solo':''}" data-i="${i}" ${safeUrl(e.link)?`data-link="${esc(e.link)}"`:''}>
      <span class="badge"><i></i>${esc(e.badge)}</span><h3>${esc(e.title)}</h3>${e.subtitle?`<p>${esc(e.subtitle)}</p>`:''}</div>`).join('')}</div>
    ${ev.length>1?`<div class="dots" id="dots">${ev.map((_, i) => `<i class="${i?'':'on'}"></i>`).join('')}</div>`:''}`;
}
function bindHero(){
  const ht = $('#ht'); if (!ht) return;
  ht.querySelectorAll('.hero').forEach(el => {
    const e = S.events[el.dataset.i], img = safeUrl(e.image);
    if (img) el.style.backgroundImage = `linear-gradient(180deg,rgba(0,0,0,.08),rgba(0,0,0,.68)),url(${JSON.stringify(img)})`;
    if (el.dataset.link) el.onclick = () => window.open(el.dataset.link, '_blank', 'noopener');
  });
  const dots = $('#dots');
  if (dots) ht.addEventListener('scroll', () => {
    const w = ht.firstElementChild.getBoundingClientRect().width + 12;
    const i = Math.round(ht.scrollLeft / w);
    dots.querySelectorAll('i').forEach((d, k) => d.classList.toggle('on', k === i));
  }, {passive: true});
}

function viewHome(){
  const v = S.view, s = S.settings;
  $('#view').innerHTML = `${heroHtml()}
    <button class="btn" id="showQr" style="margin-bottom:2px">${ICON.qr} Tampilkan QR Saya</button>
    ${v.campaigns.length ? v.campaigns.map(camp => `<section class="card">
      <div class="camp-h"><span class="ci">${esc(camp.icon)}</span><div><h3 style="margin:0">${esc(camp.name)}</h3><small>${campInfo(camp)}</small></div></div>
      ${!camp.running ? '<div class="notice">Event ini sudah selesai. Kartu di bawah masih bisa ditukar.</div>' : ''}
      ${camp.limitReached ? `<div class="notice">Kamu punya ${camp.maxCards} kartu yang belum selesai. Tukar reward dulu agar bisa mulai kartu baru.</div>` : ''}
      ${camp.cards.map(c => cardHtml(camp, c, false)).join('')}</section>`).join('')
      : '<div class="nohero" style="margin-top:14px">Belum ada event stamp yang berlangsung</div>'}
    ${s.reward_terms ? `<p class="hint" style="font-size:12px;text-align:center">${esc(s.reward_terms)}</p>` : ''}
    <div class="center"><button class="link" id="rf">Segarkan</button></div>`;
  bindHero();
  $('#showQr').onclick = showMyQr;
  $('#rf').onclick = ev => run(ev.currentTarget, async () => { await enterAppQuiet(); toast('Diperbarui', 'ok'); });
}

/* --- polling: stamp baru dari kasir muncul + animasi (jeda ±4 detik) --- */
const P = {v: '', timer: null, busy: false, idle: 0};
function nextDelay(){ return P.idle < 12 ? 6000 : P.idle < 40 ? 12000 : 20000; }   /* makin lama tak ada perubahan, makin jarang */
function startPoll(){
  stopPoll();
  if (!S.user || S.user.role !== 'customer') return;
  P.idle = 0; schedulePoll();
  document.addEventListener('visibilitychange', onVis);
}
function schedulePoll(){ clearTimeout(P.timer); P.timer = setTimeout(async () => { await poll(); if (S.user && S.user.role === 'customer' && P.timer) schedulePoll(); }, nextDelay()); }
function stopPoll(){ clearTimeout(P.timer); P.timer = null; document.removeEventListener('visibilitychange', onVis); }
function onVis(){ if (!document.hidden){ P.idle = 0; poll(); clearTimeout(P.timer); schedulePoll(); } }
async function poll(){
  if (document.hidden || P.busy || !S.token) return;
  P.busy = true;
  try {
    const r = await call('poll', {v: P.v});
    P.v = r.v;
    if (r.changed){ P.idle = 0; applyView(r.view, true); } else P.idle++;
  } catch(e){ if (e.code === 'AUTH') handleErr(e); }
  finally { P.busy = false; }
}
function stampsById(v){ const o = {}; v.campaigns.forEach(c => c.cards.forEach(k => { if (k.id) o[k.id] = k.stamps; })); return o; }
const readyCount = v => v.campaigns.reduce((n, c) => n + c.cards.reduce((m, k) => m + k.availableCount, 0), 0);
function applyView(nv, animate){
  let from = null, added = 0, readyUp = false;
  if (animate && S.view){
    const old = stampsById(S.view); from = {};
    Object.entries(stampsById(nv)).forEach(([id, st]) => { const o = old[id] === undefined ? 0 : old[id]; if (st > o){ from[id] = o; added += st - o; } });
    readyUp = readyCount(nv) > readyCount(S.view);
  }
  S.view = nv; S.animFrom = from;
  if (S.tab === 'home') viewHome(); else if (S.tab === 'hist') viewHistory();
  S.animFrom = null;
  if (added > 0) stampFx(added, readyUp); else if (readyUp) toast('🎁 Reward siap ditukar!', 'ok');
}
function stampFx(n, ready){
  const d = document.createElement('div'); d.className = 'fx';
  d.innerHTML = `<div class="ring"></div><div class="st">${ICON.dice}</div><div class="tx">+${n} Stamp!${ready ? '<br><span style="font-size:17px">🎁 Reward siap ditukar</span>' : ''}</div>`;
  document.body.appendChild(d); setTimeout(() => d.remove(), 2600);
  vib([90, 50, 90]);
}
async function enterAppQuiet(){
  let d;
  d = await call('bootstrap');
  S.user = d.user; S.settings = d.settings; S.events = d.events; applyTheme(d.settings.theme_color); P.v = d.version;
  applyView(d.view, true);
}

function showMyQr(){
  const o = openModal(`<div class="center"><h3>QR Member</h3><p class="sub" style="margin:4px 0 0">Tunjukkan ke kasir. QR diperbarui otomatis.</p>
    <div class="qrbox"><img id="qrimg" alt="QR"></div><div class="code" id="qrmcode">${esc(S.user.memberCode)}</div>
    <small>Kode member • atau sebutkan nomor HP Anda</small><button class="btn ghost" id="qc">Tutup</button></div>`);
  const load = async () => {
    try {
      await needQr();
      const d = await call('my_qr'); const q = qrcode(0, 'M'); q.addData(d.payload); q.make();
      o.querySelector('#qrimg').src = q.createDataURL(8, 2);
    } catch(e){ handleErr(e); }
  };
  load(); const t = setInterval(load, 50000);
  o._cleanup = () => clearInterval(t);
  o.querySelector('#qc').onclick = closeModal;
}

async function viewHistory(){
  $('#view').innerHTML = '<div class="spin">Memuat…</div>';
  try {
    const d = await call('my_history');
    $('#view').innerHTML = `<section class="card"><h3>Riwayat</h3><div class="list">${d.items.length ? d.items.map(histItem).join('') : '<div class="empty">Belum ada aktivitas</div>'}</div></section>`;
  } catch(e){ handleErr(e); }
}
function histItem(i){
  const k = {earn:['g','+'+i.qty,'Stamp ditambahkan'], adjust:['', (i.qty>0?'+':'')+i.qty,'Koreksi stamp'], redeem:['r','🎁','Tukar reward']}[i.kind] || ['','',''];
  const sub = [esc(i.ts), i.campaign ? esc(i.campaign) : '', i.kind !== 'redeem' && i.note ? esc(i.note) : ''].filter(Boolean).join(' • ');
  return `<div><span class="ico ${k[0]}">${k[1]}</span><div class="t"><b>${k[2]}${i.kind==='redeem'?' • '+esc(i.note):''}</b><small>${sub}</small></div>${i.kind==='redeem'?`<small>Stamp ke-${i.qty}</small>`:''}</div>`;
}

/* ============================ PROFIL ============================ */
function viewProfile(){
  const u = S.user;
  $('#view').innerHTML = `<section class="card"><h3>Profil</h3>
    <label for="pn">Nama</label><input id="pn" maxlength="60" value="${esc(u.name)}">
    <label for="pe">Email <small>(opsional)</small></label><input id="pe" type="email" value="${esc(u.email)}" placeholder="nama@email.com">
    <label>Nomor HP</label><input value="${esc(u.phone)}" disabled>
    <label>Kode member</label><input value="${esc(u.memberCode)}" disabled>
    <button class="btn" id="ps">Simpan</button></section>
    <section class="card"><h3>Sesi</h3>
    <button class="btn ghost" id="lo">Keluar</button>
    <button class="btn danger" id="loa">Keluar dari semua perangkat</button></section>`;
  $('#ps').onclick = ev => run(ev.currentTarget, async () => {
    const d = await call('profile_update', {name: $('#pn').value, email: $('#pe').value});
    S.user = d.user; toast('Profil disimpan', 'ok'); $('.top b').textContent = S.user.name;
  });
  const out = (action) => async ev => run(ev.currentTarget, async () => { try { await call(action); } catch(e){} tokenClear(); showLogin(); });
  $('#lo').onclick = out('logout'); $('#loa').onclick = out('logout_all');
}

/* ============================ KASIR ============================ */
function viewKasir(){
  S.cust = null; S.qty = 1;
  $('#view').innerHTML = `<section class="card"><h3 style="margin:0">Cari Pelanggan</h3>
      <div class="seg" id="modeSeg" style="margin:10px 0 12px"><button data-m="one" class="${G.on?'':'on'}">Satu orang</button><button data-m="grp" class="${G.on?'on':''}">Mode Grup</button></div>
      <div class="row"><input id="q" placeholder="No. HP atau kode member" autocomplete="off"><button class="btn sm" id="qgo">Cari</button></div>
      <button class="btn ghost" id="scanBtn">${ICON.scan} Scan QR Pelanggan</button></section>
    <div id="cust"></div>
    <section class="card"><div class="row between"><h3 style="margin:0">Aktivitas Terbaru</h3><button class="link" id="actRef">Segarkan</button></div><div class="list" id="act"></div></section>`;
  $('#qgo').onclick = ev => run(ev.currentTarget, () => doLookup($('#q').value));
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') $('#qgo').click(); });
  $('#scanBtn').onclick = startScan;
  $('#actRef').onclick = loadActivity;
  $('#modeSeg').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m === 'grp'); };
  if (G.on) renderGroup();
  loadActivity();
}

async function loadActivity(){
  try {
    const d = await call('staff_activity'), el = $('#act'); if (!el) return;
    el.innerHTML = d.items.length ? d.items.map(i => {
      const m = {earn:['g','+'+i.qty,'Stamp'], adjust:['', (i.qty>0?'+':'')+i.qty,'Koreksi'], redeem:['r','🎁','Tukar: '+i.note]}[i.kind];
      return `<div><span class="ico ${m[0]}">${m[1]}</span><div class="t"><b>${esc(i.name)}</b><small>${esc(m[2])}${i.campaign?' • '+esc(i.campaign):''} • ${esc(i.by)} • ${esc(i.ts.slice(5,16))}</small></div></div>`;
    }).join('') : '<div class="empty">Belum ada aktivitas</div>';
  } catch(e){ handleErr(e); }
}

async function doLookup(q){
  const d = await call('cust_lookup', {query: q});
  if (G.on){ addMember(d.customer); return; }
  S.cust = d.customer; S.qty = 1; renderCust();
  $('#cust').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function pickCamp(){
  const cs = S.cust.campaigns;
  if (!cs.some(c => c.id === S.campId)){ const f = cs.find(c => c.canStamp) || cs[0]; S.campId = f ? f.id : null; }
}

function renderCust(){
  const c = S.cust, box = $('#cust'); if (!c){ box.innerHTML = ''; return; }
  pickCamp();
  const camp = c.campaigns.find(x => x.id === S.campId);
  const max = S.settings.max_qty_per_add, admin = S.user.role === 'admin';
  const real = camp ? camp.cards.filter(k => k.id) : [];
  box.innerHTML = `<section class="card">
    <div class="row between"><div><h3 style="margin:0">${esc(c.name)}</h3><small>${esc(c.phone)} • ${esc(c.memberCode)}</small></div><button class="x" id="cx">×</button></div>
    ${c.campaigns.length ? `<div class="chips">${c.campaigns.map(x => `<button class="chip ${x.id===S.campId?'on':''}" data-camp="${esc(x.id)}">${esc(x.icon)} ${esc(x.name)}${x.running?'':' (selesai)'}</button>`).join('')}</div>` : ''}
    ${camp ? `<small>${campInfo(camp)}</small>
      ${camp.limitReached ? `<div class="notice">Pelanggan punya ${camp.maxCards} kartu belum selesai. Tukar reward dulu sebelum menambah stamp.</div>` : ''}
      ${camp.cards.map(k => cardHtml(camp, k, true)).join('')}
      ${camp.canStamp ? `<div class="stepper"><button id="qm">−</button><b id="qv">${S.qty}</b><button id="qp">+</button></div>
        <input id="note" maxlength="80" placeholder="Catatan (opsional)">
        <button class="btn" id="addS" ${camp.limitReached ? 'disabled' : ''}>Tambah ${S.qty} Stamp</button>`
        : '<div class="notice">Event ini tidak sedang berlangsung. Hanya penukaran reward yang bisa dilakukan.</div>'}
      ${admin && real.length ? `<details><summary>Koreksi stamp (admin)</summary><div class="row" style="margin-top:10px">
        <select id="adjc" style="width:auto">${real.map(k => `<option value="${esc(k.id)}">Kartu ${k.number}</option>`).join('')}</select>
        <input id="adj" type="number" placeholder="+/−" style="max-width:80px"><input id="adjn" placeholder="Alasan" maxlength="80"><button class="btn sm" id="adjgo">OK</button></div></details>` : ''}`
      : '<div class="empty">Belum ada event stamp aktif. Buat di Admin → Event Stamp.</div>'}
  </section>`;
  $('#cx').onclick = () => { S.cust = null; renderCust(); };
  box.querySelectorAll('[data-camp]').forEach(b => b.onclick = () => { S.campId = b.dataset.camp; S.qty = 1; renderCust(); });
  if ($('#qm')){
    const upd = () => { $('#qv').textContent = S.qty; $('#addS').textContent = `Tambah ${S.qty} Stamp`; };
    $('#qm').onclick = () => { S.qty = Math.max(1, S.qty - 1); upd(); };
    $('#qp').onclick = () => { S.qty = Math.min(max, S.qty + 1); upd(); };
    $('#addS').onclick = ev => addStamp(ev.currentTarget, false);
  }
  box.querySelectorAll('[data-claim]').forEach(b => b.onclick = ev => run(ev.currentTarget, async () => {
    if (!await askConfirm(`Tukar "${b.dataset.nm}" untuk ${c.name}?`, 'Ya, tukar')) return;
    const d = await call('reward_redeem', {userId: c.id, cardId: b.dataset.card, rewardId: b.dataset.claim});
    S.cust = d.customer; renderCust(); loadActivity();
    toast(d.cardDone ? 'Reward ditukar — kartu selesai 🎉' : 'Reward berhasil ditukar 🎁', 'ok');
  }));
  if ($('#adjgo')) $('#adjgo').onclick = ev => run(ev.currentTarget, async () => {
    const d = await call('stamp_adjust', {userId: c.id, cardId: $('#adjc').value, delta: $('#adj').value, note: $('#adjn').value});
    S.cust = d.customer; renderCust(); toast('Stamp dikoreksi', 'ok'); loadActivity();
  });
}

async function addStamp(btn, force){
  const c = S.cust;
  if (btn._busy) return;
  btn._busy = true; btn.disabled = true; btn.classList.add('loading');
  try {
    const d = await call('stamp_add', {userId: c.id, campaignId: S.campId, qty: S.qty, note: $('#note').value, force: force});
    S.cust = d.customer; S.qty = 1; renderCust();
    toast(d.newCards ? `Stamp ditambahkan ✔ (${d.newCards} kartu baru dibuat)` : 'Stamp ditambahkan ✔', 'ok');
    if (navigator.vibrate) navigator.vibrate(60);
    loadActivity();
  } catch(e){
    btn._busy = false; btn.disabled = false; btn.classList.remove('loading');
    if (e.code === 'COOLDOWN' && S.user.role === 'admin'){
      if (await askConfirm(e.message + ' Tetap tambahkan?', 'Tetap tambah')) return addStamp($('#addS'), true);
    } else handleErr(e);
  }
}

/* --- Mode Grup: banyak pelanggan sekaligus --- */
function setMode(on){
  G.on = on;
  document.querySelectorAll('#modeSeg button').forEach(b => b.classList.toggle('on', (b.dataset.m === 'grp') === on));
  S.cust = null;
  if (on) renderGroup(); else $('#cust').innerHTML = '';
}
function addMember(v){
  const i = G.members.findIndex(m => m.id === v.id);
  if (i >= 0){ G.members[i] = v; toast(v.name + ' sudah ada di grup'); }
  else {
    if (G.members.length >= 20) throw new Error('Maksimal 20 orang per grup');
    G.members.push(v); toast(v.name + ' ditambahkan ✔', 'ok');
  }
  G.results = null; renderGroup();
  const q = $('#q'); if (q) q.value = '';
}
const memberQty = id => G.over[id] !== undefined ? G.over[id] : G.qty;
function groupCamps(){ return G.members.length ? G.members[0].campaigns.filter(c => c.canStamp) : []; }
function memberStatus(m){
  const camp = m.campaigns.find(c => c.id === S.campId); if (!camp) return '';
  if (camp.limitReached) return `<span class="err">kartu penuh (batas ${camp.maxCards})</span>`;
  const k = camp.cards.find(x => x.state === 'open');
  return k ? `kartu ${k.number}: ${k.stamps}/${k.maxRequired}` : '';
}
function renderGroup(){
  const box = $('#cust'); if (!box || !G.on) return;
  const nt = $('#gnote'); if (nt) G.note = nt.value;
  const n = G.members.length, camps = groupCamps(), admin = S.user.role === 'admin', max = S.settings.max_qty_per_add;
  if (!camps.some(c => c.id === S.campId)) S.campId = camps[0] ? camps[0].id : null;
  const rd = [];
  G.members.forEach(m => m.campaigns.forEach(camp => { if (camp.redeemable) camp.cards.forEach(k => k.milestones.forEach(ms => { if (ms.status === 'available') rd.push({m, camp, k, ms}); })); }));
  G.rd = rd;
  const resHtml = G.results ? `<div class="notice"><b>Hasil</b>${G.results.map(r => `<div style="margin-top:4px">${r.ok ? '✓' : '✗'} ${esc(r.name)} — ${esc(r.text)}</div>`).join('')}
    ${admin && G.cdFail.length ? '<button class="btn sm danger" id="gForce" style="margin-top:8px">Paksa yang kena jeda</button>' : ''}</div>` : '';
  box.innerHTML = `<section class="card">
    <div class="row between"><h3 style="margin:0">Grup • ${n} orang</h3>${n ? '<button class="link" id="gClear">Kosongkan</button>' : ''}</div>
    ${n ? '' : '<div class="empty">Tambahkan pelanggan lewat Scan QR (bisa berturut-turut tanpa menutup kamera) atau cari nomor HP di atas.</div>'}
    ${camps.length ? `<div class="chips">${camps.map(c => `<button class="chip ${c.id===S.campId?'on':''}" data-camp="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>` : (n ? '<div class="notice">Tidak ada event stamp yang sedang berlangsung.</div>' : '')}
    ${n ? `<div class="list">${G.members.map(m => `<div><div class="t"><b>${esc(m.name)}</b><small>${esc(m.phone)} • ${memberStatus(m)}</small></div>
        <div class="mini"><button data-q="-" data-u="${esc(m.id)}">−</button><b>${memberQty(m.id)}</b><button data-q="+" data-u="${esc(m.id)}">+</button></div>
        <button class="x" data-rm="${esc(m.id)}">×</button></div>`).join('')}</div>
      <div class="row between" style="margin-top:10px"><small>Stamp per orang (untuk semua)</small>
        <div class="stepper" style="margin:0;gap:14px"><button id="gm">−</button><b id="gqv">${G.qty}</b><button id="gp">+</button></div></div>
      <input id="gnote" maxlength="80" placeholder="Catatan (opsional)" value="${esc(G.note)}" style="margin-top:10px">
      <button class="btn" id="gAdd" ${S.campId ? '' : 'disabled'}>Tambah stamp ke ${n} orang</button>` : ''}
    ${resHtml}
    ${rd.length ? `<h3 style="margin:18px 0 4px">Reward siap tukar</h3><div class="list">${rd.map((x, i) => `<div><label class="chk" style="margin:0;flex:1"><input type="checkbox" class="rdx" data-i="${i}"><span><b>${esc(x.m.name)}</b><br><small>${esc(x.camp.icon)} ${esc(x.camp.name)} • Kartu ${x.k.number} • ${esc(x.ms.name)}</small></span></label></div>`).join('')}</div>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="gAll" style="flex:1">Pilih semua</button><button class="btn ok sm" id="gRedeem" style="flex:2">Tukar yang dipilih</button></div>` : ''}
  </section>`;
  box.querySelectorAll('[data-camp]').forEach(b => b.onclick = () => { S.campId = b.dataset.camp; renderGroup(); });
  box.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { const id = b.dataset.u; G.over[id] = Math.min(max, Math.max(1, memberQty(id) + (b.dataset.q === '+' ? 1 : -1))); renderGroup(); });
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { G.members = G.members.filter(m => m.id !== b.dataset.rm); delete G.over[b.dataset.rm]; G.results = null; renderGroup(); });
  if ($('#gClear')) $('#gClear').onclick = () => { G.members = []; G.over = {}; G.results = null; G.cdFail = []; G.note = ''; renderGroup(); };
  if ($('#gm')){
    $('#gm').onclick = () => { G.qty = Math.max(1, G.qty - 1); G.over = {}; renderGroup(); };
    $('#gp').onclick = () => { G.qty = Math.min(max, G.qty + 1); G.over = {}; renderGroup(); };
  }
  const stampItems = ids => G.members.filter(m => !ids || ids.includes(m.id)).map(m => ({userId: m.id, qty: memberQty(m.id)}));
  const doStamp = (btn, force, ids) => run(btn, async () => {
    G.note = $('#gnote') ? $('#gnote').value : G.note;
    const items = stampItems(ids);
    const d = await call('stamp_batch', {campaignId: S.campId, note: G.note, force: force, items});
    finishBatch(d.results, 'stamp', items);
  });
  if ($('#gAdd')) $('#gAdd').onclick = ev => doStamp(ev.currentTarget, false, null);
  if ($('#gForce')) $('#gForce').onclick = ev => doStamp(ev.currentTarget, true, G.cdFail.slice());
  if ($('#gAll')) $('#gAll').onclick = () => { const bs = box.querySelectorAll('.rdx'), all = [...bs].every(c => c.checked); bs.forEach(c => c.checked = !all); };
  if ($('#gRedeem')) $('#gRedeem').onclick = ev => run(ev.currentTarget, async () => {
    const picked = [...box.querySelectorAll('.rdx:checked')].map(c => G.rd[+c.dataset.i]);
    if (!picked.length) return toast('Centang reward yang akan ditukar', 'err');
    if (!await askConfirm(`Tukar ${picked.length} reward?`, 'Ya, tukar')) return;
    const items = picked.map(x => ({userId: x.m.id, cardId: x.k.id, rewardId: x.ms.id, label: x.ms.name}));
    const d = await call('redeem_batch', {items});
    finishBatch(d.results, 'redeem', items);
  });
}
function finishBatch(results, kind, items){
  G.cdFail = [];
  G.results = results.map((r, i) => {
    const idx = G.members.findIndex(x => x.id === r.userId), name = idx >= 0 ? G.members[idx].name : '?';
    if (r.ok){
      if (idx >= 0 && r.customer) G.members[idx] = r.customer;
      const text = kind === 'stamp' ? `+${items[i].qty} stamp${r.newCards ? ` (${r.newCards} kartu baru)` : ''}` : `${items[i].label} ditukar${r.cardDone ? ' • kartu selesai' : ''}`;
      return {ok: true, name, text};
    }
    if (r.code === 'COOLDOWN') G.cdFail.push(r.userId);
    return {ok: false, name, text: r.error};
  });
  const bad = results.filter(r => !r.ok).length;
  toast(`${results.length - bad} berhasil${bad ? `, ${bad} gagal` : ''}`, bad ? 'err' : 'ok');
  renderGroup(); loadActivity();
}

/* --- QR scanner --- */
let scanStream = null, scanRaf = 0;
function stopScan(){ cancelAnimationFrame(scanRaf); if (scanStream){ scanStream.getTracks().forEach(t => t.stop()); scanStream = null; } }
async function startScan(){
  const o = openModal(`<h3>Scan QR Pelanggan</h3>
    <video id="sv" playsinline muted></video><canvas id="sc" hidden></canvas>
    <p class="hint center" id="smsg">Arahkan kamera ke QR di HP pelanggan…</p>
    <label class="btn ghost" style="cursor:pointer">📷 Ambil foto QR<input id="sf" type="file" accept="image/*" capture="environment" hidden></label>
    <button class="btn danger" id="sx">Tutup</button>`);
  o._cleanup = stopScan;
  o.querySelector('#sx').onclick = closeModal;
  const libP = needJsqr();
  const video = o.querySelector('#sv'), canvas = o.querySelector('#sc'), ctx = canvas.getContext('2d', {willReadFrequently: true}), msg = o.querySelector('#smsg');
  let hold = false;
  const grp = () => { msg.classList.remove('err'); msg.textContent = `${G.members.length} orang di grup — arahkan ke QR berikutnya`; };
  const found = data => {
    if (G.on){ hold = true; run(null, () => doLookup(data)).then(grp).finally(() => setTimeout(() => { hold = false; }, 1200)); }
    else { closeModal(); run(null, () => doLookup(data)); }
  };
  o.querySelector('#sf').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { await libP; } catch(err){ msg.textContent = err.message; msg.classList.add('err'); return; }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1000 / Math.max(img.width, img.height));
      canvas.width = img.width * k; canvas.height = img.height * k; ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const r = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, {inversionAttempts: 'attemptBoth'});
      URL.revokeObjectURL(img.src);
      if (r && r.data) found(r.data); else { msg.textContent = 'QR tidak terbaca. Coba lebih dekat & terang.'; msg.classList.add('err'); }
    };
    img.src = URL.createObjectURL(f);
  };
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}}, audio: false});
    video.srcObject = scanStream; await video.play();
    const tick = () => {
      if (!scanStream) return;
      if (!hold && window.jsQR && video.readyState === video.HAVE_ENOUGH_DATA){
        const k = Math.min(1, 640 / video.videoWidth);
        canvas.width = video.videoWidth * k; canvas.height = video.videoHeight * k;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const r = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, {inversionAttempts: 'dontInvert'});
        if (r && r.data){ found(r.data); if (!G.on) return; }
      }
      scanRaf = requestAnimationFrame(tick);
    };
    tick();
  } catch(e){
    video.style.display = 'none';
    msg.classList.add('err');
    msg.textContent = 'Kamera langsung tidak bisa dibuka di sini. Gunakan "Ambil foto QR" di bawah, atau ketik kode/nomor HP.';
  }
}

/* ============================ ADMIN: EVENT ============================ */
async function viewEvents(){
  $('#view').innerHTML = '<div class="spin">Memuat…</div>';
  try { const d = await call('events_list'); renderEvents(d.events); } catch(e){ handleErr(e); }
}
function renderEvents(list){
  S.evAdmin = list;
  $('#view').innerHTML = `<section class="card"><div class="row between"><h3 style="margin:0">Hero Card Event</h3><button class="btn sm" id="evNew">+ Event</button></div>
    <p class="hint" style="margin:8px 0 0;font-size:13px">Event aktif dan dalam rentang waktunya tampil di beranda pelanggan.</p>
    <div id="evl">${list.length ? list.map(e => `<div class="ev-item"><div class="ev-th" ${safeUrl(e.image)?`data-img="${esc(e.image)}"`:''}></div>
      <div class="t" style="flex:1;min-width:0"><b>${esc(e.title)}</b><br><small>${e.start||e.end ? esc((e.start||'…').replace('T',' ')+' → '+(e.end||'…').replace('T',' ')) : 'Tanpa batas waktu'}</small></div>
      <span class="pill ${e.active?'':'off'}">${e.active?'Aktif':'Nonaktif'}</span>
      <button class="link" data-edit="${esc(e.id)}">Ubah</button></div>`).join('') : '<div class="empty">Belum ada event</div>'}</div></section>`;
  document.querySelectorAll('.ev-th[data-img]').forEach(el => el.style.backgroundImage = `url(${JSON.stringify(el.dataset.img)})`);
  $('#evNew').onclick = () => eventForm();
  $('#evl').onclick = e => { const b = e.target.closest('[data-edit]'); if (b) eventForm(S.evAdmin.find(x => x.id === b.dataset.edit)); };
}
function eventForm(e){
  e = e || {title:'', subtitle:'', badge:'Sedang Berlangsung', image:'', link:'', start:'', end:'', active:true, sort:0};
  const o = openModal(`<div class="row between"><h3>${e.id ? 'Ubah' : 'Tambah'} Event</h3><button class="x" id="mx">×</button></div>
    <label>Judul *</label><input id="f_t" maxlength="80" value="${esc(e.title)}" placeholder="Live Music Jumat Malam">
    <label>Sub-judul</label><input id="f_s" maxlength="140" value="${esc(e.subtitle)}" placeholder="Jumat 19.00 • Gratis">
    <label>Teks badge</label><input id="f_b" maxlength="30" value="${esc(e.badge)}">
    <label>Link gambar (https)</label><input id="f_i" value="${esc(e.image)}" placeholder="https:&#47;&#47;… atau link Google Drive (dibagikan ke 'Siapa saja')">
    <label>Link tujuan saat diklik (opsional)</label><input id="f_l" value="${esc(e.link)}" placeholder="https:&#47;&#47;…">
    <div class="row"><div style="flex:1"><label>Mulai</label><input id="f_st" type="datetime-local" value="${esc(e.start)}"></div><div style="flex:1"><label>Selesai</label><input id="f_en" type="datetime-local" value="${esc(e.end)}"></div></div>
    <div class="row"><div style="flex:1"><label>Urutan</label><input id="f_o" type="number" value="${e.sort}"></div></div>
    <label class="chk"><input type="checkbox" id="f_a" ${e.active?'checked':''}> Aktif</label>
    <button class="btn" id="fs">Simpan</button>
    ${e.id ? '<button class="btn danger" id="fd">Hapus Event</button>' : ''}`);
  o.querySelector('#mx').onclick = closeModal;
  o.querySelector('#fs').onclick = ev => run(ev.currentTarget, async () => {
    const d = await call('event_save', {id: e.id, title: o.querySelector('#f_t').value, subtitle: o.querySelector('#f_s').value, badge: o.querySelector('#f_b').value,
      image: o.querySelector('#f_i').value, link: o.querySelector('#f_l').value, start: o.querySelector('#f_st').value, end: o.querySelector('#f_en').value,
      sort: o.querySelector('#f_o').value, active: o.querySelector('#f_a').checked});
    closeModal(); renderEvents(d.events); toast('Event disimpan', 'ok');
  });
  const del = o.querySelector('#fd');
  if (del) del.onclick = async () => {
    if (!await askConfirm('Hapus event ini?', 'Hapus')) return;
    run(null, async () => { const d = await call('event_delete', {id: e.id}); closeModal(); renderEvents(d.events); toast('Event dihapus', 'ok'); });
  };
}

/* ============================ ADMIN: PENGATURAN ============================ */
async function viewAdmin(){
  $('#view').innerHTML = '<div class="spin">Memuat…</div>';
  try {
    const [st, cf, rw, cp] = await Promise.all([call('stats'), call('settings_get'), call('rewards_list'), call('campaigns_list')]);
    $('#view').innerHTML = `<section class="card"><h3>Ringkasan</h3><div class="tiles">
        <div class="tile"><b>${st.customers}</b><small>Pelanggan</small></div><div class="tile"><b>${st.stampsToday}</b><small>Stamp hari ini</small></div>
        <div class="tile"><b>${st.redeemToday}</b><small>Reward ditukar hari ini</small></div><div class="tile"><b>${st.redeemMonth}</b><small>Reward bulan ini</small></div></div></section>
      <section class="card" id="cpCard"></section>
      <section class="card" id="rwCard"></section>
      <section class="card"><h3>Aturan & Tampilan</h3><div id="sf"></div><button class="btn" id="ssave">Simpan Pengaturan</button></section>
      <section class="card"><h3>Pengguna & Peran</h3>
        <div class="row"><input id="uq" placeholder="Cari nama / nomor HP (kosong = staff)"><button class="btn sm" id="ugo">Cari</button></div>
        <p class="hint" style="font-size:12px;margin:8px 0 0">Calon kasir harus sudah pernah daftar/login sekali.</p><div class="list" id="ul"></div></section>`;
    renderCampaigns(cp.campaigns);
    renderRewards(rw.rewards);
    $('#sf').innerHTML = cf.fields.map(f => {
      const id = 'st_' + f.key;
      if (f.type === 'text') return `<label for="${id}">${esc(f.label)}</label><textarea id="${id}" rows="2" data-k="${f.key}">${esc(f.value)}</textarea>`;
      if (f.type === 'c') return `<label for="${id}">${esc(f.label)}</label><input id="${id}" type="color" data-k="${f.key}" value="${esc(f.value)}" style="height:46px;padding:4px">`;
      if (f.type === 'n') return `<label for="${id}">${esc(f.label)}</label><input id="${id}" type="number" data-k="${f.key}" min="${f.min}" max="${f.max}" value="${esc(f.value)}">`;
      return `<label for="${id}">${esc(f.label)}</label><input id="${id}" data-k="${f.key}" value="${esc(f.value)}">`;
    }).join('');
    $('#ssave').onclick = ev => run(ev.currentTarget, async () => {
      const values = {}; document.querySelectorAll('#sf [data-k]').forEach(el => values[el.dataset.k] = el.value);
      await call('settings_save', {values});
      const d = await call('bootstrap'); S.settings = d.settings; applyTheme(d.settings.theme_color);
      toast('Pengaturan disimpan', 'ok');
    });
    const search = () => run($('#ugo'), async () => {
      const d = await call('user_search', {q: $('#uq').value});
      $('#ul').innerHTML = d.users.length ? d.users.map(u => `<div><div class="t"><b>${esc(u.name)}</b><small>${esc(u.phone)} • ${esc(u.memberCode)} • ${u.stamps} total stamp</small></div>
        ${u.id === S.user.id ? '<span class="pill">Anda</span>' : `<select data-u="${esc(u.id)}" style="width:auto;padding:8px">
          ${['customer','cashier','admin'].map(r => `<option value="${r}" ${u.role===r?'selected':''}>${ROLE_LABEL[r]}</option>`).join('')}</select>
          <button class="link" data-t="${esc(u.id)}" data-a="${u.active?1:0}">${u.active ? 'Nonaktifkan' : 'Aktifkan'}</button>`}</div>`).join('') : '<div class="empty">Tidak ada hasil</div>';
    });
    $('#ugo').onclick = search; $('#uq').addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    $('#ul').onchange = e => { const s = e.target.closest('select[data-u]'); if (s) run(null, async () => { await call('user_update', {userId: s.dataset.u, role: s.value}); toast('Peran diubah', 'ok'); }); };
    $('#ul').onclick = e => { const b = e.target.closest('button[data-t]'); if (b) run(null, async () => { await call('user_update', {userId: b.dataset.t, active: b.dataset.a !== '1'}); toast('Status diubah', 'ok'); search(); }); };
    search();
  } catch(e){ handleErr(e); }
}

function renderCampaigns(list){
  S.campAdmin = list;
  $('#cpCard').innerHTML = `<div class="row between"><h3 style="margin:0">Event Stamp</h3><button class="btn sm" id="cpNew">+ Event</button></div>
    <p class="hint" style="font-size:13px;margin:8px 0 0">Setiap event punya kartu, periode, dan reward sendiri. Kasir memilih event saat memberi stamp.</p>
    <div class="list">${list.map(c => {
      const st = c.start || c.end ? esc((c.start || '…').replace('T', ' ') + ' → ' + (c.end || '…').replace('T', ' ')) : 'Berlaku sepanjang waktu';
      return `<div><span class="ico">${esc(c.icon)}</span><div class="t"><b>${esc(c.name)}</b><small>${st}${c.redeemUntil ? ' • tukar s/d ' + esc(c.redeemUntil.replace('T', ' ')) : ''}</small></div>
        <span class="pill ${c.active?'':'off'}">${c.active?'Aktif':'Nonaktif'}</span><button class="link" data-cp="${esc(c.id)}">Ubah</button></div>`;
    }).join('')}</div>`;
  $('#cpNew').onclick = () => campaignForm();
  $('#cpCard').onclick = e => { const b = e.target.closest('[data-cp]'); if (b) campaignForm(S.campAdmin.find(x => x.id === b.dataset.cp)); };
}
function campaignForm(c){
  c = c || {name:'', description:'', icon:'☕', start:'', end:'', redeemUntil:'', active:true, sort:0};
  const o = openModal(`<div class="row between"><h3>${c.id ? 'Ubah' : 'Tambah'} Event Stamp</h3><button class="x" id="mx">×</button></div>
    <label>Nama event *</label><input id="c_n" maxlength="60" value="${esc(c.name)}" placeholder="Ramadhan Spesial">
    <div class="row"><div style="flex:0 0 90px"><label>Ikon</label><input id="c_i" maxlength="4" value="${esc(c.icon)}"></div><div style="flex:1"><label>Deskripsi</label><input id="c_d" maxlength="140" value="${esc(c.description)}"></div></div>
    <div class="row"><div style="flex:1"><label>Mulai</label><input id="c_s" type="datetime-local" value="${esc(c.start)}"></div><div style="flex:1"><label>Selesai</label><input id="c_e" type="datetime-local" value="${esc(c.end)}"></div></div>
    <label>Reward masih bisa ditukar sampai</label><input id="c_u" type="datetime-local" value="${esc(c.redeemUntil)}">
    <p class="hint" style="font-size:12px;margin:6px 0 0">Kosongkan mulai/selesai untuk event tanpa batas waktu. Jika batas penukaran kosong, kartu hanya bisa ditukar sampai event selesai.</p>
    <label>Urutan tampil</label><input id="c_o" type="number" value="${c.sort}">
    <label class="chk"><input type="checkbox" id="c_a" ${c.active?'checked':''}> Aktif</label>
    <button class="btn" id="cs">Simpan</button>${c.id && c.id !== 'default' ? '<button class="btn danger" id="cd">Hapus</button>' : ''}`);
  o.querySelector('#mx').onclick = closeModal;
  o.querySelector('#cs').onclick = ev => run(ev.currentTarget, async () => {
    const q = id => o.querySelector(id);
    const d = await call('campaign_save', {id: c.id, name: q('#c_n').value, icon: q('#c_i').value, description: q('#c_d').value,
      start: q('#c_s').value, end: q('#c_e').value, redeemUntil: q('#c_u').value, sort: q('#c_o').value, active: q('#c_a').checked});
    closeModal(); renderCampaigns(d.campaigns); toast('Event stamp disimpan', 'ok');
    const rw = await call('rewards_list'); renderRewards(rw.rewards);
  });
  const del = o.querySelector('#cd');
  if (del) del.onclick = async () => {
    if (!await askConfirm('Hapus event ini beserta rewardnya?', 'Hapus')) return;
    run(null, async () => { const d = await call('campaign_delete', {id: c.id}); closeModal(); renderCampaigns(d.campaigns); const rw = await call('rewards_list'); renderRewards(rw.rewards); toast('Event dihapus', 'ok'); });
  };
}

function renderRewards(list){
  S.rwAdmin = list;
  const cname = id => { const c = (S.campAdmin || []).find(x => x.id === id); return c ? c.icon + ' ' + c.name : id; };
  $('#rwCard').innerHTML = `<div class="row between"><h3 style="margin:0">Reward & Milestone</h3><button class="btn sm" id="rwNew">+ Reward</button></div>
    <p class="hint" style="font-size:13px;margin:8px 0 0">Stamp menumpuk di satu kartu per event. Tiap reward diklaim sekali per kartu dan tidak mengurangi stamp. Kartu penuh yang belum selesai ditukar tetap disimpan, lalu stamp berikutnya mengisi kartu baru.</p>
    <div class="list">${list.length ? list.map(r => `<div><span class="ico ${r.active?'':'lk'}">${r.required}</span><div class="t"><b>${esc(r.name)}</b><small>${esc(cname(r.campaignId))}${r.description ? ' • ' + esc(r.description) : ''}</small></div>
      <span class="pill ${r.active?'':'off'}">${r.active?'Aktif':'Nonaktif'}</span><button class="link" data-rw="${esc(r.id)}">Ubah</button></div>`).join('') : '<div class="empty">Belum ada reward</div>'}</div>`;
  $('#rwNew').onclick = () => rewardForm();
  $('#rwCard').onclick = e => { const b = e.target.closest('[data-rw]'); if (b) rewardForm(S.rwAdmin.find(x => x.id === b.dataset.rw)); };
}
function rewardForm(r){
  r = r || {name:'', description:'', required:'', active:true, sort:0, campaignId:(S.campAdmin && S.campAdmin[0] ? S.campAdmin[0].id : 'default')};
  const o = openModal(`<div class="row between"><h3>${r.id ? 'Ubah' : 'Tambah'} Reward</h3><button class="x" id="mx">×</button></div>
    <label>Event stamp *</label><select id="w_c">${(S.campAdmin || []).map(c => `<option value="${esc(c.id)}" ${c.id===r.campaignId?'selected':''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select>
    <label>Nama reward *</label><input id="w_n" maxlength="80" value="${esc(r.name)}" placeholder="Gratis 1 minuman">
    <label>Deskripsi</label><input id="w_d" maxlength="140" value="${esc(r.description)}" placeholder="Semua menu minuman">
    <label>Tercapai di stamp ke- *</label><input id="w_r" type="number" min="1" max="100" value="${esc(r.required)}" placeholder="10">
    <label>Urutan (jika stamp sama)</label><input id="w_o" type="number" value="${r.sort}">
    <label class="chk"><input type="checkbox" id="w_a" ${r.active?'checked':''}> Aktif</label>
    <button class="btn" id="ws">Simpan</button>${r.id ? '<button class="btn danger" id="wd">Hapus</button>' : ''}`);
  o.querySelector('#mx').onclick = closeModal;
  o.querySelector('#ws').onclick = ev => run(ev.currentTarget, async () => {
    const d = await call('reward_save', {id: r.id, campaignId: o.querySelector('#w_c').value, name: o.querySelector('#w_n').value, description: o.querySelector('#w_d').value,
      required: o.querySelector('#w_r').value, sort: o.querySelector('#w_o').value, active: o.querySelector('#w_a').checked});
    closeModal(); renderRewards(d.rewards); toast('Reward disimpan', 'ok');
  });
  const del = o.querySelector('#wd');
  if (del) del.onclick = async () => {
    if (!await askConfirm('Hapus reward ini? (Riwayat penukaran tetap tersimpan)', 'Hapus')) return;
    run(null, async () => { const d = await call('reward_delete', {id: r.id}); closeModal(); renderRewards(d.rewards); toast('Reward dihapus', 'ok'); });
  };
}

init();


/* ============================ RASA APLIKASI HP ============================ */
function vib(p){ try { if (navigator.vibrate) navigator.vibrate(p); } catch(e){} }
document.addEventListener('click', e => { if (e.target.closest('.btn, .nav button, .chip, .seg button, .stepper button')) vib(8); }, true);

/* splash: tampil sampai aplikasi siap (minimal sebentar supaya tidak berkedip) */
const SPLASH_T0 = performance.now();
function hideSplash(){
  const el = document.getElementById('splash'); if (!el || el._gone) return; el._gone = true;
  const wait = Math.max(0, 650 - (performance.now() - SPLASH_T0));
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, wait);
}
setTimeout(hideSplash, 9000);

/* tarik ke bawah untuk memuat ulang */
let _ptrInit = false;
function initPtr(){
  if (_ptrInit) return; _ptrInit = true;
  let y0 = null, d = 0, busy = false;
  const ind = () => document.getElementById('ptr');
  window.addEventListener('touchstart', e => { y0 = (window.scrollY <= 0 && !modals.length && !busy) ? e.touches[0].clientY : null; d = 0; }, {passive: true});
  window.addEventListener('touchmove', e => {
    if (y0 == null) return;
    d = Math.max(0, e.touches[0].clientY - y0);
    const el = ind(); if (!el) return;
    if (d > 8 && window.scrollY <= 0){ const h = Math.min(70, d * .5); el.style.height = h + 'px'; el.style.opacity = Math.min(1, h / 50); el.classList.toggle('rdy', h >= 50); }
  }, {passive: true});
  window.addEventListener('touchend', async () => {
    const el = ind(); if (!el) { y0 = null; return; }
    const go_ = y0 != null && d * .5 >= 50; y0 = null;
    if (!go_){ el.style.height = '0'; el.style.opacity = 0; el.classList.remove('rdy'); return; }
    busy = true; el.classList.add('spinning'); el.style.height = '46px'; vib(12);
    try {
      if (S.user && S.user.role === 'customer') await enterAppQuiet(); else if (S.tab) go(S.tab);
    } catch(e){ handleErr(e); }
    el.classList.remove('spinning', 'rdy'); el.style.height = '0'; el.style.opacity = 0; busy = false;
  }, {passive: true});
}

/* info koneksi */
window.addEventListener('offline', () => toast('Tidak ada koneksi internet', 'err'));
window.addEventListener('online', () => toast('Kembali online', 'ok'));
