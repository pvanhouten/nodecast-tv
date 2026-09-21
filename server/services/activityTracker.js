/**
 * Activity Tracker
 *
 * Tracks "currently watching" activity for playback paths that don't spawn
 * a long-lived, killable process (unlike transcodeSession.js's HLS
 * sessions): the direct proxy passthrough (/api/proxy/stream) and the
 * lightweight remux/direct-transcode paths. Live TV playback via hls.js
 * hits these repeatedly - once for the manifest, then again for every
 * segment, each with its own unique URL - so there's no single request
 * that represents "the user is watching this channel." Instead, we key by
 * user (one entry per user, not per URL) and treat same-directory URLs as
 * continued playback of the same stream rather than a new one, so segment
 * churn doesn't reset the "started watching" time or spawn duplicate rows.
 */

const activity = new Map(); // userId -> { username, url, baseKey, type, startTime, lastAccess }

const ACTIVE_WINDOW_MS = 20 * 1000; // no touch in this long = no longer "watching"
const PRUNE_AFTER_MS = 5 * 60 * 1000; // drop stale entries entirely after this long

/**
 * A stable identifier for "which stream" a URL belongs to, ignoring the
 * per-segment filename (e.g. segment_42.ts) so consecutive segment
 * fetches for the same channel collapse into one entry.
 */
function baseKeyFor(url) {
    try {
        const u = new URL(url);
        const dir = u.pathname.replace(/\/[^/]*$/, '/');
        return `${u.origin}${dir}`;
    } catch (e) {
        return url;
    }
}

/**
 * Record that a user is actively pulling data for a URL right now.
 */
function touch({ userId, username, url, type }) {
    const now = Date.now();
    const base = baseKeyFor(url);
    const existing = activity.get(userId);

    if (existing && existing.baseKey === base) {
        // Same stream, just another segment/manifest poll - keep the
        // original display URL and startTime, bump the heartbeat.
        existing.lastAccess = now;
    } else {
        // New stream for this user (first touch, or they switched channels).
        activity.set(userId, {
            username,
            url,
            baseKey: base,
            type,
            startTime: now,
            lastAccess: now
        });
    }
}

/**
 * Return entries touched within the active window, in the same shape
 * transcodeSession.getAllSessions() uses so the dashboard can merge both.
 */
function getActive() {
    const now = Date.now();
    const result = [];
    for (const [userId, entry] of activity.entries()) {
        const idleMs = now - entry.lastAccess;
        if (idleMs <= ACTIVE_WINDOW_MS) {
            result.push({
                id: null, // no killable process behind this entry
                url: entry.url,
                status: entry.type,
                startTime: entry.startTime,
                lastAccess: entry.lastAccess,
                idleMs,
                userId,
                username: entry.username,
                killable: false
            });
        }
    }
    return result;
}

function prune() {
    const now = Date.now();
    for (const [userId, entry] of activity.entries()) {
        if (now - entry.lastAccess > PRUNE_AFTER_MS) {
            activity.delete(userId);
        }
    }
}

let cleanupInterval = null;
function startCleanupInterval() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(prune, 60 * 1000);
}

module.exports = {
    touch,
    getActive,
    startCleanupInterval
};
