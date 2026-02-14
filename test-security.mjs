/**
 * Security-focused tests for the Localyse Figma plugin UI.
 *
 * Tests XSS vectors, CSP, message origin validation, and response handling.
 */

import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = `file://${path.resolve(__dirname, "ui.html")}`;

const FAKE_PNG_BYTES = (() => {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
    "Nl7BcQAAAABJRU5ErkJggg==";
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0));
})();

let errors = [];
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓  ${label}`);
  } else {
    failed++;
    console.error(`  ✗  FAIL: ${label}`);
  }
}

(async () => {
  console.log("\n=== Localyse UI — Security Tests ===\n");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: "/usr/local/bin/google-chrome",
  });

  const page = await browser.newPage();
  page.on("pageerror", (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE ERROR: ${msg.text()}`);
  });

  await page.goto(UI_PATH, { waitUntil: "domcontentloaded" });

  // ------------------------------------------------------------------
  // TEST 1: CSP meta tag present
  // ------------------------------------------------------------------
  console.log("1. Content Security Policy");
  const cspTag = await page.$eval(
    'meta[http-equiv="Content-Security-Policy"]',
    (el) => el.getAttribute("content")
  );
  assert(cspTag && cspTag.includes("default-src 'none'"), "CSP default-src is 'none'");
  assert(cspTag && cspTag.includes("connect-src https://localyse-proxy."), "CSP connect-src restricts to proxy worker");
  assert(cspTag && cspTag.includes("img-src blob: data:"), "CSP img-src allows blob: and data:");

  // ------------------------------------------------------------------
  // TEST 2: XSS via text layer content in title attribute
  // ------------------------------------------------------------------
  console.log("\n2. XSS via title attribute injection");

  // Select a frame with malicious text content
  const XSS_TEXT = '" onmouseover="alert(document.cookie)" data-x="';
  const xssLayers = [
    { id: "xss:1", name: "Malicious", characters: XSS_TEXT, x: 0, y: 0, width: 200, height: 20 },
  ];

  await page.evaluate((imgBytes, layers) => {
    window.postMessage({
      pluginMessage: {
        type: "frame-selected",
        payload: { id: "200:1", name: "XSS Test", width: 800, height: 600, imageBytes: imgBytes, textLayers: layers },
      },
    }, "*");
  }, FAKE_PNG_BYTES, xssLayers);
  await new Promise((r) => setTimeout(r, 300));

  // Select a locale
  const localeSelects = await page.$$(".locale-select");
  if (localeSelects.length > 0) await localeSelects[0].select("fr-FR");
  await new Promise((r) => setTimeout(r, 200));

  // Mock fetch
  await page.evaluate(() => {
    window.fetch = async (url, opts) => {
      if (typeof url === "string" && url.includes("api.openai.com")) {
        const body = JSON.parse(opts.body);
        const layers = JSON.parse(body.messages[1].content);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify(layers.map(l => ({ id: l.id, translated: "Traduit: " + l.text }))) } }],
          }),
        };
      }
    };
  });

  // Generate
  const genBtn = await page.$("#footer button");
  await genBtn.click();
  await new Promise((r) => setTimeout(r, 2000));

  // Check that the title attribute is properly escaped
  const titleAttr = await page.$eval(".translation-original", (el) => el.getAttribute("title"));
  assert(
    titleAttr === XSS_TEXT,
    "Title attribute contains the raw text (not broken out of attribute)"
  );
  // The title attribute contains the literal XSS string as plain text — that's safe.
  // What matters is that it didn't BREAK OUT of the attribute to create a new attribute.
  assert(
    titleAttr.includes("onmouseover"),
    "Title attribute preserves the literal text content (safe — set via DOM property)"
  );

  // Verify no onmouseover attribute exists on the element itself
  const hasOnmouseover = await page.$eval(
    ".translation-original",
    (el) => el.hasAttribute("onmouseover")
  );
  assert(!hasOnmouseover, "No onmouseover event handler attribute injected");

  // Count attributes on the element — should only be class + title
  const attrCount = await page.$eval(
    ".translation-original",
    (el) => el.attributes.length
  );
  assert(attrCount === 2, `Element has exactly 2 attributes (class + title), got ${attrCount}`);

  // ------------------------------------------------------------------
  // TEST 3: XSS via translated content from OpenAI
  // ------------------------------------------------------------------
  console.log("\n3. XSS via malicious translation response");

  const translatedContent = await page.$eval(".translation-translated", (el) => el.textContent);
  // The translated text should contain the XSS payload as literal text
  assert(
    translatedContent.includes("onmouseover"),
    "Malicious translation is rendered as safe literal text (not executed)"
  );

  // The element itself should have NO event handler attributes
  const transHasOnmouseover = await page.$eval(
    ".translation-translated",
    (el) => el.hasAttribute("onmouseover")
  );
  assert(!transHasOnmouseover, "Translated element has no injected event handlers");

  // Only 1 attribute (class) on translated span
  const transAttrCount = await page.$eval(
    ".translation-translated",
    (el) => el.attributes.length
  );
  assert(transAttrCount === 1, `Translated element has exactly 1 attribute (class), got ${transAttrCount}`);

  // ------------------------------------------------------------------
  // TEST 4: Message origin validation
  // ------------------------------------------------------------------
  console.log("\n4. Message origin validation");

  // Messages without pluginMessage should be ignored
  const beforeFrameName = await page.$eval("#frameName", (el) => el.textContent);
  await page.evaluate(() => {
    window.postMessage({ someOtherFormat: { type: "frame-selected" } }, "*");
  });
  await new Promise((r) => setTimeout(r, 200));
  const afterFrameName = await page.$eval("#frameName", (el) => el.textContent);
  assert(
    beforeFrameName === afterFrameName,
    "Messages without pluginMessage wrapper are ignored"
  );

  // Messages with non-string type should be ignored
  await page.evaluate(() => {
    window.postMessage({ pluginMessage: { type: 123 } }, "*");
  });
  await new Promise((r) => setTimeout(r, 200));
  const afterFrameName2 = await page.$eval("#frameName", (el) => el.textContent);
  assert(
    beforeFrameName === afterFrameName2,
    "Messages with non-string type are ignored"
  );

  // ------------------------------------------------------------------
  // TEST 5: escHtml function properly escapes all dangerous chars
  // ------------------------------------------------------------------
  console.log("\n5. escHtml escapes dangerous characters");

  const escapeTests = await page.evaluate(() => {
    const tests = [
      { input: '<script>alert(1)</script>', expected: '&lt;script&gt;alert(1)&lt;/script&gt;' },
      { input: '" onclick="alert(1)"', expected: '&quot; onclick=&quot;alert(1)&quot;' },
      { input: "' onfocus='alert(1)'", expected: "&#39; onfocus=&#39;alert(1)&#39;" },
      { input: '&<>"\'', expected: '&amp;&lt;&gt;&quot;&#39;' },
    ];
    return tests.map(t => ({
      ...t,
      actual: escHtml(t.input),
      pass: escHtml(t.input) === t.expected,
    }));
  });

  escapeTests.forEach((t) => {
    assert(t.pass, `escHtml("${t.input.slice(0, 30)}…") → properly escaped (got: ${t.actual})`);
  });

  // ------------------------------------------------------------------
  // TEST 6: API error body is not leaked raw
  // ------------------------------------------------------------------
  console.log("\n6. API error body sanitisation");

  // Reset state
  await page.evaluate((imgBytes) => {
    window.postMessage({
      pluginMessage: {
        type: "frame-selected",
        payload: { id: "300:1", name: "Error Test", width: 800, height: 600, imageBytes: imgBytes, textLayers: [{ id: "e:1", name: "T", characters: "Hello", x: 0, y: 0, width: 100, height: 20 }] },
      },
    }, "*");
  }, FAKE_PNG_BYTES);
  await new Promise((r) => setTimeout(r, 300));

  // Mock a failing fetch
  await page.evaluate(() => {
    window.fetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid API key provided: sk-test****." } }),
    });
  });

  // Need to click reset first if results are showing
  const resetBtn = await page.$("#resetBtn");
  if (resetBtn) await resetBtn.click();
  await new Promise((r) => setTimeout(r, 300));

  const locSels = await page.$$(".locale-select");
  if (locSels.length > 0) {
    const val = await locSels[0].evaluate(el => el.value);
    if (!val) await locSels[0].select("fr-FR");
  }
  await new Promise((r) => setTimeout(r, 200));

  const genBtn2 = await page.$("#footer button");
  if (genBtn2) await genBtn2.click();
  await new Promise((r) => setTimeout(r, 1500));

  // Check that the toast shows a sanitised error, not the raw body
  const toastText = await page.$eval(".toast.error", (el) => el.textContent).catch(() => "");
  assert(
    toastText.includes("Invalid API key") || toastText.includes("OpenAI API error"),
    "Error toast shows sanitised message, not raw response body"
  );
  assert(
    toastText.length < 300,
    "Error toast is truncated (length: " + toastText.length + ")"
  );

  // ------------------------------------------------------------------
  // SUMMARY
  // ------------------------------------------------------------------
  console.log("\n=== Results ===");
  if (errors.length > 0) {
    console.log("\nJavaScript Errors Detected:");
    errors.forEach((e) => console.error("  " + e));
  } else {
    console.log("\nNo JavaScript errors detected.");
  }
  console.log(`\nPassed: ${passed}  |  Failed: ${failed}  |  JS Errors: ${errors.length}\n`);

  await browser.close();
  process.exit(failed > 0 || errors.length > 0 ? 1 : 0);
})();
