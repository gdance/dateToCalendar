// =============================================================================
// Date to Calendar — background service worker
// =============================================================================

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'createCalendarEvent',
    title: 'Create Calendar Event',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'createCalendarEvent') return;

  const text = (info.selectionText || '').trim();
  const parsed = parseDateFromText(text);

  if (!parsed) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Date to Calendar',
      message: `Could not recognise a date in: "${text.slice(0, 80)}"`,
    });
    return;
  }

  const ics = generateICS(parsed, tab?.title || 'Event');
  const dataUrl = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics);

  chrome.downloads.download({ url: dataUrl, filename: 'event.ics' });
});

// =============================================================================
// ICS generator
// =============================================================================

function generateICS(parsed, title) {
  const summary = (title || 'Event').replace(/[\\;,]/g, '\\$&').slice(0, 200);
  const uid     = `${Date.now()}@date-to-calendar`;
  const stamp   = toICSDateTime(new Date());

  let dtstart, dtend;
  if (parsed.allDay) {
    dtstart = `DTSTART;VALUE=DATE:${toICSDate(parsed.start)}`;
    dtend   = `DTEND;VALUE=DATE:${toICSDate(addDays(parsed.start, 1))}`;
  } else {
    // If a UTC offset was detected, convert to UTC so calendar apps show the
    // correct time regardless of where the user's machine is located.
    // If no timezone was detected, store as floating (no Z) so the calendar
    // app treats it as local time — the least surprising behaviour.
    const endTime = parsed.end || addHours(parsed.start, 1);
    if (parsed.offsetMinutes !== null) {
      dtstart = `DTSTART:${toICSDateTime(toUTC(parsed.start, parsed.offsetMinutes))}`;
      dtend   = `DTEND:${toICSDateTime(toUTC(endTime, parsed.offsetMinutes))}`;
    } else {
      dtstart = `DTSTART:${toICSDateTimeLocal(parsed.start)}`;
      dtend   = `DTEND:${toICSDateTimeLocal(endTime)}`;
    }
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Date to Calendar Chrome Extension//EN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    dtstart,
    dtend,
    `SUMMARY:${summary}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

function toICSDate(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  return `${y}${mo}${d}`;
}

// UTC datetime with Z suffix
function toICSDateTime(date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
}

// Floating (no timezone) datetime — no Z suffix
function toICSDateTimeLocal(date) {
  const y  = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d  = String(date.getDate()).padStart(2, '0');
  const h  = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s  = String(date.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

// Shift a local-wall-clock Date to UTC given the source UTC offset in minutes
function toUTC(date, offsetMinutes) {
  return new Date(date.getTime() - offsetMinutes * 60_000);
}

// =============================================================================
// Timezone parser
// Known offsets in minutes from UTC. Abbreviations that are ambiguous (e.g.
// CST = US Central OR China Standard) are listed with the most common meaning.
// =============================================================================

const TZ_ABBR = {
  // UTC / GMT
  UTC: 0, GMT: 0, WET: 0,
  // North America — standard
  NST: -210, AST: -240, EST: -300, CST: -360, MST: -420, PST: -480,
  AKST: -540, HST: -600,
  // North America — daylight
  NDT: -150, ADT: -180, EDT: -240, CDT: -300, MDT: -360, PDT: -420,
  AKDT: -480, HDT: -540,
  // North America — generic (resolve to DST-aware offset at runtime via resolveNAZone)
  ET: 'NA_ET', CT: 'NA_CT', MT: 'NA_MT', PT: 'NA_PT', AT: 'NA_AT',
  // Europe
  WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180,
  // Middle East / Asia
  MSK: 180, GST: 240, PKT: 300, IST: 330, BST_BD: 360,
  ICT: 420, WIB: 420, CST_CN: 480, HKT: 480, SGT: 480, JST: 540, KST: 540,
  AEST: 600, ACST: 570, AEDT: 660, NZST: 720, NZDT: 780,
};

// Generic NA timezone codes → [standard offset, daylight offset]
const NA_ZONES = {
  NA_ET: [-300, -240], NA_CT: [-360, -300],
  NA_MT: [-420, -360], NA_PT: [-480, -420], NA_AT: [-240, -180],
};

// US/Canada DST: second Sunday of March → first Sunday of November
function isNADST(date) {
  const y = date.getFullYear();
  const mar1 = new Date(y, 2, 1);
  const dstStart = new Date(y, 2, 8 + (7 - mar1.getDay()) % 7);
  const nov1 = new Date(y, 10, 1);
  const dstEnd = new Date(y, 10, 1 + (7 - nov1.getDay()) % 7);
  return date >= dstStart && date < dstEnd;
}

function resolveOffset(raw, date) {
  if (typeof raw === 'number') return raw;
  const zone = NA_ZONES[raw];
  if (!zone) return null;
  return isNADST(date) ? zone[1] : zone[0];
}

// Matches: UTC+5, GMT-7, UTC+05:30, +0530, -07:00, +05:30, EST, PDT, …
const TZ_RE = /\b(?:UTC|GMT)([+-]\d{1,2}(?::?\d{2})?)\b|\b([+-]\d{2}:?\d{2})\b|\b([A-Z]{2,5})\b/g;

// Returns a numeric offset (minutes) or a NA_* token to be resolved later
function parseTimezone(text) {
  let match;
  TZ_RE.lastIndex = 0;

  while ((match = TZ_RE.exec(text)) !== null) {
    if (match[1]) return parseOffsetString(match[1]);
    if (match[2]) return parseOffsetString(match[2]);
    if (match[3] && match[3] in TZ_ABBR) return TZ_ABBR[match[3]];
  }
  return null;
}

function parseOffsetString(s) {
  // s is like "+5", "+05:30", "-0700"
  const sign = s[0] === '-' ? -1 : 1;
  const digits = s.replace(/[^0-9]/g, '');
  let hours, mins;
  if (digits.length <= 2) {
    hours = parseInt(digits);
    mins  = 0;
  } else {
    hours = parseInt(digits.slice(0, digits.length - 2));
    mins  = parseInt(digits.slice(-2));
  }
  return sign * (hours * 60 + mins);
}

// =============================================================================
// Date parser
// =============================================================================

const MONTH_MAP = {
  january:0, february:1, march:2,    april:3,   may:4,    june:5,
  july:6,    august:7,   september:8, october:9, november:10, december:11,
  jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
};

const TIME_RE = /\b(\d{1,2})(?::(\d{2})(?::(\d{2}))?)?\s*(am|pm|AM|PM)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

// Parse a single time token from a match array
function timeFromMatch(m) {
  let h, min, sec;
  if (m[4]) {
    h   = parseInt(m[1]);
    min = m[2] ? parseInt(m[2]) : 0;
    sec = m[3] ? parseInt(m[3]) : 0;
    const mer = m[4].toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
  } else {
    h   = parseInt(m[5]);
    min = parseInt(m[6]);
    sec = 0;
  }
  return { h, min, sec };
}

// Returns { start, end? } — end is present when a range like "9:30 am to 11:30 am" is found
function parseTimeRange(text) {
  TIME_RE.lastIndex = 0;
  const times = [];
  let m;
  while ((m = TIME_RE.exec(text)) !== null) {
    times.push(timeFromMatch(m));
  }
  if (times.length === 0) return null;

  // Treat as range only when two times appear and the text contains "to", "-" or "–" between them
  if (times.length >= 2 && /\bto\b|–|-/.test(text)) {
    return { start: times[0], end: times[1] };
  }
  return { start: times[0] };
}

function parseDateFromText(text) {
  const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)';

  const patterns = [
    // ISO: 2026-01-15
    {
      re: /\b(\d{4})-(\d{2})-(\d{2})\b/i,
      fn: (m) => ({ y: +m[1], mo: +m[2] - 1, d: +m[3] }),
    },
    // Month DD, YYYY  (January 15, 2026)
    {
      re: new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
      fn: (m) => ({ y: +m[3], mo: MONTH_MAP[m[1].toLowerCase()], d: +m[2] }),
    },
    // DD Month YYYY  (15 January 2026)
    {
      re: new RegExp(`\\b(\\d{1,2})\\s+${MONTH}\\s+(\\d{4})\\b`, 'i'),
      fn: (m) => ({ y: +m[3], mo: MONTH_MAP[m[2].toLowerCase()], d: +m[1] }),
    },
    // Weekday, Month DD, YYYY  (Monday, January 15, 2026)
    {
      re: new RegExp(`\\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\\s+${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
      fn: (m) => ({ y: +m[3], mo: MONTH_MAP[m[1].toLowerCase()], d: +m[2] }),
    },
    // MM/DD/YYYY
    {
      re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
      fn: (m) => ({ y: +m[3], mo: +m[1] - 1, d: +m[2] }),
    },
  ];

  for (const { re, fn } of patterns) {
    const m = text.match(re);
    if (!m) continue;

    const { y, mo, d } = fn(m);
    if (mo < 0 || mo > 11 || d < 1 || d > 31) continue;

    const range = parseTimeRange(text);
    if (range) {
      const start = new Date(y, mo, d, range.start.h, range.start.min, range.start.sec);
      const end   = range.end
        ? new Date(y, mo, d, range.end.h, range.end.min, range.end.sec)
        : null;
      const rawTZ        = parseTimezone(text);
      const offsetMinutes = rawTZ !== null ? resolveOffset(rawTZ, start) : null;
      return { start, end, allDay: false, offsetMinutes };
    }
    return { start: new Date(y, mo, d), allDay: true, offsetMinutes: null };
  }

  // Last resort — browser native parsing
  const fallback = new Date(text);
  if (!isNaN(fallback.getTime())) {
    const rawTZ = parseTimezone(text);
    return { start: fallback, allDay: false, offsetMinutes: rawTZ !== null ? resolveOffset(rawTZ, fallback) : null };
  }

  return null;
}

// =============================================================================
// Helpers
// =============================================================================

function addHours(date, n) { return new Date(date.getTime() + n * 3_600_000); }
function addDays(date, n)  { return new Date(date.getTime() + n * 86_400_000); }
