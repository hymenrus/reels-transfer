import { createClient } from "npm:@supabase/supabase-js@2";

function envKey(name: string, bundleName: string): string {
  const direct = Deno.env.get(name);
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get(bundleName) || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch { return ""; }
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function appRedirect(result: string): Response {
  const base = Deno.env.get("APP_SITE_URL") || "https://hymenrus.github.io/reels-transfer/";
  const target = new URL(base);
  target.searchParams.set("instagram", result);
  return Response.redirect(target.toString(), 302);
}
function grantedScopes(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return new Response("GET required", { status: 405 });
  const requestUrl = new URL(req.url);
  const code = requestUrl.searchParams.get("code") || "";
  const state = requestUrl.searchParams.get("state") || "";
  const metaError = requestUrl.searchParams.get("error");
  if (!state) return appRedirect("state_invalid");

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const appId = Deno.env.get("INSTAGRAM_APP_ID") || "";
  const appSecret = Deno.env.get("INSTAGRAM_APP_SECRET") || "";
  const redirectUri = Deno.env.get("INSTAGRAM_REDIRECT_URI") || `${supabaseUrl.replace(/\/$/, "")}/functions/v1/instagram-oauth-callback`;
  if (!supabaseUrl || !serviceKey || !appId || !appSecret) return appRedirect("setup_required");

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: stateRow, error: stateError } = await admin
    .from("instagram_oauth_states")
    .delete()
    .eq("state_hash", await sha256(state))
    .gt("expires_at", new Date().toISOString())
    .select("user_id")
    .maybeSingle();
  if (stateError || !stateRow?.user_id) return appRedirect("state_invalid");
  if (metaError || !code) return appRedirect("cancelled");

  try {
    const form = new FormData();
    form.set("client_id", appId);
    form.set("client_secret", appSecret);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", redirectUri);
    form.set("code", code);
    const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
    const shortBody = await shortResponse.json();
    const shortData = Array.isArray(shortBody.data) ? shortBody.data[0] : shortBody;
    const shortToken = String(shortData?.access_token || "");
    const permissions = grantedScopes(shortData?.permissions);
    if (!shortResponse.ok || !shortToken) return appRedirect("token_exchange_failed");

    const required = ["instagram_business_basic", "instagram_business_content_publish"];
    if (!required.every((scope) => permissions.includes(scope))) return appRedirect("permissions_missing");

    const longUrl = new URL("https://graph.instagram.com/access_token");
    longUrl.searchParams.set("grant_type", "ig_exchange_token");
    longUrl.searchParams.set("client_secret", appSecret);
    longUrl.searchParams.set("access_token", shortToken);
    const longResponse = await fetch(longUrl.toString());
    const longBody = await longResponse.json();
    const longToken = String(longBody?.access_token || "");
    const expiresIn = Number(longBody?.expires_in || 0);
    if (!longResponse.ok || !longToken || !Number.isFinite(expiresIn) || expiresIn < 3600) return appRedirect("long_token_failed");

    const profileUrl = new URL("https://graph.instagram.com/v26.0/me");
    profileUrl.searchParams.set("fields", "user_id,username");
    const profileResponse = await fetch(profileUrl.toString(), { headers: { Authorization: `Bearer ${longToken}` } });
    const profile = await profileResponse.json();
    const instagramUserId = String(profile?.user_id || profile?.id || shortData?.user_id || "");
    const username = String(profile?.username || "");
    if (!profileResponse.ok || !instagramUserId || !username) return appRedirect("profile_lookup_failed");

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const { error: saveError } = await admin.rpc("save_instagram_connection", {
      p_user_id: stateRow.user_id,
      p_instagram_user_id: instagramUserId,
      p_username: username,
      p_access_token: longToken,
      p_token_expires_at: expiresAt,
      p_granted_scopes: permissions,
    });
    if (saveError) {
      // Do not log API responses or OAuth tokens; unique-account conflicts are handled as a safe generic error.
      console.error("Instagram connection could not be saved.");
      return appRedirect("account_already_linked");
    }
    return appRedirect("connected");
  } catch (error) {
    console.error("Instagram OAuth callback failed:", error instanceof Error ? error.name : "unknown");
    return appRedirect("connection_failed");
  }
});
