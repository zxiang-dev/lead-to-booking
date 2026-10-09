// SQLite (sql.js, WASM) shared by both tabs. Times are whole minutes on the simulated clock (time.js).
// A contact is a person; an enquiry is one job they asked about, and a person can have several.
// Each enquiry is a conversation: the customer's messages, the agent's replies and the owner's.
// What the agent may do on its own is decided here, not in its prompt: a trigger checks every
// message it tries to send against the mode and the message's risk, and refuses prices outright.
// Nobody is texted automatically without consent. Bookings can't clash, and the agent can only book
// a time it actually offered. Triggers write the audit trail, so no write path can skip it.
import { CHANNELS, SERVICES, KINDS, MODES, serviceWord, personLabel } from './terms.js';
import { fmtTime } from './time.js';

const SQLJS = 'https://cdn.jsdelivr.net/npm/sql.js@1.14.2/dist/';

// A price, a percentage or a discount: things only the owner may put in writing.
const PRICE_RE = /\$\s?\d|\b\d+\s?%|\bdiscount|\bfree of charge\b|\bno charge\b|\bat no cost\b|\bfor free\b/i;

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- The simulated current time. One row.
CREATE TABLE clock (
  id  INTEGER PRIMARY KEY CHECK (id = 1),
  now INTEGER NOT NULL
);

-- How much the agent may send on its own: approve (nothing; the owner sends every reply) |
-- routine (routine replies) | full (everything except hard stops).
CREATE TABLE settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('approve', 'routine', 'full'))
);

-- The ZIP codes the business covers.
CREATE TABLE service_area (
  zip  TEXT PRIMARY KEY,
  area TEXT NOT NULL
);

-- Each message exactly as it arrived, with what the agent read from it (agent_output, as JSON;
-- null when no model call was made) and the fields after code checked them.
-- outcome (who it is from): new | merged | review (waiting for the owner) | duplicate (a repeat
-- delivery) | separate (the owner ruled it someone new) | reply (an answer to one of our messages).
CREATE TABLE inbound (
  id               INTEGER PRIMARY KEY,
  channel          TEXT NOT NULL,
  received_at      INTEGER NOT NULL,
  raw              TEXT NOT NULL,
  words            TEXT,     -- what the customer wrote, without headers
  name             TEXT,
  phone            TEXT,
  email            TEXT,
  email_suggestion TEXT,
  zip              TEXT,
  service          TEXT,
  summary          TEXT,
  urgent           INTEGER NOT NULL DEFAULT 0,
  text_ok          INTEGER,  -- a referral row's consent to be texted: 1 yes, 0 no; null for other channels
  intent           TEXT,
  agent_output     TEXT,
  outcome          TEXT NOT NULL DEFAULT 'pending',
  contact_id       INTEGER REFERENCES contacts(id),
  enquiry_id       INTEGER REFERENCES enquiries(id)
);

-- One record per person. Its details are resolved from the inbound records linked to it.
CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT,
  phone      TEXT,
  email      TEXT,
  zip        TEXT,
  created_at INTEGER NOT NULL
);

-- One job a person asked about, and the conversation about it.
-- stage: open (the agent is handling it) | owner (waiting for the owner) | booked | lost | nurture
CREATE TABLE enquiries (
  id             INTEGER PRIMARY KEY,
  contact_id     INTEGER NOT NULL REFERENCES contacts(id),
  service        TEXT,
  summary        TEXT,
  zip            TEXT,     -- where the job is
  area           TEXT,     -- null when the ZIP is unknown or outside the service area
  channel        TEXT NOT NULL,
  reply_via      TEXT NOT NULL CHECK (reply_via IN ('sms', 'email')),
  reply_to       TEXT,     -- the number or address the conversation goes to
  subject        TEXT,     -- of our emails, when we wrote first (a referral)
  text_ok        INTEGER NOT NULL DEFAULT 1,  -- 0: never texted by the agent or automation
  urgent         INTEGER NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'open',
  created_at     INTEGER NOT NULL,
  first_reply_at INTEGER,
  owner_needed   INTEGER NOT NULL DEFAULT 0,  -- the owner had to step in at least once
  closed_at      INTEGER,
  close_reason   TEXT
);

-- Which inbound records make up each contact, and why each one was linked.
-- rule: first | auto-merge | owner-merge | reply
CREATE TABLE contact_sources (
  inbound_id INTEGER PRIMARY KEY REFERENCES inbound(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  rule       TEXT NOT NULL,
  score      INTEGER,
  reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  linked_at  INTEGER NOT NULL
);

-- Values the owner corrected; they win over every source.
CREATE TABLE corrections (
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  field      TEXT NOT NULL,
  value      TEXT NOT NULL,
  original   TEXT,
  at         INTEGER NOT NULL,
  PRIMARY KEY (contact_id, field)
);

-- Possible matches code will not decide on its own.
CREATE TABLE match_reviews (
  id         INTEGER PRIMARY KEY,
  inbound_id INTEGER NOT NULL REFERENCES inbound(id),
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  score      INTEGER NOT NULL,
  reasons    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',  -- open | merged | separate
  decided_at INTEGER
);

-- Every message in a conversation, both ways. The agent's replies start as drafts.
-- author: customer | agent (written by the model) | owner | automation (a fixed template)
-- risk: routine | soft (a judgement call) | hard (only the owner may send it)
-- status: received | draft | sent | discarded
CREATE TABLE messages (
  id         INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  author     TEXT NOT NULL,
  channel    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  words      TEXT,     -- the model's own words, before code added the greeting and times
  body       TEXT NOT NULL,
  inbound_id INTEGER REFERENCES inbound(id),
  risk       TEXT NOT NULL DEFAULT 'routine',
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  sent_by    TEXT
);

-- The visit times listed in a message, numbered as the customer sees them.
CREATE TABLE offers (
  message_id INTEGER NOT NULL REFERENCES messages(id),
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  option     INTEGER NOT NULL,
  slot_id    INTEGER NOT NULL REFERENCES slots(id),
  PRIMARY KEY (message_id, option)
);

-- The owner's queue: conversations the agent could not finish on its own.
-- status: open | sent (the draft as written) | edited (sent after the owner changed it) | closed
CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  message_id INTEGER REFERENCES messages(id),
  risk       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hold_at    INTEGER,     -- a holding reply goes out then if the customer is still waiting; null: none planned
  held_at    INTEGER,     -- when hold_at was dealt with, whether or not a reply was needed
  status     TEXT NOT NULL DEFAULT 'open',
  done_at    INTEGER
);

-- kind: nudge | last | close | reminder
-- status: scheduled | sent | paused | cancelled
CREATE TABLE followups (
  id         INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  step       INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'scheduled',
  done_at    INTEGER,
  note       TEXT
);

-- Estimate visits on the calendar.
CREATE TABLE slots (
  id       INTEGER PRIMARY KEY,
  start_at INTEGER NOT NULL UNIQUE
);

CREATE TABLE appointments (
  id         INTEGER PRIMARY KEY,
  enquiry_id INTEGER NOT NULL REFERENCES enquiries(id),
  slot_id    INTEGER NOT NULL UNIQUE REFERENCES slots(id),
  booked_at  INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL
);

-- Controls. A blocked write raises an error; the agent's blocked sends become tasks for the owner.

CREATE TRIGGER messages_insert_guard BEFORE INSERT ON messages
WHEN NEW.direction = 'out' AND NEW.status = 'sent' AND app_actor() = 'agent'
BEGIN
  SELECT RAISE(ABORT, 'Blocked: the agent drafts first, and each send is checked');
END;

-- Nobody is texted automatically without their consent. The owner may text, having asked them first.
CREATE TRIGGER messages_consent_insert BEFORE INSERT ON messages
WHEN NEW.direction = 'out' AND NEW.status = 'sent' AND NEW.channel = 'sms' AND app_actor() <> 'owner'
BEGIN
  SELECT RAISE(ABORT, 'Blocked: no consent to text')
  WHERE (SELECT text_ok FROM enquiries WHERE id = NEW.enquiry_id) = 0;
END;

CREATE TRIGGER messages_consent_send BEFORE UPDATE OF status ON messages
WHEN NEW.status = 'sent' AND OLD.status <> 'sent' AND NEW.channel = 'sms' AND app_actor() <> 'owner'
BEGIN
  SELECT RAISE(ABORT, 'Blocked: no consent to text')
  WHERE (SELECT text_ok FROM enquiries WHERE id = NEW.enquiry_id) = 0;
END;

-- The agent's permissions. The owner can send anything; the agent only what the mode allows.
CREATE TRIGGER messages_send_guard BEFORE UPDATE OF status ON messages
WHEN NEW.status = 'sent' AND OLD.status <> 'sent' AND app_actor() = 'agent'
BEGIN
  SELECT RAISE(ABORT, 'Blocked: price in the reply')
  WHERE quotes_price(NEW.body);
  SELECT RAISE(ABORT, 'Blocked: hard stop')
  WHERE NEW.risk = 'hard';
  SELECT RAISE(ABORT, 'Blocked: approval mode')
  WHERE (SELECT mode FROM settings) = 'approve';
  SELECT RAISE(ABORT, 'Blocked: judgement call')
  WHERE NEW.risk = 'soft' AND (SELECT mode FROM settings) = 'routine';
END;

-- The first reply a customer gets, for reporting.
CREATE TRIGGER messages_first_reply_insert AFTER INSERT ON messages
WHEN NEW.direction = 'out' AND NEW.status = 'sent'
BEGIN
  UPDATE enquiries SET first_reply_at = NEW.sent_at
   WHERE id = NEW.enquiry_id AND first_reply_at IS NULL;
END;

CREATE TRIGGER messages_first_reply_update AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'out' AND NEW.status = 'sent' AND OLD.status <> 'sent'
BEGIN
  UPDATE enquiries SET first_reply_at = NEW.sent_at
   WHERE id = NEW.enquiry_id AND first_reply_at IS NULL;
END;

CREATE TRIGGER appointments_guard BEFORE INSERT ON appointments
BEGIN
  SELECT RAISE(ABORT, 'Blocked: time already taken')
  WHERE EXISTS (SELECT 1 FROM appointments WHERE slot_id = NEW.slot_id);
  SELECT RAISE(ABORT, 'Blocked: time has passed')
  WHERE (SELECT start_at FROM slots WHERE id = NEW.slot_id) <= (SELECT now FROM clock);
  SELECT RAISE(ABORT, 'Blocked: enquiry closed')
  WHERE (SELECT stage FROM enquiries WHERE id = NEW.enquiry_id) IN ('booked', 'lost', 'nurture');
  SELECT RAISE(ABORT, 'Blocked: time not offered to this customer')
  WHERE app_actor() = 'agent' AND NOT EXISTS (
    SELECT 1 FROM offers o JOIN messages m ON m.id = o.message_id
     WHERE o.enquiry_id = NEW.enquiry_id AND o.slot_id = NEW.slot_id AND m.status = 'sent');
END;

-- Booking a visit is the only way an enquiry becomes booked, and it stops the check-ins.
CREATE TRIGGER appointments_book AFTER INSERT ON appointments
BEGIN
  UPDATE enquiries SET stage = 'booked', closed_at = NEW.booked_at WHERE id = NEW.enquiry_id;
  UPDATE followups SET status = 'cancelled', done_at = NEW.booked_at, note = 'Stopped: booked'
   WHERE enquiry_id = NEW.enquiry_id AND status IN ('scheduled', 'paused') AND kind <> 'reminder';
END;

CREATE TRIGGER enquiries_booked_guard BEFORE UPDATE OF stage ON enquiries
WHEN NEW.stage = 'booked' AND NOT EXISTS (SELECT 1 FROM appointments WHERE enquiry_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'Blocked: an enquiry is booked only by booking a visit');
END;

CREATE TRIGGER followups_guard BEFORE UPDATE OF status ON followups
WHEN NEW.status = 'sent' AND NEW.kind <> 'reminder'
BEGIN
  SELECT RAISE(ABORT, 'Blocked: check-ins stop once an enquiry is booked or closed')
  WHERE (SELECT stage FROM enquiries WHERE id = NEW.enquiry_id) IN ('booked', 'lost', 'nurture');
END;
`;

// Created after the seed, so the history loaded at start-up is not replayed as activity. Entries name
// people and jobs rather than record numbers, as they stood when the entry was written.
const person = (id) => `(SELECT person_label(name, phone) FROM contacts WHERE id = ${id})`;
const job = (id) => `(SELECT person_label(c.name, c.phone) || ', ' || coalesce(service_word(e.service), 'service unclear')
  FROM enquiries e JOIN contacts c ON c.id = e.contact_id WHERE e.id = ${id})`;
const via = (id) => `(SELECT channel_name(channel) FROM inbound WHERE id = ${id})`;

const AUDIT = `
CREATE TRIGGER inbound_audit AFTER INSERT ON inbound BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'message.received',
    channel_name(NEW.channel) || ' received');
END;

CREATE TRIGGER inbound_outcome_audit AFTER UPDATE OF outcome ON inbound
WHEN NEW.outcome IN ('duplicate', 'review') AND OLD.outcome IS NOT NEW.outcome BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(),
    CASE NEW.outcome WHEN 'duplicate' THEN 'message.duplicate' ELSE 'match.held' END,
    channel_name(NEW.channel) || CASE NEW.outcome
      WHEN 'duplicate' THEN ' repeats an earlier delivery; no model call, nothing sent'
      ELSE ' may be from someone on file; held for the owner' END);
END;

CREATE TRIGGER contacts_audit AFTER INSERT ON contacts BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'contact.created',
    person_label(NEW.name, NEW.phone));
END;

CREATE TRIGGER enquiries_audit AFTER INSERT ON enquiries BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'enquiry.opened',
    ${job('NEW.id')});
END;

CREATE TRIGGER sources_audit AFTER INSERT ON contact_sources WHEN NEW.rule <> 'first' BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(),
    CASE NEW.rule WHEN 'reply' THEN 'message.threaded' ELSE 'contact.merged' END,
    ${via('NEW.inbound_id')} || ' from ' || ${person('NEW.contact_id')} || ': ' || NEW.reason);
END;

CREATE TRIGGER sources_delete_audit AFTER DELETE ON contact_sources BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'contact.split',
    ${via('OLD.inbound_id')} || ' taken out of ' || ${person('OLD.contact_id')} || '’s record');
END;

CREATE TRIGGER reviews_audit AFTER UPDATE OF status ON match_reviews WHEN NEW.status <> 'open' BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(),
    CASE NEW.status WHEN 'merged' THEN 'match.confirmed' ELSE 'match.rejected' END,
    ${via('NEW.inbound_id')} || CASE NEW.status WHEN 'merged' THEN ' is from ' ELSE ' is not from ' END
    || ${person('NEW.contact_id')});
END;

CREATE TRIGGER messages_sent_audit AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'out' AND NEW.status IN ('sent', 'discarded') AND OLD.status <> NEW.status BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(),
    'message.' || NEW.status,
    ${job('NEW.enquiry_id')} || ': ' || kind_label(NEW.kind)
    || CASE NEW.status WHEN 'sent' THEN CASE NEW.channel WHEN 'sms' THEN ', by text' ELSE ', by email' END ELSE '' END);
END;

CREATE TRIGGER messages_template_audit AFTER INSERT ON messages
WHEN NEW.direction = 'out' AND NEW.status = 'sent' BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'message.sent',
    ${job('NEW.enquiry_id')} || ': ' || kind_label(NEW.kind)
    || CASE NEW.channel WHEN 'sms' THEN ', by text' ELSE ', by email' END);
END;

CREATE TRIGGER tasks_audit AFTER INSERT ON tasks BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'owner.needed',
    ${job('NEW.enquiry_id')} || ': ' || NEW.reason);
END;

CREATE TRIGGER tasks_done_audit AFTER UPDATE OF status ON tasks WHEN OLD.status = 'open' AND NEW.status <> 'open' BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'owner.' || NEW.status,
    ${job('NEW.enquiry_id')} || CASE NEW.status
      WHEN 'sent' THEN ': the agent''s draft sent as written'
      WHEN 'edited' THEN ': the agent''s draft edited and sent'
      ELSE ': draft discarded and enquiry closed' END);
END;

CREATE TRIGGER enquiries_stage_audit AFTER UPDATE OF stage ON enquiries
WHEN NEW.stage IS NOT OLD.stage AND NEW.stage IN ('lost', 'nurture') BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'enquiry.' || NEW.stage,
    ${job('NEW.id')} || coalesce(': ' || NEW.close_reason, ''));
END;

CREATE TRIGGER followups_audit AFTER UPDATE OF status ON followups
WHEN NEW.status = 'sent' AND OLD.status <> 'sent' AND NEW.kind = 'close' BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'followup.close',
    ${job('NEW.enquiry_id')} || ': no booking after 7 days');
END;

CREATE TRIGGER appointments_audit AFTER INSERT ON appointments BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'visit.booked',
    ${job('NEW.enquiry_id')} || ': ' || fmt_time((SELECT start_at FROM slots WHERE id = NEW.slot_id))
    || '; check-ins stopped');
END;

CREATE TRIGGER settings_audit AFTER UPDATE OF mode ON settings WHEN NEW.mode IS NOT OLD.mode BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'agent.mode',
    '“' || mode_label(NEW.mode) || '”');
END;

CREATE TRIGGER corrections_audit AFTER INSERT ON corrections BEGIN
  INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), 'contact.corrected',
    ${person('NEW.contact_id')} || ': ' || NEW.field || ' ' || coalesce(NEW.original, '(blank)') || ' to ' || NEW.value);
END;
`;

let SQL = null;
let actor = 'system';

export async function openDb() {
  SQL ??= await window.initSqlJs({ locateFile: (f) => SQLJS + f });
  const db = new SQL.Database();
  db.create_function('app_actor', () => actor);
  db.create_function('fmt_time', (t) => (t == null ? '' : fmtTime(t)));
  db.create_function('person_label', (name, phone) => personLabel({ name, phone }));
  db.create_function('service_word', (sv) => (SERVICES[sv] ? serviceWord(sv) : null));
  db.create_function('channel_name', (c) => CHANNELS[c] ?? c);
  db.create_function('kind_label', (k) => {
    const label = KINDS[k] ?? k;
    return label[0].toUpperCase() + label.slice(1);
  });
  db.create_function('mode_label', (m) => MODES[m]?.label ?? m);
  db.create_function('quotes_price', (body) => (PRICE_RE.test(body ?? '') ? 1 : 0));
  db.exec(SCHEMA);
  return db;
}

export const installAudit = (db) => db.exec(AUDIT);

// Runs fn with app_actor() returning name, so triggers record who did it.
export function as(name, fn) {
  const prev = actor;
  actor = name;
  try {
    return fn();
  } finally {
    actor = prev;
  }
}

// All of fn's writes, or none of them.
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export const one = (db, sql, params) => all(db, sql, params)[0];

export const run = (db, sql, params = []) => db.run(sql, params);

export const lastId = (db) => one(db, 'SELECT last_insert_rowid() AS id').id;

// A write the database refused, as opposed to a bug.
export const isBlocked = (err) => /Blocked:/.test(err?.message ?? '');
export const blockedText = (err) => (err?.message ?? '').replace(/^.*?Blocked:\s*/, '');

// An audit entry for a decision no single table write records on its own.
export const audit = (db, action, detail) =>
  run(db, `INSERT INTO audit_log (at, actor, action, detail) VALUES ((SELECT now FROM clock), app_actor(), ?, ?)`, [action, detail]);
