/**
 * Unit tests for worker helper functions.
 * Run with: npx vitest run
 */
import { describe, it, expect } from "vitest";

// ──────────────────────────────────────────────────────────────────────
// Import-free copies of functions under test (worker uses module format
// but doesn't export individual helpers — we copy them here for testing)
// ──────────────────────────────────────────────────────────────────────

// --- lookupAbbrev ---

const ABBREV_DICT = {
  JAN: { fr: "JANV", de: "JAN", es: "ENE", ja: "1月", ar: "يناير" },
  FEB: { fr: "FÉV", de: "FEB", es: "FEB" },
  MON: { fr: "LUN", de: "MO", es: "LUN", ja: "月" },
  SUN: { fr: "DIM", de: "SO", es: "DOM" },
};

function lookupAbbrev(text, targetLocale) {
  const upper = text.trim().toUpperCase();
  const entry = ABBREV_DICT[upper];
  if (!entry) return null;

  const baseLang = targetLocale.split("-")[0].toLowerCase();
  const match = entry[targetLocale] || entry[baseLang];
  if (!match) return null;

  if (text === text.toUpperCase()) return match.toUpperCase();
  if (text === text.toLowerCase()) return match.toLowerCase();
  if (text[0] === text[0].toUpperCase()) {
    return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
  }
  return match;
}

// --- stripContext ---

function stripContext(translatedText, layerName) {
  const bracketEnd = translatedText.indexOf("] ");
  if (bracketEnd !== -1 && bracketEnd < layerName.length + 20) {
    return translatedText.substring(bracketEnd + 2).trim();
  }
  return translatedText.trim();
}

// ══════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════

describe("lookupAbbrev", () => {
  it("returns null for unknown abbreviations", () => {
    expect(lookupAbbrev("XYZ", "fr")).toBeNull();
    expect(lookupAbbrev("Hello", "fr")).toBeNull();
  });

  it("returns null for unsupported locale", () => {
    expect(lookupAbbrev("JAN", "xx")).toBeNull();
    expect(lookupAbbrev("JAN", "zz-ZZ")).toBeNull();
  });

  it("looks up by exact locale code", () => {
    expect(lookupAbbrev("JAN", "fr")).toBe("JANV");
    expect(lookupAbbrev("JAN", "de")).toBe("JAN");
    expect(lookupAbbrev("JAN", "es")).toBe("ENE");
  });

  it("falls back to base language for composite codes", () => {
    expect(lookupAbbrev("JAN", "fr-ca")).toBe("JANV");
    expect(lookupAbbrev("JAN", "de-AT")).toBe("JAN");
  });

  it("preserves UPPERCASE casing", () => {
    expect(lookupAbbrev("JAN", "fr")).toBe("JANV");
    expect(lookupAbbrev("MON", "de")).toBe("MO");
  });

  it("preserves lowercase casing", () => {
    expect(lookupAbbrev("jan", "fr")).toBe("janv");
    expect(lookupAbbrev("mon", "es")).toBe("lun");
  });

  it("preserves Title Case casing", () => {
    expect(lookupAbbrev("Jan", "fr")).toBe("Janv");
    expect(lookupAbbrev("Mon", "de")).toBe("Mo");
  });

  it("trims whitespace from input", () => {
    expect(lookupAbbrev("  JAN  ", "fr")).toBe("JANV");
  });

  it("handles non-Latin scripts", () => {
    expect(lookupAbbrev("JAN", "ja")).toBe("1月");
    expect(lookupAbbrev("JAN", "ar")).toBe("يناير");
  });
});

describe("stripContext", () => {
  it("strips context prefix from translated text", () => {
    expect(stripContext("[Title] Bienvenue", "Title")).toBe("Bienvenue");
    expect(stripContext("[Header Text] Bonjour le monde", "Header Text")).toBe("Bonjour le monde");
  });

  it("returns text unchanged if no bracket found", () => {
    expect(stripContext("Bienvenue", "Title")).toBe("Bienvenue");
    expect(stripContext("No brackets here", "Something")).toBe("No brackets here");
  });

  it("returns text unchanged if bracket is too far from start", () => {
    // layerName is 3 chars, bracket at position 50+ should be ignored
    const text = "A".repeat(50) + "] rest of text";
    expect(stripContext(text, "abc")).toBe(text.trim());
  });

  it("trims whitespace from result", () => {
    expect(stripContext("  [X] hello  ", "X")).toBe("hello");
    expect(stripContext("  no brackets  ", "Y")).toBe("no brackets");
  });

  it("handles empty layer name", () => {
    expect(stripContext("[] text", "")).toBe("text");
  });

  it("handles bracket in translated content (not context)", () => {
    // If the ] appears after a reasonable position, treat it as content
    expect(stripContext("[Titre] Le résultat [est] bon", "Titre")).toBe("Le résultat [est] bon");
  });
});
