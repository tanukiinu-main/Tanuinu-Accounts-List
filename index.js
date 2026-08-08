export default {
  // -------------------------------------------------------------
  // 1. Cron Trigger: 定期実行でVRChat APIを叩いてKVへ保存
  // -------------------------------------------------------------
  async scheduled(event, env, ctx) {
    console.log("[Cron] VRChat status update started...");

    try {
      // D1 データベースから全アカウントを取得
      const { results } = await env.DB.prepare(
        "SELECT profile_hash, user_id, auth_cookie FROM accounts"
      ).all();

      if (!results || results.length === 0) {
        console.log("[Cron] No accounts found in database.");
        return;
      }

      const outputLines = [];
      const BATCH_SIZE = 2; // レートリミット回避のため2件ずつ処理
      const DELAY_MS = 300;  // バッチ間のウェイト（300ms）

      for (let i = 0; i < results.length; i += BATCH_SIZE) {
        const batch = results.slice(i, i + BATCH_SIZE);

        const batchResults = await Promise.all(batch.map(async (account) => {
          const profileHashLower = account.profile_hash ? account.profile_hash.toLowerCase() : 'unknown';
          if (!account.user_id) return `${profileHashLower},offline,`;

          let status = 'offline';
          let locationInfo = '';

          try {
            const headers = {
              "User-Agent": "VRChatStatusChecker/1.0 (contact: your-email@example.com)"
            };

            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            // profile/.../private エンドポイントを実行
            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/profile/${account.user_id}/private`, { headers });

            if (vrcRes.status === 429) {
              console.warn(`[Cron] 429 Rate limited for user ${account.user_id}`);
              return `${profileHashLower},offline,`;
            }

            if (vrcRes.ok) {
              const userData = await vrcRes.json();

              // オンライン判定 (state / status / presence のチェック)
              const isOnline = userData.state && userData.state !== "offline";

              if (isOnline) {
                status = 'online';

                // location または presence.location から取得
                const loc = userData.location || (userData.presence && userData.presence.location) || '';

                // パブリックインスタンス判定 (wrld_で始まり、非公開タグが含まれない)
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

          // CSV形式 (hash,status,location) で返却
          return `${profileHashLower},${status},${locationInfo}`;
        }));

        outputLines.push(...batchResults);

        // バッチ間ウェイト
        if (i + BATCH_SIZE < results.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
      }

      // KVバインディングが存在する場合、最新のステータスを一括保存
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
  // 2. HTTP Fetch: フロントエンドにはKVから超高速応答するのみ
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

      // KVからキャッシュ済みの文字列を取得
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
