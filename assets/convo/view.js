// Tab 2: reporting tiles, every conversation, the selected one in full, and the visit calendar.
// Each conversation is one enquiry (one job); a person with two jobs has two.
import { all, one } from '../db.js';
import { now, getContact, getEnquiry, visitOf, stepLabel } from '../engine.js';
import { fmtTime, fmtNear, fmtDur, fmtDay, hhmm, dayOf, isOpen, DAY } from '../time.js';
import { CHANNELS, SERVICES, STAGES, KINDS, fmtPhone, personLabel } from '../terms.js';
import { $, esc, channelIcon, changeTracker } from '../ui.js';
import { queueCount, openTaskFor, draftBlock, onQueueClick, RISK } from '../owner.js';

let ctx;
let selected = null; // enquiry id
let filter = 'all';
let notice = null; // { text, bad }
const diff = changeTracker();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const SHORT = { web: 'Web', email: 'Email', sms: 'Text', call: 'Call', referral: 'Referral' };

const FILTERS = [
  ['all', 'All'],
  ['owner', 'Needs you'],
  ['open', 'With agent'],
  ['booked', 'Booked'],
  ['closed', 'Closed'],
];
const inFilter = (e, f) => f === 'all' || (f === 'closed' ? ['lost', 'nurture'].includes(e.stage) : e.stage === f);

export function mount(c) {
  ctx = c;
  $('#conv-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    filter = b.dataset.filter;
    renderList();
  });
  $('#conv-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-enquiry]');
    if (b) select(Number(b.dataset.enquiry));
  });
  $('#calendar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-enquiry]');
    if (b) select(Number(b.dataset.enquiry), true);
  });
  $('#thread').addEventListener('click', onThread);
}

export function reset() {
  selected = null;
  filter = 'all';
  notice = null;
  diff.clear();
}

export function refresh() {
  if (!ctx.db) return;
  renderKpis();
  renderList();
  renderThread();
  renderCalendar();
}

// Opens one conversation, from a link elsewhere on the page.
export function focus(id) {
  selected = id;
  if (!inFilter(getEnquiry(ctx.db, id), filter)) filter = 'all';
  notice = null;
  refresh();
  document.querySelector(`.conv[data-enquiry="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  $('#thread').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function select(id, scroll = false) {
  selected = id;
  notice = null;
  renderList();
  renderThread();
  if (scroll || window.matchMedia('(max-width: 1100px)').matches) $('#thread').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---- reporting ----

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function renderKpis() {
  const db = ctx.db;
  const t = now(db);
  const es = all(db, 'SELECT * FROM enquiries');
  const replied = es.filter((e) => e.first_reply_at != null);
  const speed = median(replied.map((e) => e.first_reply_at - e.created_at));
  const afterHours = replied.filter((e) => !isOpen(e.created_at)).length;
  const alone = es.filter((e) => !e.owner_needed).length;
  const pct = es.length ? Math.round((alone / es.length) * 100) : null;
  const booked = es.filter((e) => e.stage === 'booked').length;
  const bySource = Object.keys(CHANNELS)
    .filter((ch) => ch !== 'sms' || es.some((e) => e.channel === 'sms'))
    .map((ch) => {
      const of = es.filter((e) => e.channel === ch);
      return { ch, n: of.length, b: of.filter((e) => e.stage === 'booked').length };
    });
  const waiting = queueCount(db);
  const oldest = one(
    db,
    `SELECT min(at) AS at FROM (SELECT created_at AS at FROM tasks WHERE status = 'open'
       UNION ALL SELECT i.received_at FROM match_reviews r JOIN inbound i ON i.id = r.inbound_id WHERE r.status = 'open')`,
  ).at;

  $('#kpis').innerHTML = `
    <div class="kpi"><span class="kpi-label">First reply</span><span class="kpi-value">${speed == null ? '—' : speed < 1 ? 'Under 1 min' : esc(fmtDur(speed))}</span><span class="kpi-sub">median of ${replied.length} · ${afterHours} after hours</span></div>
    <div class="kpi"><span class="kpi-label">Handled without you</span><span class="kpi-value">${pct == null ? '—' : `${pct}%`}</span><span class="kpi-sub">${alone} of ${es.length} enquiries</span></div>
    <div class="kpi"><span class="kpi-label">Booked by source</span><span class="kpi-value">${booked}<span class="kpi-of"> of ${es.length}</span></span>
      <span class="kpi-bars">${bySource
        .map(
          (s) => `<span class="kb" title="${esc(CHANNELS[s.ch])}: ${s.b} of ${s.n} booked">${channelIcon(s.ch)}<span class="kb-name">${esc(SHORT[s.ch])}</span><span class="kb-track"><span style="width:${s.n ? (s.b / s.n) * 100 : 0}%"></span></span><span class="mono">${s.b}/${s.n}</span></span>`,
        )
        .join('')}</span></div>
    <div class="kpi ${waiting ? 'is-warn' : ''}"><span class="kpi-label">Waiting on you</span><span class="kpi-value">${waiting}</span><span class="kpi-sub">${waiting ? `oldest ${esc(fmtDur(t - oldest))}` : 'nothing waiting'}</span></div>`;
}

// ---- conversations ----

function conversations(db) {
  return all(
    db,
    `SELECT e.*, c.name, c.phone,
            (SELECT max(coalesce(m.sent_at, m.created_at)) FROM messages m WHERE m.enquiry_id = e.id AND m.status <> 'discarded') AS last_at,
            (SELECT m.body FROM messages m WHERE m.enquiry_id = e.id AND m.status <> 'discarded' ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 1) AS last_body,
            (SELECT CASE m.status WHEN 'draft' THEN 'draft' ELSE m.author END FROM messages m WHERE m.enquiry_id = e.id AND m.status <> 'discarded' ORDER BY coalesce(m.sent_at, m.created_at) DESC, m.id DESC LIMIT 1) AS last_by
       FROM enquiries e JOIN contacts c ON c.id = e.contact_id
      ORDER BY e.stage = 'owner' DESC, last_at DESC, e.id DESC`,
  );
}

const LAST_BY = { agent: 'Agent', automation: 'Auto', owner: 'You', draft: 'Draft' };
const snippet = (body) => (body ?? '').replace(/^Hi[^\n]*\n/, '').replace(/\n— .*$/, '').replace(/\s+/g, ' ').trim();

function renderList() {
  const db = ctx.db;
  const t = now(db);
  const all_ = conversations(db);
  if (selected == null && all_.length) selected = all_[0].id;
  const counts = Object.fromEntries(FILTERS.map(([f]) => [f, all_.filter((e) => inFilter(e, f)).length]));
  $('#conv-filters').innerHTML = FILTERS.map(
    ([f, label]) => `<button type="button" class="filter ${f === 'owner' && counts.owner ? 'is-hot' : ''}" data-filter="${f}" aria-pressed="${filter === f}">${label} <span class="mono">${counts[f]}</span></button>`,
  ).join('');
  const rows = all_.filter((e) => inFilter(e, filter));
  const changed = diff('convs', all_, (e) => e.id, (e) => [e.stage, e.last_at].join('|'));
  $('#conv-list').innerHTML =
    rows
      .map(
        (e) => `<li><button type="button" class="conv ${selected === e.id ? 'is-selected' : ''} ${changed.has(e.id) ? 'flash' : ''}" data-enquiry="${e.id}" aria-pressed="${selected === e.id}">
        <span class="conv-top"><strong>${esc(personLabel(e))}</strong><span class="conv-when mono">${esc(fmtNear(e.last_at, t))}</span></span>
        <span class="conv-sub">${esc(SERVICES[e.service] ?? 'Service unclear')} <span class="pill stage-${e.stage}">${esc(STAGES[e.stage])}</span></span>
        <span class="conv-last">${LAST_BY[e.last_by] ? `<span class="dim">${LAST_BY[e.last_by]}: </span>` : ''}${esc(snippet(e.last_body))}</span>
      </button></li>`,
      )
      .join('') || '<li class="empty">No conversations here.</li>';
}

const AUTHOR = { agent: 'Agent', owner: 'You', automation: 'Automatic' };

function bubble(m, t) {
  const via = m.channel === 'sms' ? 'text' : m.channel === 'email' ? 'email' : CHANNELS[m.channel].toLowerCase();
  if (m.direction === 'in') {
    return `<li class="msg in"><div class="bubble in"><span class="bubble-tag">${channelIcon(m.channel)} ${esc(CHANNELS[m.channel])} · ${esc(fmtNear(m.sent_at, t))}</span><p class="bubble-body">${esc(m.body)}</p></div></li>`;
  }
  if (m.status === 'discarded') return `<li class="msg note"><span>Agent’s draft discarded ${esc(fmtNear(m.created_at, t))}</span></li>`;
  const who = m.author === 'agent' && m.sent_by === 'owner' ? 'Agent’s draft, sent by you' : AUTHOR[m.author];
  return `<li class="msg out"><div class="bubble out"><span class="bubble-tag"><strong class="bubble-who">${esc(who)}</strong> · ${esc(KINDS[m.kind] ?? m.kind)} · ${esc(fmtNear(m.sent_at, t))} by ${via}</span><p class="bubble-body">${esc(m.body)}</p></div></li>`;
}

function statusCallout(db, e, task, t) {
  if (e.stage === 'booked') {
    const v = visitOf(db, e.id);
    return `<p class="callout ok">Visit booked for <strong>${esc(fmtTime(v.start_at))}</strong>.${v.start_at <= t ? ' It has started.' : ''}</p>`;
  }
  if (e.stage === 'lost') return `<p class="callout">Closed: ${esc(e.close_reason ?? '')}.</p>`;
  if (e.stage === 'nurture') return `<p class="callout">Long-term follow-up: ${esc(e.close_reason ?? '')}.</p>`;
  if (task) {
    return `<p class="callout warn"><span class="risk-pill risk-${task.risk}">${RISK[task.risk]}</span> ${esc(cap(task.reason))}. Waiting ${esc(fmtDur(t - task.created_at))}.</p>`;
  }
  return '';
}

const STEP_STATUS = { scheduled: 'Scheduled', sent: 'Done', paused: 'Paused', cancelled: 'Stopped' };

function renderThread() {
  const db = ctx.db;
  const el = $('#thread');
  const e = selected ? getEnquiry(db, selected) : null;
  if (!e) {
    el.innerHTML = '<div class="detail-empty"><p>Select a conversation.</p></div>';
    return;
  }
  const t = now(db);
  const c = getContact(db, e.contact_id);
  const task = openTaskFor(db, e.id);
  const msgs = all(db, 'SELECT * FROM messages WHERE enquiry_id = ? ORDER BY coalesce(sent_at, created_at), id', [e.id]);
  const steps = all(db, 'SELECT * FROM followups WHERE enquiry_id = ? ORDER BY due_at, id', [e.id]);
  const others = all(db, 'SELECT * FROM enquiries WHERE contact_id = ? AND id <> ? ORDER BY id DESC', [c.id, e.id]);
  const items = msgs
    .filter((m) => !(task && m.id === task.message_id))
    .map((m) => bubble(m, t))
    .join('');
  const pending = task ? `<li class="msg out pending">${draftBlock(db, task)}</li>` : '';
  const replyTo =
    e.reply_via === 'sms'
      ? e.text_ok
        ? `Texts to ${fmtPhone(e.reply_to)}`
        : `No consent to text ${fmtPhone(e.reply_to)}; no email`
      : `Emails to ${e.reply_to}${e.subject ? ` · “${e.subject}”` : ''}`;

  el.innerHTML = `
    <header class="thread-head">
      <div>
        <h2>${esc(personLabel(c))}</h2>
        <p class="thread-sub">${esc(SERVICES[e.service] ?? 'Service unclear')} · ${e.zip ? `ZIP ${esc(e.zip)}${e.area ? ` (${esc(e.area)})` : ', outside the area'}` : 'no ZIP yet'}${e.urgent ? ' · <span class="urgent">urgent</span>' : ''}</p>
        <p class="thread-sub dim">${esc(replyTo)}</p>
      </div>
      <span class="pill stage-${e.stage}">${esc(STAGES[e.stage])}</span>
    </header>
    ${statusCallout(db, e, task, t)}
    ${notice ? `<p class="notice ${notice.bad ? 'bad' : ''}" role="status">${esc(notice.text)}</p>` : ''}
    <ol class="msgs">${items}${pending}</ol>
    ${
      steps.length
        ? `<h3 class="detail-sub">Check-ins</h3>
      <ol class="steps">${steps
        .map(
          (s) => `<li class="st-${s.status}"><span class="st-dot" aria-hidden="true"></span>
          <span class="st-main"><span class="st-label">${esc(stepLabel(s.kind))}</span><span class="st-when mono">${esc(fmtNear(s.status === 'sent' ? s.done_at : s.due_at, t))}</span>
          <span class="st-status">${STEP_STATUS[s.status]}${s.note ? ` · ${esc(s.note.replace(/^\w+: /, ''))}` : ''}</span></span></li>`,
        )
        .join('')}</ol>`
        : ''
    }
    ${
      others.length
        ? `<h3 class="detail-sub">Other enquiries from this person</h3>
      <ul class="other-enqs">${others
        .map((o) => `<li><button type="button" class="enq-link" data-enquiry="${o.id}">${esc(SERVICES[o.service] ?? 'Service unclear')} <span class="pill stage-${o.stage}">${esc(STAGES[o.stage])}</span><span class="enq-go" aria-hidden="true">→</span></button></li>`)
        .join('')}</ul>`
        : ''
    }`;
}

async function onThread(ev) {
  if (!ctx.db || ctx.busy) return;
  const jump = ev.target.closest('[data-enquiry]');
  if (jump) {
    select(Number(jump.dataset.enquiry));
    return;
  }
  const out = onQueueClick(ctx, ev.target);
  if (!out.handled) return;
  notice = out.error ? { text: out.error, bad: true } : null;
  await ctx.changed();
}

// ---- calendar ----

function renderCalendar() {
  const db = ctx.db;
  const t = now(db);
  const days = [];
  for (let d = dayOf(t); days.length < 5; d++) if (d % 7 < 5) days.push(d);
  const slots = all(
    db,
    `SELECT s.start_at, a.enquiry_id, c.name, c.phone, e.service FROM slots s
       LEFT JOIN appointments a ON a.slot_id = s.id LEFT JOIN enquiries e ON e.id = a.enquiry_id LEFT JOIN contacts c ON c.id = e.contact_id
      WHERE s.start_at >= ? AND s.start_at < ? ORDER BY s.start_at`,
    [days[0] * DAY, (days.at(-1) + 1) * DAY],
  );
  const changed = diff('cal', slots, (s) => s.start_at, (s) => String(s.enquiry_id ?? ''));
  $('#calendar').innerHTML = days
    .map((d) => {
      const mine = slots.filter((s) => dayOf(s.start_at) === d);
      return `<div class="cal-day"><h3>${esc(fmtDay(d * DAY))}${d === dayOf(t) ? ' <span class="dim">today</span>' : ''}</h3><ul>${mine
        .map((s) => {
          const past = s.start_at <= t;
          const cls = `${s.enquiry_id ? 'is-booked' : 'is-open'} ${past ? 'is-past' : ''} ${changed.has(s.start_at) ? 'flash' : ''} ${s.enquiry_id === selected ? 'is-selected' : ''}`;
          const what = s.enquiry_id
            ? `<button type="button" class="cal-who" data-enquiry="${s.enquiry_id}">${esc(personLabel(s))} <span class="dim">· ${esc(SERVICES[s.service] ?? '')}</span></button>`
            : `<span class="dim">${past ? '—' : 'Open'}</span>`;
          return `<li class="cal-slot ${cls}"><span class="mono">${hhmm(s.start_at)}</span>${what}</li>`;
        })
        .join('')}</ul></div>`;
    })
    .join('');
}
