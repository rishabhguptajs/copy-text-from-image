import { locateImage, selectRegion, showToast, type Region } from './injected';
import { canCapture, recordUse, recheckLicense, FREE_LIMIT } from './license';

declare const __TEST__: boolean;

const OFFSCREEN_URL = 'offscreen.html';
const busyTabs = new Set<number>();

// ---------- menus & entry points ----------

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ocr-image',
      title: 'Copy text from image',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'ocr-area',
      title: 'Select area to copy text',
      contexts: ['page', 'selection', 'link', 'video', 'frame'],
    });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => void recheckLicense());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'ocr-image' && info.srcUrl && (info.frameId ?? 0) === 0) {
    void captureImage(tab, info.srcUrl);
  } else {
    // Images inside iframes, and the generic menu item, fall back to drag-select.
    void captureArea(tab);
  }
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'select-area' && tab?.id) void captureArea(tab);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'background') return;
  if (msg.type === 'start-area') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id) void captureArea(tab);
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ---------- flows ----------

async function captureArea(tab: chrome.tabs.Tab) {
  await guarded(tab, async (tabId) => {
    const region = await inject<Region | null>(tabId, selectRegion, []);
    if (!region) return; // cancelled
    await runOcr(tab, region);
  });
}

async function captureImage(tab: chrome.tabs.Tab, srcUrl: string) {
  await guarded(tab, async (tabId) => {
    const region = await inject<Region | null>(tabId, locateImage, [srcUrl]);
    if (!region) {
      await toast(tabId, 'Could not find that image', 'Drag over it instead: the area selector is starting.', 'info');
      const area = await inject<Region | null>(tabId, selectRegion, []);
      if (area) await runOcr(tab, area);
      return;
    }
    await runOcr(tab, region);
  });
}

async function runOcr(tab: chrome.tabs.Tab, region: Region) {
  const tabId = tab.id!;
  if (!(await canCapture())) {
    await toast(
      tabId,
      `You've used your ${FREE_LIMIT} free captures`,
      'Unlock unlimited captures with a one-time purchase. The settings page just opened.',
      'error',
    );
    chrome.runtime.openOptionsPage();
    return;
  }

  // Screenshot first, so our own toast never ends up in the image.
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await toast(tabId, 'Reading text…', '', 'info');

  await ensureOffscreen();
  const result = (await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'ocr-and-copy',
    dataUrl,
    region,
  })) as { ok: boolean; text?: string; error?: string };

  if (!result?.ok) {
    await toast(tabId, 'Something went wrong', result?.error || 'OCR failed. Please try again.', 'error');
    return;
  }
  const text = result.text || '';
  if (!text) {
    await toast(tabId, 'No text found', 'Try selecting a tighter area around the text.', 'error');
    return;
  }

  if (__TEST__) (globalThis as any).__lastOcr = text;
  const left = await recordUse();
  const preview = text.length > 160 ? `${text.slice(0, 160)}…` : text;
  const footer = left === null ? '' : `\n\n${left} free capture${left === 1 ? '' : 's'} left`;
  await toast(tabId, `Copied ${text.length} characters`, preview + footer, 'success');
}

// ---------- helpers ----------

async function guarded(tab: chrome.tabs.Tab, fn: (tabId: number) => Promise<void>) {
  const tabId = tab.id!;
  if (busyTabs.has(tabId)) return;
  busyTabs.add(tabId);
  try {
    await fn(tabId);
  } catch (err) {
    console.error('[copy-text-from-image]', err);
    const shown = await toast(tabId, 'Something went wrong', String((err as Error)?.message || err), 'error');
    if (!shown) await flagUnsupported(tabId);
  } finally {
    busyTabs.delete(tabId);
  }
}

async function inject<T>(tabId: number, func: (...args: any[]) => any, args: any[]): Promise<T> {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result as T;
}

async function toast(tabId: number, title: string, body: string, kind: 'info' | 'success' | 'error') {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [title, body, kind] });
    return true;
  } catch {
    return false;
  }
}

// Chrome blocks extensions on chrome:// pages, the Web Store and some others. Show it on the icon instead.
async function flagUnsupported(tabId: number) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d9534f' });
  await chrome.action.setBadgeText({ tabId, text: '!' });
  await chrome.action.setTitle({ tabId, title: "Chrome doesn't allow extensions on this page" });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }), 4000);
}

let creating: Promise<void> | null = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Runs the offline OCR engine in a web worker and copies the recognized text to the clipboard.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

// Test-only hooks, stripped from the production build.
if (__TEST__) {
  (globalThis as any).__ocrTest = { captureImage, captureArea };
}
