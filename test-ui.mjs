/**
 * Headless browser test for the Localyse Figma plugin UI.
 *
 * This script loads ui.html in Chrome, simulates the Figma plugin
 * message protocol, and exercises every major UI state:
 *   1. Initial empty state
 *   2. Frame-selected state (with mock image + text layers)
 *   3. Locale picker — add locales, verify info tags
 *   4. Generate flow — mock an OpenAI response and verify results render
 *   5. Apply button appears after generation
 *
 * It collects all console errors / uncaught exceptions and reports them.
 */

import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_PATH = `file://${path.resolve(__dirname, "ui.html")}`;

// Fake 1×1 white PNG as base64 → raw bytes
const FAKE_PNG_BYTES = (() => {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
    "Nl7BcQAAAABJRU5ErkJggg==";
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0));
})();

const MOCK_TEXT_LAYERS = [
  { id: "1:1", name: "Heading", characters: "Welcome to our store", x: 0, y: 0, width: 300, height: 40 },
  { id: "1:2", name: "Price", characters: "$49.99", x: 0, y: 50, width: 100, height: 20 },
  { id: "1:3", name: "Author", characters: "By John Smith", x: 0, y: 80, width: 200, height: 20 },
  { id: "1:4", name: "Location", characters: "New York, USA", x: 0, y: 110, width: 200, height: 20 },
  { id: "1:5", name: "CTA", characters: "Buy Now", x: 0, y: 140, width: 120, height: 36 },
];

// ---- Helpers ----

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

// ---- Main ----

(async () => {
  console.log("\n=== Localyse UI — Headless Browser Tests ===\n");

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    executablePath: "/usr/local/bin/google-chrome",
  });

  const page = await browser.newPage();

  // Collect JS errors
  page.on("pageerror", (err) => {
    errors.push(`PAGE ERROR: ${err.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      errors.push(`CONSOLE ERROR: ${msg.text()}`);
    }
  });

  // Load the UI
  await page.goto(UI_PATH, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#emptyState");

  // ------------------------------------------------------------------
  // TEST 1: Empty state is visible on load
  // ------------------------------------------------------------------
  console.log("1. Initial empty state");
  const emptyVisible = await page.$eval("#emptyState", (el) => !el.classList.contains("hidden"));
  assert(emptyVisible, "Empty state is visible");
  const mainHidden = await page.$eval("#mainContent", (el) => el.classList.contains("hidden"));
  assert(mainHidden, "Main content is hidden");
  const genBtnDisabled = await page.$eval("#footer button", (el) => el.disabled);
  assert(genBtnDisabled, "Generate button is disabled");

  // ------------------------------------------------------------------
  // TEST 2: Simulate frame-selected message
  // ------------------------------------------------------------------
  console.log("\n2. Frame selected");
  await page.evaluate((imageBytes, textLayers) => {
    window.postMessage({
      pluginMessage: {
        type: "frame-selected",
        payload: {
          id: "100:1",
          name: "Hero Section",
          width: 1440,
          height: 900,
          imageBytes: imageBytes,
          textLayers: textLayers,
        },
      },
    }, "*");
  }, FAKE_PNG_BYTES, MOCK_TEXT_LAYERS);

  await new Promise((r) => setTimeout(r, 300));

  const emptyHidden = await page.$eval("#emptyState", (el) => el.classList.contains("hidden"));
  assert(emptyHidden, "Empty state is hidden after selection");
  const mainVisible = await page.$eval("#mainContent", (el) => !el.classList.contains("hidden"));
  assert(mainVisible, "Main content is visible");

  const frameName = await page.$eval("#frameName", (el) => el.textContent);
  assert(frameName === "Hero Section", `Frame name shows "Hero Section" (got "${frameName}")`);
  const frameDim = await page.$eval("#frameDim", (el) => el.textContent);
  assert(frameDim === "1440 × 900", `Frame dimensions show "1440 × 900" (got "${frameDim}")`);

  // Check image src is set (blob URL)
  const imgSrc = await page.$eval("#frameImage", (el) => el.src);
  assert(imgSrc.startsWith("blob:"), "Frame preview image has blob URL");

  // ------------------------------------------------------------------
  // TEST 3: Locale picker — one empty row should exist
  // ------------------------------------------------------------------
  console.log("\n3. Locale picker");
  let localeRowCount = await page.$$eval(".locale-row", (rows) => rows.length);
  assert(localeRowCount === 1, `One locale row exists by default (got ${localeRowCount})`);

  // Select French (France)
  await page.select(".locale-select", "fr-FR");
  await new Promise((r) => setTimeout(r, 200));

  // Verify info tags appear
  const infoTags = await page.$$eval(".locale-info .tag", (tags) => tags.map((t) => t.textContent));
  assert(infoTags.includes("French"), `Language tag "French" shown (tags: ${infoTags.join(", ")})`);
  assert(infoTags.includes("EUR"), `Currency tag "EUR" shown (tags: ${infoTags.join(", ")})`);

  // Add a second locale
  await page.click("#addLocaleBtn");
  await new Promise((r) => setTimeout(r, 200));
  localeRowCount = await page.$$eval(".locale-row", (rows) => rows.length);
  assert(localeRowCount === 2, `Two locale rows after adding (got ${localeRowCount})`);

  // Select Japanese
  const secondSelect = (await page.$$(".locale-select"))[1];
  await secondSelect.select("ja-JP");
  await new Promise((r) => setTimeout(r, 200));

  // Add 3 more to hit the limit
  await page.click("#addLocaleBtn");
  await page.click("#addLocaleBtn");
  await page.click("#addLocaleBtn");
  await new Promise((r) => setTimeout(r, 200));
  localeRowCount = await page.$$eval(".locale-row", (rows) => rows.length);
  assert(localeRowCount === 5, `Five locale rows at max (got ${localeRowCount})`);

  // Add button should now be disabled
  const addBtnDisabled = await page.$eval("#addLocaleBtn", (el) => el.disabled);
  assert(addBtnDisabled, "Add locale button is disabled at 5 locales");

  // Remove one locale
  const removeBtns = await page.$$(".locale-remove-btn");
  await removeBtns[4].click();
  await new Promise((r) => setTimeout(r, 200));
  localeRowCount = await page.$$eval(".locale-row", (rows) => rows.length);
  assert(localeRowCount === 4, `Four locale rows after removal (got ${localeRowCount})`);

  // Generate button should be enabled (we have at least one locale selected)
  const genEnabled = await page.$eval("#footer button", (el) => !el.disabled);
  assert(genEnabled, "Generate button is enabled with locales selected");

  // ------------------------------------------------------------------
  // TEST 4: no-selection message hides content
  // ------------------------------------------------------------------
  console.log("\n4. No-selection message");
  await page.evaluate(() => {
    window.postMessage({ pluginMessage: { type: "no-selection" } }, "*");
  });
  await new Promise((r) => setTimeout(r, 300));
  const emptyBackVisible = await page.$eval("#emptyState", (el) => !el.classList.contains("hidden"));
  assert(emptyBackVisible, "Empty state returns on deselection");

  // Re-select for next tests
  await page.evaluate((imageBytes, textLayers) => {
    window.postMessage({
      pluginMessage: {
        type: "frame-selected",
        payload: {
          id: "100:1",
          name: "Hero Section",
          width: 1440,
          height: 900,
          imageBytes: imageBytes,
          textLayers: textLayers,
        },
      },
    }, "*");
  }, FAKE_PNG_BYTES, MOCK_TEXT_LAYERS);
  await new Promise((r) => setTimeout(r, 300));

  // ------------------------------------------------------------------
  // TEST 5: Generate flow (mock the fetch call)
  // ------------------------------------------------------------------
  console.log("\n5. Generate translation flow");

  // Enter a fake API key
  // Select locales for generation

  // Ensure at least one locale is selected (fr-FR should still be there)
  const selectedLocales = await page.$$eval(".locale-select", (sels) =>
    sels.map((s) => s.value).filter(Boolean)
  );
  assert(selectedLocales.length >= 1, `At least one locale is selected (got ${selectedLocales.length})`);

  // Mock fetch to intercept OpenAI calls
  await page.evaluate(() => {
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      if (typeof url === "string" && url.includes("api.openai.com")) {
        // Parse the request to get text layer IDs
        const body = JSON.parse(opts.body);
        const userContent = JSON.parse(body.messages[1].content);
        const translated = userContent.map((item) => ({
          id: item.id,
          translated: "[TRANSLATED] " + item.text,
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify(translated),
                },
              },
            ],
          }),
        };
      }
      return origFetch(url, opts);
    };
  });

  // Click Generate
  const generateBtn = await page.$("#footer button");
  await generateBtn.click();

  // Wait for generation to complete (spinner, then results)
  await new Promise((r) => setTimeout(r, 2000));

  // Check that results section is visible
  const resultsVisible = await page.$eval("#resultsSection", (el) => !el.classList.contains("hidden"));
  assert(resultsVisible, "Results section is visible after generation");

  // Check result cards
  const resultCards = await page.$$eval(".result-card", (cards) => cards.length);
  assert(resultCards >= 1, `At least one result card rendered (got ${resultCards})`);

  // Check translation rows
  const translationRows = await page.$$eval(".translation-row", (rows) =>
    rows.map((r) => ({
      original: r.querySelector(".translation-original")?.textContent || "",
      translated: r.querySelector(".translation-translated")?.textContent || "",
    }))
  );
  assert(translationRows.length > 0, `Translation rows rendered (got ${translationRows.length})`);

  if (translationRows.length > 0) {
    const first = translationRows[0];
    assert(
      first.translated.startsWith("[TRANSLATED]"),
      `First translation has mock prefix (got "${first.translated}")`
    );
  }

  // ------------------------------------------------------------------
  // TEST 6: Apply and Reset buttons
  // ------------------------------------------------------------------
  console.log("\n6. Apply and Reset buttons");
  const applyBtn = await page.$("#applyBtn");
  assert(applyBtn !== null, "Apply to Canvas button exists");
  const resetBtn = await page.$("#resetBtn");
  assert(resetBtn !== null, "Start Over button exists");

  // Click reset
  await resetBtn.click();
  await new Promise((r) => setTimeout(r, 300));
  const resultsAfterReset = await page.$eval("#resultsSection", (el) => el.classList.contains("hidden"));
  assert(resultsAfterReset, "Results section hidden after reset");

  // ------------------------------------------------------------------
  // TEST 7: Duplicate locale prevention
  // ------------------------------------------------------------------
  console.log("\n7. Duplicate locale prevention");
  // Clear all locale rows by removing them one at a time (re-query each time since DOM re-renders)
  while (true) {
    const btns = await page.$$(".locale-remove-btn");
    if (btns.length === 0) break;
    await btns[0].click();
    await new Promise((r) => setTimeout(r, 150));
  }

  // Add two rows
  await page.click("#addLocaleBtn");
  await new Promise((r) => setTimeout(r, 100));
  await page.click("#addLocaleBtn");
  await new Promise((r) => setTimeout(r, 100));

  // Select same locale in first
  const selects = await page.$$(".locale-select");
  await selects[0].select("de-DE");
  await new Promise((r) => setTimeout(r, 200));

  // Check that de-DE is disabled in second dropdown
  const secondOptions = await page.$$eval(
    ".locale-row:nth-child(2) .locale-select option",
    (opts) => opts.filter((o) => o.value === "de-DE").map((o) => o.disabled)
  );
  assert(
    secondOptions.length > 0 && secondOptions[0] === true,
    "Already-selected locale is disabled in other dropdowns"
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

  if (failed > 0 || errors.length > 0) {
    process.exit(1);
  }
  process.exit(0);
})();
