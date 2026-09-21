/**
 * Activity Tracker
 *
 * Tracks "currently watching" activity for playback paths that don't spawn
 * a long-lived, killable process (unlike transcodeSession.js's HLS
 * sessions): the direct proxy passthrough (/api/proxy/stream) and the
 * lightweight remux/direct-transcode paths. Live TV playback via hls.js
 * hits these repeatedly - once for the manifest, then again for every
 * segment, each with its own unique URL, and manifest/segment URLs often
 * live under entirely different paths for the same channel (many Xtream
 * backends redirect the manifest to one path and serve segments from
 * another). So we key by user (one entry per user, not per URL) and only
 * use manifest (.m3u8) URLs to establish "which stream" identity - segment
 * touches just keep the entry alive without changing the display or
 * resetting the timer, and a genuinely new manifest identity (a real
 * channel switch) is what resets things.
 */

const activity = new Map(); // userId -> { username, url, identity, type, startTime, lastAccess }

const ACTIVE_WINDOW_MS = 20 * 1000; // no touch in this long = no longer "watching"
const PRUNE_AFTER_MS = 5 * 60 * 1000; // drop stale entries entirely after this long

function isManifestUrl(url) {
    return url.split('?')[0].toLowerCase().endsWith('.m3u8');
}

/**
 * A stable identity for "which stream" a manifest URL points to - origin +
 * path, ignoring the query string since many providers attach rotating
 * tokens/signatures there even for the same channel.
 */
function identityFor(url) {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch (e) {
        return url.split('?')[0];
    }
}

/**
 * Record that a user is actively pulling data for a URL right now.
 * `label`, if provided (resolved by the caller - see proxy.js's
 * resolveStreamLabel), is a human-readable channel/movie/series name to
 * show instead of the raw URL, which also embeds plaintext credentials
 * for Xtream sources.
 */
function touch({ userId, username, url, type, label }) {
    const now = Date.now();
    const existing = activity.get(userId);
    const manifest = isManifestUrl(url);

    if (!existing) {
        activity.set(userId, {
            username,
            url,
            label: label || null,
            identity: manifest ? identityFor(url) : url,
            type,
            startTime: now,
            lastAccess: now
        });
        return;
    }

    existing.lastAccess = now;

    if (manifest) {
        const newIdentity = identityFor(url);
        if (newIdentity !== existing.identity) {
            // A different manifest means a real channel/stream switch -
            // update what's displayed and restart the "started" clock.
            existing.identity = newIdentity;
            existing.url = url;
            existing.label = label || null;
            existing.startTime = now;
        }
    }
    // Non-manifest (segment) touches only keep the entry alive; they never
    // change the displayed URL/label or reset the timer, since segment
    // paths for the same channel churn constantly and often don't share a
    // directory with the manifest at all.
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
                label: entry.label,
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
