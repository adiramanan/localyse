# Localyse Plugin — Complete Code Explanation

A beginner-friendly, in-depth walkthrough of every part of this Figma plugin, designed to teach you front-end development concepts as you read.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Project Configuration Files](#2-project-configuration-files)
3. [The Plugin Sandbox — `code.ts`](#3-the-plugin-sandbox--codets)
4. [The User Interface — `ui.html`](#4-the-user-interface--uihtml)
   - [4a. HTML Structure](#4a-html-structure)
   - [4b. CSS Styling](#4b-css-styling)
   - [4c. JavaScript Logic](#4c-javascript-logic)
5. [The Backend Worker — `worker/index.js`](#5-the-backend-worker--workerindexjs)
6. [Testing](#6-testing)
7. [CI/CD Pipeline](#7-cicd-pipeline)
8. [Key Front-End Patterns to Learn From](#8-key-front-end-patterns-to-learn-from)

---

## 1. Architecture Overview

This plugin has a **three-layer architecture**, which is a very common pattern in real-world web applications:

```
┌─────────────────────────────────────────────────────────┐
│                   Figma Desktop App                      │
│                                                          │
│  ┌──────────────┐    postMessage()    ┌──────────────┐  │
│  │  Sandbox      │ ◄────────────────► │  UI (iframe)  │  │
│  │  code.ts      │                    │  ui.html       │  │
│  │               │                    │                │  │
│  │ • Reads the   │                    │ • Shows the    │  │
│  │   Figma doc   │                    │   user         │  │
│  │ • Clones      │                    │   interface    │  │
│  │   frames      │                    │ • Makes HTTP   │  │
│  │ • Sets text   │                    │   requests     │  │
│  └──────────────┘                    └───────┬────────┘  │
│                                               │          │
└───────────────────────────────────────────────┼──────────┘
                                                │ fetch()
                                    ┌───────────▼───────────┐
                                    │  Cloudflare Worker     │
                                    │  worker/index.js       │
                                    │                        │
                                    │  • Rate limiting       │
                                    │  • Azure translation   │
                                    │  • GPT-4o-mini refine  │
                                    │  • Response caching    │
                                    └────────────────────────┘
```

### Why Three Layers?

**Figma plugins** run in a special sandboxed environment. They are split into two halves:

- **Sandbox (`code.ts`)** — Has access to the Figma document (can read nodes, create shapes, set text) but has **no access to the DOM or network**. Think of it as the "back-end within Figma."
- **UI (`ui.html`)** — A regular web page loaded in an `<iframe>`. It can show HTML, CSS, and JavaScript, and it **can** make network requests (`fetch`), but it has **no access** to the Figma document.

They communicate via `postMessage()` — a secure browser API for sending data between different JavaScript contexts.

The **Cloudflare Worker** is a serverless function that acts as a proxy between the plugin and external AI services (Azure Translator and OpenAI). It handles rate limiting, caching, and API key security so that sensitive credentials never touch the client.

---

## 2. Project Configuration Files

### `manifest.json` — The Plugin Identity Card

```json
{
  "id": "1604794975030379607",
  "name": "Localyse",
  "api": "1.0.0",
  "main": "code.js",
  "ui": "ui.html",
  "documentAccess": "dynamic-page",
  "permissions": ["currentuser"],
  "editorType": ["figma"],
  "networkAccess": {
    "allowedDomains": ["https://localyse-proxy.adiramanan98.workers.dev"],
    "reasoning": "Required to call the translation proxy for smart content translation."
  }
}
```

**What each field means:**

| Field | Purpose |
|-------|---------|
| `id` | Unique Figma-assigned plugin ID |
| `name` | Display name in Figma's plugin menu |
| `api` | Figma Plugin API version |
| `main` | The compiled sandbox code that Figma executes |
| `ui` | The HTML file shown in the plugin panel |
| `documentAccess` | `"dynamic-page"` means the plugin can only access the current page, not the entire file |
| `permissions` | `["currentuser"]` grants access to `figma.currentUser` (needed for rate-limiting IDs) |
| `editorType` | Only works in Figma (not FigJam) |
| `networkAccess` | Explicitly declares which domains the UI iframe can contact — a security measure |

### `package.json` — Dependencies & Scripts

```json
{
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "lint": "eslint . --ext .ts,.js --ignore-path .gitignore",
    "test": "vitest run"
  }
}
```

- **`build`** runs the TypeScript compiler to convert `code.ts` → `code.js`
- **`watch`** recompiles automatically when you save changes (useful during development)
- **`lint`** checks code quality using ESLint
- **`test`** runs unit tests with Vitest

**Key dependencies:**
- `@figma/plugin-typings` — TypeScript type definitions for the Figma Plugin API
- `typescript` — The TypeScript compiler
- `eslint` + plugins — Code quality checker
- `prettier` — Code formatter
- `vitest` — Test runner
- `puppeteer` — Headless browser for UI testing

### `tsconfig.json` — TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["ES2017"],
    "module": "CommonJS",
    "strict": true,
    "typeRoots": ["./node_modules/@figma"],
    "types": ["plugin-typings"]
  },
  "include": ["code.ts"]
}
```

This tells TypeScript:
- Compile to ES2017 (modern-enough JavaScript)
- Use Figma's type definitions so we get autocomplete and type-checking for `figma.*` APIs
- Only compile `code.ts` (the UI is plain HTML/JS, not TypeScript)

### `.eslintrc.json` — Linting Rules

Notable rules:
- `"no-var": "error"` — Forces `let`/`const` over `var` (modern JS best practice)
- `"eqeqeq": ["error", "always"]` — Forces `===` over `==` (prevents type coercion bugs)
- `"prefer-const": "warn"` — Prefers `const` when a variable is never reassigned

### `.prettierrc` — Code Formatting

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "es5",
  "printWidth": 100,
  "tabWidth": 2
}
```

This ensures consistent code style across the project: double quotes, semicolons, 2-space indentation.

---

## 3. The Plugin Sandbox — `code.ts`

This file runs inside Figma's secure sandbox. It **cannot** access the browser DOM or make network requests, but it **can** read and modify the Figma document.

### 3.1 Plugin Initialization (Lines 1–20)

```typescript
figma.showUI(__html__, { width: 480, height: 800, themeColors: true });
```

**`figma.showUI()`** is the very first thing a Figma plugin does. It:
- Opens the UI panel using the HTML from `ui.html` (`__html__` is a special Figma variable that contains the HTML file contents)
- Sets the initial panel size (480×800 pixels)
- `themeColors: true` tells Figma to inject CSS variables for its light/dark theme

```typescript
figma.ui.postMessage({
  type: "user-info",
  userId: figma.currentUser?.id || "anonymous",
});
```

Immediately sends the current user's Figma ID to the UI. The UI uses this for rate-limiting identification when calling the translation API. The `?.` is **optional chaining** — if `currentUser` is null, it won't crash but returns `undefined`.

```typescript
(async () => {
  try {
    const savedLocales = await figma.clientStorage.getAsync("savedLocales");
    if (Array.isArray(savedLocales) && savedLocales.length > 0) {
      figma.ui.postMessage({ type: "restore-locales", locales: savedLocales });
    }
  } catch { /* first launch or storage unavailable */ }
})();
```

This is an **IIFE** (Immediately Invoked Function Expression) — a function that runs right away. It:
1. Reads previously saved locale selections from Figma's persistent client storage
2. Sends them to the UI to restore the user's previous choices

`figma.clientStorage` is like `localStorage` but specific to the Figma plugin — data persists across sessions.

### 3.2 Helper Functions (Lines 26–143)

#### `collectTextNodes(node)` — Recursive Tree Walker

```typescript
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
```

**What it does:** Walks through every node in a frame tree and collects all text nodes.

**Key concepts:**
- **Recursion** — The function calls itself for each child node. This is a classic pattern for traversing tree structures (like the DOM or Figma's node tree).
- **Type narrowing** — `if (node.type === "TEXT")` checks the node type before treating it as a `TextNode`.
- **Duck typing** — `if ("children" in node)` checks whether the node has children without needing to know its exact type.
- **Spread operator** — `...collectTextNodes(child)` unpacks the array returned by the recursive call.

#### `mirrorForRtl(node)` — Right-to-Left Layout Mirroring

This function handles languages like Arabic and Hebrew that read right-to-left:

```typescript
function mirrorForRtl(node: SceneNode): void {
  if (node.type === "TEXT") {
    const align = node.textAlignHorizontal;
    if (align === "LEFT") node.textAlignHorizontal = "RIGHT";
    else if (align === "RIGHT") node.textAlignHorizontal = "LEFT";
    return;
  }
  // ... (swaps padding, reverses children order, swaps border radii)
}
```

**What it does:**
1. **Text nodes:** Flips LEFT alignment to RIGHT and vice versa
2. **Auto-layout frames:** Swaps `paddingLeft`/`paddingRight` and reverses child order
3. **Border radii:** Swaps left/right corner radii
4. **Recurses** into all children

This is a great example of how internationalisation (i18n) affects UI layout — it's not just about translating text!

#### `extractTextLayers(frame)` — Serialize Text Data

```typescript
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
```

Converts Figma node objects into plain JavaScript objects that can be sent to the UI via `postMessage`. Figma nodes can't be sent directly — only serialisable data (strings, numbers, arrays, plain objects) can cross the sandbox boundary.

#### `uint8ArrayToBase64(bytes)` — Manual Base64 Encoding

```typescript
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  // ... (processes 3 bytes at a time into 4 base64 characters)
}
```

The Figma sandbox doesn't have `btoa()` (which browsers normally provide), so this is a manual implementation. Base64 encoding converts binary data (like a PNG image) into a text string that can be safely embedded in HTML.

**Why base64?** Sending raw byte arrays through `postMessage` can be slow for large images. Base64 strings are more compact to transfer.

#### `exportFrameImage(node)` — Frame Screenshot

```typescript
async function exportFrameImage(node: SceneNode): Promise<Uint8Array> {
  const scale = Math.min(1, 800 / node.width);
  const bytes = await node.exportAsync({
    format: "PNG",
    constraint: { type: "SCALE", value: scale },
  });
  return bytes;
}
```

Exports the selected frame as a PNG thumbnail. `Math.min(1, 800 / node.width)` ensures the image is never upscaled and is capped at 800px wide for performance.

### 3.3 Selection Watcher (Lines 148–201)

```typescript
let selectionGeneration = 0;

async function handleSelectionChange() {
  const gen = ++selectionGeneration;
  const sel = figma.currentPage.selection;
  // ... exports image, extracts text ...
  if (gen !== selectionGeneration) return; // Bail if selection changed
  // ... sends data to UI ...
}

figma.on("selectionchange", handleSelectionChange);
handleSelectionChange(); // Fire once at launch
```

**Key concept: Race condition prevention with a generation counter.**

The problem: Exporting an image is async (takes time). If the user rapidly changes their selection, we don't want stale data from an old selection to overwrite fresh data from the new selection.

The solution: Each call to `handleSelectionChange` increments a counter (`selectionGeneration`). After the async export finishes, it checks if the counter still matches. If not, another selection happened in the meantime, and this result is discarded.

This is a common pattern in front-end development — you'll see it in search-as-you-type features, infinite scrolling, and anywhere async operations can be superseded.

### 3.4 Message Handler — `figma.ui.onmessage` (Lines 216–396)

This is the sandbox's "API router." It receives messages from the UI and takes action:

#### `apply-translations` — The Core Feature

```typescript
if (msg.type === "apply-translations") {
  const { sourceFrameId, translations } = msg;
  // 1. Input validation (check types of all incoming data)
  // 2. Find the source frame by ID
  // 3. For each locale:
  //    a. Clone the source frame
  //    b. Position the clone next to the original (with 50px gap)
  //    c. Batch-load all fonts used in the clone
  //    d. Replace text in each text node with the translation
  //    e. Mirror layout for RTL languages
  // 4. Notify the UI when done
}
```

**Important details:**

- **Font loading** — Before changing any text in Figma, you must load the fonts used by those text nodes. The code collects all unique fonts first, then loads them in parallel with `Promise.all()` for efficiency.
- **Node matching by index** — Clone preserves tree structure, so `cloneTextNodes[i]` corresponds to `sourceTextNodes[i]`.
- **RTL mirroring** — Applied after text changes, not before, because text content affects layout.

#### Other message types:

| Message | Purpose |
|---------|---------|
| `resize` | Allows the UI to request a window resize (with bounds checking) |
| `save-locales` | Persists locale selections to `clientStorage` |
| `save-preset` / `delete-preset` / `load-presets` | Manages saved locale presets |
| `close` | Closes the plugin |

---

## 4. The User Interface — `ui.html`

This is a single HTML file containing everything: HTML structure, CSS styles, and JavaScript logic. In the Figma plugin ecosystem, the UI must be a single file (no external imports allowed).

### 4a. HTML Structure

#### Security Header

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
           img-src blob: data:; connect-src https://localyse-proxy.adiramanan98.workers.dev;" />
```

**Content Security Policy (CSP)** is a security feature that restricts what the page can do:
- `default-src 'none'` — Block everything by default
- `script-src 'unsafe-inline'` — Only allow inline scripts (needed since everything is in one file)
- `img-src blob: data:` — Allow blob URLs and data URLs for the frame preview image
- `connect-src https://localyse-proxy...` — Only allow network requests to the translation proxy

This prevents the UI from loading external scripts or making unauthorized API calls — important for security.

#### Layout Skeleton

The HTML follows a **header / body / footer** layout:

```html
<body>
  <!-- Fixed header with logo and status -->
  <div class="header">...</div>

  <!-- Scrollable content area -->
  <div class="body" id="bodyContainer">
    <!-- State 1: Empty (no frame selected) -->
    <div id="emptyState">...</div>

    <!-- State 2: Main content (frame selected) -->
    <div id="mainContent" class="hidden">
      <div class="frame-card">...</div>        <!-- Frame preview -->
      <div class="locale-list">...</div>        <!-- Locale pickers -->
      <div id="resultsSection">...</div>        <!-- Translation results -->
    </div>

    <!-- State 3: Loading spinner -->
    <div id="generatingState" class="hidden">...</div>

    <!-- State 4: Success confirmation -->
    <div id="successState" class="hidden">...</div>
  </div>

  <!-- Fixed footer with action button -->
  <div class="footer">...</div>
</body>
```

**Pattern: State-based UI.** The app has four mutually exclusive states. Only one is visible at a time. The `renderView()` function hides/shows the appropriate sections by toggling the `hidden` CSS class. This is a fundamental front-end pattern — React calls them "conditional renders," and Vue calls them `v-if`/`v-show`.

### 4b. CSS Styling

#### CSS Custom Properties (Variables)

```css
:root {
  --bg: #ffffff;
  --bg-secondary: #f5f5f5;
  --text-primary: #1e1e1e;
  --accent: #5b5bf6;
  --border: #e0e0e0;
  --radius: 8px;
  --transition: 180ms ease;
  /* ... more ... */
}

.figma-dark {
  --bg: #2c2c2c;
  --bg-secondary: #383838;
  --text-primary: #e5e5e5;
  /* ... overrides for dark theme ... */
}
```

**CSS Custom Properties** (also called CSS variables) are defined with `--name` and used with `var(--name)`. They cascade like normal CSS, so when the `.figma-dark` class is added to `<html>`, all the color variables are overridden, and every element using `var(--bg)` etc. automatically updates. This is the standard way to implement **theming** in modern CSS.

#### Box Model Reset

```css
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
```

This is a **CSS reset**. By default, browsers add padding and margin to elements, and `box-sizing` is `content-box` (width/height don't include padding/border). This reset ensures:
- No surprise margins/padding
- `width: 100px` means the entire element is 100px, including its padding and border

Every modern project should include this.

#### Flexbox Layouts

The plugin uses **Flexbox** extensively:

```css
body {
  display: flex;
  flex-direction: column;  /* Stack children vertically */
}

.body {
  flex: 1;                 /* Take up all remaining space */
  overflow-y: auto;        /* Scroll when content overflows */
}

.header, .footer {
  flex-shrink: 0;          /* Never shrink, even if body overflows */
}
```

This creates a classic **sticky header + sticky footer + scrollable middle** layout. The `flex: 1` on `.body` is the key — it tells the middle section to grow and fill whatever space the header and footer don't use.

#### Animations

```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}

.fade-in {
  animation: fadeIn .25s ease both;
}
```

A subtle slide-up-and-fade-in effect. The `both` value for `animation-fill-mode` means the element stays at the final state after the animation completes (instead of snapping back).

#### Custom Dropdown Styling

The native `<select>` element is very hard to style consistently across browsers, so this plugin builds a **custom dropdown** from scratch:

```css
.custom-select-trigger {
  /* Looks like an input field */
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.custom-dropdown-menu {
  position: absolute;   /* Positioned relative to the wrapper */
  top: 100%;            /* Directly below the trigger */
  width: 100%;
  max-height: 240px;
  display: none;        /* Hidden by default */
  z-index: 100;         /* Appears above other content */
}

.custom-dropdown-menu.open {
  display: flex;        /* Shown when .open class is added */
}
```

**Key techniques:**
- `position: absolute` + `top: 100%` places the dropdown directly below its trigger
- `z-index: 100` ensures it appears above other page content
- The `.open` class toggles visibility (JavaScript adds/removes this class)

### 4c. JavaScript Logic

#### Data Layer — The `LOCALES` and `CURRENCIES` Arrays

```javascript
const LOCALES = [
  { code: "ar-SA", azureCode: "ar", label: "Arabic (Saudi Arabia)",
    flag: "🇸🇦", languages: ["Arabic"], currencies: ["SAR"] },
  { code: "fr-FR", azureCode: "fr", label: "French (France)",
    flag: "🇫🇷", languages: ["French"], currencies: ["EUR"] },
  // ... 120+ locales
];

const CURRENCIES = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  // ... 160+ currencies
];
```

These are **static lookup tables** — all the data the dropdowns need, hardcoded right in the file. Each locale has:
- `code` — The standard locale code (e.g., `fr-FR`)
- `azureCode` — The code Azure Translator expects (sometimes different)
- `flag` — An emoji flag for visual identification
- `languages` / `currencies` — Metadata shown to the user

#### State Management

```javascript
let selectedFrame = null;
let localeRows = [];
let isGenerating = false;
let isSuccess = false;
let successInfo = null;
let translationResults = null;
let appliedLocaleCodes = new Set();
let figmaUserId = "anonymous";
let rateLimitRemaining = null;
let localePresets = [];
```

This is a **simple state management** approach — all the application state lives in top-level variables. When state changes, the `renderView()` function is called to update the DOM to match.

This is conceptually identical to what React does with `useState`, but done manually. The pattern is:
1. State changes → 2. Call `renderView()` → 3. DOM updates

#### DOM References

```javascript
const $emptyState = document.getElementById("emptyState");
const $mainContent = document.getElementById("mainContent");
const $generateBtn = document.getElementById("generateBtn");
// ...
```

The `$` prefix is a naming convention (not required by JavaScript) that signals "this variable holds a DOM element." It's common in vanilla JS and jQuery codebases.

These references are cached once at startup rather than queried repeatedly, which is a performance best practice.

#### The Render Cycle — `renderView()`

```javascript
function renderView() {
  // 1. Hide everything
  $emptyState.classList.add("hidden");
  $mainContent.classList.add("hidden");
  $generatingState.classList.add("hidden");
  $successState.classList.add("hidden");
  $footer.classList.remove("hidden");

  // 2. Show the correct state
  if (isSuccess && successInfo) {
    $successState.classList.remove("hidden");
    // ... populate success view ...
    return;
  }
  if (isGenerating) {
    $generatingState.classList.remove("hidden");
    return;
  }
  if (!selectedFrame) {
    $emptyState.classList.remove("hidden");
    return;
  }

  // 3. Main content view
  $mainContent.classList.remove("hidden");
  // ... update frame preview, locale rows, etc. ...
}
```

**Pattern: Declarative rendering.** Rather than imperatively showing/hiding individual elements in response to events, the code:
1. Resets everything to hidden
2. Checks the current state
3. Shows only what's appropriate

This is much less error-prone than tracking which elements are currently visible.

#### Custom Dropdown — `renderCustomDropdown()`

Building a custom dropdown is one of the most instructive exercises in front-end development. Here's what this code does:

```javascript
function renderCustomDropdown(container, row, idx, type) {
  // 1. Create the trigger (the clickable button)
  const trigger = document.createElement("div");
  trigger.className = "custom-select-trigger";

  // 2. Create the dropdown menu (hidden initially)
  const menu = document.createElement("div");
  menu.className = "custom-dropdown-menu";

  // 3. Add a search input inside the dropdown
  const searchInput = document.createElement("input");
  searchInput.placeholder = "Search languages...";

  // 4. Add an options list
  const list = document.createElement("div");
  list.className = "options-list";

  // 5. Toggle dropdown on click
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();      // Don't let this click close the dropdown
    const wasOpen = menu.classList.contains("open");
    closeAllDropdowns();       // Close any other open dropdowns
    if (!wasOpen) {
      menu.classList.add("open");
      renderOptions(list, "", ...);
      setTimeout(() => searchInput.focus(), 50);
    }
  });

  // 6. Filter options as user types
  searchInput.addEventListener("input", () => {
    renderOptions(list, searchInput.value, ...);
  });

  // 7. Keyboard navigation
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { /* move highlight down */ }
    if (e.key === "ArrowUp")   { /* move highlight up */ }
    if (e.key === "Enter")     { /* select highlighted */ }
    if (e.key === "Escape")    { /* close dropdown */ }
  });

  // 8. Accessibility attributes
  trigger.setAttribute("role", "combobox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.tabIndex = 0;
  list.setAttribute("role", "listbox");
}
```

**Concepts demonstrated:**
- **`e.stopPropagation()`** — Prevents the click from bubbling up to `document`, which would trigger the "close all dropdowns" handler
- **Event delegation** — The `document.addEventListener("click", closeAllDropdowns)` handler closes dropdowns when clicking anywhere outside
- **Search/filter** — Re-renders the options list on every keystroke
- **Keyboard navigation** — ArrowDown/ArrowUp/Enter/Escape support, which is essential for accessibility
- **ARIA attributes** — `role="combobox"`, `aria-expanded`, `role="listbox"`, `aria-selected` help screen readers understand the widget

#### The Translation Engine — `startGeneration()` and `translateLayers()`

```javascript
async function startGeneration() {
  // 1. Gather selected locales
  const selectedLocales = localeRows.filter(r => r.code).map(r => {
    const meta = LOCALES.find(l => l.code === r.code);
    return { code: r.code, meta, currency: r.currency };
  });

  // 2. Filter out already-applied locales (incremental translation)
  const newLocales = selectedLocales.filter(loc => !appliedLocaleCodes.has(loc.code));

  // 3. Switch to loading state
  isGenerating = true;
  renderView();

  // 4. Translate each locale sequentially
  for (let i = 0; i < localesToTranslate.length; i++) {
    const loc = localesToTranslate[i];
    $genStatus.textContent = "Translating to " + loc.meta.label + "…";
    $genProgress.style.width = pct + "%";

    const translated = await translateLayers(
      selectedFrame.textLayers, loc.code, loc.meta, loc.currency
    );

    // 5. Apply immediately (don't wait for all locales)
    applyOneLocale(loc.meta.label, loc.code, translated);
    appliedLocaleCodes.add(loc.code);
  }

  // 6. Switch to success state
  isSuccess = true;
  renderView();
}
```

```javascript
async function translateLayers(textLayers, localeCode, localeMeta, currencyCode) {
  const payload = {
    textLayers: textLayers.map(l => ({
      id: l.id, layerName: l.name, text: l.characters,
    })),
    targetLocale: localeMeta.azureCode || localeCode,
    localeLabel: localeMeta.label || "",
    localeCurrencies: currencyCode ? [currencyCode] : (localeMeta.currencies || []),
  };

  const response = await fetch(WORKER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": figmaUserId,
    },
    body: JSON.stringify(payload),
  });

  // Handle rate limiting
  if (response.status === 429) {
    throw new Error("Daily limit reached. Please try again tomorrow.");
  }

  // Capture remaining quota from response header
  const remaining = response.headers.get("X-RateLimit-Remaining");
  if (remaining !== null) rateLimitRemaining = parseInt(remaining);

  const translatedArray = await response.json();

  // Merge translations with original text
  return textLayers.map(layer => {
    const match = translatedArray.find(t => t.id === layer.id);
    return {
      id: layer.id,
      original: layer.characters,
      translated: match?.translated || layer.characters,
    };
  });
}
```

**Key patterns:**
- **Progress feedback** — The progress bar width is updated as each locale completes: `$genProgress.style.width = pct + "%"`
- **Incremental application** — Each locale is applied to the canvas as soon as its translation completes, rather than waiting for all to finish
- **Error handling** — Uses try/catch with specific handling for rate limits (HTTP 429)
- **Custom headers** — `X-User-Id` sends the Figma user ID for rate limiting; `X-RateLimit-Remaining` in the response tells the UI how many requests remain

#### Message Communication — `window.onmessage`

```javascript
window.onmessage = (event) => {
  const msg = event.data && event.data.pluginMessage;
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "frame-selected") {
    selectedFrame = msg.payload;
    translationResults = null;
    appliedLocaleCodes.clear();
    ensureAtLeastOneLocale();
    renderView();
  }

  if (msg.type === "no-selection") {
    selectedFrame = null;
    renderView();
  }

  // ... other message types ...
};
```

**Pattern: Message-based communication.** This is how the UI iframe receives data from the sandbox. Each message has a `type` field that acts as a discriminator. The `pluginMessage` wrapper is a Figma convention.

**Security checks:**
- `if (!msg || typeof msg.type !== "string") return;` — Ignores malformed messages
- Only processes messages with known types

#### Sending Messages to the Sandbox

```javascript
// UI → Sandbox
parent.postMessage({
  pluginMessage: {
    type: "apply-translations",
    sourceFrameId: selectedFrame.id,
    translations: [{ locale, localeCode, layers }],
  }
}, "*");
```

`parent.postMessage()` sends data from the iframe (UI) to the parent window (Figma sandbox). The `pluginMessage` wrapper is required by Figma's plugin API.

#### Dark Theme Detection

```javascript
function applyTheme() {
  const isDark = document.documentElement.dataset.figmaTheme === "dark" ||
    window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("figma-dark", isDark);
}
applyTheme();

// Watch for Figma theme changes
new MutationObserver(applyTheme).observe(document.documentElement, {
  attributes: true, attributeFilter: ["data-figma-theme"]
});

// Watch for OS-level theme changes
window.matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", applyTheme);
```

Three detection methods:
1. **Figma's `data-figma-theme` attribute** — Set by Figma on the `<html>` element
2. **`prefers-color-scheme` media query** — The OS-level dark mode setting
3. **MutationObserver** — Watches for runtime changes to the theme attribute

This ensures the plugin always matches Figma's current theme, even if the user switches mid-session.

#### Toast Notifications

```javascript
let currentToast = null;
function showToast(message, type = "error") {
  if (currentToast) {
    currentToast.remove();
    currentToast = null;
  }
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  document.body.appendChild(el);
  currentToast = el;
  setTimeout(() => {
    if (currentToast === el) currentToast = null;
    el.remove();
  }, 4000);
}
```

**Pattern: Singleton toast.** Only one toast can be visible at a time — if a new one appears, the old one is removed first. This prevents toast stacking. The toast auto-dismisses after 4 seconds.

Note: `el.textContent = message` (not `innerHTML`) is used deliberately for security — it prevents HTML injection.

#### Unique ID Generator

```javascript
let uidCounter = 0;
function uid() { return "lr-" + (++uidCounter); }
```

A simple incrementing counter that generates unique IDs like `"lr-1"`, `"lr-2"`, etc. Used to give each locale row a stable identity. The `lr-` prefix stands for "locale row."

---

## 5. The Backend Worker — `worker/index.js`

This is a **Cloudflare Worker** — a serverless function that runs at the network edge (close to users worldwide). It acts as a secure proxy between the plugin and translation APIs.

### 5.1 Why a Proxy?

1. **API key security** — Azure and OpenAI API keys are stored as server-side secrets, never exposed to the client
2. **Rate limiting** — Prevents abuse by limiting each user to 50 requests/day
3. **Caching** — Identical translation requests return cached results
4. **CORS** — Handles cross-origin headers so the Figma iframe can make requests

### 5.2 Rate Limiting

```javascript
async function checkRateLimit(env, userId, ipAddress) {
  const userKey = `rate:${userId}`;
  const userCurrent = parseInt(await env.RATE_LIMIT.get(userKey)) || 0;

  if (userCurrent >= DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Also check IP-based limit (catches spoofed user IDs)
  const ipKey = `rate:ip:${ipAddress}`;
  const ipCurrent = parseInt(await env.RATE_LIMIT.get(ipKey)) || 0;

  if (ipCurrent >= IP_DAILY_LIMIT) {
    return { allowed: false, remaining: 0 };
  }

  // Increment both counters (auto-expire after 24 hours)
  await Promise.all([
    env.RATE_LIMIT.put(userKey, String(userCurrent + 1), { expirationTtl: 86400 }),
    env.RATE_LIMIT.put(ipKey, String(ipCurrent + 1), { expirationTtl: 86400 }),
  ]);

  return { allowed: true, remaining: DAILY_LIMIT - userCurrent - 1 };
}
```

**Dual rate limiting:**
- **Per-user** (50/day) — Based on Figma user ID sent in the `X-User-Id` header
- **Per-IP** (100/day) — A secondary defense that catches users who spoof their user ID

`env.RATE_LIMIT` is a Cloudflare KV (Key-Value) store — a globally distributed database. The `expirationTtl: 86400` means entries auto-delete after 24 hours.

### 5.3 Abbreviation Dictionary

```javascript
const ABBREV_DICT = {
  JAN: { fr: "JANV", de: "JAN", es: "ENE", ja: "1月", ... },
  FEB: { fr: "FÉV", de: "FEB", ... },
  MON: { fr: "LUN", de: "MO", ... },
  // ... months and weekdays
};

function lookupAbbrev(text, targetLocale) {
  const upper = text.trim().toUpperCase();
  const entry = ABBREV_DICT[upper];
  if (!entry) return null;

  const baseLang = targetLocale.split("-")[0].toLowerCase();
  const match = entry[targetLocale] || entry[baseLang];
  if (!match) return null;

  // Preserve the casing style of the original text
  if (text === text.toUpperCase()) return match.toUpperCase();
  if (text === text.toLowerCase()) return match.toLowerCase();
  // Title Case
  return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
}
```

Machine translation APIs often struggle with abbreviations like "JAN", "MON" etc. This dictionary provides **instant, correct** translations for common abbreviated months and weekdays, bypassing Azure entirely for these tokens.

**Case preservation** is clever: if the input was "Jan" (Title Case), the output is also Title Case; "JAN" → uppercase, "jan" → lowercase.

### 5.4 Azure Translator Integration

```javascript
async function translateWithAzure(env, textLayers, targetLocale) {
  // 1. Check dictionary first (fast path)
  for (let i = 0; i < textLayers.length; i++) {
    const dictMatch = lookupAbbrev(textLayers[i].text, targetLocale);
    if (dictMatch) results[i] = { id: textLayers[i].id, translated: dictMatch };
    else azureLayers.push({ originalIndex: i, layer: textLayers[i] });
  }

  // 2. Send remaining layers to Azure with context hints
  const azureBody = azureLayers.map(({ layer }) =>
    ({ Text: `[${layer.layerName}] ${layer.text}` })
  );

  const response = await fetch(azureUrl, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": env.AZURE_TRANSLATOR_KEY,
      "Ocp-Apim-Subscription-Region": env.AZURE_TRANSLATOR_REGION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(azureBody),
  });

  // 3. Strip context prefix from results
  // "[Titre] Bienvenue" → "Bienvenue"
}
```

**Context hints** — The layer name is prepended as `[LayerName]` before the text. This gives Azure Translator context about what kind of text it is (e.g., a "Price" layer vs. a "Heading" layer). After translation, the prefix is stripped.

### 5.5 LLM Refinement (GPT-4o-mini)

```javascript
async function refineWithLLM(env, textLayers, azureResults, targetLocale, localeLabel, localeCurrencies) {
  if (!env.OPENAI_API_KEY) return azureResults; // Graceful skip

  // Chunk large requests to avoid token limits
  for (let i = 0; i < azureResults.length; i += LLM_CHUNK_SIZE) {
    const chunk = azureResults.slice(i, i + LLM_CHUNK_SIZE);
    const refined = await refineChunkWithLLM(env, chunk, ...);
    allResults.push(...refined);
  }
  return allResults;
}
```

After Azure translates the text, GPT-4o-mini refines the translations for:
- **Currency formatting** — Converting `$49.99` to `49,99 €` for German locale
- **Date formats** — Adapting `MM/DD` to `DD/MM` where appropriate
- **Abbreviation length** — Keeping short text short
- **Natural phrasing** — Fixing awkward machine translations
- **Brand preservation** — Not translating proper nouns

**Graceful degradation** — If the OpenAI API key isn't configured, the function returns Azure's translations unchanged. If the LLM response is truncated or invalid, it falls back to Azure results.

### 5.6 Translation Caching

```javascript
async function makeCacheKey(textLayers, targetLocale, localeCurrencies) {
  const input = JSON.stringify({ texts: textLayers.map(l => l.text), locale: targetLocale, currencies: localeCurrencies });
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  // Convert to hex string → cache:fr:a3b4c5d6e7...
}
```

A SHA-256 hash of the input text + locale + currencies creates a deterministic cache key. Identical requests within 1 hour return the cached result instantly, saving API calls and cost.

### 5.7 Main Request Handler

```javascript
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    // Privacy policy page
    if (request.method === "GET" && url.pathname === "/privacy") return new Response(PRIVACY_POLICY_HTML, ...);

    // Translation endpoint
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    // 1. Validate configuration
    // 2. Check rate limit
    // 3. Validate payload size and structure
    // 4. Check cache
    // 5. Translate (Azure + optional LLM refinement)
    // 6. Cache result
    // 7. Return JSON response
  }
};
```

**Input validation is thorough:**
- Payload size limit (100KB)
- Maximum 500 text layers
- Maximum 5000 characters per layer
- Type checking on all fields

---

## 6. Testing

### Unit Tests (`tests/worker.test.js`)

Tests for the worker's helper functions using Vitest:

```javascript
describe("lookupAbbrev", () => {
  it("returns null for unknown abbreviations", () => { ... });
  it("falls back to base language for composite codes", () => { ... });
  it("preserves UPPERCASE casing", () => { ... });
  it("preserves lowercase casing", () => { ... });
  it("preserves Title Case casing", () => { ... });
  it("handles non-Latin scripts", () => { ... });
});

describe("stripContext", () => {
  it("strips context prefix from translated text", () => { ... });
  it("returns text unchanged if no bracket found", () => { ... });
  it("handles bracket in translated content", () => { ... });
});
```

These test:
- The abbreviation lookup with different locales, casing styles, and edge cases
- The context-stripping logic with various bracket positions

### UI Tests (`test-ui.mjs`)

Uses Puppeteer (headless Chrome) to test the full UI:
1. **Empty state** — Verifies the correct initial state
2. **Frame selection** — Simulates Figma sending a frame-selected message
3. **Locale picker** — Tests adding/removing locales, the 5-locale limit
4. **Translation flow** — Mocks the API and verifies results render correctly
5. **Reset** — Tests the "Start Over" flow

### Security Tests (`test-security.mjs`)

Tests for XSS (Cross-Site Scripting) vulnerabilities:
1. **CSP meta tag** — Verifies the Content Security Policy is present and correct
2. **XSS via text content** — Sends malicious JavaScript as text layer content and verifies it's rendered as safe text
3. **XSS via translations** — Verifies malicious translation responses are not executed
4. **Message validation** — Verifies that malformed messages are ignored
5. **Error sanitisation** — Verifies API error messages are truncated and not rendered as raw HTML

---

## 7. CI/CD Pipeline

```yaml
# .github/workflows/ci.yml
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "npm" }
      - run: npm ci
      - run: npx tsc --noEmit    # Type-check
      - run: npm run lint          # Lint
      - run: npm test              # Unit tests
```

Runs on every push/PR to `main` or `dev`. Three checks:
1. **TypeScript type checking** — Catches type errors without producing output files
2. **ESLint** — Catches code quality issues
3. **Vitest** — Runs unit tests

---

## 8. Key Front-End Patterns to Learn From

### Pattern 1: State Machine UI
The plugin has distinct states (empty → selected → generating → success). Only one state is active at a time. This prevents bugs like showing results while still loading.

### Pattern 2: Message Passing
The sandbox and UI communicate via `postMessage`. This is the same pattern used by Web Workers, iframes, and browser extensions. Each message has a `type` discriminator.

### Pattern 3: Defensive Programming
- Input validation everywhere (sandbox validates UI messages, worker validates HTTP requests)
- Graceful degradation (no OpenAI key? Skip LLM refinement. Image export failed? Show placeholder)
- Error boundaries (try/catch with user-friendly error messages)

### Pattern 4: CSS Custom Properties for Theming
One set of variables, swapped by adding a class to `<html>`. Every component references the variables, so theme changes cascade automatically.

### Pattern 5: DOM APIs over innerHTML
The code uses `document.createElement()` + `textContent` instead of `innerHTML` for dynamic content. This prevents XSS attacks because user-supplied text is never interpreted as HTML.

### Pattern 6: Async/Await with Race Condition Guards
The generation counter in `handleSelectionChange()` prevents stale async results from overwriting fresh ones.

### Pattern 7: Progressive Enhancement
- Rate limit info only shows when running low (not always)
- Dark theme auto-detects from both Figma and OS preferences
- Locale presets only appear when there are presets to show
- Translations are applied incrementally (one locale at a time) with progress feedback
