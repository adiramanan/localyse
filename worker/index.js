/**
 * Localyse — Cloudflare Worker Proxy
 *
 * Forwards translation requests from the Figma plugin to the OpenAI API,
 * attaching the API key stored as a Cloudflare secret.
 *
 * Deploy:
 *   npx wrangler deploy
 *   npx wrangler secret put OPENAI_API_KEY
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Only allow POST
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }

    // Validate that the secret is configured
    if (!env.OPENAI_API_KEY) {
      return Response.json(
        { error: { message: "Server misconfigured: missing API key." } },
        { status: 500, headers: CORS_HEADERS }
      );
    }

    try {
      const body = await request.text();

      const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        },
        body,
      });

      // Stream the OpenAI response back to the plugin
      const responseBody = await openaiRes.text();
      return new Response(responseBody, {
        status: openaiRes.status,
        headers: {
          "Content-Type": "application/json",
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      return Response.json(
        { error: { message: "Proxy error: " + (err.message || "unknown") } },
        { status: 502, headers: CORS_HEADERS }
      );
    }
  },
};
