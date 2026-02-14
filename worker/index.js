/**
 * Localyse — Cloudflare Worker Proxy
 *
 * Translates text layers via Azure Translator API with smart context formatting,
 * then optionally refines via GPT-4o-mini for contextual accuracy.
 * Includes per-user rate limiting (25 requests/day) via Cloudflare KV.
 * Also serves the privacy policy at GET /privacy.
 *
 * Deploy:
 *   npx wrangler kv namespace create RATE_LIMIT
 *   # Copy the id into wrangler.toml
 *   npx wrangler deploy
 *   npx wrangler secret put AZURE_TRANSLATOR_KEY
 *   npx wrangler secret put AZURE_TRANSLATOR_REGION
 *   npx wrangler secret put OPENAI_API_KEY   # optional — enables LLM refinement
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
// Abbreviation dictionary (bypass Azure for known short terms)
// ──────────────────────────────────────────────────────────────────────

/**
 * Common abbreviated terms that Azure Translator handles poorly.
 * Keyed by uppercase English abbreviation → { langCode: localised abbreviation }
 * Only covers concise forms. Full words go through Azure normally.
 */
const ABBREV_DICT = {
    // Abbreviated months
    JAN: { fr: "JANV", de: "JAN", es: "ENE", it: "GEN", pt: "JAN", nl: "JAN", pl: "STY", cs: "LED", da: "JAN", sv: "JAN", nb: "JAN", fi: "TAMMI", ro: "IAN", hu: "JAN", tr: "OCA", ru: "ЯНВ", uk: "СІЧ", ar: "يناير", ja: "1月", ko: "1월", zh: "1月", hi: "जन", th: "ม.ค.", vi: "Th1", id: "JAN", ms: "JAN", bg: "ЯНУ", hr: "SIJ", sk: "JAN", sl: "JAN", lt: "SAU", lv: "JAN", et: "JAAN", el: "ΙΑΝ", he: "ינו" },
    FEB: { fr: "FÉV", de: "FEB", es: "FEB", it: "FEB", pt: "FEV", nl: "FEB", pl: "LUT", cs: "ÚNO", da: "FEB", sv: "FEB", nb: "FEB", fi: "HELMI", ro: "FEB", hu: "FEB", tr: "ŞUB", ru: "ФЕВ", uk: "ЛЮТ", ar: "فبراير", ja: "2月", ko: "2월", zh: "2月", hi: "फर", th: "ก.พ.", vi: "Th2", id: "FEB", ms: "FEB", bg: "ФЕВ", hr: "VEL", sk: "FEB", sl: "FEB", lt: "VAS", lv: "FEB", et: "VEEBR", el: "ΦΕΒ", he: "פבר" },
    MAR: { fr: "MARS", de: "MÄR", es: "MAR", it: "MAR", pt: "MAR", nl: "MRT", pl: "MAR", cs: "BŘE", da: "MAR", sv: "MAR", nb: "MAR", fi: "MAALIS", ro: "MAR", hu: "MÁR", tr: "MAR", ru: "МАР", uk: "БЕР", ar: "مارس", ja: "3月", ko: "3월", zh: "3月", hi: "मार्च", th: "มี.ค.", vi: "Th3", id: "MAR", ms: "MAC", bg: "МАР", hr: "OŽU", sk: "MAR", sl: "MAR", lt: "KOV", lv: "MAR", et: "MÄRTS", el: "ΜΑΡ", he: "מרץ" },
    APR: { fr: "AVR", de: "APR", es: "ABR", it: "APR", pt: "ABR", nl: "APR", pl: "KWI", cs: "DUB", da: "APR", sv: "APR", nb: "APR", fi: "HUHTI", ro: "APR", hu: "ÁPR", tr: "NİS", ru: "АПР", uk: "КВІ", ar: "أبريل", ja: "4月", ko: "4월", zh: "4月", hi: "अप्रै", th: "เม.ย.", vi: "Th4", id: "APR", ms: "APR", bg: "АПР", hr: "TRA", sk: "APR", sl: "APR", lt: "BAL", lv: "APR", et: "APR", el: "ΑΠΡ", he: "אפר" },
    MAY: { fr: "MAI", de: "MAI", es: "MAY", it: "MAG", pt: "MAI", nl: "MEI", pl: "MAJ", cs: "KVĚ", da: "MAJ", sv: "MAJ", nb: "MAI", fi: "TOUKO", ro: "MAI", hu: "MÁJ", tr: "MAY", ru: "МАЙ", uk: "ТРА", ar: "مايو", ja: "5月", ko: "5월", zh: "5月", hi: "मई", th: "พ.ค.", vi: "Th5", id: "MEI", ms: "MEI", bg: "МАЙ", hr: "SVI", sk: "MÁJ", sl: "MAJ", lt: "GEG", lv: "MAI", et: "MAI", el: "ΜΑΪ", he: "מאי" },
    JUN: { fr: "JUIN", de: "JUN", es: "JUN", it: "GIU", pt: "JUN", nl: "JUN", pl: "CZE", cs: "ČER", da: "JUN", sv: "JUN", nb: "JUN", fi: "KESÄ", ro: "IUN", hu: "JÚN", tr: "HAZ", ru: "ИЮН", uk: "ЧЕР", ar: "يونيو", ja: "6月", ko: "6월", zh: "6月", hi: "जून", th: "มิ.ย.", vi: "Th6", id: "JUN", ms: "JUN", bg: "ЮНИ", hr: "LIP", sk: "JÚN", sl: "JUN", lt: "BIR", lv: "JŪN", et: "JUUNI", el: "ΙΟΥΝ", he: "יונ" },
    JUL: { fr: "JUIL", de: "JUL", es: "JUL", it: "LUG", pt: "JUL", nl: "JUL", pl: "LIP", cs: "ČVC", da: "JUL", sv: "JUL", nb: "JUL", fi: "HEINÄ", ro: "IUL", hu: "JÚL", tr: "TEM", ru: "ИЮЛ", uk: "ЛИП", ar: "يوليو", ja: "7月", ko: "7월", zh: "7月", hi: "जुल", th: "ก.ค.", vi: "Th7", id: "JUL", ms: "JUL", bg: "ЮЛИ", hr: "SRP", sk: "JÚL", sl: "JUL", lt: "LIE", lv: "JŪL", et: "JUULI", el: "ΙΟΥΛ", he: "יול" },
    AUG: { fr: "AOÛT", de: "AUG", es: "AGO", it: "AGO", pt: "AGO", nl: "AUG", pl: "SIE", cs: "SRP", da: "AUG", sv: "AUG", nb: "AUG", fi: "ELO", ro: "AUG", hu: "AUG", tr: "AĞU", ru: "АВГ", uk: "СЕР", ar: "أغسطس", ja: "8月", ko: "8월", zh: "8月", hi: "अग", th: "ส.ค.", vi: "Th8", id: "AGT", ms: "OGS", bg: "АВГ", hr: "KOL", sk: "AUG", sl: "AVG", lt: "RGP", lv: "AUG", et: "AUG", el: "ΑΥΓ", he: "אוג" },
    SEP: { fr: "SEPT", de: "SEP", es: "SEP", it: "SET", pt: "SET", nl: "SEP", pl: "WRZ", cs: "ZÁŘ", da: "SEP", sv: "SEP", nb: "SEP", fi: "SYYS", ro: "SEP", hu: "SZEP", tr: "EYL", ru: "СЕН", uk: "ВЕР", ar: "سبتمبر", ja: "9月", ko: "9월", zh: "9月", hi: "सित", th: "ก.ย.", vi: "Th9", id: "SEP", ms: "SEP", bg: "СЕП", hr: "RUJ", sk: "SEP", sl: "SEP", lt: "RGS", lv: "SEP", et: "SEPT", el: "ΣΕΠ", he: "ספט" },
    OCT: { fr: "OCT", de: "OKT", es: "OCT", it: "OTT", pt: "OUT", nl: "OKT", pl: "PAŹ", cs: "ŘÍJ", da: "OKT", sv: "OKT", nb: "OKT", fi: "LOKA", ro: "OCT", hu: "OKT", tr: "EKİ", ru: "ОКТ", uk: "ЖОВ", ar: "أكتوبر", ja: "10月", ko: "10월", zh: "10月", hi: "अक्टू", th: "ต.ค.", vi: "Th10", id: "OKT", ms: "OKT", bg: "ОКТ", hr: "LIS", sk: "OKT", sl: "OKT", lt: "SPL", lv: "OKT", et: "OKT", el: "ΟΚΤ", he: "אוק" },
    NOV: { fr: "NOV", de: "NOV", es: "NOV", it: "NOV", pt: "NOV", nl: "NOV", pl: "LIS", cs: "LIS", da: "NOV", sv: "NOV", nb: "NOV", fi: "MARRAS", ro: "NOI", hu: "NOV", tr: "KAS", ru: "НОЯ", uk: "ЛИС", ar: "نوفمبر", ja: "11月", ko: "11월", zh: "11月", hi: "नव", th: "พ.ย.", vi: "Th11", id: "NOV", ms: "NOV", bg: "НОЕ", hr: "STU", sk: "NOV", sl: "NOV", lt: "LAP", lv: "NOV", et: "NOV", el: "ΝΟΕ", he: "נוב" },
    DEC: { fr: "DÉC", de: "DEZ", es: "DIC", it: "DIC", pt: "DEZ", nl: "DEC", pl: "GRU", cs: "PRO", da: "DEC", sv: "DEC", nb: "DES", fi: "JOULU", ro: "DEC", hu: "DEC", tr: "ARA", ru: "ДЕК", uk: "ГРУ", ar: "ديسمبر", ja: "12月", ko: "12월", zh: "12月", hi: "दिस", th: "ธ.ค.", vi: "Th12", id: "DES", ms: "DIS", bg: "ДЕК", hr: "PRO", sk: "DEC", sl: "DEC", lt: "GRD", lv: "DEC", et: "DETS", el: "ΔΕΚ", he: "דצמ" },
    // Abbreviated weekdays
    MON: { fr: "LUN", de: "MO", es: "LUN", it: "LUN", pt: "SEG", nl: "MA", pl: "PON", cs: "PO", da: "MAN", sv: "MÅN", nb: "MAN", fi: "MA", ro: "LUN", hu: "HÉT", tr: "PZT", ru: "ПН", uk: "ПН", ar: "اثن", ja: "月", ko: "월", zh: "一", hi: "सोम", th: "จ.", vi: "T2", id: "SEN", ms: "ISN" },
    TUE: { fr: "MAR", de: "DI", es: "MAR", it: "MAR", pt: "TER", nl: "DI", pl: "WT", cs: "ÚT", da: "TIR", sv: "TIS", nb: "TIR", fi: "TI", ro: "MAR", hu: "KED", tr: "SAL", ru: "ВТ", uk: "ВТ", ar: "ثلا", ja: "火", ko: "화", zh: "二", hi: "मंगल", th: "อ.", vi: "T3", id: "SEL", ms: "SEL" },
    WED: { fr: "MER", de: "MI", es: "MIÉ", it: "MER", pt: "QUA", nl: "WO", pl: "ŚR", cs: "ST", da: "ONS", sv: "ONS", nb: "ONS", fi: "KE", ro: "MIE", hu: "SZE", tr: "ÇAR", ru: "СР", uk: "СР", ar: "أرب", ja: "水", ko: "수", zh: "三", hi: "बुध", th: "พ.", vi: "T4", id: "RAB", ms: "RAB" },
    THU: { fr: "JEU", de: "DO", es: "JUE", it: "GIO", pt: "QUI", nl: "DO", pl: "CZW", cs: "ČT", da: "TOR", sv: "TOR", nb: "TOR", fi: "TO", ro: "JOI", hu: "CSÜ", tr: "PER", ru: "ЧТ", uk: "ЧТ", ar: "خمي", ja: "木", ko: "목", zh: "四", hi: "गुरु", th: "พฤ.", vi: "T5", id: "KAM", ms: "KHA" },
    FRI: { fr: "VEN", de: "FR", es: "VIE", it: "VEN", pt: "SEX", nl: "VR", pl: "PT", cs: "PÁ", da: "FRE", sv: "FRE", nb: "FRE", fi: "PE", ro: "VIN", hu: "PÉN", tr: "CUM", ru: "ПТ", uk: "ПТ", ar: "جمع", ja: "金", ko: "금", zh: "五", hi: "शुक्र", th: "ศ.", vi: "T6", id: "JUM", ms: "JUM" },
    SAT: { fr: "SAM", de: "SA", es: "SÁB", it: "SAB", pt: "SÁB", nl: "ZA", pl: "SOB", cs: "SO", da: "LØR", sv: "LÖR", nb: "LØR", fi: "LA", ro: "SÂM", hu: "SZO", tr: "CUM", ru: "СБ", uk: "СБ", ar: "سبت", ja: "土", ko: "토", zh: "六", hi: "शनि", th: "ส.", vi: "T7", id: "SAB", ms: "SAB" },
    SUN: { fr: "DIM", de: "SO", es: "DOM", it: "DOM", pt: "DOM", nl: "ZO", pl: "NIE", cs: "NE", da: "SØN", sv: "SÖN", nb: "SØN", fi: "SU", ro: "DUM", hu: "VAS", tr: "PAZ", ru: "ВС", uk: "НД", ar: "أحد", ja: "日", ko: "일", zh: "日", hi: "रवि", th: "อา.", vi: "CN", id: "MIN", ms: "AHD" },
};

/**
 * Look up a short text in the abbreviation dictionary.
 * Returns the localised abbreviation or null if not found.
 * Matches case-insensitively, preserves original casing style.
 */
function lookupAbbrev(text, targetLocale) {
    const upper = text.trim().toUpperCase();
    const entry = ABBREV_DICT[upper];
    if (!entry) return null;

    // Azure codes can be "fr", "fr-ca", "zh-Hans", etc. — try exact, then base lang
    const baseLang = targetLocale.split("-")[0].toLowerCase();
    const match = entry[targetLocale] || entry[baseLang];
    if (!match) return null;

    // Preserve original casing style
    if (text === text.toUpperCase()) return match.toUpperCase();
    if (text === text.toLowerCase()) return match.toLowerCase();
    if (text[0] === text[0].toUpperCase()) {
        return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
    }
    return match;
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
    // Split layers into dictionary-resolved and needs-Azure
    const results = new Array(textLayers.length);
    const azureLayers = []; // { originalIndex, layer }

    for (let i = 0; i < textLayers.length; i++) {
        const layer = textLayers[i];
        const dictMatch = lookupAbbrev(layer.text, targetLocale);
        if (dictMatch !== null) {
            results[i] = { id: layer.id, translated: dictMatch };
        } else {
            azureLayers.push({ originalIndex: i, layer });
        }
    }

    // If all layers were resolved from dictionary, skip Azure entirely
    if (azureLayers.length === 0) return results;

    // Send remaining layers to Azure
    const contextLayers = azureLayers.map(({ layer }) => ({
        ...layer,
        contextText: `[${layer.layerName}] ${layer.text}`,
    }));
    const azureBody = contextLayers.map(l => ({ Text: l.contextText }));

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

    const azureResults = await response.json();

    // Merge Azure results back into the results array
    azureLayers.forEach(({ originalIndex, layer }, i) => {
        const translated = azureResults[i]?.translations?.[0]?.text || layer.text;
        results[originalIndex] = {
            id: layer.id,
            translated: stripContext(translated, layer.layerName),
        };
    });

    return results;
}

// ──────────────────────────────────────────────────────────────────────
// LLM contextual refinement (GPT-4o-mini)
// ──────────────────────────────────────────────────────────────────────

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

/**
 * Post-process Azure translations through GPT-4o-mini for contextual
 * refinement: currency conversion, date formatting, proper names,
 * and natural-sounding localised text.
 *
 * If OPENAI_API_KEY is not set, this gracefully returns the
 * original Azure translations unchanged.
 */
async function refineWithLLM(env, textLayers, azureResults, targetLocale, localeLabel, localeCurrencies) {
    // Skip if no OpenAI key configured — Azure results are used as-is
    if (!env.OPENAI_API_KEY) return azureResults;

    // Build a compact prompt with original text + Azure translation
    const pairs = azureResults.map((r, i) => ({
        id: r.id,
        layerName: textLayers[i]?.layerName || "",
        original: textLayers[i]?.text || "",
        azureTranslation: r.translated,
    }));

    const currencyHint = localeCurrencies && localeCurrencies.length > 0
        ? `The target locale uses these currencies: ${localeCurrencies.join(", ")}.`
        : "";

    const systemPrompt = `You are a UI localisation expert. You receive text layers from a design tool that have been machine-translated from English to locale "${targetLocale}" (${localeLabel || "unknown"}).
${currencyHint}

Your job is to REFINE these translations for contextual accuracy:
1. **Currencies**: Reformat currency values to the target locale's currency symbol and number format. Keep the SAME numeric value — do NOT apply exchange rates. ${currencyHint} For example, $49.99 → 49,99 € for German/EUR, $49.99 → ₹49.99 for Hindi/INR, $1,200.50 → 1.200,50 € for German/EUR. ALWAYS replace $ with the target locale's currency symbol and adjust decimal/thousands separators to match the locale's conventions.
2. **Dates & numbers**: Adapt date formats (MM/DD → DD/MM where appropriate) and number formatting (decimal separators, thousands separators).
3. **Abbreviations**: Keep abbreviated text short. If the original is 3 letters, the translation should be similarly concise.
4. **Tone & naturalness**: Make the text sound natural for a native speaker. Fix awkward machine translations.
5. **Proper names & brands**: Do NOT translate brand names, product names, or proper nouns.
6. **UI conventions**: Respect UI conventions for the target locale (e.g. "OK" stays "OK" in most languages).

IMPORTANT: Return ONLY a JSON array with objects { "id": "...", "translated": "..." }. No explanation, no markdown. Preserve the exact same "id" values. If a translation is already good, return it unchanged.`;

    const userPrompt = JSON.stringify(pairs);

    try {
        const response = await fetch(OPENAI_ENDPOINT, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                temperature: 0.3,
                max_tokens: 4096,
            }),
        });

        if (!response.ok) {
            // LLM refinement failed — return Azure translations as fallback
            console.error(`OpenAI refinement error (${response.status})`);
            return azureResults;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) return azureResults;

        // Parse the LLM output
        let refined;
        try {
            // Strip markdown code fences if present
            const cleaned = content.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
            refined = JSON.parse(cleaned);
        } catch {
            // Parsing failed — return Azure translations as fallback
            console.error("Failed to parse LLM refinement output");
            return azureResults;
        }

        if (!Array.isArray(refined)) return azureResults;

        // Merge LLM refinements back by ID
        const refinedMap = new Map();
        for (const r of refined) {
            if (r.id && typeof r.translated === "string") {
                refinedMap.set(r.id, r.translated);
            }
        }

        return azureResults.map(r => ({
            id: r.id,
            translated: refinedMap.get(r.id) || r.translated,
        }));
    } catch (err) {
        // Network or other error — return Azure translations as fallback
        console.error("LLM refinement failed:", err.message);
        return azureResults;
    }
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
            const { textLayers, targetLocale, localeLabel, localeCurrencies } = await request.json();

            if (!textLayers || !Array.isArray(textLayers) || !targetLocale) {
                return Response.json(
                    { error: "Invalid request. Expected { textLayers, targetLocale }." },
                    { status: 400, headers: CORS_HEADERS }
                );
            }

            // For same-language variants (e.g. en-US → en-IN), skip Azure
            // since it would return the text unchanged. Let the LLM handle
            // currency, date, and number format adaptation.
            const isSourceLanguage = targetLocale === "en" || targetLocale.startsWith("en-");

            let azureTranslations;
            if (isSourceLanguage) {
                // Pass-through: use original text as the "translation"
                azureTranslations = textLayers.map(l => ({
                    id: l.id,
                    translated: l.text,
                }));
            } else {
                azureTranslations = await translateWithAzure(env, textLayers, targetLocale);
            }

            // Contextual refinement via LLM (currency, dates, naturalness)
            // Skipped gracefully if OPENAI_API_KEY is not configured
            const translations = await refineWithLLM(env, textLayers, azureTranslations, targetLocale, localeLabel, localeCurrencies);

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
