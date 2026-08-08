export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "text/plain; charset=utf-8"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

    try {
      const { results } = await env.DB.prepare(
        "SELECT profile_hash, user_id, auth_cookie FROM accounts"
      ).all();

      const outputLines = [];
      const BATCH_SIZE = 3; // 同時リクエスト数を制限
      const DELAY_MS = 200;  // バッチ間のウェイト時間

      for (let i = 0; i < results.length; i += BATCH_SIZE) {
        const batch = results.slice(i, i + BATCH_SIZE);

        const batchResults = await Promise.all(batch.map(async (account) => {
          const profileHashLower = account.profile_hash.toLowerCase();
          
          if (!account.user_id) return `${profileHashLower}-offline`;

          // 1. KVキャッシュチェック (1-3分程度キャッシュしてAPI負荷を下げる)
          const cacheKey = `status:${account.user_id}`;
          if (env.STATUS_CACHE) {
            const cached = await env.STATUS_CACHE.get(cacheKey);
            if (cached) return `${profileHashLower}-${cached}`;
          }

          let status = 'offline';
          let locationInfo = '';

          try {
            // 2. VRChat APIの利用規約に沿ったUser-Agent形式に変更
            const headers = {
              "User-Agent": "VRChatStatusChecker/1.0 (contact: your-email@example.com)"
            };

            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/users/${account.user_id}`, { headers });

            if (vrcRes.status === 429) {
              console.warn(`429 Rate limited for user ${account.user_id}`);
              return `${profileHashLower}-rate_limited`;
            }

            if (vrcRes.ok) {
              const userData = await vrcRes.json();

              if (userData.state !== "offline") {
                status = 'online';
                const loc = userData.location || '';
                const isPublic = loc.startsWith('wrld_') &&
                  !loc.includes('~private') &&
                  !loc.includes('~friends') &&
                  !loc.includes('~hidden');

                if (isPublic) locationInfo = loc;
              }
            }

            const resultStr = locationInfo ? `${status}-${locationInfo}` : status;

            // Cache API結果 (120秒)
            if (env.STATUS_CACHE) {
              await env.STATUS_CACHE.put(cacheKey, resultStr, { expirationTtl: 120 });
            }

            return `${profileHashLower}-${resultStr}`;

          } catch (e) {
            console.error(`Error fetching VRC status for ${account.profile_hash}:`, e);
            return `${profileHashLower}-error`;
          }
        }));

        outputLines.push(...batchResults);

        // バッチ間にウェイトを挟む
        if (i + BATCH_SIZE < results.length) {
          await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
      }

      return new Response(outputLines.join('\n'), { headers: corsHeaders });

    } catch (error) {
      console.error("Worker Error:", error);
      return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
    }
  }
};
