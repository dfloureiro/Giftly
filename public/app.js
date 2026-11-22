// Progressive enhancement only: everything works without JavaScript.
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset && e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) e.preventDefault();
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.querySelector(btn.dataset.copy);
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  const label = btn.textContent;
  btn.textContent = btn.dataset.copied || '✓';
  setTimeout(() => { btn.textContent = label; }, 1500);
});

// Select the share link on focus so it is easy to copy manually.
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input[readonly]')) e.target.select();
});
