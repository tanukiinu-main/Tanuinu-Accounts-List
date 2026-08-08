export default {
  async fetch(request, env) {
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
      const { results } = await env.DB.prepare(
        "SELECT profile_hash, user_id, auth_cookie FROM accounts"
      ).all();

      // 各アカウントのVRChat APIリクエストを並列実行（高速化）
      const outputLines = await Promise.all(results.map(async (account) => {
        let status = 'offline';
        let locationInfo = '';

        if (account.user_id) {
          try {
            const headers = {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VRChatStatusChecker/1.0"
            };

            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/users/${account.user_id}`, {
              headers: headers
            });

            if (vrcRes.ok) {
              const userData = await vrcRes.json();
              
              if (userData.state !== "offline") {
                status = 'online';
                
                // パブリックインスタンスの判定
                // (locationが wrld_ で始まり、private / friends / hidden などの制限が含まれない)
                const loc = userData.location || '';
                const isPublic = loc.startsWith('wrld_') && 
                                 !loc.includes('~private') && 
                                 !loc.includes('~friends') && 
                                 !loc.includes('~hidden');

                if (isPublic) {
                  // "wrld_xxx:12345" などの文字列を抽出
                  locationInfo = loc;
                }
              }
            }
          } catch (e) {
            console.error(`Error fetching VRC status for ${account.profile_hash}:`, e);
          }
        }

        // 返却フォーマット: "hash-online-wrld_xxx:12345" または "hash-offline"
        return locationInfo 
          ? `${account.profile_hash.toLowerCase()}-${status}-${locationInfo}`
          : `${account.profile_hash.toLowerCase()}-${status}`;
      }));

      return new Response(outputLines.join('\n'), {
        headers: corsHeaders
      });

    } catch (error) {
      console.error("Worker Error:", error);
      return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
    }
  }
};
