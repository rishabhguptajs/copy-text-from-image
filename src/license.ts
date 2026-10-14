export const FREE_LIMIT = 10;
export const BUY_URL = 'https://checkout.dodopayments.com/buy/pdt_0NolvTkkAlmLwUujNDBuh?quantity=1';
export const SUPPORT_EMAIL = 'hello@raegent.com';

const DODO = 'https://live.dodopayments.com';
const RECHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000; // re-check a key about once a week

export interface LicenseState {
  uses: number;
  licenseKey: string | null;
}

export async function getState(): Promise<LicenseState> {
  const s = await chrome.storage.local.get({ uses: 0, licenseKey: null });
  return { uses: Number(s.uses) || 0, licenseKey: (s.licenseKey as string) || null };
}

export async function canCapture(): Promise<boolean> {
  const s = await getState();
  return Boolean(s.licenseKey) || s.uses < FREE_LIMIT;
}

/** Counts a successful capture. Returns free captures left, or null when unlocked. */
export async function recordUse(): Promise<number | null> {
  const s = await getState();
  if (s.licenseKey) return null;
  const uses = s.uses + 1;
  await chrome.storage.local.set({ uses });
  return Math.max(0, FREE_LIMIT - uses);
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /Mac/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'ChromeOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown OS';
  const browser = /Edg\//.test(ua) ? 'Edge' : 'Chrome';
  return `${browser} on ${os}`;
}

/**
 * Activates the key on this device with Dodo Payments' public activate endpoint (no API key needed).
 * Dodo counts activations, so the "Activations Limit" set on the product is enforced.
 */
export async function activateLicense(rawKey: string): Promise<{ ok: boolean; message: string }> {
  const key = rawKey.trim();
  if (!key) return { ok: false, message: 'Paste your license key first.' };
  try {
    const res = await fetch(`${DODO}/licenses/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, name: deviceName() }),
    });

    if (res.status === 422) {
      const body = await res.text();
      if (/limit/i.test(body)) {
        return {
          ok: false,
          message: `This key is already active on the maximum number of devices. Email ${SUPPORT_EMAIL} if you need to move it to a new one.`,
        };
      }
      return { ok: false, message: 'That key is not valid or has been disabled.' };
    }
    if (res.status === 404 || res.status === 400) {
      return { ok: false, message: 'That key was not found. Check for typos and try again.' };
    }
    if (!res.ok) {
      return { ok: false, message: `The license server returned an error (HTTP ${res.status}). Please try again.` };
    }

    const data = (await res.json()) as { id?: string };
    await chrome.storage.local.set({ licenseKey: key, instanceId: data.id ?? null, checkedAt: Date.now() });
    return { ok: true, message: 'Unlocked. Thank you for supporting an independent tool.' };
  } catch {
    return { ok: false, message: 'Could not reach the license server. Check your connection and try again.' };
  }
}

/**
 * Quietly re-checks an activated key about once a week, so refunded or revoked keys stop working.
 * Being offline never locks anyone out: only an explicit "not valid" answer removes the license.
 */
export async function recheckLicense(): Promise<void> {
  const s = await chrome.storage.local.get({ licenseKey: null, instanceId: null, checkedAt: 0 });
  if (!s.licenseKey) return;
  if (Date.now() - Number(s.checkedAt || 0) < RECHECK_EVERY_MS) return;
  try {
    const res = await fetch(`${DODO}/licenses/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: s.licenseKey, license_key_instance_id: s.instanceId ?? null }),
    });
    if (!res.ok) return; // server trouble: try again next time
    const data = (await res.json()) as { valid?: boolean };
    if (data.valid === false) {
      await chrome.storage.local.remove(['licenseKey', 'instanceId', 'checkedAt']);
    } else {
      await chrome.storage.local.set({ checkedAt: Date.now() });
    }
  } catch {
    // offline: keep working
  }
}
