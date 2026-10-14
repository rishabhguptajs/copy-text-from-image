import type { Region } from './injected';

type CanvasLike = HTMLCanvasElement;
interface BitmapLike {
  width: number;
  height: number;
}

/**
 * Crops the screenshot to the selected region and cleans it up for OCR:
 * upscales small text, converts to grayscale and flips dark-mode text to dark-on-light.
 */
export function prepareCanvas(
  bitmap: BitmapLike & CanvasImageSource,
  region: Region,
  makeCanvas: () => CanvasLike,
): CanvasLike {
  // Screenshot pixels per CSS pixel. Accounts for display scaling and page zoom.
  const ratio = bitmap.width / region.vw;

  const sx = clamp(Math.round(region.x * ratio), 0, bitmap.width - 1);
  const sy = clamp(Math.round(region.y * ratio), 0, bitmap.height - 1);
  const sw = clamp(Math.round(region.w * ratio), 1, bitmap.width - sx);
  const sh = clamp(Math.round(region.h * ratio), 1, bitmap.height - sy);

  // Tesseract reads best when letters are ~30px+ tall. Normal web text is 12 to 16 CSS px,
  // so always work at roughly 3 pixels per CSS pixel, whatever the screen's DPR.
  const TARGET = 3;
  let scale = Math.max(1, TARGET / ratio);
  if (sh < 40) scale = Math.max(scale, 4 / ratio); // single tiny lines get extra help
  const maxSide = 5000;
  const maxPixels = 18_000_000;
  scale = Math.min(scale, maxSide / sw, maxSide / sh, Math.sqrt(maxPixels / (sw * sh)));
  scale = Math.max(scale, 0.25);

  const canvas = makeCanvas();
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = lum;
    sum += lum;
  }
  const mean = sum / (px.length / 4);
  if (mean < 110) {
    for (let i = 0; i < px.length; i += 4) {
      px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface OcrWord { text: string; confidence: number }
interface OcrLine { words: OcrWord[] }
interface OcrParagraph { lines: OcrLine[] }
interface OcrBlock { paragraphs: OcrParagraph[] }

const EDGE_MIN_CONF = 50; // junk sits at line edges, next to photos and icons
const INNER_MIN_CONF = 15; // words between good words are kept unless clearly garbage
const LINE_MIN_CONF = 55;

/**
 * Rebuilds text from Tesseract's word list, dropping the junk it "reads" inside photos,
 * logos and icons. That noise shows up as low-confidence fragments at the start or end of
 * a line, so we trim line edges and keep the confident words in the middle.
 */
export function textFromBlocks(blocks: OcrBlock[] | null | undefined, fallback: string): string {
  if (!blocks || blocks.length === 0) return cleanText(fallback);
  const paragraphs: string[] = [];
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      const lines: string[] = [];
      for (const line of para.lines) {
        let words = line.words.filter((w) => w.text.trim());
        while (words.length && isEdgeJunk(words[0])) words = words.slice(1);
        while (words.length && isEdgeJunk(words[words.length - 1])) words = words.slice(0, -1);
        words = words.filter((w) => w.confidence >= INNER_MIN_CONF || /[\p{L}\p{N}]{2,}/u.test(w.text));
        if (!words.length) continue;
        const avg = words.reduce((s, w) => s + w.confidence, 0) / words.length;
        const strong = words.filter((w) => w.confidence >= 80).length;
        // Keep a line when it is confident overall, or when most of it is clearly real text
        // (e.g. a sentence with one odd token like a pronunciation guide or footnote mark).
        if (avg < LINE_MIN_CONF && strong < Math.ceil(words.length / 2)) continue;
        const text = words.map((w) => w.text).join(' ');
        if (!/[\p{L}\p{N}]{2,}/u.test(text)) continue;
        lines.push(text);
      }
      if (lines.length) paragraphs.push(lines.join('\n'));
    }
  }
  return cleanText(paragraphs.join('\n\n'));
}

function isEdgeJunk(w: OcrWord): boolean {
  const t = w.text.trim();
  if (w.confidence < EDGE_MIN_CONF) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true; // lone symbols: "(", "—", "|", "&"
  if (t.length === 1 && !/^[aAI]$/.test(t)) return true; // stray single characters
  return false;
}

export function cleanText(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}
