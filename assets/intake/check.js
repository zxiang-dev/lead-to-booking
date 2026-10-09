// Code around the model. Before it: the headers every channel carries (who sent it, the subject),
// used for repeat deliveries and for threading replies, and the customer's own words. After it:
// the fields the agent read are checked and cleaned. Phone numbers go into one format, emails are
// checked for mistyped domains, ZIP codes are looked up in the service area, and the service must be
// one the business offers.
import { SERVICES, fmtPhone } from '../terms.js';

const TYPO_DOMAINS = {
  'gmial.com': 'gmail.com',
  'gmai.com': 'gmail.com',
  'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'hotmial.com': 'hotmail.com',
  'yaho.com': 'yahoo.com',
  'outlok.com': 'outlook.com',
};

// "Key: value" lines, keyed by the lower-cased key.
function keyValues(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(line);
    if (m && !(m[1].toLowerCase() in kv)) kv[m[1].toLowerCase()] = m[2].trim();
  }
  return kv;
}

const unquote = (s) => (s ?? '').trim().replace(/^["“']|["”']$/g, '').trim();

function csvRow(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur.trim()), (cur = '');
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function referral(raw) {
  const [header = '', row = ''] = raw.trim().split(/\r?\n/);
  const keys = csvRow(header).map((k) => k.toLowerCase());
  const vals = csvRow(row);
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}

function normPhone(p) {
  let digits = (p ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  return digits.length === 10 ? `+1${digits}` : null;
}

const normEmail = (e) => {
  const email = (e ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) ? email : null;
};

// Who it is from and what it answers, from the envelope alone, before the model sees it. For a
// referral row this includes consent to be texted, which code reads rather than the model.
export function headers(channel, raw) {
  if (channel === 'email') {
    const kv = keyValues(raw.split(/\r?\n\s*\r?\n/)[0]);
    const from = /^(.*?)\s*<([^>]+)>\s*$/.exec(kv.from ?? '');
    const subject = kv.subject ?? '';
    return { email: normEmail(from ? from[2] : kv.from), subject, replyTo: /^re:\s*/i.test(subject) ? subject.replace(/^re:\s*/i, '') : null };
  }
  if (channel === 'referral') {
    const r = referral(raw);
    // The client never wrote to us, so consent comes from the sheet; anything but a yes means no.
    return { phone: normPhone(r.phone), email: normEmail(r.email), textOk: /^(y|yes|true|1)$/i.test(r.ok_to_text ?? '') };
  }
  const kv = keyValues(raw);
  return { phone: normPhone(kv.from ?? kv.phone), email: normEmail(kv.email) };
}

// The customer's own words, as they appear in the conversation.
export function wordsOf(channel, raw) {
  if (channel === 'web') return keyValues(raw).message ?? '';
  if (channel === 'sms') return keyValues(raw).text ?? '';
  if (channel === 'call') return unquote(keyValues(raw).voicemail);
  if (channel === 'referral') {
    const r = referral(raw);
    return r.need ?? '';
  }
  const lines = raw.split(/\r?\n\s*\r?\n/).slice(1).join('\n\n').split(/\r?\n/);
  if (/^(hi|hello|hey)\b[^.!?]*,?\s*$/i.test(lines[0] ?? '')) lines.shift();
  const end = lines.findIndex((l) => /^(thanks|thank you|cheers|regards|best)\b[^.!?]*,?\s*$/i.test(l.trim()));
  return (end >= 0 ? lines.slice(0, end) : lines).join('\n').trim();
}

// Checks what the agent read. Returns the cleaned fields and one row per field for display.
export function check(out, areaOf) {
  const c = out.contact ?? {};
  const j = out.job ?? {};
  const rows = [];
  const f = {};

  f.name = c.name ? c.name.replace(/\s+/g, ' ').trim() : null;
  rows.push({ field: 'Name', read: c.name, value: f.name, note: f.name && f.name === f.name.toUpperCase() ? 'caller ID, surname first' : '' });

  f.phone = normPhone(c.phone);
  rows.push({
    field: 'Phone',
    read: c.phone,
    value: f.phone ? fmtPhone(f.phone) : null,
    note: f.phone ? 'normalised' : c.phone ? 'not a 10-digit number' : '',
    warn: !!c.phone && !f.phone,
  });

  f.email = normEmail(c.email);
  const domain = f.email?.split('@')[1];
  f.emailSuggestion = TYPO_DOMAINS[domain] ? `${f.email.split('@')[0]}@${TYPO_DOMAINS[domain]}` : null;
  rows.push({
    field: 'Email',
    read: c.email,
    value: f.email,
    note: f.emailSuggestion ? `possible typo: ${f.emailSuggestion}?` : c.email && !f.email ? 'not a valid address' : '',
    warn: !!f.emailSuggestion || (!!c.email && !f.email),
  });

  f.zip = /^\d{5}$/.test((j.zip ?? '').trim()) ? j.zip.trim() : null;
  f.area = areaOf(f.zip);
  rows.push({
    field: 'ZIP',
    read: j.zip,
    value: f.zip,
    note: !f.zip ? '' : f.area ? `in the service area (${f.area})` : 'outside the service area',
    warn: !!f.zip && !f.area,
  });

  f.service = j.service in SERVICES ? j.service : null;
  rows.push({ field: 'Service', read: j.service, value: SERVICES[f.service] ?? null, note: j.service && !f.service ? 'not a service we offer' : '' });

  f.urgent = !!j.urgent;
  f.summary = j.summary ?? null;
  return { fields: f, rows };
}
