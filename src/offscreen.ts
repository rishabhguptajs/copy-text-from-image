import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { Region } from './injected';
import { prepareCanvas, textFromBlocks } from './ocr-utils';

let workerPromise: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    // Everything is loaded from inside the extension package. No CDN, no network.
    workerPromise = createWorker('eng', 1 /* LSTM only */, {
      workerPath: chrome.runtime.getURL('tesseract/worker.min.js'),
      corePath: chrome.runtime.getURL('tesseract/core'),
      langPath: chrome.runtime.getURL('tesseract/lang'),
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'none',
    })
      .then(async (w) => {
        // Automatic layout: finds columns and sidebars instead of reading straight across the page.
        await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        return w;
      })
      .catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

async function loadBitmap(dataUrl: string): Promise<ImageBitmap> {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

function copyToClipboard(text: string) {
  // navigator.clipboard needs page focus, which an offscreen document never has.
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Clipboard write was blocked.');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'ocr-and-copy') return;
  (async () => {
    try {
      const bitmap = await loadBitmap(msg.dataUrl as string);
      const canvas = prepareCanvas(bitmap, msg.region as Region, () => document.createElement('canvas'));
      const worker = await getWorker();
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      const text = textFromBlocks(data.blocks as any, data.text || '');
      if (text) copyToClipboard(text);
      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, error: String((err as Error)?.message || err) });
    }
  })();
  return true;
});

// Warm the engine up in the background so the first capture is faster.
void getWorker().catch(() => {});
