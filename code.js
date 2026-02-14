"use strict";
// Localyse — Figma Plugin Main Code
// Runs in the Figma sandbox (no DOM, no fetch)
var _a;
figma.showUI(__html__, { width: 480, height: 640, themeColors: true });
// Send the current user's ID to the UI for rate-limiting identification
figma.ui.postMessage({
    type: "user-info",
    userId: ((_a = figma.currentUser) === null || _a === void 0 ? void 0 : _a.id) || "anonymous",
});
// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
/** Recursively collect every text node inside a subtree. */
function collectTextNodes(node) {
    const results = [];
    if (node.type === "TEXT") {
        results.push(node);
    }
    if ("children" in node) {
        for (const child of node.children) {
            results.push(...collectTextNodes(child));
        }
    }
    return results;
}
/** Build a serialisable description of every text layer in a frame. */
function extractTextLayers(frame) {
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
/** Export a node as a PNG thumbnail (scale 1×, max 800 px wide). */
async function exportFrameImage(node) {
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
    if (sel.length === 1 &&
        (sel[0].type === "FRAME" ||
            sel[0].type === "COMPONENT" ||
            sel[0].type === "INSTANCE" ||
            sel[0].type === "GROUP" ||
            sel[0].type === "SECTION")) {
        const node = sel[0];
        // Export image
        const imageBytes = await exportFrameImage(node);
        // Bail if selection changed while we were exporting
        if (gen !== selectionGeneration)
            return;
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
                imageBytes: Array.from(imageBytes),
                textLayers,
            },
        });
    }
    else {
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
        function isRtlLocale(code) {
            if (!code)
                return false;
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
        const sourceNode = await figma.getNodeByIdAsync(sourceFrameId);
        if (!sourceNode || !("clone" in sourceNode)) {
            figma.notify("Original frame not found.", { error: true });
            figma.ui.postMessage({ type: "apply-done" });
            return;
        }
        const source = sourceNode;
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
            const layerMap = new Map();
            for (const layer of t.layers) {
                layerMap.set(layer.id, layer.translated);
            }
            // Match clone text nodes by index (clone preserves tree structure/order)
            for (let i = 0; i < sourceTextNodes.length && i < cloneTextNodes.length; i++) {
                const originalId = sourceTextNodes[i].id;
                if (!layerMap.has(originalId))
                    continue;
                const cloneText = cloneTextNodes[i];
                const newText = layerMap.get(originalId);
                // Skip empty text nodes — getRangeAllFontNames(0, 0) would throw
                if (cloneText.characters.length === 0)
                    continue;
                try {
                    // Load every font used in this text node before mutating
                    const fontsToLoad = cloneText.getRangeAllFontNames(0, cloneText.characters.length);
                    for (const font of fontsToLoad) {
                        await figma.loadFontAsync(font);
                    }
                    cloneText.characters = newText;
                    // Flip horizontal text alignment for RTL locales
                    if (rtl) {
                        const align = cloneText.textAlignHorizontal;
                        if (align === "LEFT") {
                            cloneText.textAlignHorizontal = "RIGHT";
                        }
                        else if (align === "RIGHT") {
                            cloneText.textAlignHorizontal = "LEFT";
                        }
                        // CENTER and JUSTIFIED stay as-is
                    }
                }
                catch (err) {
                    // If a specific font can't be loaded, skip this layer but continue
                    console.error(`[Localyse] Could not set text for "${cloneText.name}": ${err}`);
                }
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
    // --- Close plugin ---
    if (msg.type === "close") {
        figma.closePlugin();
    }
};
