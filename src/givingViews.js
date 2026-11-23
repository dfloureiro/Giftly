// Views for "Gifts to give" (admin only).
import { h, raw, layout, csrfField, postButton, adminHeader, uploadField } from './views.js';
import { config } from './config.js';
import { STATUSES, VISIBILITIES, daysBetween, today } from './giving.js';
import { users } from './accounts.js';
import { wishlists } from './wishlist.js';
import { wishSection } from './wishlistViews.js';

const locale = (ctx) => (ctx.lang === 'en' ? 'en-GB' : 'pt-PT');

/** "25 Dec" / "25/12" for a YYYY-MM-DD date (no time-zone shifts). */
export function fmtDay(ctx, date, { year = false } = {}) {
  return new Intl.DateTimeFormat(locale(ctx), { day: 'numeric', month: 'short', ...(year && { year: 'numeric' }), timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

function inDays(ctx, n) {
  if (n === 0) return ctx.t('give.today');
  if (n === 1) return ctx.t('give.tomorrow');
  return ctx.t('give.inDays', { n });
}

export function money(ctx, cents, currency) {
  if (cents == null) return '';
  try {
    return new Intl.NumberFormat(locale(ctx), { style: 'currency', currency: currency || config.currency }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

const moneyList = (ctx, totals) => totals.map((t) => money(ctx, t.cents, t.currency)).join(' + ');

const privateBadge = (ctx, row) => (row.visibility === 'private' ? h`<span class="badge private" title="${ctx.t('give.privateHint')}">🔒 ${ctx.t('give.private')}</span>` : '');

const STATUS_ICON = { idea: '💡', bought: '🛍️', given: '🎁' };

function giveNav(ctx, active) {
  const tab = (href, key, name) => h`<a href="${href}" class="subtab${active === name ? ' active' : ''}"${active === name ? raw(' aria-current="page"') : ''}>${ctx.t(key)}</a>`;
  return h`<nav class="subnav">
    ${tab('/admin/give', 'give.upcoming', 'upcoming')}
    ${tab('/admin/give/people', 'give.people', 'people')}
    ${tab('/admin/give/occasions', 'give.occasions', 'occasions')}
  </nav>`;
}

/** Search box: filters the list instantly (app.js) and also works as a normal GET form. */
function searchBox(ctx, { q = '', action, target, placeholder }) {
  return h`<form method="get" action="${action}" class="search" role="search">
    <input type="search" name="q" value="${q}" placeholder="${placeholder}" aria-label="${placeholder}" data-filter="${target}" autocomplete="off">
  </form>`;
}

function favoriteButton(ctx, p, back) {
  return h`<form method="post" action="/admin/give/people/${p.id}/favorite" class="inline fav-form">
    ${csrfField(ctx)}<input type="hidden" name="on" value="${p.favorite ? '0' : '1'}"><input type="hidden" name="back" value="${back}">
    <button type="submit" class="fav${p.favorite ? ' on' : ''}" aria-pressed="${p.favorite ? 'true' : 'false'}" title="${p.favorite ? ctx.t('give.unfavorite') : ctx.t('give.favorite')}" aria-label="${p.favorite ? ctx.t('give.unfavorite') : ctx.t('give.favorite')}">${p.favorite ? '★' : '☆'}</button>
  </form>`;
}

function page(ctx, { title, active, body }) {
  return layout(ctx, { title, body: h`${adminHeader(ctx)}${giveNav(ctx, active)}${body}` });
}

function visibilityField(ctx, value = 'shared', { disabled = false } = {}) {
  if (disabled) return h`<p class="small muted">${value === 'private' ? ctx.t('give.privateByOther') : ''}</p>`;
  return h`<label>${ctx.t('give.visibility')}
    <select name="visibility">
      ${VISIBILITIES.map((v) => h`<option value="${v}"${v === value ? raw(' selected') : ''}>${ctx.t(`give.vis.${v}`)}</option>`)}
    </select>
    <span class="small muted">${ctx.t('give.visibilityHint')}</span>
  </label>`;
}

const isOwner = (ctx, row) => !row || row.owner_id === ctx.user.id;

// ---------- gifts ----------

function giftThumb(ctx, g) {
  if (g.image_file) return h`<div class="thumb small"><img src="/img/${g.image_file}" alt="" loading="lazy"></div>`;
  const pending = g.preview_status === 'pending';
  return h`<div class="thumb small empty${pending ? ' pending' : ''}"${pending ? h` data-preview-id="${g.id}" data-preview-kind="gift"` : ''} aria-hidden="true">🎁</div>`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Gift fields for create/edit. Price is typed only when the link didn't give one. */
function giftFields(ctx, v = {}) {
  const linkPrice = v.price_source === 'link';
  return h`
    <label>${ctx.t('give.giftName')}
      <input name="name" required maxlength="200" value="${v.name || ''}">
    </label>
    <label>${ctx.t('admin.itemUrl')}
      <input name="url" type="url" maxlength="2000" value="${v.url || ''}" placeholder="https://">
    </label>
    <div class="row">
      <label class="grow">${ctx.t('give.status')}
        <select name="status">
          ${STATUSES.map((s) => h`<option value="${s}"${s === (v.status || 'idea') ? raw(' selected') : ''}>${STATUS_ICON[s]} ${ctx.t(`give.status.${s}`)}</option>`)}
        </select>
      </label>
      ${linkPrice
        ? h`<p class="small muted grow">${ctx.t('give.priceFromLink', { price: money(ctx, v.price_cents, v.price_currency) })}</p>`
        : h`<label class="grow">${ctx.t('give.price')}
            <input name="price" inputmode="decimal" maxlength="12" value="${v.price_cents != null ? (v.price_cents / 100).toFixed(2).replace('.', ctx.lang === 'en' ? '.' : ',') : ''}" placeholder="${ctx.t('give.pricePlaceholder')}">
          </label>`}
    </div>
    ${linkPrice ? '' : h`<p class="small muted hint">${ctx.t('give.priceHint')}</p>`}
    <label>${ctx.t('admin.itemNotes')}
      <input name="notes" maxlength="1000" value="${v.notes || ''}">
    </label>
    ${visibilityField(ctx, v.visibility, { disabled: v.id && !isOwner(ctx, v) })}`;
}

/** "Joint gift" picker: other people this gift is also for. */
function jointPicker(ctx, others, checked = []) {
  if (!others.length) return '';
  const on = new Set(checked);
  return h`<details class="joint"${on.size ? raw(' open') : ''}>
    <summary>👥 ${ctx.t('give.joint')}</summary>
    <p class="small muted">${ctx.t('give.jointHint')}</p>
    <div class="joint-people">
      ${others.map((p) => h`<label class="check"><input type="checkbox" name="also" value="${p.id}"${on.has(p.id) ? raw(' checked') : ''}> ${p.name}</label>`)}
    </div>
  </details>`;
}

function giftRow(ctx, g, { back, showOccasion = false, others = [], anchor = true, forPerson = null } = {}) {
  // Candidates for the joint picker: everyone offered here plus whoever it is already for.
  const co = g.people.filter((x) => x.id !== g.person_id);
  const pickable = [...new Map([...others, ...co].filter((x) => x.id !== g.person_id).map((x) => [x.id, x])).values()];
  const withWhom = forPerson ? g.people.filter((x) => x.id !== forPerson) : g.people;
  const host = g.url ? hostOf(g.url) : '';
  const occasionLabel = g.occasion_id ? g.occasion_name : ctx.t('give.birthdayYear', { year: g.year });
  return h`<li class="gift"${anchor ? h` id="gift-${g.id}"` : ''}>
    ${giftThumb(ctx, g)}
    <div class="body">
      <div class="gift-title">
        <strong>${g.name}</strong> ${privateBadge(ctx, g)}
      </div>
      ${g.wishlist_item_id ? h`<p class="small muted">🎀 ${ctx.t('wish.fromWishlist')}${g.wish_status === 'removed' || (g.wish_status === 'received' && g.status !== 'given') ? h` · <strong class="warn">${ctx.t(`wish.removedFlag.${g.wish_removed_reason}`)}</strong>` : ''}</p>` : ''}
      ${g.joint ? h`<p class="small joint-line">👥 ${forPerson ? ctx.t('give.jointWith', { names: withWhom.map((x) => x.name).join(' & ') }) : ctx.t('give.jointFor', { names: g.people.map((x) => x.name).join(' & ') })}</p>` : ''}
      <div class="meta small">
        ${g.price_cents != null ? h`<span class="price">${money(ctx, g.price_cents, g.price_currency)}</span>` : ''}
        ${g.url ? h`<a href="${g.url}" target="_blank" rel="noopener noreferrer nofollow">${host} ↗</a>` : ''}
        ${showOccasion ? h`<span class="muted">${occasionLabel}</span>` : ''}
      </div>
      ${g.notes ? h`<p class="notes small">${g.notes}</p>` : ''}
      ${g.preview_status === 'pending' ? h`<p class="small muted" data-preview-status="${g.id}">${ctx.t('preview.pending')}</p>` : ''}
      <div class="gift-actions">
        <form method="post" action="/admin/give/gifts/${g.id}/status" class="inline status-form">
          ${csrfField(ctx)}<input type="hidden" name="back" value="${back}">
          <select name="status" data-autosubmit aria-label="${ctx.t('give.status')}">
            ${STATUSES.map((s) => h`<option value="${s}"${s === g.status ? raw(' selected') : ''}>${STATUS_ICON[s]} ${ctx.t(`give.status.${s}`)}</option>`)}
          </select>
          <button type="submit" class="secondary small-btn" data-autosubmit-fallback>${ctx.t('admin.save')}</button>
        </form>
        <details class="edit">
          <summary>${ctx.t('admin.edit')}</summary>
          <form method="post" action="/admin/give/gifts/${g.id}" class="stack">
            ${csrfField(ctx)}<input type="hidden" name="back" value="${back}">
            ${giftFields(ctx, g)}
            <input type="hidden" name="also_present" value="1">
            ${jointPicker(ctx, pickable, co.map((x) => x.id))}
            ${uploadField(ctx)}
            <label>${ctx.t('preview.imageSource')}
              <input name="image_source" type="url" maxlength="2000" value="${g.image_source || ''}" placeholder="https://…/foto.jpg">
            </label>
            ${g.image_file ? h`<label class="check"><input type="checkbox" name="remove_image" value="1"> ${ctx.t('preview.remove')}</label>` : ''}
            <button type="submit" class="primary">${ctx.t('admin.save')}</button>
          </form>
          <div class="row">
            ${g.url ? postButton(ctx, `/admin/give/gifts/${g.id}/preview`, ctx.t('preview.refresh'), { cls: 'link small', extra: `<input type="hidden" name="back" value="${escAttr(back)}">` }) : ''}
            ${postButton(ctx, `/admin/give/gifts/${g.id}/delete`, ctx.t('admin.delete'), { cls: 'link danger small', confirm: ctx.t('admin.deleteItemConfirm'), extra: `<input type="hidden" name="back" value="${escAttr(back)}">` })}
          </div>
        </details>
      </div>
    </div>
  </li>`;
}

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** "Add a gift" form. `occasion` fixes the occasion (checklist); otherwise `choices` gives a select. */
function addGiftForm(ctx, { personId, back, occasion, choices = [], open = false, others = [] }) {
  return h`<details class="add-gift"${open ? raw(' open') : ''}>
    <summary>＋ ${ctx.t('give.addGift')}</summary>
    <form method="post" action="/admin/give/gifts" class="stack">
      ${csrfField(ctx)}
      <input type="hidden" name="person_id" value="${personId}">
      <input type="hidden" name="back" value="${back}">
      ${occasion
        ? h`<input type="hidden" name="occasion" value="${occasion}">`
        : h`<label>${ctx.t('give.forOccasion')}
            <select name="occasion" required>
              ${choices.map((c) => h`<option value="${c.value}">${c.birthdayYear ? ctx.t('give.birthdayYear', { year: c.birthdayYear }) : `${c.occasion.name} · ${fmtDay(ctx, c.occasion.date, { year: true })}`}</option>`)}
            </select>
            ${choices.length ? '' : h`<span class="small muted">${ctx.t('give.noOccasionChoices')}</span>`}
          </label>`}
      ${giftFields(ctx)}
      ${jointPicker(ctx, others)}
      ${uploadField(ctx)}
      <button type="submit" class="primary">${ctx.t('admin.add')}</button>
    </form>
  </details>`;
}

// ---------- pages ----------

export function overviewPage(ctx, { entries, christmasYear, christmas, hasPeople }) {
  return page(ctx, {
    title: ctx.t('give.tab'),
    active: 'upcoming',
    body: h`
<h1>${ctx.t('give.upcomingTitle')}</h1>
${!hasPeople ? h`<p class="empty">${ctx.t('give.noPeopleYet')} <a href="/admin/give/people">${ctx.t('give.addPerson')}</a></p>` : ''}
${hasPeople && !entries.length ? h`<p class="empty">${ctx.t('give.nothingSoon')}</p>` : ''}
<ul class="upcoming">
  ${entries.map((e) => e.kind === 'birthday'
    ? h`<li class="${e.done ? 'done' : ''}">
        <a href="/admin/give/people/${e.person.id}#year-${e.year}">
          <span class="when"><strong>${fmtDay(ctx, e.date)}</strong><span class="small muted">${inDays(ctx, e.inDays)}</span></span>
          <span class="what">🎂 ${ctx.t('give.birthdayOf', { name: e.person.name })}${e.age ? h` <span class="muted">(${e.age})</span>` : ''} ${privateBadge(ctx, e.person)}</span>
          <span class="state">${e.done ? h`<span class="pill ok">✓ ${ctx.t('give.hasGift')}</span>`
            : e.ideas ? h`<span class="pill">💡 ${ctx.t('give.ideasCount', { n: e.ideas })}</span>`
            : h`<span class="pill missing">${ctx.t('give.noGift')}</span>`}</span>
        </a>
      </li>`
    : h`<li class="${e.done ? 'done' : ''}">
        <a href="/admin/give/occasions/${e.occasion.id}">
          <span class="when"><strong>${fmtDay(ctx, e.date)}</strong><span class="small muted">${inDays(ctx, e.inDays)}</span></span>
          <span class="what">${e.occasion.type === 'christmas' ? '🎄' : '📅'} ${e.occasion.name} ${privateBadge(ctx, e.occasion)}</span>
          <span class="state"><span class="pill${e.done ? ' ok' : e.doneCount < e.total ? ' missing' : ''}">${ctx.t('give.progressShort', { done: e.doneCount, total: e.total })}</span></span>
        </a>
      </li>`)}
</ul>
${hasPeople && !christmas ? h`<section class="card">
  <h2>🎄 ${ctx.t('give.christmasName', { year: christmasYear })}</h2>
  <p class="small muted">${ctx.t('give.newChristmasHint')}</p>
  <form method="post" action="/admin/give/occasions/christmas" class="inline">
    ${csrfField(ctx)}<input type="hidden" name="year" value="${christmasYear}">
    <button type="submit" class="primary">${ctx.t('give.newChristmas', { year: christmasYear })}</button>
  </form>
</section>` : ''}`,
  });
}

const MONTHS = (ctx) => Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(locale(ctx), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))));

function personFields(ctx, v = {}, { canSetVisibility = true } = {}) {
  return h`
    <label>${ctx.t('give.personName')}
      <input name="name" required maxlength="80" value="${v.name || ''}">
    </label>
    <fieldset class="group">
      <legend>${ctx.t('give.birthday')}</legend>
      <div class="row">
        <label>${ctx.t('give.day')}
          <input name="birthday_day" inputmode="numeric" type="number" min="1" max="31" value="${v.birthday_day || ''}" size="3">
        </label>
        <label class="grow">${ctx.t('give.month')}
          <select name="birthday_month">
            <option value="">—</option>
            ${MONTHS(ctx).map((m, i) => h`<option value="${i + 1}"${v.birthday_month === i + 1 ? raw(' selected') : ''}>${m}</option>`)}
          </select>
        </label>
        <label>${ctx.t('give.yearOptional')}
          <input name="birth_year" inputmode="numeric" type="number" min="1900" max="2200" value="${v.birth_year || ''}" size="5">
        </label>
      </div>
    </fieldset>
    <label>${ctx.t('admin.itemNotes')}
      <textarea name="notes" rows="2" maxlength="1000" placeholder="${ctx.t('give.personNotesPlaceholder')}">${v.notes || ''}</textarea>
    </label>
    <label class="check"><input type="checkbox" name="gives_christmas" value="1"${v.gives_christmas ? raw(' checked') : ''}> 🎄 ${ctx.t('give.givesChristmas')}</label>
    ${visibilityField(ctx, v.visibility, { disabled: !canSetVisibility })}
    <label>${ctx.t('wish.personIsAdmin')}
      <select name="user_id">
        <option value="">—</option>
        ${users.all().map((u) => h`<option value="${u.id}"${v.user_id === u.id ? raw(' selected') : ''}>${u.name} (${u.username})</option>`)}
      </select>
      <span class="small muted">${ctx.t('wish.personIsAdminHint')}</span>
    </label>`;
}

export function peoplePage(ctx, { list, form, error, q = '' }) {
  return page(ctx, {
    title: ctx.t('give.people'),
    active: 'people',
    body: h`
<h1>${ctx.t('give.people')}</h1>
${searchBox(ctx, { q, action: '/admin/give/people', target: '#people-list > li', placeholder: ctx.t('give.searchPeople') })}
${list.length ? h`<ul class="lists with-fav" id="people-list">
  ${list.map((p) => h`<li data-search="${`${p.name} ${p.notes || ''}`}">${favoriteButton(ctx, p, `/admin/give/people${q ? `?q=${encodeURIComponent(q)}` : ''}`)}<a href="/admin/give/people/${p.id}">
    <strong>${p.name} ${privateBadge(ctx, p)}${p.gives_christmas ? h` <span title="${ctx.t('give.givesChristmas')}">🎄</span>` : ''}</strong>
    <span class="small muted">${p.next ? ctx.t('give.nextBirthday', { date: fmtDay(ctx, p.next.date), when: inDays(ctx, daysBetween(today(), p.next.date)) }) : ctx.t('give.noBirthday')}</span>
  </a></li>`)}
</ul>
<p class="empty" data-filter-empty hidden>${ctx.t('give.noMatches')}</p>` : h`<p class="empty">${q ? ctx.t('give.noMatches') : ctx.t('give.noPeopleYet')}</p>`}
<section class="card">
  <h2>${ctx.t('give.addPerson')}</h2>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/give/people" class="stack">
    ${csrfField(ctx)}
    ${personFields(ctx, form)}
    <button type="submit" class="primary">${ctx.t('admin.add')}</button>
  </form>
</section>`,
  });
}

export function personPage(ctx, { person, next, history, choices, others = [], personForm, personError, wish = { kind: 'none' }, giveChoices = [], preselect = '' }) {
  const back = `/admin/give/people/${person.id}`;
  // Group the history by year → occasion, newest first.
  const groups = [];
  for (const g of history) {
    const key = g.occasion_id ? `o${g.occasion_id}` : `b${g.year}`;
    let grp = groups.find((x) => x.key === key);
    if (!grp) {
      grp = {
        key, year: g.year,
        label: g.occasion_id ? `${g.occasion_type === 'christmas' ? '🎄' : '📅'} ${g.occasion_name}` : `🎂 ${ctx.t('give.birthdayYear', { year: g.year })}`,
        gifts: [],
      };
      groups.push(grp);
    }
    grp.gifts.push(g);
  }
  const age = next && person.birth_year ? next.year - person.birth_year : null;
  return page(ctx, {
    title: person.name,
    active: 'people',
    body: h`
<h1>${favoriteButton(ctx, person, `/admin/give/people/${person.id}`)} ${person.name} ${privateBadge(ctx, person)}</h1>
<p class="muted">${next ? h`🎂 ${ctx.t('give.birthdayOn', { date: fmtDay(ctx, next.date, { year: true }) })}${age ? h` · ${ctx.t('give.turns', { age })}` : ''}` : ctx.t('give.noBirthday')}
  ${person.gives_christmas ? h` · 🎄 ${ctx.t('give.givesChristmas')}` : ''}</p>
${person.notes ? h`<p class="description">${person.notes}</p>` : ''}

<section id="wishlist">
  <h2>🎀 ${ctx.t('wish.ofName', { name: person.name })}</h2>
  ${wish.kind === 'self' ? h`<p class="small muted">${ctx.t('wish.selfPerson')} <a href="/admin/wishlist">${ctx.t('wish.mineTitle')}</a></p>`
    : wish.kind === 'person' ? h`<p class="small muted">${ctx.t('wish.personIntro')}</p>
      ${wishSection(ctx, { w: wish.w, items: wish.items, choices: giveChoices, preselect, lists: wish.lists,
        editable: true, personId: person.id, back: `/admin/give/people/${person.id}`, history: wish.history ?? [] })}`
    : h`${wish.own ? h`<p class="small muted">${ctx.t('wish.othersIntro', { name: person.name })}</p>
      ${wishSection(ctx, { w: wish.own.w, items: wish.own.items, choices: giveChoices, preselect, lists: wish.own.lists })}`
      : h`<p class="small muted">${ctx.t('wish.adminPrivate', { name: person.name })}</p>`}`}
</section>
${wish.kind === 'admin' ? h`<section id="ideas">
  <h2>💡 ${ctx.t('wish.ideasFor', { name: person.name })}</h2>
  <p class="small muted">${ctx.t('wish.ideasForIntro', { name: person.name })}</p>
  ${wishSection(ctx, { w: wish.w, items: wish.items, choices: giveChoices, preselect, lists: wish.lists,
        editable: true, banner: !wish.own, personId: person.id, back: `/admin/give/people/${person.id}`, history: wish.history ?? [] })}
</section>` : ''}

<section>
  <h2 class="history-title">🎁 ${ctx.t('give.historyTitle')}</h2>
  ${addGiftForm(ctx, { personId: person.id, back, choices, others })}
  ${groups.length ? groups.map((grp) => h`
    <h2 id="year-${grp.year}">${grp.label}</h2>
    <ul class="gifts">${grp.gifts.map((g) => giftRow(ctx, g, { back, others, forPerson: person.id }))}</ul>`)
  : h`<p class="empty">${ctx.t('give.noGiftsYet')}</p>`}
</section>

<section class="card">
  <details${personError ? raw(' open') : ''}>
    <summary><strong>${ctx.t('give.editPerson')}</strong></summary>
    ${personError ? h`<div class="flash flash-error" role="alert">${personError}</div>` : ''}
    <form method="post" action="/admin/give/people/${person.id}" class="stack">
      ${csrfField(ctx)}
      ${personFields(ctx, personForm || person, { canSetVisibility: isOwner(ctx, person) })}
      <button type="submit" class="primary">${ctx.t('admin.save')}</button>
    </form>
    <hr>
    ${postButton(ctx, `/admin/give/people/${person.id}/delete`, ctx.t('give.deletePerson'), { cls: 'danger', confirm: ctx.t('give.deletePersonConfirm', { name: person.name }) })}
  </details>
</section>`,
  });
}

export function occasionsPage(ctx, { list, people, christmasYear, form = {}, error, q = '' }) {
  const hasChristmas = list.some((o) => o.type === 'christmas' && o.date.startsWith(String(christmasYear)));
  return page(ctx, {
    title: ctx.t('give.occasions'),
    active: 'occasions',
    body: h`
<h1>${ctx.t('give.occasions')}</h1>
<p class="small muted">${ctx.t('give.birthdaysAutomatic')}</p>
${searchBox(ctx, { q, action: '/admin/give/occasions', target: '#occasion-list > li', placeholder: ctx.t('give.searchOccasions') })}
${!hasChristmas ? h`<form method="post" action="/admin/give/occasions/christmas" class="inline">
  ${csrfField(ctx)}<input type="hidden" name="year" value="${christmasYear}">
  <button type="submit" class="primary">🎄 ${ctx.t('give.newChristmas', { year: christmasYear })}</button>
</form>` : ''}
${list.length ? h`<ul class="lists" id="occasion-list">
  ${list.map((o) => h`<li data-search="${o.name}"><a href="/admin/give/occasions/${o.id}">
    <strong>${o.type === 'christmas' ? '🎄' : '📅'} ${o.name} ${privateBadge(ctx, o)}</strong>
    <span class="small muted">${fmtDay(ctx, o.date, { year: true })}${o.total != null ? ` · ${ctx.t('give.progressShort', { done: o.done, total: o.total })}` : ''}</span>
  </a></li>`)}
</ul>
<p class="empty" data-filter-empty hidden>${ctx.t('give.noMatches')}</p>` : h`<p class="empty">${q ? ctx.t('give.noMatches') : ctx.t('give.noOccasions')}</p>`}

<section class="card">
  <h2>${ctx.t('give.newOccasion')}</h2>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/give/occasions" class="stack">
    ${csrfField(ctx)}
    <label>${ctx.t('give.occasionName')}
      <input name="name" required maxlength="120" value="${form.name || ''}" placeholder="${ctx.t('give.occasionNamePlaceholder')}">
    </label>
    <label>${ctx.t('give.date')}
      <input name="date" type="date" required value="${form.date || ''}">
    </label>
    ${people.length ? h`<fieldset class="group">
      <legend>${ctx.t('give.participants')}</legend>
      ${people.map((p) => h`<label class="check"><input type="checkbox" name="people" value="${p.id}"> ${p.name} ${privateBadge(ctx, p)}</label>`)}
    </fieldset>` : ''}
    ${visibilityField(ctx, form.visibility)}
    <button type="submit" class="primary">${ctx.t('admin.create')}</button>
  </form>
</section>`,
  });
}

/** "Pick from their wishlist" for people who are admins with a visible wishlist (not yourself). */
function pickFromWishlist(ctx, person, occasionValue) {
  if (person.user_id === ctx.user.id) return '';
  return h`<p class="small"><a href="/admin/give/people/${person.id}?occasion=${encodeURIComponent(occasionValue)}#wishlist">🎀 ${ctx.t('wish.pickFromWishlist')}</a></p>`;
}

export function checklistPage(ctx, { occasion, rows, orphans, total, done, spent, onlyMissing, candidates, occasionForm, occasionError }) {
  const back = `/admin/give/occasions/${occasion.id}${onlyMissing ? '?missing=1' : ''}`;
  const shown = onlyMissing ? rows.filter((r) => !r.done) : rows;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const participants = rows.map((r) => r.person);
  const seen = new Set(); // a joint gift shows in several rows; only the first gets the #anchor
  const firstTime = (id) => !seen.has(id) && seen.add(id);
  return page(ctx, {
    title: occasion.name,
    active: 'occasions',
    body: h`
<h1>${occasion.type === 'christmas' ? '🎄' : '📅'} ${occasion.name} ${privateBadge(ctx, occasion)}</h1>
${postButton(ctx, `/admin/give/occasions/${occasion.id}/duplicate`, `⧉ ${ctx.t('give.duplicate', { year: Number(occasion.date.slice(0, 4)) + 1 })}`, { cls: 'link small' })}
<p class="muted">${fmtDay(ctx, occasion.date, { year: true })}</p>

<section class="card progress-card">
  <p><strong>${ctx.t('give.progress', { done, total })}</strong></p>
  <progress max="${total || 1}" value="${done}" aria-label="${ctx.t('give.progress', { done, total })}">${pct}%</progress>
  ${spent.length ? h`<p class="small">${ctx.t('give.spent', { total: moneyList(ctx, spent) })}</p>` : ''}
  <p class="small">${onlyMissing
    ? h`<a href="/admin/give/occasions/${occasion.id}">${ctx.t('give.showAll')}</a>`
    : h`<a href="/admin/give/occasions/${occasion.id}?missing=1">${ctx.t('give.onlyMissing')}</a>`}</p>
</section>

${!rows.length ? h`<p class="empty">${ctx.t('give.noParticipants')}</p>` : ''}
<ul class="checklist">
  ${shown.map((r) => h`<li class="${r.done ? 'done' : ''}">
    <div class="who-row">
      <a href="/admin/give/people/${r.person.id}"><strong>${r.done ? '✓ ' : ''}${r.person.name}</strong></a> ${privateBadge(ctx, r.person)}
      ${postButton(ctx, `/admin/give/occasions/${occasion.id}/participants/${r.person.id}/remove`, '✕', { cls: 'link small', confirm: ctx.t('give.removeParticipantConfirm', { name: r.person.name }) })}
    </div>
    ${pickFromWishlist(ctx, r.person, `occasion:${occasion.id}`)}
    ${r.previous.length ? h`<p class="small muted">${ctx.t('give.lastYear')}: ${r.previous.map((g) => g.name).join(', ')}</p>` : ''}
    ${r.gifts.length ? h`<ul class="gifts">${r.gifts.map((g) => giftRow(ctx, g, { back, others: participants, anchor: firstTime(g.id), forPerson: r.person.id }))}</ul>` : ''}
    ${addGiftForm(ctx, { personId: r.person.id, back, occasion: `occasion:${occasion.id}`, others: participants.filter((p) => p.id !== r.person.id) })}
  </li>`)}
</ul>
${orphans.length ? h`<h2>${ctx.t('give.otherGifts')}</h2><ul class="gifts">${orphans.map((g) => giftRow(ctx, g, { back, others: participants }))}</ul>` : ''}

${candidates.length ? h`<section class="card">
  <form method="post" action="/admin/give/occasions/${occasion.id}/participants" class="row">
    ${csrfField(ctx)}
    <label class="grow">${ctx.t('give.addParticipant')}
      <select name="person_id">${candidates.map((p) => h`<option value="${p.id}">${p.name}</option>`)}</select>
    </label>
    <button type="submit" class="secondary">${ctx.t('admin.add')}</button>
  </form>
</section>` : ''}

<section class="card">
  <details${occasionError ? raw(' open') : ''}>
    <summary><strong>${ctx.t('give.editOccasion')}</strong></summary>
    ${occasionError ? h`<div class="flash flash-error" role="alert">${occasionError}</div>` : ''}
    <form method="post" action="/admin/give/occasions/${occasion.id}" class="stack">
      ${csrfField(ctx)}
      <label>${ctx.t('give.occasionName')}
        <input name="name" required maxlength="120" value="${(occasionForm || occasion).name}">
      </label>
      <label>${ctx.t('give.date')}
        <input name="date" type="date" required value="${(occasionForm || occasion).date}">
      </label>
      ${visibilityField(ctx, (occasionForm || occasion).visibility, { disabled: !isOwner(ctx, occasion) })}
      <button type="submit" class="primary">${ctx.t('admin.save')}</button>
    </form>
    <hr>
    ${postButton(ctx, `/admin/give/occasions/${occasion.id}/delete`, ctx.t('give.deleteOccasion'), { cls: 'danger', confirm: ctx.t('give.deleteOccasionConfirm') })}
  </details>
</section>`,
  });
}

export function errorBack(ctx, message, to) {
  return layout(ctx, {
    body: h`${adminHeader(ctx)}<div class="flash flash-error" role="alert">${message}</div><p><a href="${to}">← ${ctx.t('give.goBack')}</a></p>`,
  });
}
