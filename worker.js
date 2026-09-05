const VERSION = "ROOT-TEST-20260905-02";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return new Response(
        JSON.stringify({
          ok: true,
          version: VERSION,
          message: "WORKER API IS RUNNING"
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=UTF-8",
            "Cache-Control": "no-store"
          }
        }
      );
    }

    if (url.pathname === "/api/test") {
      return new Response("API TEST OK - " + VERSION, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      });
    }

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);

      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    }

    return new Response(
      "ABSORPTION ROOT TEST OK\n" + VERSION,
      {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=UTF-8",
          "Cache-Control": "no-store"
        }
      }
    );
  }
};
