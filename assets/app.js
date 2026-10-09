// Two tabs over one in-browser database and one simulated clock: messages are taken in and answered
// in the first, and every conversation, the calendar and the numbers are in the second. The mode
// in the side rail sets how much the agent may send on its own. Each tab's code loads when it is
// first opened.
import { openDb, installAudit, tx, one, audit, as } from './db.js';
import { seed } from './seed.js';
import { now, advance, nextEvent, mode, setMode } from './engine.js';
import { queueCount, resetQueue } from './owner.js';
import { fmtDay, hhmm, isOpen, nextOpen, fmtNear } from './time.js';
import { MODES } from './terms.js';
import { $, esc, changeTracker, renderActivity } from './ui.js';

const VIEWS = {
  intake: () => import('./intake/view.js'),
  convo: () => import('./convo/view.js'),
};
const loaded = {}; // name -> Promise of the mounted module
const diff = changeTracker();

const ctx = {
  db: null,
  busy: false, // a tab is mid-animation; the clock, the mode and Reset wait
  changed,
  advanceTo,
  focusEnquiry,
};
let active = 'intake';

function view(name) {
  loaded[name] ??= VIEWS[name]().then((mod) => {
    mod.mount(ctx);
    return mod;
  });
  return loaded[name];
}

// Switch tab, re-rendering it from the database so changes made elsewhere show up.
async function show(name) {
  active = name;
  for (const tab of document.querySelectorAll('.nav-item')) tab.setAttribute('aria-selected', String(tab.dataset.view === name));
  for (const key of Object.keys(VIEWS)) $(`#view-${key}`).hidden = key !== name;
  const mod = await view(name);
  if (ctx.db && active === name) mod.refresh();
  return mod;
}

// Opens the conversations tab with one enquiry selected.
async function focusEnquiry(id) {
  const mod = await show('convo');
  mod.focus(id);
}

function renderModes() {
  const current = ctx.db ? mode(ctx.db) : 'routine';
  $('#modes').innerHTML = Object.entries(MODES)
    .map(
      ([key, m]) => `<label class="mode ${key === current ? 'is-on' : ''}">
        <input type="radio" name="mode" value="${key}" ${key === current ? 'checked' : ''} ${ctx.busy || !ctx.db ? 'disabled' : ''}>
        <span class="mode-text"><span class="mode-label">${esc(m.label)}</span><span class="mode-sub">${esc(m.sub)}</span></span>
      </label>`,
    )
    .join('');
}

function renderRail() {
  const db = ctx.db;
  const t = now(db);
  $('#clock-time').textContent = hhmm(t);
  $('#clock-day').textContent = fmtDay(t, true);
  $('#clock-hours').innerHTML = isOpen(t)
    ? '<span class="open-dot"></span>Office open until 18:00'
    : `<span class="open-dot closed"></span>Office closed · opens ${esc(fmtNear(nextOpen(t), t))}`;
  const next = nextEvent(db);
  $('#next-due').disabled = !next || ctx.busy;
  $('#next-what').textContent = next ? `${fmtNear(next.t, t)} · ${next.text}` : 'Nothing scheduled';
  for (const b of document.querySelectorAll('[data-advance]')) b.disabled = ctx.busy;
  renderModes();

  const waiting = queueCount(db);
  $('#nav-intake-sub').textContent = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : 'Nothing needs you';
  $('#nav-intake-sub').classList.toggle('warn', waiting > 0);
  const open = one(db, `SELECT count(*) AS n FROM enquiries WHERE stage = 'open'`).n;
  const booked = one(db, `SELECT count(*) AS n FROM appointments a JOIN slots s ON s.id = a.slot_id WHERE s.start_at >= ?`, [t]).n;
  $('#nav-convo-sub').textContent = `${open} with the agent · ${booked} visits ahead`;
}

// Re-render everything that reads the database after a change.
async function changed() {
  if (!ctx.db) return;
  renderRail();
  renderActivity(ctx.db, $('#activity'), diff);
  const mod = await view(active);
  mod.refresh();
}

function advanceTo(target) {
  tx(ctx.db, () => advance(ctx.db, target));
}

async function onAdvance(mins) {
  if (ctx.busy || !ctx.db) return;
  advanceTo(now(ctx.db) + mins);
  await changed();
}

async function onNextDue() {
  if (ctx.busy || !ctx.db) return;
  const next = nextEvent(ctx.db);
  if (!next) return;
  advanceTo(Math.max(next.t, now(ctx.db)));
  await changed();
}

async function onMode(e) {
  const input = e.target.closest('input[name="mode"]');
  if (!input || ctx.busy || !ctx.db) return;
  tx(ctx.db, () => setMode(ctx.db, input.value));
  await changed();
}

function setStatus(cls, text) {
  $('#db-status').className = `db-status ${cls}`;
  $('#db-status').innerHTML = `<span class="dot"></span><span class="status-text">${esc(text)}</span>`;
}

async function boot() {
  setStatus('', 'Loading…');
  renderModes();
  try {
    const db = await openDb();
    seed(db);
    installAudit(db);
    as('system', () =>
      audit(
        db,
        'records.loaded',
        `${one(db, 'SELECT count(*) AS n FROM contacts').n} contacts, ${one(db, 'SELECT count(*) AS n FROM enquiries').n} enquiries, `
          + `${one(db, 'SELECT count(*) AS n FROM messages').n} messages, ${one(db, 'SELECT count(*) AS n FROM appointments').n} visits booked`,
      ),
    );
    ctx.db = db;
    diff.clear();
    setStatus('ready', 'Ready');
    await changed();
  } catch (err) {
    console.error(err);
    setStatus('failed', `Could not load: ${err.message}`);
  }
}

async function reset() {
  if (ctx.busy) return;
  ctx.db?.close();
  ctx.db = null;
  resetQueue();
  for (const mod of await Promise.all(Object.values(loaded))) mod.reset();
  await boot();
}

$('.nav').addEventListener('click', (e) => {
  const tab = e.target.closest('.nav-item');
  if (tab) show(tab.dataset.view);
});
$('.clock-buttons').addEventListener('click', (e) => {
  const b = e.target.closest('[data-advance]');
  if (b) onAdvance(Number(b.dataset.advance));
});
$('#modes').addEventListener('change', onMode);
$('#next-due').addEventListener('click', onNextDue);
$('#reset').addEventListener('click', reset);
show(active);
boot();
