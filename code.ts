// Localyse — Figma Plugin Main Code
// Runs in the Figma sandbox (no DOM, no fetch)

figma.showUI(__html__, { width: 480, height: 800, themeColors: true });

// Send the current user's ID to the UI for rate-limiting identification
figma.ui.postMessage({
  type: "user-info",
  userId: figma.currentUser?.id || "anonymous",
});

// P2.2: Send saved locales to the UI on launch
(async () => {
  try {
    const savedLocales = await figma.clientStorage.getAsync("savedLocales");
    if (Array.isArray(savedLocales) && savedLocales.length > 0) {
      figma.ui.postMessage({ type: "restore-locales", locales: savedLocales });
    }
  } catch { /* first launch or storage unavailable */ }
})();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Recursively collect every text node inside a subtree. */
function collectTextNodes(node: SceneNode): TextNode[] {
  const results: TextNode[] = [];
  if (node.type === "TEXT") {
    results.push(node);
  }
  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children) {
      results.push(...collectTextNodes(child as SceneNode));
    }
  }
  return results;
}

/**
 * Recursively mirror a frame tree for RTL layout.
 * This handles:
 *  - Horizontal auto-layout: reverse children order
 *  - Auto-layout frames: swap paddingLeft ↔ paddingRight
 *  - Text nodes: flip LEFT ↔ RIGHT alignment
 *  - All frames: swap border radius (topLeft↔topRight, bottomLeft↔bottomRight)
 *
 * Note: Non-auto-layout frames are NOT position-mirrored because manually
 * positioned children have complex constraints that can't be reliably flipped.
 */
function mirrorForRtl(node: SceneNode): void {
  // --- Text node: flip horizontal alignment ---
  if (node.type === "TEXT") {
    const align = node.textAlignHorizontal;
    if (align === "LEFT") {
      node.textAlignHorizontal = "RIGHT";
    } else if (align === "RIGHT") {
      node.textAlignHorizontal = "LEFT";
    }
    return;
  }

  // --- Frame / Component / Instance with children ---
  if (!("children" in node)) return;

  const frame = node as FrameNode;
  const isAutoLayout = "layoutMode" in frame && (frame.layoutMode === "HORIZONTAL" || frame.layoutMode === "VERTICAL");

  if (isAutoLayout) {
    // Swap left/right padding
    const tmpPadding = frame.paddingLeft;
    frame.paddingLeft = frame.paddingRight;
    frame.paddingRight = tmpPadding;

    // Reverse children order in horizontal auto-layout
    if (frame.layoutMode === "HORIZONTAL") {
      // Snapshot children references first, then re-insert at position 0
      // Each insertChild(0, child) pushes previous children right
      const children = [...frame.children];
      for (const child of children) {
        frame.insertChild(0, child);
      }
    }
  }

  // Swap border radius left ↔ right (if applicable)
  if ("topLeftRadius" in frame) {
    const tlr = frame.topLeftRadius;
    const trr = frame.topRightRadius;
    const blr = frame.bottomLeftRadius;
    const brr = frame.bottomRightRadius;
    frame.topLeftRadius = trr;
    frame.topRightRadius = tlr;
    frame.bottomLeftRadius = brr;
    frame.bottomRightRadius = blr;
  }

  // Recurse into children
  for (const child of frame.children) {
    mirrorForRtl(child as SceneNode);
  }
}

/** Build a serialisable description of every text layer in a frame. */
function extractTextLayers(frame: SceneNode) {
  const textNodes = collectTextNodes(frame);
  return textNodes.map((t) => ({
    id: t.id,
    name: t.name,
    characters: t.characters,
    x: t.absoluteTransform[0][2],
    y: t.absoluteTransform[1][2],
    width: t.width,
    height: t.height,
  }));
}

/** Convert a Uint8Array to a base64 string (no btoa in Figma sandbox). */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const a = bytes[i];
    const b = i + 1 < len ? bytes[i + 1] : 0;
    const c = i + 2 < len ? bytes[i + 2] : 0;
    result += CHARS[a >> 2];
    result += CHARS[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < len ? CHARS[((b & 15) << 2) | (c >> 6)] : "=";
    result += i + 2 < len ? CHARS[c & 63] : "=";
  }
  return result;
}

/** Export a node as a PNG thumbnail (scale 1×, max 800 px wide). */
async function exportFrameImage(node: SceneNode): Promise<Uint8Array> {
  const scale = Math.min(1, 800 / node.width);
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });
  return bytes;
}

// ------------------------------------------------------------------
// Selection watcher — with generation counter to prevent races
// ------------------------------------------------------------------

let selectionGeneration = 0;

async function handleSelectionChange() {
  const gen = ++selectionGeneration;
  const sel = figma.currentPage.selection;

  if (
    sel.length === 1 &&
    (sel[0].type === "FRAME" ||
      sel[0].type === "COMPONENT" ||
      sel[0].type === "INSTANCE" ||
      sel[0].type === "GROUP" ||
      sel[0].type === "SECTION")
  ) {
    const node = sel[0];

    // Export image — with error handling (P1.4)
    let imageBase64 = "";
    try {
      const imageBytes = await exportFrameImage(node);
      // Convert to base64 for more efficient postMessage transfer (P3.2)
      imageBase64 = uint8ArrayToBase64(imageBytes);
    } catch (err) {
      console.error(`[Localyse] Frame export failed: ${err}`);
      // Continue with empty image — UI will show a placeholder
    }

    // Bail if selection changed while we were exporting
    if (gen !== selectionGeneration) return;

    // Extract text layers
    const textLayers = extractTextLayers(node);

    // Send to UI
    figma.ui.postMessage({
      type: "frame-selected",
      payload: {
        id: node.id,
        name: node.name,
        width: Math.round(node.width),
        height: Math.round(node.height),
        imageBase64,
        textLayers,
      },
    });
  } else {
    figma.ui.postMessage({ type: "no-selection" });
  }
}

figma.on("selectionchange", handleSelectionChange);
// Fire once at launch in case something is already selected
handleSelectionChange();

// ------------------------------------------------------------------
// Messages from the UI
// ------------------------------------------------------------------

figma.ui.onmessage = async (msg) => {
  // --- Apply translations to duplicated frames ---
  if (msg.type === "apply-translations") {
    const { sourceFrameId, translations } = msg;

    // RTL locale prefixes — languages that read right-to-left
    const RTL_CODES = ["ar", "he", "fa", "ur", "ps", "yi", "sd", "ku"];

    function isRtlLocale(code: string): boolean {
      if (!code) return false;
      const base = code.split("-")[0].toLowerCase();
      return RTL_CODES.includes(base);
    }

    // --- Input validation ---
    if (typeof sourceFrameId !== "string" || !Array.isArray(translations)) {
      figma.notify("Invalid translation payload.", { error: true });
      figma.ui.postMessage({ type: "apply-done" });
      return;
    }
    // Validate each translation entry
    for (const t of translations) {
      if (typeof t.locale !== "string" || !Array.isArray(t.layers)) {
        figma.notify("Invalid translation entry.", { error: true });
        figma.ui.postMessage({ type: "apply-done" });
        return;
      }
      for (const layer of t.layers) {
        if (typeof layer.id !== "string" || typeof layer.translated !== "string") {
          figma.notify("Invalid translation layer data.", { error: true });
          figma.ui.postMessage({ type: "apply-done" });
          return;
        }
      }
    }

    const sourceNode = await figma.getNodeByIdAsync(sourceFrameId) as SceneNode | null;
    if (!sourceNode || !("clone" in sourceNode)) {
      figma.notify("Original frame not found.", { error: true });
      figma.ui.postMessage({ type: "apply-done" });
      return;
    }

    const source = sourceNode as FrameNode;
    const GAP = 50;

    // Count existing locale clones of this frame to calculate correct offset
    // (handles incremental apply where locales arrive one at a time)
    let existingClones = 0;
    if (source.parent && "children" in source.parent) {
      const prefix = source.name + " — ";
      for (const sibling of source.parent.children) {
        if (sibling.id !== source.id && sibling.name.startsWith(prefix)) {
          existingClones++;
        }
      }
    }
    let offsetX = (source.width + GAP) * (existingClones + 1);

    for (const t of translations) {
      // clone() automatically inserts into the same parent
      const clone = source.clone();
      clone.name = `${source.name} — ${t.locale}`;
      clone.x = source.x + offsetX;
      clone.y = source.y;
      offsetX += clone.width + GAP;

      const rtl = isRtlLocale(t.localeCode || "");

      // Walk text layers in the clone and apply translated text
      const cloneTextNodes = collectTextNodes(clone);
      const sourceTextNodes = collectTextNodes(source);

      // Build a map from original node id → translated text
      const layerMap = new Map<string, string>();
      for (const layer of t.layers) {
        layerMap.set(layer.id, layer.translated);
      }

      // P3.1: Batch font loading — collect all unique fonts first, load in parallel
      const fontsToLoad = new Set<string>();
      for (let i = 0; i < cloneTextNodes.length; i++) {
        const cloneText = cloneTextNodes[i];
        if (cloneText.characters.length === 0) continue;
        try {
          const fonts = cloneText.getRangeAllFontNames(0, cloneText.characters.length);
          for (const font of fonts) {
            fontsToLoad.add(JSON.stringify(font));
          }
        } catch { /* ignore — will be caught below */ }
      }
      // Load all unique fonts in parallel
      await Promise.all(
        Array.from(fontsToLoad).map((key) =>
          figma.loadFontAsync(JSON.parse(key) as FontName).catch(() => {})
        )
      );

      // Match clone text nodes by index (clone preserves tree structure/order)
      for (let i = 0; i < sourceTextNodes.length && i < cloneTextNodes.length; i++) {
        const originalId = sourceTextNodes[i].id;
        if (!layerMap.has(originalId)) continue;

        const cloneText = cloneTextNodes[i];
        const newText = layerMap.get(originalId)!;

        // Skip empty text nodes
        if (cloneText.characters.length === 0) continue;

        try {
          cloneText.characters = newText;
        } catch (err) {
          // If text can't be set, skip this layer but continue
          console.error(
            `[Localyse] Could not set text for "${cloneText.name}": ${err}`
          );
        }
      }

      // Full RTL layout mirroring — applied after all text is set
      if (rtl) {
        mirrorForRtl(clone);
      }
    }

    figma.notify(`Created ${translations.length} localised frame(s) ✓`);
    figma.ui.postMessage({ type: "apply-done" });
  }

  // --- Resize plugin window ---
  if (msg.type === "resize") {
    const w = Number(msg.width);
    const h = Number(msg.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 2000 && h <= 2000) {
      figma.ui.resize(w, h);
    }
  }

  // --- Save locales to client storage (P2.2) ---
  if (msg.type === "save-locales") {
    if (Array.isArray(msg.locales)) {
      figma.clientStorage.setAsync("savedLocales", msg.locales).catch(() => {});
    }
  }

  // --- Locale presets (P6.5) ---
  if (msg.type === "save-preset") {
    const { name, locales } = msg;
    if (typeof name === "string" && Array.isArray(locales)) {
      figma.clientStorage.getAsync("localePresets").then((presets: any) => {
        const all = Array.isArray(presets) ? presets : [];
        // Replace existing preset with same name, or add new
        const idx = all.findIndex((p: any) => p.name === name);
        if (idx >= 0) {
          all[idx] = { name, locales };
        } else {
          all.push({ name, locales });
        }
        figma.clientStorage.setAsync("localePresets", all).catch(() => {});
        figma.ui.postMessage({ type: "presets-updated", presets: all });
      }).catch(() => {});
    }
  }

  if (msg.type === "delete-preset") {
    const { name } = msg;
    figma.clientStorage.getAsync("localePresets").then((presets: any) => {
      const all = Array.isArray(presets) ? presets : [];
      const filtered = all.filter((p: any) => p.name !== name);
      figma.clientStorage.setAsync("localePresets", filtered).catch(() => {});
      figma.ui.postMessage({ type: "presets-updated", presets: filtered });
    }).catch(() => {});
  }

  if (msg.type === "load-presets") {
    figma.clientStorage.getAsync("localePresets").then((presets: any) => {
      figma.ui.postMessage({
        type: "presets-updated",
        presets: Array.isArray(presets) ? presets : [],
      });
    }).catch(() => {
      figma.ui.postMessage({ type: "presets-updated", presets: [] });
    });
  }

  // --- Close plugin ---
  if (msg.type === "close") {
    figma.closePlugin();
  }
};
