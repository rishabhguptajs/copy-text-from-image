import { getState, FREE_LIMIT } from './license';

const status = document.getElementById('status')!;

document.getElementById('select')!.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ target: 'background', type: 'start-area' });
  window.close();
});

document.getElementById('settings')!.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const s = await getState();
  const commands = await chrome.commands.getAll();
  const shortcut = commands.find((c) => c.name === 'select-area')?.shortcut || 'no shortcut set';
  const plan = s.licenseKey ? 'Unlimited' : `${Math.max(0, FREE_LIMIT - s.uses)} free captures left`;
  status.textContent = `${plan} · ${shortcut}`;
})();
