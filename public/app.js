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
    // List gifts and gifts-to-give are polled separately (data-preview-kind="gift").
    const groups = {};
    for (const el of els) (groups[el.dataset.previewKind || 'item'] ||= []).push(el);
    for (const [kind, group] of Object.entries(groups)) {
      try {
        const ids = group.map((el) => el.dataset.previewId).join(',');
        const res = await fetch(`/admin/previews?kind=${kind}&ids=${ids}`, { credentials: 'same-origin' });
        const data = await res.json();
        for (const el of group) {
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
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 1500);
})();

// Selects marked data-autosubmit save on change; their fallback button is hidden when JS runs.
document.querySelectorAll('[data-autosubmit-fallback]').forEach((b) => { b.hidden = true; });
document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-autosubmit]')) e.target.form.requestSubmit();
});

// Admin: image upload. Resize in the browser (max 800px) and send as a data: URL in a hidden field.
document.addEventListener('change', async (e) => {
  const input = e.target.closest('[data-upload-input]');
  if (!input) return;
  const box = input.closest('[data-upload]');
  const data = box.querySelector('[data-upload-data]');
  const preview = box.querySelector('[data-upload-preview]');
  const file = input.files && input.files[0];
  data.value = '';
  preview.hidden = true;
  if (!file) return;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff'; // flatten transparency for JPEG
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let url = canvas.toDataURL('image/webp', 0.85);
    if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', 0.85);
    data.value = url;
    preview.src = url;
    preview.hidden = false;
  } catch {
    input.value = '';
    alert('Não foi possível ler esta imagem. / Could not read this image.');
  }
});
