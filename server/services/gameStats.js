// Live game stats for the player overlay.
// Finds the ESPN game that a channel/stream title is about (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM")
// and returns a compact score summary. Self-contained: no dependencies beyond global fetch.
// ESPN's public scoreboard JSON is unofficial and keyless; every failure degrades to "no match".

const LEAGUES = [
    { key: 'ncaam', label: 'NCAAB', path: 'basketball/mens-college-basketball', query: 'groups=50&limit=400' },
    { key: 'ncaaw', label: 'NCAAW', path: 'basketball/womens-college-basketball', query: 'groups=50&limit=400' },
    { key: 'ncaaf', label: 'NCAAF', path: 'football/college-football', query: 'groups=80&limit=400' },
    { key: 'nfl', label: 'NFL', path: 'football/nfl', query: '' },
    { key: 'nba', label: 'NBA', path: 'basketball/nba', query: '' },
    { key: 'nhl', label: 'NHL', path: 'hockey/nhl', query: '' },
    { key: 'mlb', label: 'MLB', path: 'baseball/mlb', query: '' }
];

const CACHE_MS = 10_000;
const FAIL_CACHE_MS = 5_000;
const FETCH_TIMEOUT_MS = 6_000;
const cache = new Map(); // league key -> { at, ttl, promise }

function normalize(s) {
    return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

function hasWords(haystack, needle) {
    if (!needle) return false;
    return ` ${haystack} `.includes(` ${needle} `);
}

// Length of the best name for this team found in the (normalized) title, or 0.
function teamScore(title, team) {
    let best = 0;
    for (const raw of [team.location, team.displayName, team.shortDisplayName]) {
        const n = normalize(raw);
        if (n.length >= 3 && hasWords(title, n)) best = Math.max(best, n.length);
    }
    return best;
}

function summarize(event, league) {
    const comp = event.competitions?.[0];
    if (!comp) return null;
    const side = (homeAway) => {
        const c = comp.competitors?.find((x) => x.homeAway === homeAway);
        if (!c) return null;
        const rank = c.curatedRank?.current;
        return {
            name: c.team?.shortDisplayName || c.team?.displayName || '',
            abbr: c.team?.abbreviation || '',
            logo: c.team?.logo || null,
            score: c.score ?? '',
            record: c.records?.find((r) => r.type === 'total')?.summary || c.records?.[0]?.summary || '',
            rank: rank && rank <= 25 ? rank : null,
            winner: c.winner === true
        };
    };
    const away = side('away');
    const home = side('home');
    if (!away || !home) return null;
    const type = event.status?.type || {};
    const situation = comp.situation || {};
    return {
        league: league.label,
        state: type.state || 'pre', // pre | in | post
        detail: type.shortDetail || type.detail || '',
        period: event.status?.period ?? null,
        clock: event.status?.displayClock || '',
        away,
        home,
        lastPlay: situation.lastPlay?.text || '',
        broadcast: comp.broadcasts?.[0]?.names?.[0] || '',
        link: event.links?.find((l) => l.rel?.includes('summary'))?.href || event.links?.[0]?.href || null
    };
}

// Pure matcher (exported for tests): pick the event whose two teams both appear in the title.
function findGame(title, events, league) {
    const t = normalize(title);
    if (!t) return null;
    let best = null;
    for (const event of events || []) {
        const comps = event.competitions?.[0]?.competitors || [];
        if (comps.length !== 2) continue;
        const a = teamScore(t, comps[0].team || {});
        const b = teamScore(t, comps[1].team || {});
        if (!a || !b) continue;
        const score = a + b;
        if (!best || score > best.score) best = { score, event };
    }
    return best ? summarize(best.event, league) : null;
}

function looksLikeMatchup(title) {
    return /\s(@|at|vs\.?|v)\s/i.test(String(title || ''));
}

async function fetchLeague(league) {
    const now = Date.now();
    const hit = cache.get(league.key);
    if (hit && now - hit.at < hit.ttl) return hit.promise;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard${league.query ? '?' + league.query : ''}`;
    const entry = { at: now, ttl: CACHE_MS, promise: null };
    entry.promise = fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => d.events || [])
        .catch((err) => {
            entry.ttl = FAIL_CACHE_MS;
            console.warn(`[GameStats] ${league.key} scoreboard failed: ${err.message}`);
            return [];
        });
    cache.set(league.key, entry);
    return entry.promise;
}

async function lookup(title) {
    title = String(title || '').slice(0, 200);
    if (!looksLikeMatchup(title)) return null; // only titles that name two teams
    const lists = await Promise.all(LEAGUES.map((l) => fetchLeague(l)));
    let best = null;
    LEAGUES.forEach((league, i) => {
        const g = findGame(title, lists[i], league);
        if (g) best = best || g; // leagues are ordered; first hit wins
    });
    return best;
}

module.exports = { lookup, findGame, normalize, looksLikeMatchup, LEAGUES };
