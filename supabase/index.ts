// Edge Function "api" — satu-satunya pintu dari aplikasi web ke database.
// Browser mengirim POST (teks JSON): [action, token, payload]. Fungsi ini memanggil public.ls_api()
// dengan service role, dan bertugas mengirim OTP lewat WhatsApp (Fonnte).
//
// Secrets (Supabase > Edge Functions > Secrets):
//   FONNTE_TOKEN   token Fonnte untuk kirim WhatsApp
//   DEBUG_OTP      "true" = OTP hanya dicatat di log fungsi (UJI COBA saja!)
//   ALLOWED_ORIGIN (opsional) mis. https://nama-situs.netlify.app ; kosong = semua asal
// SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY tersedia otomatis.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FONNTE = Deno.env.get("FONNTE_TOKEN") ?? "";
const DEBUG = Deno.env.get("DEBUG_OTP") === "true";
const ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });

const fail = (error: string, code = "ERR") => json({ ok: false, error, code });

async function sendWhatsApp(phone: string, message: string): Promise<boolean> {
  if (!FONNTE) {
    if (DEBUG) { console.log(`[DEBUG OTP] ${phone} -> ${message}`); return true; }
    return false;
  }
  try {
    const res = await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: FONNTE },
      body: new URLSearchParams({ target: phone, message }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) { console.error("Fonnte error", JSON.stringify(body)); return false; }
    return true;
  } catch (e) {
    console.error("Fonnte fetch error", e);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") return json({ ok: true, api: "aiueo-loyalty", wa: !!FONNTE || DEBUG });
  if (req.method !== "POST") return fail("Metode tidak didukung", "BAD");

  let action = "", token: string | null = null, payload: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    if (raw.length > 200_000) return fail("Permintaan terlalu besar", "BAD");
    const a = JSON.parse(raw);
    action = String(a[0] ?? "");
    token = a[1] == null ? null : String(a[1]);
    payload = (a[2] && typeof a[2] === "object") ? a[2] : {};
  } catch {
    return fail("Permintaan tidak valid.", "BAD");
  }

  const { data, error } = await sb.rpc("ls_api", {
    p_action: action, p_token: token, p_payload: payload, p_meta: { wa: !!FONNTE || DEBUG },
  });
  if (error) {
    console.error("rpc error", error.message);
    return fail("Terjadi kesalahan di server. Coba lagi.");
  }

  // OTP: kirim WhatsApp lalu buang data rahasia sebelum dikirim ke browser
  if (data?.ok && data.data && data.data._send) {
    const s = data.data._send as { phone: string; message: string };
    delete data.data._send;
    const sent = await sendWhatsApp(s.phone, s.message);
    if (!sent) return fail("Gagal mengirim WhatsApp. Coba lagi beberapa saat lagi.");
  }
  return json(data);
});
