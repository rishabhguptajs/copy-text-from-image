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
export interface OcrBlock { paragraphs: OcrParagraph[] }
export interface Rect { left: number; top: number; width: number; height: number }

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
export function looksLikeCode(blocks: OcrBlock[]): boolean {
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
        // Short code lines like "build(root)" often score low; losing a line is worse than a typo.
        const words = line.words.filter((w) => w.text.trim() && w.bbox);
        // A lone glyph far to the right of the line ("I", "|") is a speck, not code. It also stretches the
        // line's box upward and hides the blank line above it.
        const lineCharW = medianCharWidth(words);
        while (words.length > 1 && lineCharW) {
          const last = words[words.length - 1];
          const prev = words[words.length - 2];
          if (/^[Il|1.,'`]$/.test(last.text.trim()) && last.confidence < 85 && (last.bbox!.x0 - prev.bbox!.x1) / lineCharW >= 4) words.pop();
          else break;
        }
        if (!words.length) continue;
        const avg = words.reduce((s, w) => s + w.confidence, 0) / words.length;
        if (avg < 8 && !/[A-Za-z0-9]{3,}/.test(words.map((w) => w.text).join(''))) continue;
        allWords.push(...words);
        const bb = line.bbox;
        rows.push({
          text: '',
          left: words[0].bbox!.x0,
          top: Math.min(...words.map((w) => w.bbox!.y0 ?? bb?.y0 ?? 0)),
          bottom: bb?.y1 ?? 0,
        });
        (rows[rows.length - 1] as any).words = words;
      }
    }
  }
  if (!rows.length) return '';
  rows.sort((a, b) => a.top - b.top);
  const charW = medianCharWidth(allWords) || 8;
  for (const r of rows) {
    r.text = joinWords((r as any).words, charW);
    // The "i" of a leading "if" is often dropped, which also shifts the line one glyph left.
    if (/^f\s.*:$/.test(r.text)) {
      r.text = 'i' + r.text;
      r.left -= charW;
    }
  }
  restoreLeadingCall(rows as any, charW);
  const fixed = repairIdentifiers(rows.map((r) => r.text));
  rows.forEach((r, i) => (r.text = fixed[i]));
  const minLeft = Math.min(...rows.map((r) => r.left));
  const cols = rows.map((r) => (r.left - minLeft) / charW);
  const unit = indentUnit(cols);
  const pitches = rows.slice(1).map((r, i) => r.top - rows[i].top).filter((d) => d > 0).sort((a, b) => a - b);
  const pitch = pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0;
  const out: string[] = [];
  rows.forEach((r, i) => {
    if (i && pitch && r.top - rows[i - 1].top > pitch * 1.6) out.push('');
    const c = unit ? Math.round(cols[i] / unit) * unit : Math.round(cols[i]);
    out.push(' '.repeat(c >= 1 ? c : 0) + fixBrackets(straightenQuotes(r.text)).replace(/(["'])\s*[&§$#*%]{1,3}\s*\(/, '$1 % ('));
  });
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\s+$/g, '');
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

function straightenQuotes(line: string): string {
  return line.replace(/[\u2018\u2019\u201B]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/**
 * Tesseract misreads "(" and ")" as "{", "}", "[", "l" or "i": build{child), (child, v}).
 * Closers are matched against the opener on the stack and the wrong half is corrected.
 * Letters misread as brackets are left alone: guessing would corrupt real identifiers.
 */
function fixBrackets(line: string): string {
  const chars = line.split('');
  const stack: number[] = [];
  let quote = '';
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' && i > 0 && /[A-Za-z0-9_]/.test(chars[i - 1])) ch = chars[i] = '(';
    if ('({['.includes(ch)) stack.push(i);
    else if (ch === ')') {
      if (stack.length) chars[stack.pop()!] = '(';
    } else if (ch === '}' || ch === ']') {
      if (!stack.length) continue;
      const open = stack.pop()!;
      if (chars[open] === '(') chars[i] = ')';
    }
  }
  return chars.join('');
}

// ---------- second pass for code ----------

const lineAvg = (words: OcrWord[]) => (words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : -1);

/**
 * Bands of ink (full-width rows) that no recognised line covers. Tesseract sometimes skips a short
 * line such as "build(root)"; its ink is still there. Expects dark text on a light background.
 */
export function uncoveredBands(
  img: { data: Uint8ClampedArray; width: number; height: number },
  boxes: { y0: number; y1: number }[],
  words: { y0: number; y1: number }[] = [],
): { y0: number; y1: number }[] {
  if (!boxes.length) return [];
  const { data, width, height } = img;
  const need = Math.max(2, Math.round(width * 0.0015));
  const ink: boolean[] = [];
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) if (data[(y * width + x) * 4] < 110) n++;
    ink.push(n >= need);
  }
  const hs = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)] || 10;
  const gapMax = Math.max(2, Math.round(medH * 0.3));
  // Look only inside the gaps between recognised lines. Across the whole selection, the brackets of two
  // neighbouring lines touch and their ink fuses into one band that looks covered.
  const sorted = [...boxes].sort((a, b) => a.y0 - b.y0);
  const found: { y0: number; y1: number }[] = [];
  let reach = sorted[0].y1;
  for (let i = 1; i < sorted.length; i++) {
    const from = reach + 1;
    const to = sorted[i].y0 - 1;
    reach = Math.max(reach, sorted[i].y1);
    if (to - from + 1 < medH * 0.45) continue;
    let cur: { y0: number; y1: number } | null = null;
    let gap = 0;
    const close = () => {
      if (cur && cur.y1 - cur.y0 + 1 >= medH * 0.45) found.push(cur);
      cur = null;
    };
    for (let y = from; y <= to; y++) {
      if (ink[y]) {
        if (!cur) cur = { y0: y, y1: y };
        cur.y1 = y;
        gap = 0;
      } else if (cur && ++gap > gapMax) close();
    }
    close();
  }
  return found;
}

/**
 * Re-reads every line of a code selection on its own (single-line mode is far more accurate than
 * page layout mode), keeps whichever reading is more confident, and reads ink bands the first pass
 * missed. `ocrRect` runs single-line OCR on a rectangle and returns the words found there.
 */
export async function refineCodeBlocks(
  blocks: OcrBlock[],
  img: { data: Uint8ClampedArray; width: number; height: number },
  ocrRect: (r: Rect) => Promise<OcrWord[]>,
): Promise<void> {
  const lines = blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  const boxes = lines.filter((l) => l.bbox && l.bbox.y0 !== undefined).map((l) => ({ y0: l.bbox!.y0!, y1: l.bbox!.y1! }));
  const lineHs = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  const medLine = lineHs[Math.floor(lineHs.length / 2)] || 20;
  const rectFor = (x0: number, y0: number, x1: number, y1: number, pad?: number): Rect => {
    const padY = pad ?? Math.max(2, Math.round((y1 - y0) * 0.15));
    const left = clamp(Math.round(x0) - 8, 0, img.width - 1);
    const top = clamp(Math.round(y0) - padY, 0, img.height - 1);
    return {
      left,
      top,
      width: clamp(Math.round(x1) + 8 - left, 1, img.width - left),
      height: clamp(Math.round(y1) + padY - top, 1, img.height - top),
    };
  };
  // Page-mode lines that are already confident are left alone: re-reading them only costs time.
  const redo: { line: OcrLine; second: OcrWord[] }[] = [];
  for (const line of lines) {
    const bb = line.bbox;
    if (!bb || bb.y0 === undefined || bb.y1 === undefined) continue;
    const ws = line.words.filter((w) => w.text.trim());
    if (ws.length && lineAvg(ws) >= 92 && ws.every((w) => w.confidence >= 70)) continue;
    const second = await ocrRect(rectFor(bb.x0, bb.y0, bb.x1, bb.y1));
    if (second.length && second.every((w) => w.bbox)) redo.push({ line, second });
  }
  // Pick between the two readings by how many of their names occur in the other lines, then by confidence.
  const tokensOf = (ws: OcrWord[]) => new Set(ws.map((w) => w.text).join(' ').match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []);
  const lineSets = new Map<OcrLine, Set<string>>();
  const lineCount = new Map<string, number>();
  for (const line of lines) {
    const set = tokensOf(line.words);
    const other = redo.find((r) => r.line === line);
    if (other) for (const t of tokensOf(other.second)) set.add(t);
    lineSets.set(line, set);
    for (const t of set) lineCount.set(t, (lineCount.get(t) ?? 0) + 1);
  }
  const score = (line: OcrLine, ws: OcrWord[]) => {
    const own = lineSets.get(line)!;
    let sc = lineAvg(ws) / 100;
    for (const t of tokensOf(ws)) sc += (lineCount.get(t) ?? 0) - (own.has(t) ? 1 : 0) >= 1 ? 1 : -1;
    return sc;
  };
  for (const { line, second } of redo) {
    const bb = line.bbox!;
    let words = score(line, second) >= score(line, line.words) ? second : line.words;
    const other = words === second ? line.words : second;
    // Whichever reading wins may still start with a junk word ("Fr", "oe"): borrow the other reading's
    // confident word for that spot, and drop the junk and anything it covers.
    const first = words[0];
    const spot = other.find((w) => w.bbox && first.bbox && w.bbox.x0 <= first.bbox.x0 + 12 && w.bbox.x1 > first.bbox.x0 + 12);
    if (spot && first.text.length <= 3 && first.confidence < 60 && spot.confidence >= 80 && spot.text.length > first.text.length) {
      words = [spot, ...words.filter((w) => w.bbox!.x0 >= spot.bbox!.x1 - 4)];
    }
    line.words = words;
    line.bbox = { x0: words[0].bbox!.x0, x1: words[words.length - 1].bbox!.x1, y0: bb.y0, y1: bb.y1 };
  }
  const extra: OcrLine[] = [];
  const wordBoxes = lines.flatMap((l) =>
    l.words.filter((w) => w.text.trim() && w.bbox && w.bbox.y0 !== undefined).map((w) => ({ y0: w.bbox!.y0!, y1: w.bbox!.y1! })),
  );
  for (const band of uncoveredBands(img, boxes, wordBoxes)) {
    // Crop to the band's own ink columns and a full line's height: a tight, full-width strip reads as noise.
    let minX = img.width;
    let maxX = 0;
    for (let y = band.y0; y <= band.y1; y++) {
      for (let x = 0; x < img.width; x++) {
        if (img.data[(y * img.width + x) * 4] < 110) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    if (maxX <= minX) continue;
    const mid = (band.y0 + band.y1) / 2;
    const half = medLine * 0.65;
    const words = await ocrRect(rectFor(minX, mid - half, maxX, mid + half, 0));
    const known = [...tokensOf(words)].filter((t) => (lineCount.get(t) ?? 0) >= 1).length;
    if (words.length && (lineAvg(words) >= 45 || (lineAvg(words) >= 10 && known >= 1) || known >= 2) && /[A-Za-z0-9]{2,}/.test(words.map((w) => w.text).join(''))) {
      extra.push({ words, bbox: { x0: words[0].bbox!.x0, x1: words[words.length - 1].bbox!.x1, y0: band.y0, y1: band.y1 } });
    }
  }
  if (extra.length && blocks.length) blocks[0].paragraphs.push({ lines: extra });
}

const KNOWN_WORDS = new Set(
  ('def return for in if not else elif while import from class self None True False and or is lambda with as try except ' +
    'str int float len id print range set list dict tuple type sum min max abs open map zip sorted enumerate isinstance ' +
    'const let var function this new null undefined true false typeof async await console log').split(' '),
);

const levenshtein1 = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++d > 1) return false;
  return d === 1;
};

/**
 * Fixes glyph confusions using the code's own vocabulary: "striid" is "str(id" when both names occur
 * elsewhere, "wid" is "uid" when "uid" is used five times, "nl" is "n1" when "n2" exists.
 */
function repairIdentifiers(lines: string[]): string[] {
  const split = (l: string) => {
    const i = l.indexOf('#');
    return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i)];
  };
  const freq = new Map<string, number>();
  for (const l of lines) for (const t of split(l)[0].match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
  const KEYWORDS = new Set(['if', 'for', 'while', 'return', 'in', 'not', 'and', 'or', 'elif', 'else', 'with', 'switch', 'catch', 'print']);
  // Names used as calls elsewhere ("build(child)"): a space before "(" after them is a misread gap.
  const callNames = new Set<string>();
  for (const l of lines) for (const m of split(l)[0].matchAll(/([A-Za-z_]\w*)\(/g)) if (!KEYWORDS.has(m[1])) callNames.add(m[1]);
  const known = (t: string) => KNOWN_WORDS.has(t) || (freq.get(t) ?? 0) >= 2;
  const seen = (t: string) => t.length >= 2 && (KNOWN_WORDS.has(t) || (freq.get(t) ?? 0) >= 1);
  const strong = [...freq].filter(([t, n]) => n >= 3 && t.length >= 3).map(([t]) => t);
  const fix = (t: string): string => {
    for (let k = 2; k < t.length - 2; k++) {
      if ('liI1|'.includes(t[k]) && seen(t.slice(0, k)) && seen(t.slice(k + 1))) return t.slice(0, k) + '(' + t.slice(k + 1);
    }
    if (t.includes('_')) return t.split('_').map((part) => (part.length >= 3 ? fix(part) : part)).join('_');
    if (known(t) && !/^[a-z]+[lI]$/.test(t)) return t;
    const m = /^([A-Za-z]+)[lI]$/.exec(t);
    if (m && [...freq.keys()].some((k) => k === m[1] + '2' || k === m[1] + '3')) return m[1] + '1';
    if (known(t)) return t;
    // A stray glyph glued to a known name: "buildi(child)" is "build(child)".
    if (/[liI|]$/.test(t) && known(t.slice(0, -1)) && t.length > 3) return t.slice(0, -1);
    if (t.length >= 3) {
      const near = strong.filter((u) => levenshtein1(t, u));
      if (!near.length) return t;
      near.sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0));
      if (near.length === 1 || (freq.get(near[0]) ?? 0) >= 2 * (freq.get(near[1]) ?? 0)) return near[0];
    }
    return t;
  };
  return lines.map((l) => {
    const [code, comment] = split(l);
    const tidy = code
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, fix)
      .replace(/(\w)\.\s+(?=[A-Za-z_])/g, '$1.') // "edges. add" -> "edges.add"
      .replace(/\b([A-Za-z_]\w*)\s+\(/g, (m, n) => (callNames.has(n) ? n + '(' : m))
      .replace(/(\.[A-Za-z_]\w*)\s+\(/g, '$1(') // "dot.edge (" -> "dot.edge("
      .replace(/\._\s+(?=[A-Za-z])/g, '._') // "n2._ op" -> "n2._op"
      .replace(/\(\s+/g, '(')
      .replace(/([^\s,])\s+\)/g, '$1)');
    const digits = comment.replace(/\b([a-z]+)[lI]\b/g, (m, base) =>
      [...freq.keys()].some((k) => k === base + '2' || k === base + '3') ? base + '1' : m,
    );
    const call = balanceCall(fixBrackets(tidy).replace(/^(\s*[A-Za-z_]\w*),(?=[A-Za-z_]\w*\()/, '$1.'))
      .replace(/\(\s+/g, '(')
      .replace(/%\.(\d)7f?(?!\d)/g, '%.$1f');
    return call + digits;
  });
}

/** "x.add(child, v))" has one ")" too many: the tuple\'s opening "(" was lost. */
function balanceCall(code: string): string {
  const opens = (code.match(/\(/g) ?? []).length;
  const closes = (code.match(/\)/g) ?? []).length;
  if (closes !== opens + 1) return code;
  const i = code.indexOf('(');
  if (i < 0 || !/^\w+\s*,/.test(code.slice(i + 1))) return code;
  return code.slice(0, i + 1) + '(' + code.slice(i + 1);
}

/**
 * A line whose start was read as a short junk word followed by a wide gap ("rr      = uid, ...") lost a
 * call like "dot.node(name". A sibling line that starts "dot.node(name = uid ..." supplies it: same
 * word after the "=", and a prefix about as wide as the gap.
 */
function restoreLeadingCall(rows: { text: string; words?: OcrWord[] }[], charW: number): void {
  for (const r of rows) {
    const ws = r.words;
    if (!ws || ws.length < 3 || !ws[0].bbox || !ws[1].bbox) continue;
    if (ws[0].text.length > 3 || ws[0].confidence >= 70 || !/^=/.test(ws[1].text) || /[(.]/.test(ws[0].text)) continue;
    const span = (ws[1].bbox.x0 - ws[0].bbox.x0) / charW;
    if (span < 5) continue;
    const next = ws[1].text === '=' ? ws[2].text : ws[1].text.slice(1);
    const key = next.replace(/[^\w]+$/, '');
    for (const o of rows) {
      if (o === r) continue;
      const m = /^\s*([\w.]+\([^=]*?)\s*=\s*(\S+)/.exec(o.text);
      if (!m || m[2].replace(/[^\w]+$/, '') !== key) continue;
      if (Math.abs(m[1].length + 1 - span) > 3) continue;
      r.text = r.text.replace(/^(\s*)\S+\s+=/, '$1' + m[1] + ' =');
      break;
    }
  }
}
