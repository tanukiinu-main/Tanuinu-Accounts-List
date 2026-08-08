export default {
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
          let locationInfo = '';

          try {
            const headers = {
              "User-Agent": "VRCMU/1.0 (VRChat private profile client)"
            };

            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/profile/${account.user_id}/private`, { headers });

            if (vrcRes.status === 429) {
              console.warn(`[Cron] 429 Rate limited for user ${account.user_id}`);
              return `${profileHashLower},offline,`;
            }

            if (vrcRes.ok) {
              const userData = await vrcRes.json();

              // ネストされた activity や presence、または直下から state と location を取得
              const activity = userData.activity || {};
              const presence = userData.presence || {};

              // state の判定 (activity.state -> userData.state の順で参照)
              const rawState = activity.state || userData.state || 'offline';
              const isOnline = rawState !== 'offline';

              if (isOnline) {
                status = 'online';

                // location の取得 (activity.location -> presence 構築 -> userData.location の順)
                let loc = activity.location || '';
                
                if (!loc && presence.world && presence.instance) {
                  loc = `${presence.world}:${presence.instance}`;
                }
                
                if (!loc) {
                  loc = userData.location || '';
                }

                // パブリックインスタンス判定
                const isPublic = typeof loc === 'string' &&
                  loc.startsWith('wrld_') &&
                  !loc.includes('~private') &&
                  !loc.includes('~friends') &&
                  !loc.includes('~hidden') &&
                  !loc.includes('~group');

                if (isPublic) {
                  locationInfo = loc;
                }
              }
            }
          } catch (e) {
            console.error(`[Cron] Error fetching VRC status for ${account.profile_hash}:`, e);
          }

          return `${profileHashLower},${status},${locationInfo}`;
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
