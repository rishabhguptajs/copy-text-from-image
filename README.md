# Copy Text from Image: Offline OCR

Chrome extension (Manifest V3) by Raegent. Copy text from any image, video frame, chart or unselectable text. OCR runs 100% on-device with Tesseract; nothing is uploaded.

## Use
- Right-click an image → **Copy text from image**
- `Ctrl+Shift+Y` (`Cmd+Shift+Y` on Mac) → drag a box over anything
- Or click the toolbar icon → **Select area to copy text**

## Try it locally
1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → pick the `dist` folder

## Develop
```
npm install
npm run build        # production build to dist/
npm run build:test   # test build to dist-test/ (adds test hooks + <all_urls>, never publish this)
npm run typecheck
```

## Before publishing
1. **Dodo Payments:** create the product ($4.99 one-time) and attach a License Key entitlement. Keys are validated with Dodo's public `POST https://live.dodopayments.com/licenses/validate` endpoint (no API key needed). Point `BUY_URL` in `src/license.ts` at your checkout or at raegent.com/ocr.
2. Host a privacy policy at raegent.com/ocr (the text in the options page is a good start).
3. Zip the **contents** of `dist/` and upload to the Chrome Web Store, Edge Add-ons and (after a Firefox check) Firefox Add-ons.

## Layout
- `src/background.ts` service worker: menus, shortcut, screenshot, free-limit gate
- `src/injected.ts` functions injected into pages: area selector, image locator, toast
- `src/offscreen.ts` offscreen document: runs Tesseract in a worker, copies to clipboard
- `src/ocr-utils.ts` crop, upscale, grayscale, dark-mode inversion, text cleanup
- `src/license.ts` 10 free captures, then license key unlock
- `static/` manifest, HTML pages, icons
