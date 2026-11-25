// "Who is watching what" for the gamewatch server (github.com/pvanhouten/containers, gamewatch/).
// Evidence that someone is watching comes from the stream activity (activityTracker + HLS transcode sessions); what they
// are watching (channel name and the programme on it) comes from a heartbeat the overlay sends, because the guide data
// lives in the browser. Read by gamewatch at GET /api/gamewatch/active with a shared secret.
const crypto = require('node:crypto');

const REPORT_TTL_MS = 60 * 1000;     // a heartbeat older than this is ignored
const IDLE_LIMIT_MS = 30 * 1000;     // a transcode session untouched for this long is not "watching"
const MAX_TEXT = 300;

const reports = new Map(); // userId -> { username, channel, title, at }

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');

function record({ userId, username, channel, title }, now = Date.now(), store = reports) {
    if (userId === undefined || userId === null) return;
    store.set(userId, { username: clip(username), channel: clip(channel), title: clip(title), at: now });
    if (store.size > 500) store.delete(store.keys().next().value);
}

/** entries: activityTracker.getActive() + transcodeSession.getAllSessions() rows. One row per user. */
function buildActive({ entries, reports: store = reports, now = Date.now() }) {
    const rows = [];
    const seen = new Set();
    for (const e of entries) {
        if (seen.has(e.userId) || (typeof e.idleMs === 'number' && e.idleMs > IDLE_LIMIT_MS)) continue;
        seen.add(e.userId);
        const r = store.get(e.userId);
        const fresh = r && now - r.at <= REPORT_TTL_MS;
        rows.push({
            user: e.username || '',
            channel: (fresh && r.channel) || e.label || '',
            title: fresh ? r.title : '',
            since: e.startTime || null
        });
    }
    return rows;
}

function secretMatches(provided, expected) {
    if (!expected || typeof provided !== 'string' || !provided) return false;
    const a = Buffer.from(provided), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { record, buildActive, secretMatches, reports, REPORT_TTL_MS };
