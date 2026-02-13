"use strict";
// Localyse — Figma Plugin Main Code
// Runs in the Figma sandbox (no DOM, no fetch)
figma.showUI(__html__, { width: 480, height: 640, themeColors: true });
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
// Selection watcher
// ------------------------------------------------------------------
let currentSelectionId = null;
async function handleSelectionChange() {
    const sel = figma.currentPage.selection;
    if (sel.length === 1 &&
        (sel[0].type === "FRAME" ||
            sel[0].type === "COMPONENT" ||
            sel[0].type === "INSTANCE" ||
            sel[0].type === "GROUP")) {
        const node = sel[0];
        currentSelectionId = node.id;
        // Export image
        const imageBytes = await exportFrameImage(node);
        // Extract text layers
        const textLayers = "children" in node
            ? extractTextLayers(node)
            : [];
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
        currentSelectionId = null;
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
        // translations: Array<{ locale: string, layers: Array<{ id: string, translated: string }> }>
        const sourceNode = figma.getNodeById(sourceFrameId);
        if (!sourceNode || !("clone" in sourceNode)) {
            figma.notify("Original frame not found.", { error: true });
            return;
        }
        const parent = sourceNode.parent;
        let offsetX = sourceNode.width + 100;
        for (const t of translations) {
            const clone = sourceNode.clone();
            clone.name = `${sourceNode.name} — ${t.locale}`;
            if (parent && "appendChild" in parent) {
                parent.appendChild(clone);
            }
            clone.x = sourceNode.x + offsetX;
            clone.y = sourceNode.y;
            offsetX += clone.width + 100;
            // Walk text layers in the clone and apply translated text
            const cloneTextNodes = collectTextNodes(clone);
            // Build a map from original text → translated text
            const layerMap = new Map();
            for (const layer of t.layers) {
                layerMap.set(layer.id, layer.translated);
            }
            // Match by original node id suffix (clone preserves structure but gets new ids)
            // Instead we match by original characters + layer name
            const sourceTextNodes = collectTextNodes(sourceNode);
            for (let i = 0; i < sourceTextNodes.length && i < cloneTextNodes.length; i++) {
                const originalId = sourceTextNodes[i].id;
                if (layerMap.has(originalId)) {
                    const cloneText = cloneTextNodes[i];
                    const newText = layerMap.get(originalId);
                    // Load fonts used in this text node
                    const fontsToLoad = cloneText.getRangeAllFontNames(0, cloneText.characters.length);
                    for (const font of fontsToLoad) {
                        await figma.loadFontAsync(font);
                    }
                    cloneText.characters = newText;
                }
            }
        }
        figma.notify(`Created ${translations.length} localised frame(s) ✓`);
        figma.ui.postMessage({ type: "apply-done" });
    }
    // --- Resize plugin window ---
    if (msg.type === "resize") {
        figma.ui.resize(msg.width, msg.height);
    }
    // --- Close plugin ---
    if (msg.type === "close") {
        figma.closePlugin();
    }
};
