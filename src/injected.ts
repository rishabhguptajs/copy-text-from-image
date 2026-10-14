// Functions in this file are injected into web pages with chrome.scripting.executeScript({ func }).
// They are serialized, so each one must be fully self-contained: no imports, no outside references.

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  vw: number; // viewport width in CSS px, used to map to screenshot pixels
  vh: number;
}

/** Full-page overlay: user drags a box, resolves with the box in viewport CSS px (or null if cancelled). */
export function selectRegion(): Promise<Region | null> {
  return new Promise((resolve) => {
    const ID = '__raegent_ocr_overlay';
    document.getElementById(ID)?.remove();

    const overlay = document.createElement('div');
    overlay.id = ID;
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.18)',
      userSelect: 'none',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed',
      border: '2px solid #C14D2E',
      background: 'rgba(193,77,46,0.10)',
      boxShadow: '0 0 0 9999px rgba(0,0,0,0.12)',
      display: 'none',
      pointerEvents: 'none',
      borderRadius: '2px',
    });

    const hint = document.createElement('div');
    hint.textContent = 'Drag over the text you want to copy   ·   Esc to cancel';
    Object.assign(hint.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 14px',
      borderRadius: '8px',
      background: '#1c1b19',
      color: '#f5f3ee',
      font: '500 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif',
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
    });

    overlay.append(box, hint);
    document.documentElement.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let done = false;

    const rectFrom = (e: MouseEvent) => {
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      return { x, y, w, h };
    };

    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const r = rectFrom(e);
      Object.assign(box.style, {
        left: `${r.x}px`,
        top: `${r.y}px`,
        width: `${r.w}px`,
        height: `${r.h}px`,
      });
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
    };

    const finish = (r: { x: number; y: number; w: number; h: number } | null) => {
      if (done) return;
      done = true;
      cleanup();
      if (!r) return resolve(null);
      // Wait until the overlay is gone from the screen before the screenshot is taken.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          setTimeout(() => resolve({ ...r, vw: window.innerWidth, vh: window.innerHeight }), 40),
        ),
      );
    };

    const onUp = (e: MouseEvent) => {
      if (!dragging) return;
      dragging = false;
      const r = rectFrom(e);
      if (r.w < 6 || r.h < 6) return finish(null);
      finish(r);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };

    overlay.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      hint.style.display = 'none';
      box.style.display = 'block';
      onMove(e);
    });
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
    window.addEventListener('keydown', onKey, true);
  });
}

/**
 * Reads real page text inside the box straight from the DOM (instant, exact). Returns null when
 * the box is mostly an image, video or canvas, or holds no real text, so the caller can fall back to OCR.
 */
export function readDomText(r: { x: number; y: number; w: number; h: number }): string | null {
  const inside = (cx: number, cy: number) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;

  // 1. If pictures cover a good part of the box, the text is probably inside them: use OCR.
  let media = 0;
  let samples = 0;
  const N = 6;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const el = document.elementFromPoint(r.x + ((i + 0.5) * r.w) / N, r.y + ((j + 0.5) * r.h) / N);
      if (!el) continue;
      samples++;
      if (/^(IMG|VIDEO|CANVAS|PICTURE|OBJECT|EMBED|IFRAME)$/i.test(el.tagName)) media++;
      else if (el.tagName === 'svg' || el.closest('svg')) media++;
      else if (getComputedStyle(el).backgroundImage.startsWith('url(') && !(el.textContent || '').trim()) media++;
    }
  }
  if (!samples || media / samples >= 0.15) return null;

  // 2. Collect words whose centre lies inside the box and that are really visible there.
  interface W { t: string; x0: number; x1: number; y0: number; y1: number }
  const words: W[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let count = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.nodeValue || '';
    const parent = n.parentElement;
    if (!parent || !text.trim() || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.tagName)) continue;
    range.selectNodeContents(n);
    const nb = range.getBoundingClientRect();
    if (nb.right < r.x || nb.left > r.x + r.w || nb.bottom < r.y || nb.top > r.y + r.h) continue;
    const cs = getComputedStyle(parent);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
    // Invisible-ink text (transparent colour, zero size) must not reach the clipboard: the user cannot see it.
    if (/^rgba\(.*,\s*0\)$/.test(cs.color) || cs.color === 'transparent' || parseFloat(cs.fontSize) < 4) continue;
    const re = /\S+/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      for (const b of Array.from(range.getClientRects())) {
        if (!b.width || !b.height) continue;
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        if (!inside(cx, cy)) continue;
        const top = document.elementFromPoint(cx, cy);
        if (!top || !(parent.contains(top) || top.contains(parent))) continue; // covered by something else
        if (++count > 4000) return null;
        words.push({ t: m[0], x0: b.left, x1: b.right, y0: b.top, y1: b.bottom });
        break;
      }
    }
  }
  if (!words.length) return null;

  // 3. Group words into lines by vertical overlap, then rebuild spacing and indentation.
  words.sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1) || a.x0 - b.x0);
  const lines: W[][] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    const ref = last && last[0];
    if (ref && Math.abs(w.y0 + w.y1 - (ref.y0 + ref.y1)) / 2 < Math.min(w.y1 - w.y0, ref.y1 - ref.y0) * 0.6) last.push(w);
    else lines.push([w]);
  }
  const widths = words.filter((w) => w.t.length >= 2).map((w) => (w.x1 - w.x0) / w.t.length).sort((a, b) => a - b);
  const charW = widths.length ? widths[Math.floor(widths.length / 2)] : 8;
  const minLeft = Math.min(...lines.map((l) => Math.min(...l.map((w) => w.x0))));
  const out: string[] = [];
  let prevBottom = 0;
  for (const l of lines) {
    l.sort((a, b) => a.x0 - b.x0);
    let text = l[0].t;
    for (let i = 1; i < l.length; i++) {
      const gap = (l[i].x0 - l[i - 1].x1) / charW;
      text += ' '.repeat(gap >= 3 ? Math.round(gap) : 1) + l[i].t;
    }
    const cols = Math.round((l[0].x0 - minLeft) / charW);
    const top = Math.min(...l.map((w) => w.y0));
    const height = Math.max(...l.map((w) => w.y1)) - top;
    if (out.length && top - prevBottom > height * 0.8) out.push(''); // paragraph gap
    out.push((cols >= 2 ? ' '.repeat(cols) : '') + text);
    prevBottom = Math.max(...l.map((w) => w.y1));
  }
  const result = out.join('\n').replace(/\s+$/, '');
  return /[\p{L}\p{N}]/u.test(result) ? result : null;
}

/** Fetches the right-clicked image at full resolution, from inside the page so cookies and CORS rules match. */
export async function fetchImageData(srcUrl: string): Promise<string | null> {
  try {
    const res = await fetch(srcUrl, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') || blob.type.includes('svg') || blob.size > 15_000_000) return null;
    return await new Promise<string | null>((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** Finds the right-clicked image, scrolls it into view and returns its visible box. */
export function locateImage(srcUrl: string): Promise<Region | null> {
  return new Promise((resolve) => {
    const imgs = Array.from(document.images);
    const el =
      imgs.find((i) => i.currentSrc === srcUrl) ||
      imgs.find((i) => i.src === srcUrl) ||
      null;
    if (!el) return resolve(null);

    const before = el.getBoundingClientRect();
    const fullyVisible =
      before.top >= 0 &&
      before.left >= 0 &&
      before.bottom <= window.innerHeight &&
      before.right <= window.innerWidth;
    if (!fullyVisible) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        setTimeout(() => {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, r.left);
          const y = Math.max(0, r.top);
          const w = Math.min(window.innerWidth, r.right) - x;
          const h = Math.min(window.innerHeight, r.bottom) - y;
          if (w < 4 || h < 4) return resolve(null);
          resolve({ x, y, w, h, vw: window.innerWidth, vh: window.innerHeight });
        }, fullyVisible ? 0 : 120),
      ),
    );
  });
}

/** Small toast in the bottom-right corner, isolated from page styles with a shadow root. */
export function showToast(title: string, body: string, kind: 'info' | 'success' | 'error'): void {
  const ID = '__raegent_ocr_toast';
  document.getElementById(ID)?.remove();

  const host = document.createElement('div');
  host.id = ID;
  Object.assign(host.style, {
    position: 'fixed',
    right: '20px',
    bottom: '20px',
    zIndex: '2147483647',
  });
  const root = host.attachShadow({ mode: 'closed' });

  const accent = kind === 'error' ? '#d9534f' : kind === 'success' ? '#3f9a5c' : '#C14D2E';
  const card = document.createElement('div');
  card.setAttribute(
    'style',
    [
      'max-width:340px',
      'padding:12px 14px',
      'border-radius:10px',
      'background:#1c1b19',
      'color:#f5f3ee',
      'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif',
      'box-shadow:0 8px 28px rgba(0,0,0,.28)',
      `border-left:4px solid ${accent}`,
      'transition:opacity .25s ease, transform .25s ease',
      'opacity:0',
      'transform:translateY(8px)',
    ].join(';'),
  );

  const t = document.createElement('div');
  t.textContent = title;
  t.setAttribute('style', 'font-weight:600;margin-bottom:2px');
  card.appendChild(t);

  if (body) {
    const b = document.createElement('div');
    b.textContent = body;
    b.setAttribute(
      'style',
      'color:#c9c5bb;white-space:pre-wrap;word-break:break-word;max-height:4.4em;overflow:hidden',
    );
    card.appendChild(b);
  }

  root.appendChild(card);
  document.documentElement.appendChild(host);
  requestAnimationFrame(() => {
    card.style.opacity = '1';
    card.style.transform = 'translateY(0)';
  });

  const ttl = kind === 'info' ? 20000 : kind === 'error' ? 6000 : 3500;
  setTimeout(() => {
    card.style.opacity = '0';
    setTimeout(() => host.remove(), 300);
  }, ttl);
}
