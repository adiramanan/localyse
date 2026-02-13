# Localyse

A Figma plugin that helps designers localise their designs into multiple languages using AI-powered translation (GPT-4o-mini).

## Features

- **Frame Selection** — Select any frame, component, or instance on the canvas to localise
- **Live Preview** — See a thumbnail of the selected frame inside the plugin
- **Up to 5 Locales** — Add up to five target locales, each showing available languages and currencies
- **Smart Translation** — Uses OpenAI GPT-4o-mini to intelligently translate content:
  - Translates UI copy, labels, and body text into the target language
  - Transliterates or preserves proper names (people) appropriately per locale
  - Localises place names to their commonly accepted forms
  - Converts currency symbols and codes to match the target locale
  - Reformats numbers and dates to locale conventions
  - Preserves template variables and placeholders
- **Apply to Canvas** — Creates duplicated, translated frames directly on the Figma canvas

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Plugin

```bash
npm run build
```

This compiles `code.ts` into `code.js`.

### 3. Load in Figma

1. Open Figma Desktop
2. Go to **Plugins → Development → Import plugin from manifest…**
3. Select the `manifest.json` file from this directory
4. The plugin will appear under **Plugins → Development → Localyse**

### 4. Use the Plugin

1. Run the plugin from the Figma menu
2. Select a frame on the canvas — a preview will appear in the plugin
3. Enter your **OpenAI API key** in the input field
4. Add up to 5 target locales using the locale picker
5. Click **Generate Translations** — the plugin calls GPT-4o-mini to translate all text layers
6. Review the translations in the results panel
7. Click **Apply to Canvas** to create localised copies of the frame

## Project Structure

```
manifest.json   — Figma plugin manifest
code.ts         — Plugin sandbox code (TypeScript source)
code.js         — Compiled plugin sandbox code
ui.html         — Plugin UI (HTML + CSS + JS, runs in iframe)
package.json    — Dependencies and build scripts
tsconfig.json   — TypeScript configuration
```

## API Key

The plugin requires an OpenAI API key to function. The key is entered directly in the plugin UI and is used only for in-browser API calls — it is never stored on any server.

The plugin uses the `gpt-4o-mini` model, which is cost-effective and performant for translation tasks.

## Supported Locales

The plugin includes 40+ locales spanning major world languages and regions, each with:
- **Languages** spoken in that locale
- **Currencies** used in that locale (including locales with multiple currencies)

## License

MIT
