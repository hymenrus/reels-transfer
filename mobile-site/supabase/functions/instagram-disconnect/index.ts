import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: corsHeaders });
function envKey(name: string, bundleName: string): string {
  const direct = Deno.env.get(name);
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get(bundleName) || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch { return ""; }
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = envKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const authorization = req.headers.get("authorization") || "";
  if (!supabaseUrl || !publishableKey || !serviceKey) return json({ error: "Supabase function configuration is incomplete." }, 503);
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Oturum açman gerekiyor." }, 401);

  let requestedAccountId = "";
  try {
    const body = await req.json();
    requestedAccountId = typeof body?.account_id === "string" ? body.account_id : "";
  } catch {
    return json({ error: "Geçerli bir Instagram hesabı seç." }, 400);
  }
  if (requestedAccountId && !UUID_RE.test(requestedAccountId)) return json({ error: "Geçerli bir Instagram hesabı seç." }, 400);

  const authClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Oturum doğrulanamadı." }, 401);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  if (!requestedAccountId) {
    // Backwards-compatible only when there is exactly one active account; never disconnect all accounts.
    const { data, error } = await admin.from("instagram_accounts")
      .select("id")
      .eq("user_id", user.id)
      .is("disconnected_at", null)
      .order("connected_at", { ascending: false })
      .limit(2);
    if (error) return json({ error: "Instagram hesabı bulunamadı." }, 500);
    if (!data?.length) return json({ connected: false });
    if (data.length !== 1) return json({ error: "Kesilecek Instagram hesabını seç." }, 400);
    requestedAccountId = String(data[0].id);
  }

  const { data: account, error: lookupError } = await admin.from("instagram_accounts")
    .select("id")
    .eq("id", requestedAccountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (lookupError) return json({ error: "Instagram hesabı doğrulanamadı." }, 500);
  if (!account) return json({ error: "Bu Instagram hesabı sana ait değil veya artık mevcut değil." }, 404);

  const { data: disconnected, error: disconnectError } = await admin.rpc("disconnect_instagram_account", {
    p_user_id: user.id,
    p_instagram_account_id: requestedAccountId,
  });
  if (disconnectError) return json({ error: "Instagram bağlantısı kaldırılamadı." }, 500);
  if (disconnected !== true) return json({ error: "Instagram hesabı artık mevcut değil." }, 404);
  return json({ connected: false });
});
