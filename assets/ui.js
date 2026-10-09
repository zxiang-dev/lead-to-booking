// DOM helpers shared by both tabs.
import { all } from './db.js';
import { fmtTime } from './time.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const beat = (ms) => (reducedMotion ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

// Remembers each list's rows from the last render, so the rows that changed can flash.
export function changeTracker() {
  let seen = {};
  const diff = (list, rows, keyFn, sigFn) => {
    const prev = seen[list];
    const next = new Map(rows.map((r) => [keyFn(r), sigFn(r)]));
    seen[list] = next;
    if (!prev) return new Set();
    const changed = new Set();
    for (const [k, sig] of next) if (prev.get(k) !== sig) changed.add(k);
    return changed;
  };
  diff.clear = () => {
    seen = {};
  };
  return diff;
}

// Small inline icons for the channels.
const ICONS = {
  web: '<path d="M3 5.5h14M3 5.5v9a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-9M3 5.5 4.5 3.5h11L17 5.5M6 9h8M6 12h5"/>',
  email: '<rect x="2.75" y="4.5" width="14.5" height="11" rx="1.5"/><path d="m3.5 5.5 6.5 5 6.5-5"/>',
  call: '<path d="M6.5 3.5 8 7l-2 1.25a8 8 0 0 0 5.75 5.75L13 12l3.5 1.5V16a1.5 1.5 0 0 1-1.5 1.5A12.5 12.5 0 0 1 2.5 5 1.5 1.5 0 0 1 4 3.5Z"/><path d="m12.5 3.5 4 4m0-4-4 4"/>',
  sms: '<path d="M4.5 4h11A1.5 1.5 0 0 1 17 5.5v7a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3h-1A1.5 1.5 0 0 1 3 12.5v-7A1.5 1.5 0 0 1 4.5 4Z"/><path d="M7 8.5h6M7 11h4"/>',
  referral: '<rect x="2.75" y="3.75" width="14.5" height="12.5" rx="1.5"/><path d="M2.75 8h14.5M2.75 12h14.5M7.5 3.75v12.5"/>',
};
export const channelIcon = (channel, title = '') =>
  `<svg class="ch-icon ch-${channel}" viewBox="0 0 20 20" aria-hidden="${title ? 'false' : 'true'}"${title ? ` role="img" aria-label="${esc(title)}"` : ''}>${ICONS[channel] ?? ''}</svg>`;

const ACTOR_CLASS = { agent: 'actor-agent', automation: 'actor-auto', owner: 'actor-owner', clock: 'actor-clock', system: 'actor-clock' };
const ACTOR_NAME = { agent: 'Agent', automation: 'Automation', owner: 'You', clock: 'Clock', system: 'System' };

// Plain names for the audit log's event codes; the code itself stays on hover.
const EVENT = {
  'message.received': 'Message in',
  'message.duplicate': 'Repeat ignored',
  'message.threaded': 'Reply matched',
  'message.sent': 'Sent',
  'message.discarded': 'Draft discarded',
  'match.held': 'Who is it?',
  'match.confirmed': 'Same person',
  'match.rejected': 'Someone new',
  'contact.created': 'New contact',
  'contact.merged': 'Known contact',
  'contact.split': 'Contact split',
  'contact.corrected': 'Contact fixed',
  'consent.recorded': 'Consent',
  'enquiry.opened': 'New enquiry',
  'enquiry.moved': 'Enquiry moved',
  'enquiry.lost': 'Closed',
  'enquiry.nurture': 'Long-term',
  'owner.needed': 'Needs you',
  'owner.sent': 'You sent',
  'owner.edited': 'You edited',
  'owner.closed': 'You closed',
  'followup.close': 'Check-ins ended',
  'visit.booked': 'Booked',
  'agent.mode': 'Mode changed',
  'clock.moved': 'Clock moved',
  'records.loaded': 'Loaded',
};

// The audit log under both tabs, newest first.
export function renderActivity(db, el, diff) {
  const rows = all(db, 'SELECT id, at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 80');
  const changed = diff('activity', rows, (r) => r.id, () => '1');
  el.innerHTML = rows.length
    ? rows
        .map(
          (r) => `<li class="${changed.has(r.id) ? 'flash' : ''}">
        <span class="act-time mono">${esc(fmtTime(r.at))}</span>
        <span class="actor ${ACTOR_CLASS[r.actor] ?? 'actor-clock'}">${esc(ACTOR_NAME[r.actor] ?? r.actor)}</span>
        <span class="act-body"><span class="act-action" title="${esc(r.action)}">${esc(EVENT[r.action] ?? r.action)}</span> ${esc(r.detail)}</span>
      </li>`,
        )
        .join('')
    : '<li class="empty">Nothing yet.</li>';
}
