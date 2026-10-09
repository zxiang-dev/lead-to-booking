// Names shown for the codes stored in the database, and small helpers for showing people and services.
export const CHANNELS = { web: 'Web form', email: 'Email', sms: 'Text message', call: 'Missed call', referral: 'Referral sheet' };
export const SERVICES = { roofing: 'Roofing', hvac: 'HVAC', plumbing: 'Plumbing' };
export const STAGES = { open: 'With agent', owner: 'Needs you', booked: 'Booked', lost: 'Closed', nurture: 'Long-term' };

// How much the agent may send on its own. Hard stops come to the owner in every mode.
export const MODES = {
  approve: { label: 'Approve every reply', sub: 'The agent drafts, you send.' },
  routine: { label: 'Send routine replies', sub: 'Anything unusual comes to you.' },
  full: { label: 'Send all it safely can', sub: 'Only hard stops come to you.' },
};

// What each outbound message is.
export const KINDS = {
  reply: 'reply with times',
  answer: 'answer with times',
  clarify: 'question back',
  decline: 'polite decline',
  holding: 'holding reply',
  closing: 'closing reply',
  confirm: 'booking confirmation',
  retry: 'new times after a clash',
  nudge: 'check-in',
  last: 'last check-in',
  reminder: 'visit reminder',
  owner: 'reply',
};

// The service as it reads mid-sentence: "a roofing job", "an HVAC job".
export const serviceWord = (s) => (s === 'hvac' ? 'HVAC' : (SERVICES[s] ?? '').toLowerCase());

// +15125550142 -> (512) 555-0142
export const fmtPhone = (p) => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p ?? '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (p ?? '');
};

// The name to greet someone by; caller-ID style names ("TAN J") give none.
export const greetName = (name) => {
  if (!name || name === name.toUpperCase()) return '';
  const first = name.trim().split(/\s+/)[0];
  return first.replace(/\W/g, '').length > 1 ? first : '';
};

export const firstName = (name) => (name ?? '').trim().split(/\s+/)[0];

// How a person is named on screen: their name, else their number.
export const personLabel = (c) => c?.name ?? (c?.phone ? fmtPhone(c.phone) : 'Unknown caller');
