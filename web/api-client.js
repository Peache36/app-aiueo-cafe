/* Klien API: POST text/plain (tanpa preflight CORS) ke Edge Function Supabase. */
(function () {
  function post(arr) {
    var url = window.LS_API_URL;
    if (!url || /GANTI_/.test(url)) return Promise.reject(new Error('config.js belum diisi URL Edge Function Supabase.'));
    var ctl = ('AbortController' in window) ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 30000) : null;
    return fetch(url, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify(arr), signal: ctl ? ctl.signal : undefined})
      .then(function (r) { return r.text(); })
      .then(function (t) {
        if (timer) clearTimeout(timer);
        try { return JSON.parse(t); } catch (e) { throw new Error('Respons server tidak dikenali.'); }
      }, function (e) {
        if (timer) clearTimeout(timer);
        throw new Error(e && e.name === 'AbortError' ? 'Server terlalu lama merespons. Coba lagi.' : 'Gagal terhubung ke server');
      });
  }
  window.LSAPI = {post: post};
})();
