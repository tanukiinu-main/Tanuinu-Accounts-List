export default {
  async fetch(request, env) {
    // CORS ヘッダー設定
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "text/plain; charset=utf-8"
    };

    // OPTIONS リクエスト（Preflight）の処理
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
    }

    try {
      // D1 データベースから指定のカラム名で取得
      const { results } = await env.DB.prepare(
        "SELECT profile_hash, user_id, auth_cookie FROM accounts"
      ).all();

      const outputLines = [];

      // 各アカウントの VRChat ステータスを取得
      for (const account of results) {
        let isOnline = false;

        if (account.user_id) {
          try {
            const headers = {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) VRChatStatusChecker/1.0"
            };

            // auth_cookie が存在する場合は認証Cookieを付与
            if (account.auth_cookie) {
              headers["Cookie"] = `auth=${account.auth_cookie}`;
            }

            const vrcRes = await fetch(`https://api.vrchat.cloud/api/1/users/${account.user_id}`, {
              headers: headers
            });

            if (vrcRes.ok) {
              const userData = await vrcRes.json();
              // offline 以外のステータス（active, join me など）をオンラインとみなす
              isOnline = userData.state !== "offline";
            }
          } catch (e) {
            console.error(`Error fetching VRC status for profile_hash ${account.profile_hash}:`, e);
          }
        }

        // user_id や email は露出させず、profile_hash とオンライン判定のみを出力
        outputLines.push(`${account.profile_hash.toLowerCase()}-${isOnline ? 'online' : 'offline'}`);
      }

      return new Response(outputLines.join('\n'), {
        headers: corsHeaders
      });

    } catch (error) {
      console.error("Worker Error:", error);
      return new Response("Internal Server Error", { status: 500, headers: corsHeaders });
    }
  }
};
