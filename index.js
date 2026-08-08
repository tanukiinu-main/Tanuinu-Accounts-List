export default {
  // -------------------------------------------------------------
  // 1. Cron Trigger: VRChat APIから無加工でデータを取得してKV保存
  // -------------------------------------------------------------
  async scheduled(event, env, ctx) {
    console.log("[Cron] VRChat status update started...");

    try {
      const { results } = await env.DB.prepare(
        "SELECT profile_hash, user_id, auth_cookie FROM accounts"
      ).all();

      if (!results || results.length === 0) {
        console.log("[Cron] No accounts found in database.");
        return;
      }

      const outputLines = [];
      const BATCH_SIZE = 2;
      const DELAY_MS = 300;

      for (let i = 0; i < results.length; i += BATCH_SIZE) {
        const batch = results.slice(i, i + BATCH_SIZE);

        const batchResults = await Promise.all(batch.map(async (account) => {
          const profileHashLower = account.profile_hash ? account.profile_hash.toLowerCase() : 'unknown';
          if (!account.user_id) return `${profileHashLower},offline,`;

          let status = 'offline';
          let rawLocation = '';

          try {
            const headers = {
              "User-Agent": "VRCMU/1.0 (VRChat private profile client)"
            };

            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            // auth/user または profile/private をコール
            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/auth/user`, { headers });

            if (vrcRes.status === 429) {
              console.warn(`[Cron] 429 Rate limited for user ${account.user_id}`);
              return `${profileHashLower},offline,`;
            }

            if (vrcRes.ok) {
              const userData = await vrcRes.json();

              const activity = userData.activity || {};
              const presence = userData.presence || {};

              // ステータスの正確な判定 (presence.status -> activity.state -> userData.state)
              status = presence.status || activity.state || userData.state || 'offline';

              // 生の location を一切フィルターせずにそのまま取得
              if (presence.world && presence.instance) {
                rawLocation = `${presence.world}:${presence.instance}`;
              } else if (activity.location) {
                rawLocation = activity.location;
              } else if (userData.location) {
                rawLocation = userData.location;
              }
            }
          } catch (e) {
            console.error(`[Cron] Error fetching VRC status for ${account.profile_hash}:`, e);
          }

          // フィルターなしで無加工出力: "hash,state,raw_location"
          return `${profileHashLower},${status},${rawLocation}`;
        }));

        outputLines.push(...batchResults);

        if (i + BATCH_SIZE < results.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
      }

      if (env.STATUS_CACHE) {
        await env.STATUS_CACHE.put("latest_status_data", outputLines.join('\n'));
        console.log("[Cron] Cache updated successfully.");
      } else {
        console.error("[Cron] Error: STATUS_CACHE KV binding is missing.");
      }

    } catch (error) {
      console.error("[Cron] Scheduled handler error:", error);
    }
  },

  // -------------------------------------------------------------
  // 2. HTTP Fetch: KVから無加工データをそのまま返却
  // -------------------------------------------------------------
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "text/plain; charset=utf-8"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    try {
      if (!env.STATUS_CACHE) {
        return new Response("KV Binding Error: STATUS_CACHE not configured", { status: 500, headers: corsHeaders });
      }

      const cachedData = await env.STATUS_CACHE.get("latest_status_data");

      if (cachedData === null) {
        return new Response("Data not ready yet (Waiting for first Cron execution)", { status: 503, headers: corsHeaders });
      }

      return new Response(cachedData, {
        status: 200,
        headers: corsHeaders
      });

    } catch (error) {
      console.error("[Fetch] Worker Error:", error);
      return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
    }
  }
};
