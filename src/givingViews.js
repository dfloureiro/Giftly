// Views for occasions, people and the gifts to give them (admin only).
import { h, raw, layout, csrfField, postButton, adminHeader, uploadField, birthdayFields, pageHead, formPage } from './views.js';
import { config } from './config.js';
import { STATUSES, VISIBILITIES, daysBetween, today } from './giving.js';
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

const STATUS_ICON = { planned: '📌', bought: '🛍️', given: '🎁' };

function subnav(ctx, tabs, active) {
  return h`<nav class="subnav">${tabs.map(([href, key, name]) => h`<a href="${href}" class="subtab${active === name ? ' active' : ''}"${active === name ? raw(' aria-current="page"') : ''}>${ctx.t(key)}</a>`)}</nav>`;
}

/** Search box: filters the list instantly (app.js) and also works as a normal GET form. */
function searchBox(ctx, { q = '', action, target, placeholder, extra = '' }) {
  return h`<form method="get" action="${action}" class="search" role="search">${extra}
    <input type="search" name="q" value="${q}" placeholder="${placeholder}" aria-label="${placeholder}" data-filter="${target}" autocomplete="off">
  </form>`;
}

function favoriteButton(ctx, p, back) {
  return h`<form method="post" action="/admin/people/${p.id}/favorite" class="inline fav-form">
    ${csrfField(ctx)}<input type="hidden" name="on" value="${p.favorite ? '0' : '1'}"><input type="hidden" name="back" value="${back}">
    <button type="submit" class="fav${p.favorite ? ' on' : ''}" aria-pressed="${p.favorite ? 'true' : 'false'}" title="${p.favorite ? ctx.t('give.unfavorite') : ctx.t('give.favorite')}" aria-label="${p.favorite ? ctx.t('give.unfavorite') : ctx.t('give.favorite')}">${p.favorite ? '★' : '☆'}</button>
  </form>`;
}

function page(ctx, { title, body }) {
  return layout(ctx, { title, body: h`${adminHeader(ctx)}${body}` });
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
          ${STATUSES.map((s) => h`<option value="${s}"${s === (v.status || 'planned') ? raw(' selected') : ''}>${STATUS_ICON[s]} ${ctx.t(`give.status.${s}`)}</option>`)}
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
        <form method="post" action="/admin/gifts/${g.id}/status" class="inline status-form">
          ${csrfField(ctx)}<input type="hidden" name="back" value="${back}">
          <select name="status" data-autosubmit aria-label="${ctx.t('give.status')}">
            ${STATUSES.map((s) => h`<option value="${s}"${s === g.status ? raw(' selected') : ''}>${STATUS_ICON[s]} ${ctx.t(`give.status.${s}`)}</option>`)}
          </select>
          <button type="submit" class="secondary small-btn" data-autosubmit-fallback>${ctx.t('admin.save')}</button>
        </form>
        <details class="edit">
          <summary>${ctx.t('admin.edit')}</summary>
          <form method="post" action="/admin/gifts/${g.id}" class="stack">
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
            ${g.url ? postButton(ctx, `/admin/gifts/${g.id}/preview`, ctx.t('preview.refresh'), { cls: 'link small', extra: `<input type="hidden" name="back" value="${escAttr(back)}">` }) : ''}
            ${postButton(ctx, `/admin/gifts/${g.id}/delete`, ctx.t('admin.delete'), { cls: 'link danger small', confirm: ctx.t('admin.deleteItemConfirm'), extra: `<input type="hidden" name="back" value="${escAttr(back)}">` })}
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
    <form method="post" action="/admin/gifts" class="stack">
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

/** "missing 6 of 18" / "all sorted" / "no gift" / "planned" for an upcoming entry. */
function entryState(ctx, e) {
  if (e.kind === 'birthday') {
    return e.done ? h`<span class="pill ok">✓ ${ctx.t('give.hasGift')}</span>`
      : e.planned ? h`<span class="pill">📌 ${ctx.t('give.plannedCount', { n: e.planned })}</span>`
      : h`<span class="pill ${e.past ? 'past' : 'missing'}">${ctx.t('give.noGift')}</span>`;
  }
  if (!e.total) return h`<span class="pill">${ctx.t('give.noParticipantsShort')}</span>`;
  return e.done ? h`<span class="pill ok">✓ ${ctx.t('give.allSorted')}</span>`
    : h`<span class="pill missing">${ctx.t('give.missingOf', { missing: e.total - e.doneCount, total: e.total })}</span>`;
}

function entryCard(ctx, e, { pinned = false } = {}) {
  const href = e.kind === 'birthday' ? `/admin/people/${e.person.id}#year-${e.year}` : `/admin/occasions/${e.occasion.id}`;
  const what = e.kind === 'birthday'
    ? h`🎂 ${ctx.t('give.birthdayOf', { name: e.person.name })}${e.age ? h` <span class="muted">(${e.age})</span>` : ''} ${privateBadge(ctx, e.person)}`
    : h`${e.occasion.type === 'christmas' ? '🎄' : '📅'} ${e.occasion.name} ${privateBadge(ctx, e.occasion)}`;
  return h`<li class="${e.done ? 'done' : ''}${pinned ? ' pinned' : ''}">
    <a href="${href}">
      <span class="when"><strong>${fmtDay(ctx, e.date)}</strong><span class="small muted">${inDays(ctx, e.inDays)}</span></span>
      <span class="what">${what}</span>
      <span class="state">${entryState(ctx, e)}</span>
    </a>
  </li>`;
}

function newChristmasButton(ctx, year) {
  return h`<form method="post" action="/admin/occasions/christmas" class="inline">
    ${csrfField(ctx)}<input type="hidden" name="year" value="${year}">
    <button type="submit" class="primary">🎄 ${ctx.t('give.newChristmas', { year })}</button>
  </form>`;
}

/** Occasions: "Upcoming" (the home page: the next 60 days as cards) or "All" (grouped by year). */
export function occasionsPage(ctx, { view, q = '', entries, pinned, season, christmasYear, christmas, hasPeople, all }) {
  const tabs = subnav(ctx, [['/admin/occasions', 'give.upcoming', 'upcoming'], ['/admin/occasions?view=all', 'give.all', 'all']], view);
  const head = h`${pageHead(ctx, ctx.t('nav.occasions'), { href: '/admin/occasions/new', label: ctx.t('give.newOccasion') })}${tabs}`;
  if (view === 'all') {
    const years = [];
    for (const e of all) {
      let g = years.find((x) => x.year === e.year);
      if (!g) years.push(g = { year: e.year, list: [] });
      g.list.push(e);
    }
    const row = (e) => {
      const isB = e.kind === 'birthday';
      const name = isB ? e.person.name : e.occasion.name;
      const href = isB ? `/admin/people/${e.person.id}#year-${e.year}` : `/admin/occasions/${e.occasion.id}`;
      const what = isB
        ? h`🎂 ${ctx.t('give.birthdayOf', { name })}${e.age ? h` <span class="muted">(${e.age})</span>` : ''} ${privateBadge(ctx, e.person)}`
        : h`${e.occasion.type === 'christmas' ? '🎄' : '📅'} ${name} ${privateBadge(ctx, e.occasion)}`;
      return h`<li data-search="${name}" class="${e.done ? 'done' : ''}"><a href="${href}">
    <span class="when"><strong>${fmtDay(ctx, e.date)}</strong></span>
    <span class="what">${what}</span>
    <span class="state">${entryState(ctx, e)}</span>
  </a></li>`;
    };
    return page(ctx, {
      title: ctx.t('nav.occasions'),
      body: h`${head}
<p class="small muted">${ctx.t('give.allHint')}</p>
${searchBox(ctx, { q, action: '/admin/occasions', target: '#occasion-list li[data-search]', placeholder: ctx.t('give.searchOccasions'), extra: raw('<input type="hidden" name="view" value="all">') })}
${all.length ? h`<div id="occasion-list">${years.map((g) => h`<h2>${g.year}</h2>
<ul class="upcoming compact">${g.list.map(row)}</ul>`)}</div>
<p class="empty" data-filter-empty hidden>${ctx.t('give.noMatches')}</p>` : h`<p class="empty">${q ? ctx.t('give.noMatches') : ctx.t('give.noOccasions')}</p>`}`,
    });
  }
  return page(ctx, {
    title: ctx.t('nav.occasions'),
    body: h`${head}
${season && pinned ? h`<ul class="upcoming pinned-list">${entryCard(ctx, pinned, { pinned: true })}</ul>` : ''}
${season && !christmas && hasPeople ? h`<section class="card pinned">
  <h2>🎄 ${ctx.t('give.christmasName', { year: christmasYear })}</h2>
  <p class="small muted">${ctx.t('give.newChristmasHint')}</p>
  ${newChristmasButton(ctx, christmasYear)}
</section>` : ''}
${!hasPeople ? h`<p class="empty">${ctx.t('give.noPeopleYet')} <a href="/admin/people/new">${ctx.t('give.addPerson')}</a></p>` : ''}
${hasPeople && !entries.length && !pinned ? h`<p class="empty">${ctx.t('give.nothingSoon')}</p>` : ''}
<ul class="upcoming">${entries.map((e) => entryCard(ctx, e))}</ul>`,
  });
}

export function newOccasionPage(ctx, { people, christmasYear, christmas, form = {}, error }) {
  return layout(ctx, {
    title: ctx.t('give.newOccasion'),
    body: h`
${adminHeader(ctx, '/admin/occasions?view=all', `← ${ctx.t('nav.occasions')}`)}
<h1>${ctx.t('give.newOccasion')}</h1>
${!christmas ? h`<section class="card">
  <h2>🎄 ${ctx.t('give.christmasName', { year: christmasYear })}</h2>
  <p class="small muted">${ctx.t('give.newChristmasHint')}</p>
  ${newChristmasButton(ctx, christmasYear)}
</section>` : ''}
<section class="card">
  <h2>📅 ${ctx.t('give.otherOccasion')}</h2>
  <p class="small muted">${ctx.t('give.birthdaysAutomatic')}</p>
  ${error ? h`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" action="/admin/occasions" class="stack">
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

const MONTHS = (ctx) => Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(locale(ctx), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, i, 1))));

function personFields(ctx, v = {}, { canSetVisibility = true } = {}) {
  return h`
    <label>${ctx.t('give.personName')}
      <input name="name" required maxlength="80" value="${v.name || ''}">
    </label>
    <fieldset class="group">
      <legend>${ctx.t('give.birthday')}</legend>
      ${birthdayFields(ctx, v)}
      ${v.user_id ? h`<span class="small muted">${ctx.t('people.birthdayFromProfile')}</span>` : ''}
    </fieldset>
    <label>${ctx.t('admin.itemNotes')}
      <textarea name="notes" rows="2" maxlength="1000" placeholder="${ctx.t('give.personNotesPlaceholder')}">${v.notes || ''}</textarea>
    </label>
    <label class="check"><input type="checkbox" name="gives_christmas" value="1"${v.gives_christmas ? raw(' checked') : ''}> 🎄 ${ctx.t('give.givesChristmas')}</label>
    ${visibilityField(ctx, v.visibility, { disabled: !canSetVisibility })}`;
}

/** An admin joined and a person with their name already exists: "is it the same one?" */
function adminMatchCard(ctx, { user, candidates }) {
  return h`<section class="card prompt">
  <p><strong>👤 ${ctx.t('people.adminJoined', { name: user.name })}</strong></p>
  ${candidates.map((c) => h`<p>${ctx.t('people.sameQuestion', { name: c.name })} <a href="/admin/people/${c.id}" class="small">${ctx.t('people.seeRecord')}</a></p>
  <div class="row">
    <form method="post" action="/admin/people/admins/${user.id}/link" class="inline">
      ${csrfField(ctx)}<input type="hidden" name="person_id" value="${c.id}">
      <button type="submit" class="primary">${ctx.t('people.link')}</button>
    </form>
  </div>`)}
  ${postButton(ctx, `/admin/people/admins/${user.id}/new`, ctx.t('people.createNew'), { cls: 'secondary' })}
  <p class="small muted">${ctx.t('people.linkHint', { name: user.name })}</p>
</section>`;
}

export function peoplePage(ctx, { list, q = '', matches = [] }) {
  return page(ctx, {
    title: ctx.t('give.people'),
    body: h`
${pageHead(ctx, ctx.t('give.people'), { href: '/admin/people/new', label: ctx.t('give.newPerson') })}
${matches.map((m) => adminMatchCard(ctx, m))}
${searchBox(ctx, { q, action: '/admin/people', target: '#people-list > li', placeholder: ctx.t('give.searchPeople') })}
${list.length ? h`<ul class="lists with-fav" id="people-list">
  ${list.map((p) => h`<li data-search="${`${p.name} ${p.notes || ''}`}">${favoriteButton(ctx, p, `/admin/people${q ? `?q=${encodeURIComponent(q)}` : ''}`)}<a href="/admin/people/${p.id}">
    <strong>${p.name} ${privateBadge(ctx, p)}${p.user_id ? h` <span class="badge" title="${ctx.t('people.isAdminHint')}">👤 ${ctx.t('people.adminBadge')}</span>` : ''}${p.gives_christmas ? h` <span title="${ctx.t('give.givesChristmas')}">🎄</span>` : ''}</strong>
    <span class="small muted">${p.next ? ctx.t('give.nextBirthday', { date: fmtDay(ctx, p.next.date), when: inDays(ctx, daysBetween(today(), p.next.date)) }) : ctx.t('give.noBirthday')}</span>
  </a></li>`)}
</ul>
<p class="empty" data-filter-empty hidden>${ctx.t('give.noMatches')}</p>` : h`<p class="empty">${q ? ctx.t('give.noMatches') : ctx.t('give.noPeopleYet')}</p>`}`,
  });
}

export function newPersonPage(ctx, { form = {}, error }) {
  return formPage(ctx, {
    title: ctx.t('give.newPerson'), back: '/admin/people', backLabel: ctx.t('give.people'), error,
    body: h`<form method="post" action="/admin/people" class="stack">
      ${csrfField(ctx)}
      ${personFields(ctx, form)}
      <button type="submit" class="primary">${ctx.t('admin.add')}</button>
    </form>`,
  });
}

export function personPage(ctx, { person, next, history, choices, others = [], personForm, personError, wish, soon = [], giveChoices = [], preselect = '' }) {
  const back = `/admin/people/${person.id}`;
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
  const years = [...new Set(groups.map((g) => g.year))];
  const age = next && person.birth_year ? next.year - person.birth_year : null;
  const ideasArgs = { choices: giveChoices, preselect, editable: true, personId: person.id, back };
  return page(ctx, {
    title: person.name,
    body: h`
<h1>${favoriteButton(ctx, person, back)} ${person.name} ${privateBadge(ctx, person)}</h1>
<p class="muted">${next ? h`🎂 ${ctx.t('give.birthdayOn', { date: fmtDay(ctx, next.date, { year: true }) })}${age ? h` · ${ctx.t('give.turns', { age })}` : ''}` : ctx.t('give.noBirthday')}
  ${person.gives_christmas ? h` · 🎄 ${ctx.t('give.givesChristmas')}` : ''}</p>
${person.user_id ? h`<p class="small muted">👤 ${ctx.t('people.isAdmin', { name: person.name })}</p>` : ''}
${person.notes ? h`<p class="description">${person.notes}</p>` : ''}
<p class="row person-actions">
  <a class="button primary" href="#wishlist">🎁 ${ctx.t('people.illGiveAction')}</a>
  <a class="button secondary" href="/admin/people/${person.id}/new-list">＋ ${ctx.t('wish.createListFromThis')}</a>
</p>

${soon.length ? h`<section id="soon">
  <h2>📅 ${ctx.t('people.upcoming')}</h2>
  <ul class="upcoming compact">${soon.map((e) => h`<li class="${e.done ? 'done' : ''}">
    <a href="${e.kind === 'birthday' ? `#year-${e.year}` : `/admin/occasions/${e.occasion.id}`}">
      <span class="when"><strong>${fmtDay(ctx, e.date)}</strong><span class="small muted">${inDays(ctx, e.inDays)}</span></span>
      <span class="what">${e.kind === 'birthday' ? h`🎂 ${ctx.t('give.birthdayYear', { year: e.year })}` : h`${e.occasion.type === 'christmas' ? '🎄' : '📅'} ${e.occasion.name}`}</span>
      <span class="state">${entryState(ctx, { ...e, kind: 'birthday' })}</span>
    </a></li>`)}</ul>
</section>` : ''}

<section id="wishlist">
${person.user_id ? h`
  <h2>🎀 ${ctx.t('wish.ofName', { name: person.name })}</h2>
  ${wish.own ? h`<p class="small muted">${ctx.t('wish.othersIntro', { name: person.name })}</p>
    ${wishSection(ctx, { w: wish.own.w, items: wish.own.items, choices: giveChoices, preselect, lists: wish.own.lists, back, createList: false })}`
    : h`<p class="small muted">${ctx.t('wish.adminPrivate', { name: person.name })}</p>`}
  <h2 id="ideas">💡 ${ctx.t('wish.ideasFor', { name: person.name })}</h2>
  <p class="small muted">${ctx.t('wish.ideasForIntro', { name: person.name })}</p>
  ${wishSection(ctx, { w: wish.ideas.w, items: wish.ideas.items, lists: wish.ideas.lists, history: wish.ideas.history, banner: !wish.own, addForm: true, createList: false, ...ideasArgs })}`
  : h`
  <h2>🎀 ${ctx.t('wish.ideasWishlist', { name: person.name })}</h2>
  <p class="small muted">${ctx.t('wish.personIntro')}</p>
  ${wishSection(ctx, { w: wish.ideas.w, items: wish.ideas.items, lists: wish.ideas.lists, history: wish.ideas.history, addForm: true, createList: false, ...ideasArgs })}`}
${wish.mine ? h`
  <h3 id="private-ideas">🔒 ${ctx.t('wish.myPrivateIdeas', { name: person.name })}</h3>
  <p class="small muted">${ctx.t('wish.myPrivateIdeasIntro')}</p>
  ${wishSection(ctx, { w: wish.mine.w, items: wish.mine.items, lists: wish.mine.lists, history: wish.mine.history, banner: false, createList: false, ...ideasArgs })}` : ''}
</section>

<section>
  <h2 class="history-title">🎁 ${ctx.t('give.historyTitle')}</h2>
  ${addGiftForm(ctx, { personId: person.id, back, choices, others })}
  ${groups.length ? years.map((y) => h`<h3 class="year-head" id="year-${y}">${y}</h3>
    ${groups.filter((grp) => grp.year === y).map((grp) => h`<h4>${grp.label}</h4>
    <ul class="gifts">${grp.gifts.map((g) => giftRow(ctx, g, { back, others, forPerson: person.id }))}</ul>`)}`)
  : h`<p class="empty">${ctx.t('give.noGiftsYet')}</p>`}
</section>

<section class="card">
  <details${personError ? raw(' open') : ''}>
    <summary><strong>${ctx.t('give.editPerson')}</strong></summary>
    ${personError ? h`<div class="flash flash-error" role="alert">${personError}</div>` : ''}
    <form method="post" action="/admin/people/${person.id}" class="stack">
      ${csrfField(ctx)}
      ${personFields(ctx, { ...(personForm || person), user_id: person.user_id }, { canSetVisibility: isOwner(ctx, person) })}
      <button type="submit" class="primary">${ctx.t('admin.save')}</button>
    </form>
    <hr>
    ${person.user_id ? h`<p class="small muted">${ctx.t('people.cantDeleteAdmin')}</p>`
      : postButton(ctx, `/admin/people/${person.id}/delete`, ctx.t('give.deletePerson'), { cls: 'danger', confirm: ctx.t('give.deletePersonConfirm', { name: person.name }) })}
  </details>
</section>`,
  });
}

/** "Pick from their wishlist": the person's page, with the occasion already chosen. */
function pickFromWishlist(ctx, person, occasionValue) {
  return h`<p class="small"><a href="/admin/people/${person.id}?occasion=${encodeURIComponent(occasionValue)}#wishlist">🎀 ${ctx.t('wish.pickFromWishlist')}</a></p>`;
}

export function checklistPage(ctx, { occasion, rows, orphans, total, done, spent, onlyMissing, candidates, occasionForm, occasionError }) {
  const back = `/admin/occasions/${occasion.id}${onlyMissing ? '?missing=1' : ''}`;
  const shown = onlyMissing ? rows.filter((r) => !r.done) : rows;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const participants = rows.map((r) => r.person);
  const seen = new Set(); // a joint gift shows in several rows; only the first gets the #anchor
  const firstTime = (id) => !seen.has(id) && seen.add(id);
  return layout(ctx, {
    title: occasion.name,
    body: h`
${adminHeader(ctx, '/admin/occasions', `← ${ctx.t('nav.occasions')}`)}
<h1>${occasion.type === 'christmas' ? '🎄' : '📅'} ${occasion.name} ${privateBadge(ctx, occasion)}</h1>
${postButton(ctx, `/admin/occasions/${occasion.id}/duplicate`, `⧉ ${ctx.t('give.duplicate', { year: Number(occasion.date.slice(0, 4)) + 1 })}`, { cls: 'link small' })}
<p class="muted">${fmtDay(ctx, occasion.date, { year: true })}</p>

<section class="card progress-card">
  <p><strong>${ctx.t('give.progress', { done, total })}</strong></p>
  <progress max="${total || 1}" value="${done}" aria-label="${ctx.t('give.progress', { done, total })}">${pct}%</progress>
  ${spent.length ? h`<p class="small">${ctx.t('give.spent', { total: moneyList(ctx, spent) })}</p>` : ''}
  <p class="small">${onlyMissing
    ? h`<a href="/admin/occasions/${occasion.id}">${ctx.t('give.showAll')}</a>`
    : h`<a href="/admin/occasions/${occasion.id}?missing=1">${ctx.t('give.onlyMissing')}</a>`}</p>
</section>

${!rows.length ? h`<p class="empty">${ctx.t('give.noParticipants')}</p>` : ''}
<ul class="checklist">
  ${shown.map((r) => h`<li class="${r.done ? 'done' : ''}">
    <div class="who-row">
      <a href="/admin/people/${r.person.id}"><strong>${r.done ? '✓ ' : ''}${r.person.name}</strong></a> ${privateBadge(ctx, r.person)}
      ${postButton(ctx, `/admin/occasions/${occasion.id}/participants/${r.person.id}/remove`, '✕', { cls: 'link small', confirm: ctx.t('give.removeParticipantConfirm', { name: r.person.name }) })}
    </div>
    ${pickFromWishlist(ctx, r.person, `occasion:${occasion.id}`)}
    ${r.previous.length ? h`<p class="small muted">${ctx.t('give.lastYear')}: ${r.previous.map((g) => g.name).join(', ')}</p>` : ''}
    ${r.gifts.length ? h`<ul class="gifts">${r.gifts.map((g) => giftRow(ctx, g, { back, others: participants, anchor: firstTime(g.id), forPerson: r.person.id }))}</ul>` : ''}
    ${addGiftForm(ctx, { personId: r.person.id, back, occasion: `occasion:${occasion.id}`, others: participants.filter((p) => p.id !== r.person.id) })}
  </li>`)}
</ul>
${orphans.length ? h`<h2>${ctx.t('give.otherGifts')}</h2><ul class="gifts">${orphans.map((g) => giftRow(ctx, g, { back, others: participants }))}</ul>` : ''}

${candidates.length ? h`<section class="card">
  <form method="post" action="/admin/occasions/${occasion.id}/participants" class="row">
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
    <form method="post" action="/admin/occasions/${occasion.id}" class="stack">
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
    ${postButton(ctx, `/admin/occasions/${occasion.id}/delete`, ctx.t('give.deleteOccasion'), { cls: 'danger', confirm: ctx.t('give.deleteOccasionConfirm') })}
  </details>
</section>`,
  });
}

export function errorBack(ctx, message, to) {
  return layout(ctx, {
    body: h`${adminHeader(ctx)}<div class="flash flash-error" role="alert">${message}</div><p><a href="${to}">← ${ctx.t('give.goBack')}</a></p>`,
  });
}
