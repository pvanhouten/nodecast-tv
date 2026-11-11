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
        id: String(event.id || ''),
        leagueKey: league.key,
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

// ---- Lineups -------------------------------------------------------------------------------------
const LINEUP_CACHE_MS = 30_000;
const lineupCache = new Map(); // `${leagueKey}:${eventId}` -> { at, promise }

function soccerTeams(summary) {
    return (summary.rosters || []).map((r) => ({
        homeAway: r.homeAway,
        name: r.team?.shortDisplayName || r.team?.displayName || '',
        formation: r.formation || '',
        starters: (r.roster || []).filter((p) => p.starter).sort((a, b) => (a.formationPlace || 99) - (b.formationPlace || 99))
            .map((p) => ({ num: p.jersey || '', name: p.athlete?.displayName || '', pos: p.position?.abbreviation || '', out: !!p.subbedOut })),
        bench: (r.roster || []).filter((p) => !p.starter)
            .map((p) => ({ num: p.jersey || '', name: p.athlete?.displayName || '', pos: p.position?.abbreviation || '', in: !!p.subbedIn }))
    }));
}

function basketballTeams(summary) {
    return (summary.boxscore?.players || []).map((t) => {
        const block = t.statistics?.[0] || {};
        const labels = block.labels || [];
        const idx = (l) => labels.indexOf(l);
        const stat = (p) => {
            const st = p.stats || [];
            const pts = st[idx('PTS')], reb = st[idx('REB')], ast = st[idx('AST')];
            return pts == null ? '' : `${pts} pts` + (reb && reb !== '0' ? `, ${reb} reb` : '') + (ast && ast !== '0' ? `, ${ast} ast` : '');
        };
        const row = (p) => ({ num: p.athlete?.jersey || '', name: p.athlete?.displayName || '', pos: p.athlete?.position?.abbreviation || '', stat: stat(p) });
        const all = block.athletes || [];
        return {
            homeAway: summary.header?.competitions?.[0]?.competitors?.find((c) => c.id === t.team?.id)?.homeAway || '',
            name: t.team?.shortDisplayName || t.team?.displayName || '',
            formation: '',
            starters: all.filter((p) => p.starter).map(row),
            bench: all.filter((p) => !p.starter && !p.didNotPlay).map(row)
        };
    });
}

// Every player in a box score with their stat groups. Works for basketball, NFL, NHL and MLB
// (boxscore.players[team].statistics[category].athletes[]); soccer comes from rosters[].roster[].stats.
function boxPlayers(summary, sport) {
    const teams = [];
    if (sport === 'soccer') {
        for (const r of summary.rosters || []) {
            teams.push({
                homeAway: r.homeAway, name: r.team?.shortDisplayName || r.team?.displayName || '',
                players: (r.roster || []).map((p) => ({
                    id: String(p.athlete?.id || ''), num: p.jersey || '', name: p.athlete?.displayName || '',
                    pos: p.position?.abbreviation || '', starter: !!p.starter,
                    groups: [{ title: 'This match', stats: (p.stats || []).filter((x) => x.displayValue && x.displayValue !== '0')
                        .map((x) => [x.shortDisplayName || x.abbreviation || x.displayName, x.displayValue]) }]
                }))
            });
        }
        return teams;
    }
    const compOf = (id) => summary.header?.competitions?.[0]?.competitors?.find((c) => c.id === id);
    for (const t of summary.boxscore?.players || []) {
        const byId = new Map();
        (t.statistics || []).forEach((block, bi) => {
            const title = ({ forwards: 'Forwards', defenses: 'Defense', goalies: 'Goalies', passing: 'Passing', rushing: 'Rushing',
                receiving: 'Receiving', fumbles: 'Fumbles', defensive: 'Defense', interceptions: 'Interceptions', kicking: 'Kicking',
                punting: 'Punting', kickReturns: 'Kick returns', puntReturns: 'Punt returns' })[block.name]
                || (sport === 'baseball' ? (bi === 0 ? 'Batting' : 'Pitching') : 'This game');
            for (const a of block.athletes || []) {
                const id = String(a.athlete?.id || '');
                if (!id) continue;
                let p = byId.get(id);
                if (!p) {
                    p = { id, num: a.athlete.jersey || '', name: a.athlete.displayName || '', pos: a.athlete.position?.abbreviation || '',
                        starter: !!a.starter, unit: title, groups: [] };
                    byId.set(id, p);
                }
                p.groups.push({ title, stats: (block.labels || []).map((l, i) => [l, (a.stats || [])[i]]).filter(([, v]) => v != null && v !== '') });
            }
        });
        teams.push({ homeAway: compOf(t.team?.id)?.homeAway || '', name: t.team?.shortDisplayName || t.team?.displayName || '', players: [...byId.values()] });
    }
    return teams;
}

// Pure (exported for tests): turn an ESPN summary into [{ name, formation, starters[], bench[] }].
function buildLineups(summary, sport) {
    if (sport === 'soccer') return soccerTeams(summary);
    if (sport === 'basketball') return basketballTeams(summary);
    if (sport === 'hockey' || sport === 'baseball') {
        // No true "starting lineup" in the box score: list everyone who has played, grouped by unit.
        return boxPlayers(summary, sport).map((t) => ({
            homeAway: t.homeAway, name: t.name, formation: '', bench: [],
            starters: t.players.map((p) => ({ unit: p.unit, num: p.num, name: p.name, pos: p.pos,
                stat: p.groups[0].stats.filter(([l]) => (sport === 'hockey' ? ['G', 'A', 'SV%'] : ['H-AB', 'IP', 'K', 'ERA']).includes(l))
                    .map(([l, v]) => `${v} ${l}`).join(', ') }))
        }));
    }
    return [];
}

// NFL: ESPN's game summary has no lineup, so use each team's depth chart (projected starters per position)
// joined with its roster for jersey numbers. Not the official game-day active list.
const TEAM_CACHE_MS = 10 * 60_000;
const teamCache = new Map(); // `${path}:${teamId}` -> { at, promise }

function getJson(url) {
    return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
}

function nflRoster(roster) {
    const out = [];
    for (const g of roster?.athletes || []) for (const a of g.items || []) {
        out.push({ id: String(a.id), num: a.jersey || '', name: a.displayName || a.fullName || '', pos: a.position?.abbreviation || '' });
    }
    return out;
}

function nflTeamStarters(depth, roster) {
    const jersey = new Map();
    for (const a of nflRoster(roster)) jersey.set(a.id, a.num);
    const charts = depth?.depthchart || [];
    const pick = (re) => charts.find((c) => re.test(c.name || ''));
    const unit = (chart, label) => Object.entries(chart?.positions || {}).filter(([pos]) => pos !== 'fb' && pos !== 'nb').map(([pos, v]) => {
        const a = v.athletes?.[0];
        return a ? { unit: label, num: jersey.get(String(a.id)) || '', name: a.displayName || '', pos: pos.replace(/\d+$/, '').toUpperCase() } : null;
    }).filter(Boolean);
    const offense = charts.find((c) => c.positions && 'qb' in c.positions);
    const defense = pick(/\bD\b|defense/i) || charts.find((c) => c.positions && ('mlb' in c.positions || 'lde' in c.positions || 'lcb' in c.positions));
    return [...unit(offense, 'Offense'), ...unit(defense, 'Defense')];
}

function nflTeam(path, teamId) {
    const key = `${path}:${teamId}`;
    const hit = teamCache.get(key);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.promise;
    const base = `https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}`;
    const entry = { at: Date.now(), promise: null };
    entry.promise = Promise.all([getJson(base + '/depthcharts'), getJson(base + '/roster')])
        .then(([d, r]) => ({ starters: nflTeamStarters(d, r), roster: nflRoster(r) }))
        .catch((err) => { teamCache.delete(key); console.warn(`[GameStats] nfl team ${key} failed: ${err.message}`); return { starters: [], roster: [] }; });
    teamCache.set(key, entry);
    return entry.promise;
}

async function nflLineups(league, summary) {
    const comps = summary.header?.competitions?.[0]?.competitors || [];
    const teams = await Promise.all(comps.map(async (c) => ({
        homeAway: c.homeAway || '',
        name: c.team?.shortDisplayName || c.team?.displayName || '',
        formation: '',
        starters: (await nflTeam(league.path, c.team?.id)).starters,
        bench: []
    })));
    return teams;
}

async function lineups(leagueKey, eventId) {
    const league = LEAGUES.find((l) => l.key === leagueKey);
    if (!league || !/^\d{1,20}$/.test(String(eventId))) return null; // only known leagues, numeric ids
    const key = `${league.key}:${eventId}`;
    const hit = lineupCache.get(key);
    if (hit && Date.now() - hit.at < LINEUP_CACHE_MS) return hit.promise;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/summary?event=${eventId}`;
    const entry = { at: Date.now(), promise: null };
    entry.promise = fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(async (d) => (league.key === 'nfl'
            ? { sport: 'football', note: 'Depth chart (projected starters)', teams: await nflLineups(league, d) }
            : { sport: league.sport, teams: buildLineups(d, league.sport) }))
        .catch((err) => {
            lineupCache.delete(key);
            console.warn(`[GameStats] lineups ${key} failed: ${err.message}`);
            return null;
        });
    lineupCache.set(key, entry);
    if (lineupCache.size > 200) lineupCache.delete(lineupCache.keys().next().value);
    return entry.promise;
}

// ---- Player search + season stats -----------------------------------------------------------------
const playersCache = new Map(); // `${leagueKey}:${eventId}` -> { at, promise }
const seasonCache = new Map();  // `${leagueKey}:${athleteId}` -> { at, promise }

async function players(leagueKey, eventId) {
    const league = LEAGUES.find((l) => l.key === leagueKey);
    if (!league || !/^\d{1,20}$/.test(String(eventId))) return null;
    const key = `${league.key}:${eventId}`;
    const hit = playersCache.get(key);
    if (hit && Date.now() - hit.at < LINEUP_CACHE_MS) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = getJson(`https://site.api.espn.com/apis/site/v2/sports/${league.path}/summary?event=${eventId}`)
        .then(async (d) => {
            const teams = boxPlayers(d, league.sport);
            if (league.key === 'nfl') { // box score only lists players with stats; add the full roster so numbers are searchable
                const comps = d.header?.competitions?.[0]?.competitors || [];
                for (const c of comps) {
                    const t = teams.find((x) => x.homeAway === c.homeAway) || (teams.push({ homeAway: c.homeAway, name: c.team?.shortDisplayName || '', players: [] }), teams[teams.length - 1]);
                    const have = new Set(t.players.map((p) => p.id));
                    for (const r of (await nflTeam(league.path, c.team?.id)).roster) if (!have.has(r.id)) t.players.push({ ...r, groups: [] });
                }
            }
            return { sport: league.sport, teams };
        })
        .catch((err) => { playersCache.delete(key); console.warn(`[GameStats] players ${key} failed: ${err.message}`); return null; });
    playersCache.set(key, entry);
    if (playersCache.size > 100) playersCache.delete(playersCache.keys().next().value);
    return entry.promise;
}

// Latest-season line from ESPN's athlete overview (not available for every league).
async function playerSeason(leagueKey, athleteId) {
    const league = LEAGUES.find((l) => l.key === leagueKey);
    if (!league || !/^\d{1,20}$/.test(String(athleteId))) return null;
    const key = `${league.key}:${athleteId}`;
    const hit = seasonCache.get(key);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = getJson(`https://site.web.api.espn.com/apis/common/v3/sports/${league.path}/athletes/${athleteId}/overview`)
        .then((o) => {
            const st = o.statistics;
            const split = st?.splits?.[0];
            return st?.labels && split ? { title: st.displayName || 'Season', split: split.displayName || '', labels: st.labels, values: split.stats } : null;
        })
        .catch(() => null);
    seasonCache.set(key, entry);
    if (seasonCache.size > 300) seasonCache.delete(seasonCache.keys().next().value);
    return entry.promise;
}

module.exports = { players, playerSeason, boxPlayers, lineups, buildLineups, nflTeamStarters, lookup, findGame, normalize, looksLikeMatchup, sportHint, LEAGUES };
