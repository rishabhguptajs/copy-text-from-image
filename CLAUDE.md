# Copy Text from Image: Offline OCR (by Raegent)

Chrome extension (Manifest V3). Copies text from images, video frames and unselectable text. OCR runs fully on-device with Tesseract.js (WASM). Sold as a one-time $4.99 license through Dodo Payments.

## Commands
- `npm install` once
- `npm run build` → production build in `dist/`
- `npm run build:test` → test build in `dist-test/` (test hooks + `<all_urls>`). Never publish this one.
- `npm run typecheck`
- `npm run release` → production build, then zips `dist/` contents into `release/copy-text-from-image-v<version>.zip`

## Layout
- `src/background.ts` service worker: context menus, keyboard command, screenshot, free-limit gate, toasts
- `src/injected.ts` functions injected into pages via `chrome.scripting.executeScript({ func })`. They are serialized, so every function must be fully self-contained (no imports, no outside references).
- `src/offscreen.ts` offscreen document: runs Tesseract in a worker, copies to clipboard (execCommand, since offscreen docs have no focus)
- `src/ocr-utils.ts` crop, ~3x upscale, grayscale, dark-mode inversion, confidence-based junk filtering (`textFromBlocks`)
- `src/license.ts` 10 free captures; Dodo license activation (`POST /licenses/activate`, public endpoint) and weekly re-validation (`POST /licenses/validate`). Offline never locks users out; only an explicit `valid:false` removes the license.
- `static/` manifest, popup/options/offscreen HTML, icons
- `build.mjs` esbuild bundle + copies Tesseract worker, LSTM-only WASM cores and `eng.traineddata.gz` into the build. MV3 forbids remote code, so OCR assets must stay bundled.
- `store-assets/` Chrome Web Store screenshots and promo tiles (`make_assets.py` regenerates them)

## Key facts
- Checkout link: https://checkout.dodopayments.com/buy/pdt_0NolvTkkAlmLwUujNDBuh?quantity=1 (`BUY_URL` in `src/license.ts`)
- Support email: hello@raegent.com (`SUPPORT_EMAIL` in `src/license.ts`)
- Website: raegent.com/ocr, thanks page raegent.com/ocr/thanks, privacy raegent.com/ocr/privacy
- Dodo license: no expiry, activation limit 3 devices

## Rules
- Never delete files without asking.
- Keep permissions minimal; any new permission needs a justification for the store's Privacy tab.
- No remote code, no analytics, nothing uploaded. Privacy is the main selling point.
- Copy style: no em dashes, no fabricated numbers.
- Bump `version` in `static/manifest.json` for every store upload (store rejects same or lower versions).

## Releasing an update
1. Make changes, `npm run typecheck`, test by loading `dist/` unpacked in Chrome
2. Bump version in `static/manifest.json`
3. `npm run release`
4. Chrome Web Store dashboard → item → Package → Upload new package → Submit for review
5. After approval, Chrome auto-updates existing users within a few hours

## Backlog
- Change default shortcut from Cmd/Ctrl+Shift+Y (clashes with Mac screenshot apps)
- Drag-select over real page text: read DOM text directly instead of OCR (instant, 100% accurate); OCR only for images/video/canvas
- Right-click image: OCR the original full-resolution image instead of a screenshot of it
- Auto-activate license when the buyer lands on raegent.com/ocr/thanks?license_key=...
- More OCR languages as optional downloads
