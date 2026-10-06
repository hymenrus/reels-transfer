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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = envKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const authorization = req.headers.get("authorization") || "";
  if (!supabaseUrl || !publishableKey || !serviceKey) return json({ error: "Supabase function configuration is incomplete." }, 503);
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Oturum açman gerekiyor." }, 401);

  const authClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Oturum doğrulanamadı." }, 401);
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.from("instagram_accounts").delete().eq("user_id", user.id);
  if (error) return json({ error: "Instagram bağlantısı kaldırılamadı." }, 500);
  return json({ connected: false });
});
