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
function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = envKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const appId = Deno.env.get("INSTAGRAM_APP_ID") || "";
  const appSiteUrl = Deno.env.get("APP_SITE_URL") || "https://hymenrus.github.io/reels-transfer/";
  const redirectUri = Deno.env.get("INSTAGRAM_REDIRECT_URI") || `${supabaseUrl.replace(/\/$/, "")}/functions/v1/instagram-oauth-callback`;
  if (!supabaseUrl || !publishableKey || !serviceKey) return json({ error: "Supabase function configuration is incomplete." }, 503);
  if (!appId) return json({ error: "Instagram bağlantısı henüz kurulmadı. Site yöneticisinin Meta App ayarlarını tamamlaması gerekiyor." }, 503);

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "Oturum açman gerekiyor." }, 401);
  const authClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authorization } } });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Oturum doğrulanamadı; tekrar giriş yap." }, 401);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const state = randomState();
  const stateHash = await sha256(state);
  const { error: insertError } = await admin.from("instagram_oauth_states").insert({
    state_hash: stateHash,
    user_id: user.id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  if (insertError) return json({ error: "Instagram bağlantısı başlatılamadı. Biraz sonra tekrar dene." }, 500);

  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "instagram_business_basic,instagram_business_content_publish");
  url.searchParams.set("state", state);
  url.searchParams.set("enable_fb_login", "false");
  return json({ authorization_url: url.toString(), app_site_url: appSiteUrl });
});
