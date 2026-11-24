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


// Search boxes: filter the list instantly (the form still works as a normal search without JS).
document.querySelectorAll('input[data-filter]').forEach((input) => {
  const fold = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const empty = document.querySelector('[data-filter-empty]');
  input.addEventListener('input', () => {
    const q = fold(input.value.trim());
    let shown = 0;
    document.querySelectorAll(input.dataset.filter).forEach((el) => {
      const hit = !q || fold(el.dataset.search || el.textContent).includes(q);
      el.hidden = !hit;
      if (hit) shown++;
    });
    if (empty) empty.hidden = shown > 0;
  });
});

// Drag to reorder (same approach as the Parcels TRMNL plugin): drag a card by its handle.
// Nothing is moved in the page while the finger is down (iOS stops sending touch events if the
// touched element moves): cards are only shifted with transforms, and the new order is applied
// — and saved — on release.
(function sortable() {
  const lists = document.querySelectorAll('[data-sortable]');
  if (!lists.length) return;
  const csrf = document.querySelector('input[name="_csrf"]')?.value || '';
  let drag = null;

  lists.forEach((list) => {
    const handles = list.querySelectorAll(':scope > li > .drag-handle');
    if (handles.length < 2) return;
    list.classList.add('js-sortable');
    handles.forEach((h) => {
      h.hidden = false;
      h.addEventListener('pointerdown', (ev) => start(ev, list));
      // Older iOS can still scroll the page from the handle unless touchmove is cancelled.
      h.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
    });
  });

  function start(ev, list) {
    if (drag || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    ev.preventDefault();
    const li = ev.currentTarget.closest('li');
    const cards = [...list.children].filter((c) => c.tagName === 'LI');
    const from = cards.indexOf(li);
    const tops = cards.map((c) => c.offsetTop);
    const heights = cards.map((c) => c.offsetHeight);
    const gap = cards.length > 1 ? tops[1] - tops[0] - heights[0] : 10;
    drag = { list, li, cards, from, to: from, tops, heights, step: heights[from] + gap,
      id: ev.pointerId, startY: ev.clientY + window.scrollY, y: ev.clientY, raf: 0 };
    try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
    li.classList.add('dragging');
    list.classList.add('sorting');
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function place() {
    const d = drag;
    let top = d.tops[d.from] + (d.y + window.scrollY - d.startY);
    const lo = d.tops[0];
    const hi = d.tops[d.tops.length - 1] + d.heights[d.heights.length - 1] - d.heights[d.from];
    top = Math.max(lo, Math.min(hi, top));
    const centre = top + d.heights[d.from] / 2;
    // Target index: how many of the other cards have their middle above the dragged card's middle.
    let to = 0;
    for (let k = 0; k < d.cards.length; k++) if (k !== d.from && d.tops[k] + d.heights[k] / 2 < centre) to++;
    d.to = to;
    d.cards.forEach((c, j) => {
      if (j === d.from) return;
      let shift = 0;
      if (d.from < to && j > d.from && j <= to) shift = -d.step;
      if (d.from > to && j >= to && j < d.from) shift = d.step;
      c.style.transform = shift ? `translateY(${shift}px)` : '';
    });
    d.li.style.transform = `translateY(${top - d.tops[d.from]}px)`;
  }

  function move(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    ev.preventDefault();
    drag.y = ev.clientY;
    place();
  }

  // Scroll the page while the finger is held near the top or bottom edge.
  function autoScroll() {
    if (!drag) return;
    const edge = 80, h = window.innerHeight;
    let dy = 0;
    if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 8);
    else if (drag.y > h - edge) dy = Math.ceil((drag.y - (h - edge)) / 8);
    if (dy) {
      const before = window.scrollY;
      window.scrollBy(0, dy);
      if (window.scrollY !== before) place();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  async function end(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    d.list.classList.remove('sorting');
    d.cards.forEach((c) => { c.style.transform = ''; c.classList.remove('dragging'); });
    if (d.to === d.from) return;
    const order = d.cards.slice();
    order.splice(d.to, 0, order.splice(d.from, 1)[0]);
    order.forEach((c) => d.list.appendChild(c)); // apply in the page
    try {
      const res = await fetch(d.list.dataset.sortable, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // data-sortable-extra carries e.g. "person_id=5" for a person's wishlist.
        body: new URLSearchParams([...new URLSearchParams(d.list.dataset.sortableExtra || ''),
          ['_csrf', csrf], ['order', order.map((c) => c.dataset.id).join(',')]]),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      window.location.reload(); // couldn't save: show the real order again
    }
  }
})();

// Menus (<details class="account-menu">): open towards the side with room so they never leave the
// screen (a gear button on the left of a phone used to push its menu off the left edge), close the
// others, and close on a click outside or Escape. Without JavaScript they still open (right-aligned).
(function menus() {
  const MARGIN = 12;
  const place = (menu) => {
    menu.classList.remove('align-start');
    menu.style.translate = '';
    let r = menu.getBoundingClientRect();
    if (r.left < MARGIN) { menu.classList.add('align-start'); r = menu.getBoundingClientRect(); }
    const over = r.right - (document.documentElement.clientWidth - MARGIN);
    if (over > 0) menu.style.translate = `${-Math.min(over, r.left - MARGIN)}px 0`;
  };
  const all = () => document.querySelectorAll('details.account-menu[open]');
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.matches('.account-menu') || !d.open) return;
    for (const other of all()) if (other !== d) other.open = false;
    const menu = d.querySelector(':scope > .menu');
    if (menu) place(menu);
  }, true);
  document.addEventListener('click', (e) => {
    for (const d of all()) if (!d.contains(e.target)) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of all()) { d.open = false; d.querySelector('summary')?.focus(); }
  });
})();
