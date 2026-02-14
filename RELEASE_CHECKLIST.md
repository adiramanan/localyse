# Localyse — Figma Plugin Release Checklist

## 1. Build + Packaging

- [x] Build passes (`npm run build`)
- [x] `code.js` and `ui.html` exist and are referenced correctly in manifest
- [x] No dev-only flags shipped (`enableProposedApi` removed)
- [ ] Consider minifying `code.js` for production (optional, not required for review)

## 2. `manifest.json`

- [x] `documentAccess` set to `"dynamic-page"`
- [x] `editorType` is `["figma"]`
- [x] `api` version is `"1.0.0"`
- [x] `networkAccess.allowedDomains` restricted to worker URL only
- [x] `networkAccess.reasoning` provided
- [x] No unnecessary `permissions` included
- [x] No hardcoded `id` (Figma assigns on first publish)

## 3. Functional QA

- [ ] Test with **nothing selected** → shows empty state
- [ ] Test with **wrong node type** selected (e.g. a vector, not a frame)
- [ ] Test with **multiple frames** selected
- [ ] Test with a **component/instance** selected
- [x] Missing fonts handling (try/catch on `loadFontAsync`)
- [ ] Test on a **large file** (many pages/nodes) → verify no performance issues
- [ ] Test **offline behavior** → verify error toast appears gracefully
- [ ] Test frame **deletion while plugin is open**
- [ ] Test with a frame that has **no text layers**

## 4. Trust, Safety & Support

- [x] Prepare a **support contact** (email: adiramanan98@gmail.com)
- [x] Draft a **privacy policy** (served at worker `/privacy` endpoint)
- [ ] Be ready for **Data security disclosure** in the publish flow

## 5. Listing Assets (entered in Figma publish modal)

- [ ] **Name**: Localyse
- [ ] **Tagline**: AI-powered design localisation
- [ ] **Description**: write a compelling description
- [ ] **Category**: select appropriate category
- [ ] **Icon**: 128×128 PNG
- [ ] **Thumbnail**: 1920×1080 PNG
- [ ] Optional: playground file
- [ ] Optional: up to 9 carousel images/videos

## 6. Submit

- [ ] Open **Figma Desktop** → Plugins → Manage plugins → **Publish**
- [ ] Fill listing details + upload media
- [ ] Complete Data security disclosure
- [ ] Add support contact
- [ ] **Submit for review**

## 7. Post-Publish

- [ ] Prepare release notes for future updates
- [ ] To update: Manage plugins → **Publish new version**
- [ ] Expect re-review for material updates
