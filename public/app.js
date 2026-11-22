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

// Admin: while link previews are loading, poll and swap thumbnails in place (no page reload).
(function pollPreviews() {
  const pending = () => [...document.querySelectorAll('[data-preview-id]')];
  if (!pending().length) return;
  let tries = 0;
  const tick = async () => {
    const els = pending();
    if (!els.length || ++tries > 40) return;
    try {
      const ids = els.map((el) => el.dataset.previewId).join(',');
      const res = await fetch(`/admin/previews?ids=${ids}`, { credentials: 'same-origin' });
      const data = await res.json();
      for (const el of els) {
        const p = data[el.dataset.previewId];
        if (!p || p.status === 'pending') continue;
        const id = el.dataset.previewId;
        el.removeAttribute('data-preview-id');
        el.classList.remove('pending');
        if (p.image) {
          const img = document.createElement('img');
          img.src = p.image;
          img.alt = '';
          el.classList.remove('empty');
          el.textContent = '';
          el.appendChild(img);
        }
        document.querySelectorAll(`[data-preview-status="${id}"]`).forEach((n) => n.remove());
      }
    } catch { /* try again */ }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
})();
