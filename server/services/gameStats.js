// Live game stats for the player overlay.
// Finds the ESPN game that a channel/stream title is about (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM")
// and returns a compact score summary. Self-contained: no dependencies beyond global fetch.
// ESPN's public scoreboard JSON is unofficial and keyless; every failure degrades to "no match".

const LEAGUES = [
    { key: 'ncaam', sport: 'basketball', label: 'NCAAB', path: 'basketball/mens-college-basketball', query: 'groups=50&limit=400' },
    { key: 'ncaaw', sport: 'basketball', label: 'NCAAW', path: 'basketball/womens-college-basketball', query: 'groups=50&limit=400' },
    { key: 'nba', sport: 'basketball', label: 'NBA', path: 'basketball/nba', query: '' },
    { key: 'ncaaf', sport: 'football', label: 'NCAAF', path: 'football/college-football', query: 'groups=80&limit=400' },
    { key: 'nfl', sport: 'football', label: 'NFL', path: 'football/nfl', query: '' },
    { key: 'nhl', sport: 'hockey', label: 'NHL', path: 'hockey/nhl', query: '' },
    { key: 'mlb', sport: 'baseball', label: 'MLB', path: 'baseball/mlb', query: '' },
    // ESPN's soccer/all aggregates every league (Premier League, La Liga, Champions League, Liga MX, ...)
    { key: 'soccer', sport: 'soccer', label: 'Soccer', path: 'soccer/all', query: 'limit=500' },
    { key: 'ncaa-soccer-m', sport: 'soccer', label: 'NCAA Soccer', path: 'soccer/usa.ncaa.m.1', query: 'limit=500' },
    { key: 'ncaa-soccer-w', sport: 'soccer', label: 'NCAA Soccer', path: 'soccer/usa.ncaa.w.1', query: 'limit=500' }
];

// If the title says which sport it is, only search that sport (stops "Georgia vs South Carolina Soccer"
// matching a basketball game on the same day).
const SPORT_HINTS = [
    ['basketball', /\b(ncaab|ncaaw|basketball|nba|wnba)\b/i],
    ['football', /\b(ncaaf|nfl|college football)\b/i],
    ['hockey', /\b(nhl|hockey)\b/i],
    ['baseball', /\b(mlb|baseball)\b/i],
    // soccer last: "Basketball Champions League" must resolve to basketball first
    ['soccer', /\b(soccer|epl|premier league|la ?liga|bundesliga|serie a|ligue 1|champions league|europa|uefa|mls|liga mx)\b/i]
];
function sportHint(title) {
    const hit = SPORT_HINTS.find(([, re]) => re.test(title));
    return hit ? hit[0] : null;
}

const CACHE_MS = 10_000;
const FAIL_CACHE_MS = 5_000;
const FETCH_TIMEOUT_MS = 6_000;
const cache = new Map(); // league key -> { at, ttl, promise }

const ALIASES = [[/\butd\b/g, 'united'], [/\bspurs\b/g, 'tottenham'], [/\bman\b/g, 'manchester']];
function normalize(s) {
    let n = String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
        .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
    for (const [re, to] of ALIASES) n = n.replace(re, to);
    return n;
}

function hasWords(haystack, needle) {
    if (!needle) return false;
    return ` ${haystack} `.includes(` ${needle} `);
}

// Words too generic to identify a club on their own.
const GENERIC = new Set(['united', 'city', 'real', 'sporting', 'athletic', 'club', 'state', 'football', 'women', 'womens', 'university', 'college', 'national', 'royal', 'saint', 'north', 'south', 'east', 'west']);

// How well a team matches the (normalized) title: full-name hits score by name length;
// otherwise a distinctive word of the name ("bayern" for "FC Bayern" vs "Bayern Munich") scores half.
function teamScore(title, team) {
    const names = [team.location, team.displayName, team.shortDisplayName].map(normalize).filter(Boolean);
    let best = 0;
    for (const n of names) if (n.length >= 3 && hasWords(title, n)) best = Math.max(best, n.length);
    if (best) return best;
    for (const n of names) {
        for (const w of n.split(' ')) {
            if (w.length >= 5 && !GENERIC.has(w) && hasWords(title, w)) best = Math.max(best, w.length / 2);
        }
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
    const game = best ? summarize(best.event, league) : null;
    return game ? { game, score: best.score } : null;
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
    const sport = sportHint(title);
    const leagues = sport ? LEAGUES.filter((l) => l.sport === sport) : LEAGUES;
    const lists = await Promise.all(leagues.map((l) => fetchLeague(l)));
    let best = null;
    leagues.forEach((league, i) => {
        const g = findGame(title, lists[i], league);
        if (g && (!best || g.score > best.score)) best = g;
    });
    return best ? best.game : null;
}

module.exports = { lookup, findGame, normalize, looksLikeMatchup, sportHint, LEAGUES };
