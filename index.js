export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateAllAccountsStatus(env));
  },

  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT id, status FROM statuses ORDER BY id ASC"
        ).all();

        const statusLines = results.map((row) => `${row.id}-${row.status}`);

        return new Response(statusLines.join("\n"), {
          headers: {
            ...corsHeaders,
            "Content-Type": "text/plain;charset=UTF-8",
            "Cache-Control": "no-cache",
          },
        });
      } catch (error) {
        return new Response("D1 Read Error", { status: 500, headers: corsHeaders });
      }
    }

    if (request.method === "POST") {
      const summary = await updateAllAccountsStatus(env);
      return new Response(JSON.stringify(summary), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  },
};

// 指定ミリ秒待機するヘルパー関数
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function updateAllAccountsStatus(env) {
  try {
    const { results: accounts } = await env.DB.prepare(
      "SELECT user_id, auth_cookie, email FROM accounts"
    ).all();

    if (!accounts || accounts.length === 0) {
      return { success: true, updatedCount: 0 };
    }

    let updatedCount = 0;

    for (const acc of accounts) {
      let success = false;
      let retries = 0;
      const maxRetries = 2; // 429時のリトライ上限

      while (!success && retries <= maxRetries) {
        try {
          const vrchatRes = await fetch(`https://api.vrchat.cloud/api/1/users/${acc.user_id}`, {
            headers: {
              "User-Agent": `TanuinuAccountsList/1.0 (${acc.email})`,
              "Cookie": `auth=${acc.auth_cookie}`,
            },
          });

          // 429 (Too Many Requests) が返ってきた場合
          if (vrchatRes.status === 429) {
            console.warn(`429 Too Many Requests on ${acc.user_id}. Waiting 8 seconds...`);
            await sleep(8000); // 8秒待機して再試行
            retries++;
            continue;
          }

          if (vrchatRes.ok) {
            const userData = await vrchatRes.json();
            const currentStatus = userData.state || userData.status || "offline";

            await env.DB.prepare(
              `INSERT INTO statuses (id, status, updated_at) 
               VALUES (?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(id) DO UPDATE SET 
                 status = excluded.status,
                 updated_at = CURRENT_TIMESTAMP`
            )
              .bind(acc.user_id, currentStatus)
              .run();

            updatedCount++;
            success = true;
          } else {
            console.error(`VRChat API Error (${acc.user_id}): HTTP ${vrchatRes.status}`);
            break; // 429以外のエラー（401 Unauthorized等）はリトライせずスキップ
          }
        } catch (err) {
          console.error(`Request Failed for ${acc.user_id}:`, err);
          break;
        }
      }

      // レート制限回避のため、次のアカウント処理まで 800ms 待機（1分間でちょうど60件処理できるペース）
      await sleep(800);
    }

    console.log(`Update complete: ${updatedCount}/${accounts.length}`);
    return { success: true, updatedCount, total: accounts.length };
  } catch (error) {
    console.error("Batch update error:", error);
    return { success: false, error: error.message };
  }
}
