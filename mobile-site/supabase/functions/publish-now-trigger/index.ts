import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://hymenrus.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function envKey(name: string, bundleName: string): string {
  const direct = Deno.env.get(name);
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get(bundleName) || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const publishableKey = envKey("SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEYS");
  const serviceKey = envKey("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEYS");
  const githubToken = Deno.env.get("GITHUB_WORKFLOW_TOKEN") || "";
  if (!supabaseUrl || !publishableKey || !serviceKey || !githubToken) {
    return json({ error: "Bulut işçisi sunucuda yapılandırılmamış." }, 503);
  }

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return json({ error: "Oturum açman gerekiyor." }, 401);
  }
  const authClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data: { user }, error: authError } = await authClient.auth.getUser();
  if (authError || !user) return json({ error: "Oturum doğrulanamadı; tekrar giriş yap." }, 401);

  const payload = await req.json().catch(() => ({})) as { reel_id?: unknown; video_import_id?: unknown };
  const reelId = typeof payload.reel_id === "string" ? payload.reel_id.trim() : "";
  const videoImportId = typeof payload.video_import_id === "string" ? payload.video_import_id.trim() : "";
  const isReelTrigger = Boolean(reelId) && !videoImportId && uuidPattern.test(reelId);
  const isImportTrigger = Boolean(videoImportId) && !reelId && uuidPattern.test(videoImportId);
  if (!isReelTrigger && !isImportTrigger) return json({ error: "İş tetikleme kimliği geçersiz." }, 400);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let pending: { id: string; status?: string } | null = null;
  let queueError: { message: string } | null = null;
  if (isReelTrigger) {
    const result = await admin
      .from("reels_queue")
      .select("id")
      .eq("id", reelId)
      .eq("user_id", user.id)
      .eq("status", "queued")
      .eq("publish_now", true)
      .eq("rights_confirmed", true)
      .limit(1)
      .maybeSingle();
    pending = result.data;
    queueError = result.error;
  } else {
    const result = await admin
      .from("video_import_jobs")
      .select("id,status")
      .eq("id", videoImportId)
      .eq("user_id", user.id)
      .in("status", ["queued", "processing", "ready"])
      .limit(1)
      .maybeSingle();
    pending = result.data;
    queueError = result.error;
  }
  if (queueError) return json({ error: "İş isteği doğrulanamadı." }, 503);
  if (!pending) return json({ error: "Bu hesaba ait bekleyen iş bulunamadı." }, 409);
  if (isImportTrigger && pending.status !== "queued") {
    const { count, error: pendingImportsError } = await admin
      .from("video_import_jobs")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "queued");
    if (pendingImportsError) return json({ error: "Bulut arşiv kuyruğu denetlenemedi." }, 503);
    if (!count) return json({ ok: true, already_started: true });
  }

  try {
    const response = await fetch(
      "https://api.github.com/repos/hymenrus/reels-transfer/actions/workflows/process-reels.yml/dispatches",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: isReelTrigger
            ? { target_reel_id: pending.id }
            : { max_video_imports: "3" },
        }),
      },
    );
    if (response.status !== 204) {
      console.error("GitHub workflow dispatch rejected; HTTP", response.status);
      return json({ error: "Bulut işçisi şu anda başlatılamadı." }, 502);
    }
  } catch {
      return json({ error: "Bulut işçisine ulaşılamadı." }, 502);
  }

  if (isReelTrigger) {
    const { error: stageError } = await admin
      .from("reels_queue")
      .update({ stage: "Hemen paylaşım tetiklendi", updated_at: new Date().toISOString() })
      .eq("id", pending.id)
      .eq("user_id", user.id)
      .eq("status", "queued")
      .eq("publish_now", true);
    if (stageError) console.error("Workflow dispatched but queue stage update failed.");
  }

  return json({ ok: true, dispatched: true });
});
