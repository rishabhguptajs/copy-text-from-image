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
  opts: { scale?: number } = {},
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
  if (opts.scale) scale = Math.min(opts.scale, maxSide / sw, maxSide / sh, Math.sqrt(maxPixels / (sw * sh)));
  scale = Math.max(scale, 0.25);

  const canvas = makeCanvas();
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // Transparent PNGs would otherwise read as black and trigger the dark-mode inversion below.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = img.data;
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = lum;
    hist[lum | 0]++;
    sum += lum;
  }
  const total = px.length / 4;
  const mean = sum / total;
  // Stretch contrast between the 2nd and 98th percentile so faint grey text becomes crisp.
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < total * 0.02; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < total * 0.02; hi--);
  const span = hi - lo;
  const stretch = span >= 30 && span < 235;
  const invert = mean < 110;
  for (let i = 0; i < px.length; i += 4) {
    let v = px[i];
    if (stretch) v = clamp(((v - lo) * 255) / span, 0, 255);
    if (invert) v = 255 - v;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface OcrBox { x0: number; x1: number; y0?: number; y1?: number }
interface OcrWord { text: string; confidence: number; bbox?: OcrBox }
interface OcrLine { words: OcrWord[]; bbox?: OcrBox }
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
  if (looksLikeCode(blocks)) {
    const code = codeFromBlocks(blocks);
    if (code) return code;
  }
  interface Kept { text: string; left: number | null; charW: number | null }
  const paragraphs: Kept[][] = [];
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      const lines: Kept[] = [];
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
        const charW = medianCharWidth(words);
        const text = joinWords(words, charW);
        if (!/[\p{L}\p{N}]{2,}/u.test(text) && !words.every(isCodeSymbol)) continue;
        lines.push({ text, left: words[0].bbox ? words[0].bbox.x0 : null, charW });
      }
      if (lines.length) paragraphs.push(lines);
    }
  }
  // Indentation: measure each line's left edge against the leftmost line, in characters.
  const lefts = paragraphs.flat().map((l) => l.left).filter((v): v is number => v !== null);
  const minLeft = lefts.length ? Math.min(...lefts) : 0;
  const widths = paragraphs.flat().map((l) => l.charW).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const globalCharW = widths.length ? widths[Math.floor(widths.length / 2)] : 0;
  const out = paragraphs.map((lines) =>
    lines
      .map((l) => {
        if (l.left === null || !globalCharW) return l.text;
        const cols = Math.round((l.left - minLeft) / globalCharW);
        return (cols >= 2 ? ' '.repeat(cols) : '') + l.text;
      })
      .join('\n'),
  );
  return cleanText(out.join('\n\n'));
}

/** Typical glyph width of a line, from its words' boxes. Null when boxes are missing. */
function medianCharWidth(words: OcrWord[]): number | null {
  const ws = words
    .filter((w) => w.bbox && w.text.length >= 2)
    .map((w) => (w.bbox!.x1 - w.bbox!.x0) / w.text.length)
    .sort((a, b) => a - b);
  return ws.length ? ws[Math.floor(ws.length / 2)] : null;
}

/** Joins words with one space, or with proportionally more when a wide gap (aligned columns, code) separates them. */
function joinWords(words: OcrWord[], charW: number | null): string {
  let out = words[0].text;
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1].bbox;
    const b = words[i].bbox;
    let spaces = 1;
    if (a && b && charW) {
      const gap = (b.x0 - a.x1) / charW;
      if (gap >= 3) spaces = Math.round(gap);
    }
    out += ' '.repeat(spaces) + words[i].text;
  }
  return out;
}

// Brackets and punctuation that real code lines start or end with. Kept when Tesseract is confident.
const CODE_SYMBOLS = /^[{}()[\];,.:<>=+\-*/\\"'`;]+$/;
const CODE_SYMBOL_MIN_CONF = 75;

function isCodeSymbol(w: OcrWord): boolean {
  return w.confidence >= CODE_SYMBOL_MIN_CONF && CODE_SYMBOLS.test(w.text.trim());
}

function isEdgeJunk(w: OcrWord): boolean {
  const t = w.text.trim();
  if (isCodeSymbol(w)) return false;
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
    .replace(/^\n+|\s+$/g, ''); // keep the first line's indentation
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// ---------- source code ----------

const CODE_HINT = /[=(){}[\];_]|\w\.\w|^\s*#/;
const CODE_STRONG = /[=(){};]|\b(def|return|import|const|function)\b/;

/** Several lines full of brackets, assignments and identifiers: treat the box as source code. */
function looksLikeCode(blocks: OcrBlock[]): boolean {
  const lines = blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const texts = lines.map((l) => l.words.map((w) => w.text).join(' ')).filter((t) => t.trim());
  if (texts.length < 3) return false;
  const hinted = texts.filter((t) => CODE_HINT.test(t)).length;
  const strong = texts.filter((t) => CODE_STRONG.test(t)).length;
  return hinted / texts.length >= 0.6 && strong >= 2 && strong / texts.length >= 0.4;
}

/**
 * Code needs every character: no edge trimming, symbols and comment marks stay, one line per
 * source line, indentation snapped to the file's own indent step, blank lines where there were gaps.
 */
function codeFromBlocks(blocks: OcrBlock[]): string {
  interface L { text: string; left: number; top: number; bottom: number }
  const rows: L[] = [];
  const allWords: OcrWord[] = [];
  for (const block of blocks) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        const words = line.words.filter((w) => w.text.trim() && w.confidence >= 10 && w.bbox);
        if (!words.length) continue;
        const avg = words.reduce((s, w) => s + w.confidence, 0) / words.length;
        if (avg < 25) continue;
        allWords.push(...words);
        const bb = line.bbox;
        rows.push({
          text: '',
          left: words[0].bbox!.x0,
          top: bb?.y0 ?? 0,
          bottom: bb?.y1 ?? 0,
        });
        (rows[rows.length - 1] as any).words = words;
      }
    }
  }
  if (!rows.length) return '';
  rows.sort((a, b) => a.top - b.top);
  const charW = medianCharWidth(allWords) || 8;
  for (const r of rows) r.text = joinWords((r as any).words, charW);
  const minLeft = Math.min(...rows.map((r) => r.left));
  const cols = rows.map((r) => (r.left - minLeft) / charW);
  const unit = indentUnit(cols);
  const pitches = rows.slice(1).map((r, i) => r.top - rows[i].top).filter((d) => d > 0).sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
  const out: string[] = [];
  rows.forEach((r, i) => {
    if (i && pitch && r.top - rows[i - 1].top > pitch * 1.6) out.push('');
    const c = unit ? Math.round(cols[i] / unit) * unit : Math.round(cols[i]);
    out.push(' '.repeat(c >= 1 ? c : 0) + fixBrackets(r.text));
  });
  return out.join('\n').replace(/^\n+|\s+$/g, '');
}

/** The indent step (2, 4, 3 or 8 columns) that best fits the measured line offsets. */
function indentUnit(cols: number[]): number {
  const indented = cols.filter((c) => c >= 1);
  if (!indented.length) return 0;
  let best = 0;
  let bestErr = 0.2; // average rounding error must beat this, or we leave offsets unsnapped
  for (const u of [4, 2, 3, 8]) {
    const err = indented.reduce((s, c) => s + Math.abs(c / u - Math.round(c / u)), 0) / indented.length;
    if (err < bestErr) {
      best = u;
      bestErr = err;
    }
  }
  return best;
}

/**
 * Tesseract often reads "(" as "{" or "[" next to identifiers: build{child). A closing ")" that finds
 * a "{" or "[" open on top of the stack means that opener was really "(".
 */
function fixBrackets(line: string): string {
  const chars = line.split('');
  const stack: number[] = [];
  chars.forEach((ch, i) => {
    if ('({['.includes(ch)) stack.push(i);
    else if (ch === ')' && stack.length) {
      const j = stack.pop()!;
      if (chars[j] !== '(') chars[j] = '(';
    } else if (ch === '}' && stack.length) stack.pop();
    else if (ch === ']' && stack.length) stack.pop();
  });
  return chars.join('');
}
