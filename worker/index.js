/**
 * Localyse — Cloudflare Worker Proxy
 *
 * Translates text layers via Azure Translator API with smart context formatting.
 * Includes per-user rate limiting (25 requests/day) via Cloudflare KV.
 * Also serves the privacy policy at GET /privacy.
 *
 * Deploy:
 *   npx wrangler kv namespace create RATE_LIMIT
 *   # Copy the id into wrangler.toml
 *   npx wrangler deploy
 *   npx wrangler secret put AZURE_TRANSLATOR_KEY
 *   npx wrangler secret put AZURE_TRANSLATOR_REGION
 */

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-User-Id",
};

const DAILY_LIMIT = 25;
const DAY_IN_SECONDS = 86400;

const AZURE_ENDPOINT = "https://api.cognitive.microsofttranslator.com/translate";
const AZURE_API_VERSION = "3.0";

// ──────────────────────────────────────────────────────────────────────
// Rate limiting
// ──────────────────────────────────────────────────────────────────────

async function checkRateLimit(env, userId) {
    const key = `rate:${userId}`;
    const current = parseInt(await env.RATE_LIMIT.get(key)) || 0;

    if (current >= DAILY_LIMIT) {
        return { allowed: false, remaining: 0 };
    }

    await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: DAY_IN_SECONDS });
    return { allowed: true, remaining: DAILY_LIMIT - current - 1 };
}

// ──────────────────────────────────────────────────────────────────────
// Smart context formatting
// ──────────────────────────────────────────────────────────────────────

/**
 * Prepend layer name as a context hint for more accurate translations.
 * Format: "[LayerName] text to translate"
 * After translation, the prefix is stripped from the result.
 */
function addContext(textLayers) {
    return textLayers.map(layer => ({
        ...layer,
        contextText: `[${layer.layerName}] ${layer.text}`,
    }));
}

function stripContext(translatedText, layerName) {
    // Azure may translate the context prefix too — try to strip it
    // Look for ] followed by a space near the start
    const bracketEnd = translatedText.indexOf("] ");
    if (bracketEnd !== -1 && bracketEnd < layerName.length + 20) {
        return translatedText.substring(bracketEnd + 2).trim();
    }
    return translatedText.trim();
}

// ──────────────────────────────────────────────────────────────────────
// Azure Translator
// ──────────────────────────────────────────────────────────────────────

async function translateWithAzure(env, textLayers, targetLocale) {
    const layersWithContext = addContext(textLayers);

    const azureBody = layersWithContext.map(l => ({ Text: l.contextText }));

    const url = `${AZURE_ENDPOINT}?api-version=${AZURE_API_VERSION}&to=${targetLocale}`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY,
            "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(azureBody),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Azure Translator error (${response.status}): ${errText.slice(0, 200)}`);
    }

    const results = await response.json();

    // Azure returns [{translations: [{text: "...", to: "xx"}]}] per input
    return textLayers.map((layer, i) => {
        const translated = results[i]?.translations?.[0]?.text || layer.text;
        return {
            id: layer.id,
            translated: stripContext(translated, layer.layerName),
        };
    });
}

// ──────────────────────────────────────────────────────────────────────
// Privacy policy
// ──────────────────────────────────────────────────────────────────────

const PRIVACY_POLICY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Localyse — Privacy Policy</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      line-height:1.7;color:#1a1a2e;background:#fafafa;padding:40px 20px}
    .container{max-width:640px;margin:0 auto;background:#fff;border-radius:12px;
      padding:40px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
    h1{font-size:22px;margin-bottom:4px}
    .subtitle{color:#666;font-size:14px;margin-bottom:28px}
    h2{font-size:16px;margin:24px 0 8px;color:#333}
    p,li{font-size:14px;color:#444}
    ul{padding-left:20px;margin:8px 0}
    li{margin:4px 0}
    .highlight{background:#f0f4ff;border-left:3px solid #6c5ce7;padding:12px 16px;
      border-radius:0 8px 8px 0;margin:16px 0;font-size:13px}
    a{color:#6c5ce7}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999}
  </style>
</head>
<body>
  <div class="container">
    <h1>Privacy Policy</h1>
    <p class="subtitle">Localyse — Figma Plugin &middot; Last updated: February 2025</p>

    <h2>What Localyse Does</h2>
    <p>Localyse is a Figma plugin that translates text layers in your design frames into
    multiple locales. It helps designers create localised versions of their designs
    directly on the Figma canvas.</p>

    <h2>Data We Process</h2>
    <p>When you click <strong>Generate Translations</strong>, the following data is sent to our
    translation proxy:</p>
    <ul>
      <li><strong>Text content</strong> from the text layers in your selected frame</li>
      <li><strong>Layer names</strong> (used as context hints for more accurate translations)</li>
      <li><strong>Target locale code</strong> (e.g. fr, ja, ar)</li>
      <li><strong>Your Figma user ID</strong> (used solely for rate limiting — 25 requests/day)</li>
    </ul>

    <div class="highlight">
      <strong>We do not collect, store, or log any of your design content.</strong> Text is forwarded to
      the translation service in real time and the response is returned to your plugin. Nothing is
      persisted on our servers. Your Figma user ID is stored temporarily (up to 24 hours) in an
      encrypted counter for rate limiting purposes only.
    </div>

    <h2>Third-Party Services</h2>
    <p>Translations are powered by <strong>Microsoft Azure Translator</strong>. Your text content is
    sent to Azure's Translator API to generate translations. Microsoft's use of this data is governed by
    their <a href="https://learn.microsoft.com/en-us/legal/cognitive-services/translator/transparency-note" target="_blank">Translator
    transparency note</a> and <a href="https://privacy.microsoft.com/en-us/privacystatement" target="_blank">Privacy Statement</a>.
    Azure Translator does not store your submitted text after translation is complete.</p>

    <h2>Data We Do NOT Collect</h2>
    <ul>
      <li>Your Figma account email or name</li>
      <li>Your design files or images</li>
      <li>Analytics, cookies, or tracking data</li>
      <li>Any personally identifiable information beyond the anonymous Figma user ID</li>
    </ul>

    <h2>Rate Limiting</h2>
    <p>To ensure fair usage, each user is limited to <strong>25 translation requests per day</strong>.
    Your anonymous Figma user ID is stored in a temporary counter that automatically expires after
    24 hours. No other data is associated with this counter.</p>

    <h2>Data Storage</h2>
    <p>Localyse does not have a database. The translation proxy is a stateless Cloudflare Worker.
    The only stored data is a temporary rate-limit counter (user ID → request count) that
    auto-deletes after 24 hours.</p>

    <h2>Your Rights</h2>
    <p>Since we do not store personal data beyond a temporary anonymous counter, there is
    nothing to request deletion of. The counter expires automatically. If you have any
    questions or concerns, please contact us.</p>

    <h2>Contact</h2>
    <p>For privacy-related questions, reach out at
    <a href="mailto:adiramanan98@gmail.com">adiramanan98@gmail.com</a>.</p>

    <div class="footer">
      This policy may be updated from time to time. Changes will be reflected on this page
      with an updated date.
    </div>
  </div>
</body>
</html>`;

// ──────────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        // Serve privacy policy at GET /privacy
        if (request.method === "GET" && url.pathname === "/privacy") {
            return new Response(PRIVACY_POLICY_HTML, {
                status: 200,
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        }

        // Only allow POST for translations
        if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
        }

        // Validate secrets
        if (!env.AZURE_TRANSLATOR_KEY || !env.AZURE_TRANSLATOR_REGION) {
            return Response.json(
                { error: "Server misconfigured: missing Azure Translator credentials." },
                { status: 500, headers: CORS_HEADERS }
            );
        }

        // Rate limiting — get user ID from header
        const userId = request.headers.get("X-User-Id") || "anonymous";
        const rateCheck = await checkRateLimit(env, userId);

        if (!rateCheck.allowed) {
            return Response.json(
                {
                    error: "Daily limit reached (25 translations/day). Please try again tomorrow.",
                    rateLimited: true,
                },
                {
                    status: 429,
                    headers: {
                        ...CORS_HEADERS,
                        "X-RateLimit-Remaining": "0",
                    },
                }
            );
        }

        try {
            const { textLayers, targetLocale } = await request.json();

            if (!textLayers || !Array.isArray(textLayers) || !targetLocale) {
                return Response.json(
                    { error: "Invalid request. Expected { textLayers, targetLocale }." },
                    { status: 400, headers: CORS_HEADERS }
                );
            }

            const translations = await translateWithAzure(env, textLayers, targetLocale);

            return Response.json(translations, {
                status: 200,
                headers: {
                    ...CORS_HEADERS,
                    "X-RateLimit-Remaining": String(rateCheck.remaining),
                },
            });
        } catch (err) {
            return Response.json(
                { error: "Translation error: " + (err.message || "unknown") },
                { status: 502, headers: CORS_HEADERS }
            );
        }
    },
};
