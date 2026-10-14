import { activateLicense, getState, FREE_LIMIT, BUY_URL } from './license';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const s = await getState();
  const status = $('status');
  const unlockCard = $('unlock-card');
  if (s.licenseKey) {
    status.textContent = 'Unlocked: unlimited captures. Thank you!';
    status.dataset.kind = 'ok';
    unlockCard.hidden = true;
  } else {
    const left = Math.max(0, FREE_LIMIT - s.uses);
    status.textContent = `Free version: ${left} of ${FREE_LIMIT} captures left.`;
    status.dataset.kind = left === 0 ? 'warn' : 'info';
    unlockCard.hidden = false;
  }

  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === 'select-area')?.shortcut;
  $('shortcut').textContent = shortcut || 'not set';
}

$('buy').addEventListener('click', () => chrome.tabs.create({ url: BUY_URL }));
$('change-shortcut').addEventListener('click', () =>
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }),
);

$('license-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('license-key');
  const btn = $<HTMLButtonElement>('activate');
  const msg = $('license-msg');
  btn.disabled = true;
  msg.textContent = 'Checking…';
  msg.dataset.kind = 'info';
  const res = await activateLicense(input.value);
  msg.textContent = res.message;
  msg.dataset.kind = res.ok ? 'ok' : 'warn';
  btn.disabled = false;
  if (res.ok) input.value = '';
  await render();
});

void render();
