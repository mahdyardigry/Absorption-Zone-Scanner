const VERSION = "ROOT-TEST-WORKER-20260905-01";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          worker: VERSION,
          time: new Date().toISOString(),
          assets: !!env.ASSETS,
          message: "WORKER IS REALLY RUNNING"
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store, no-cache, must-revalidate"
          }
        }
      );
    }

    if (url.pathname === "/api/test") {
      return new Response(
        JSON.stringify({
          ok: true,
          test: "API-TEST-20260905",
          worker: VERSION
        }),
        {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          }
        }
      );
    }

    if (env.ASSETS) {
      const assetResponse = await env.ASSETS.fetch(request);

      if (assetResponse.status !== 404) {
        const headers = new Headers(assetResponse.headers);
        headers.set("cache-control", "no-store, no-cache, must-revalidate");
        headers.set("x-root-test", VERSION);

        return new Response(assetResponse.body, {
          status: assetResponse.status,
          headers
        });
      }
    }

    return new Response(
      `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ROOT TEST</title>
<style>
body{
  margin:0;
  background:#0b1020;
  color:#fff;
  font-family:Arial,sans-serif;
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:100vh;
}
.box{
  width:min(700px,90%);
  background:#111827;
  border:1px solid #334155;
  border-radius:20px;
  padding:30px;
  box-sizing:border-box;
}
h1{color:#22c55e}
pre{
  white-space:pre-wrap;
  background:#020617;
  padding:15px;
  border-radius:12px;
}
</style>
</head>
<body>
<div class="box">
<h1>ROOT TEST</h1>
<p>اگر این صفحه را می‌بینی، Worker جدید اجرا شده است.</p>
<pre id="result">در حال بررسی...</pre>
</div>

<script>
(async()=>{
  const el=document.getElementById("result");

  try{
    const r=await fetch("/api/health?x="+Date.now(),{
      cache:"no-store"
    });

    const text=await r.text();

    el.textContent =
      "HTTP: "+r.status+"\\n\\n"+
      text;
  }catch(e){
    el.textContent="ERROR:\\n"+e.message;
  }
})();
</script>
</body>
</html>`,
      {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, no-cache, must-revalidate"
        }
      }
    );
  }
};

export class CollectorDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response(
      JSON.stringify({
        ok: true,
        do: "CollectorDO",
        version: VERSION
      }),
      {
        headers: {
          "content-type": "application/json; charset=utf-8"
        }
      }
    );
  }
}
