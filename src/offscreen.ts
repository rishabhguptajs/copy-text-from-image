import { createWorker, PSM, type Worker } from 'tesseract.js';
import type { Region } from './injected';
import { looksLikeCode, prepareCanvas, refineCodeBlocks, textFromBlocks } from './ocr-utils';

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
        await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO, preserve_interword_spaces: '1' });
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

async function recognize(canvas: HTMLCanvasElement, singleLine: boolean): Promise<string> {
  const worker = await getWorker();
  // A one-line selection is read much faster, and more accurately, as a single line.
  await worker.setParameters({ tessedit_pageseg_mode: singleLine ? PSM.SINGLE_LINE : PSM.AUTO });
  const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
  const blocks = data.blocks as any;
  if (!singleLine && blocks && looksLikeCode(blocks)) {
    // Code: re-read each line on its own and pick up lines the page pass skipped.
    const img = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
    try {
      await refineCodeBlocks(blocks, img, async (rect) => {
        // Recognise a small padded crop: handing the worker the whole canvas re-encodes it every call.
        const M = 10;
        const crop = document.createElement('canvas');
        crop.width = rect.width + 2 * M;
        crop.height = rect.height + 2 * M;
        const cctx = crop.getContext('2d')!;
        cctx.fillStyle = '#fff';
        cctx.fillRect(0, 0, crop.width, crop.height);
        cctx.drawImage(canvas, rect.left, rect.top, rect.width, rect.height, M, M, rect.width, rect.height);
        const r = await worker.recognize(crop, {}, { blocks: true });
        const words = ((r.data.blocks as any[]) ?? []).flatMap((b) => b.paragraphs.flatMap((p: any) => p.lines.flatMap((l: any) => l.words)));
        const dx = rect.left - M;
        const dy = rect.top - M;
        for (const w of words) {
          if (w.bbox) w.bbox = { x0: w.bbox.x0 + dx, x1: w.bbox.x1 + dx, y0: w.bbox.y0 + dy, y1: w.bbox.y1 + dy };
        }
        return words;
      });
    } catch {
      // Keep the first-pass result if the refinement fails.
    }
  }
  return textFromBlocks(blocks, data.text || '');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  (async () => {
    try {
      let text = '';
      if (msg.type === 'copy-text') {
        text = msg.text as string;
      } else if (msg.type === 'ocr-and-copy') {
        const region = msg.region as Region;
        const bitmap = await loadBitmap(msg.dataUrl as string);
        const canvas = prepareCanvas(bitmap, region, () => document.createElement('canvas'));
        text = await recognize(canvas, region.h < 36 && region.w > region.h * 3);
      } else if (msg.type === 'ocr-original') {
        // The image at its own resolution: no crop. Upscale only small images.
        const bitmap = await loadBitmap(msg.dataUrl as string);
        const whole: Region = { x: 0, y: 0, w: bitmap.width, h: bitmap.height, vw: bitmap.width, vh: bitmap.height };
        const scale = Math.min(bitmap.width, bitmap.height) < 900 ? 2 : 1;
        const canvas = prepareCanvas(bitmap, whole, () => document.createElement('canvas'), { scale });
        text = await recognize(canvas, false);
      } else {
        return;
      }
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
