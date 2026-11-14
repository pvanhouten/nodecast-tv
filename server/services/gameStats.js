// Live game stats for the player overlay.
// Finds the ESPN game that a channel/stream title is about (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM")
// and returns a compact score summary. Self-contained: no dependencies beyond global fetch.
// ESPN's public scoreboard JSON is unofficial and keyless; every failure degrades to "no match".

const SOC = 'soccer football';
const LEAGUES = [
    { key: 'ncaam', sport: 'basketball', label: 'NCAAB', path: 'basketball/mens-college-basketball', query: 'groups=50&limit=400', words: 'ncaa ncaab college mens men basketball ncaam cbb' },
    { key: 'ncaaw', sport: 'basketball', label: 'NCAAW', path: 'basketball/womens-college-basketball', query: 'groups=50&limit=400', words: 'ncaa ncaaw college womens women basketball wbb' },
    { key: 'nba', sport: 'basketball', label: 'NBA', path: 'basketball/nba', query: '', words: 'nba basketball' },
    { key: 'ncaaf', sport: 'football', label: 'NCAAF', path: 'football/college-football', query: 'groups=80&limit=400', words: 'ncaa ncaaf college football cfb fbs' },
    // ESPN's college-football scoreboard is split by division: groups=80 is FBS only, FCS games (Southern Utah, ...) are groups=81.
    { key: 'ncaaf-fcs', sport: 'football', label: 'NCAAF FCS', path: 'football/college-football', query: 'groups=81&limit=400', words: 'ncaa ncaaf college football cfb fcs' },
    { key: 'nfl', sport: 'football', label: 'NFL', path: 'football/nfl', query: '', words: 'nfl football' },
    { key: 'nhl', sport: 'hockey', label: 'NHL', path: 'hockey/nhl', query: '', words: 'nhl hockey' },
    { key: 'mlb', sport: 'baseball', label: 'MLB', path: 'baseball/mlb', query: '', words: 'mlb baseball' },
    // One feed per competition so games carry a real label. Order matters: on a tie the earlier feed wins.
    ...[
        ['eng.1', 'Premier League', 'premier league epl english england'],
        ['esp.1', 'La Liga', 'laliga liga spanish spain'],
        ['ger.1', 'Bundesliga', 'bundesliga german germany'],
        ['ita.1', 'Serie A', 'serie seriea italian italy'],
        ['fra.1', 'Ligue 1', 'ligue ligue1 french france'],
        ['uefa.champions', 'Champions League', 'champions league ucl uefa'],
        ['uefa.europa', 'Europa League', 'europa league uel uefa'],
        ['uefa.europa.conf', 'Conference League', 'conference league uecl uefa'],
        ['eng.2', 'Championship', 'championship efl english england'],
        ['eng.fa', 'FA Cup', 'fa cup english england'],
        ['eng.league_cup', 'League Cup', 'carabao league cup efl english england'],
        ['ned.1', 'Eredivisie', 'eredivisie dutch netherlands holland'],
        ['por.1', 'Primeira Liga', 'primeira liga portuguese portugal'],
        ['sco.1', 'Scottish Premiership', 'scottish scotland spfl premiership'],
        ['tur.1', 'Super Lig', 'turkish turkey super lig'],
        ['bel.1', 'Pro League', 'belgian belgium pro league'],
        ['usa.1', 'MLS', 'mls'],
        ['mex.1', 'Liga MX', 'liga ligamx mx mexican mexico'],
        ['bra.1', 'Brasileirao', 'brazilian brazil brasileirao serie'],
        ['arg.1', 'Liga Profesional', 'argentine argentina liga profesional']
    ].map(([slug, label, words]) => ({ key: 'soc-' + slug, sport: 'soccer', label, path: 'soccer/' + slug, query: '', words: `${SOC} ${words}` })),
    { key: 'ncaa-soccer-m', sport: 'soccer', label: 'NCAA Soccer', path: 'soccer/usa.ncaa.m.1', query: 'limit=500', words: `ncaa college mens men ${SOC}` },
    { key: 'ncaa-soccer-w', sport: 'soccer', label: 'NCAA Soccer', path: 'soccer/usa.ncaa.w.1', query: 'limit=500', words: `ncaa college womens women ${SOC}` },
    // Everything else ESPN lists as soccer (other leagues, women's leagues, ...); last so labelled feeds win ties.
    { key: 'soccer', sport: 'soccer', label: 'Soccer', path: 'soccer/all', query: 'limit=500', words: SOC }
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
function nameScore(title, names) {
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
function teamScore(title, team) {
    return nameScore(title, [team.location, team.displayName, team.shortDisplayName].map(normalize).filter(Boolean));
}

// Short "what is happening right now" line (NFL down & distance, MLB count/runners). Best effort: absent fields
// just shorten the line, and ESPN only sends it while a game is live.
function buildSituation(comp, sport, teamAbbr) {
    const s = comp.situation;
    if (!s) return '';
    if (sport === 'football') {
        const parts = [];
        if (s.possession) parts.push(`${teamAbbr(s.possession)} ball`);
        const dd = s.downDistanceText || s.shortDownDistanceText;
        if (dd) parts.push(dd);
        if (s.isRedZone) parts.push('Red zone');
        return parts.filter(Boolean).join(' \u00b7 ');
    }
    if (sport === 'baseball') {
        const parts = [];
        if (s.balls != null && s.strikes != null) parts.push(`${s.balls}-${s.strikes}`);
        if (s.outs != null) parts.push(`${s.outs} out`);
        const r = [s.onFirst && '1st', s.onSecond && '2nd', s.onThird && '3rd'].filter(Boolean);
        parts.push(r.length === 3 ? 'bases loaded' : r.length ? `runners on ${r.join(', ')}` : 'bases empty');
        const name = (x) => x?.athlete?.shortName || x?.athlete?.displayName || '';
        if (name(s.batter)) parts.push(`AB: ${name(s.batter)}`);
        if (name(s.pitcher)) parts.push(`P: ${name(s.pitcher)}`);
        return parts.join(' \u00b7 ');
    }
    return '';
}

// Goals and cards so far (soccer scoreboard "details"), oldest first, last 8.
function soccerEvents(comp, teamAbbr) {
    return (comp.details || []).filter((d) => d.scoringPlay || d.yellowCard || d.redCard).map((d) => ({
        min: d.clock?.displayValue || '',
        kind: d.redCard ? 'red' : d.yellowCard ? 'yellow' : d.ownGoal ? 'og' : d.penaltyKick ? 'pen' : 'goal',
        player: d.athletesInvolved?.[0]?.displayName || '',
        team: teamAbbr(d.team?.id)
    })).slice(-8);
}

function summarize(event, league, meta) {
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
    const lastPlaySrc = comp.situation || {};
    const teamAbbr = (id) => comp.competitors?.find((c) => String(c.team?.id) === String(id))?.team?.abbreviation || '';
    return {
        id: String(event.id || ''),
        leagueKey: league.key,
        league: league.label,
        sport: league.sport,
        asOf: meta?.asOf || Date.now(),
        stale: !!meta?.stale,
        situation: type.state === 'in' ? buildSituation(comp, league.sport, teamAbbr) : '',
        events: league.sport === 'soccer' ? soccerEvents(comp, teamAbbr) : [],
        state: type.state || 'pre', // pre | in | post
        detail: type.shortDetail || type.detail || '',
        period: event.status?.period ?? null,
        clock: event.status?.displayClock || '',
        away,
        home,
        lastPlay: lastPlaySrc.lastPlay?.text || '',
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
    const game = best ? summarize(best.event, league, events && { asOf: events.asOf, stale: events.stale }) : null;
    return game ? { game, score: best.score } : null;
}

function looksLikeMatchup(title) {
    return /\s(@|at|vs\.?|v)\s/i.test(String(title || ''));
}

const lastGood = new Map(); // league key -> { at, events }: served (flagged stale) if ESPN fails later

function withMeta(events, at, stale) {
    const a = events.slice();
    a.asOf = at;
    a.stale = stale;
    return a;
}

async function fetchLeague(league) {
    const now = Date.now();
    const hit = cache.get(league.key);
    if (hit && now - hit.at < hit.ttl) return hit.promise;
    const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard${league.query ? '?' + league.query : ''}`;
    const entry = { at: now, ttl: CACHE_MS, promise: null };
    entry.promise = fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
            const events = d.events || [];
            lastGood.set(league.key, { at: Date.now(), events });
            return withMeta(events, Date.now(), false);
        })
        .catch((err) => {
            entry.ttl = FAIL_CACHE_MS;
            console.warn(`[GameStats] ${league.key} scoreboard failed: ${err.message}`);
            const g = lastGood.get(league.key);
            return g ? withMeta(g.events, g.at, true) : withMeta([], 0, true);
        });
    cache.set(league.key, entry);
    return entry.promise;
}

// ---- Team index ---------------------------------------------------------------------------------------
// ESPN lists each feed's teams once (/teams). Loaded at startup and refreshed daily, it tells us which
// leagues a pair of team names can possibly belong to, so a lookup fetches a handful of scoreboards
// instead of every feed. A feed with no index (soccer/all, or one whose list failed to load) is always searched,
// and with no index at all everything is searched, exactly as before.
const TEAM_INDEX_REFRESH_MS = 24 * 60 * 60_000;
const TEAM_INDEX_RETRY_MS = 2 * 60_000;
const teamIndex = new Map(); // league key -> { teams: [{ names }], words: Set<string> }
// Cup feeds list far fewer clubs than they play (lower-league sides), so one recognised team is enough.
const LOOSE_LEAGUES = new Set(['soc-eng.fa', 'soc-eng.league_cup']);
const NO_TEAM_LIST = new Set(['soccer']); // ESPN has no /teams for the soccer/all catch-all

function buildIndexEntry(teams) {
    const out = { teams: [], words: new Set() };
    for (const t of teams || []) {
        const names = [t.location, t.displayName, t.shortDisplayName].map(normalize).filter(Boolean);
        if (!names.length) continue;
        out.teams.push({ names });
        for (const n of [...names, normalize(t.abbreviation), normalize(t.name)]) for (const w of n.split(' ')) if (w) out.words.add(w);
    }
    return out.teams.length ? out : null;
}

// Pure: of `pool`, the leagues whose team list holds at least two teams named in the title (one for cup feeds),
// plus every league without an index.
function candidateLeagues(title, pool, index) {
    const t = normalize(title);
    const matched = [];
    const open = []; // leagues we cannot rule out
    for (const l of pool) {
        const entry = index.get(l.key);
        if (!entry) { open.push(l); continue; }
        const need = LOOSE_LEAGUES.has(l.key) ? 1 : 2;
        let hits = 0;
        for (const team of entry.teams) {
            if (nameScore(t, team.names) > 0 && ++hits >= need) { matched.push(l); break; }
        }
    }
    // The soccer catch-all only matters when a soccer team was recognised, or nothing was recognised at all.
    const keep = open.filter((l) => !NO_TEAM_LIST.has(l.key) || !matched.length || matched.some((m) => m.sport === l.sport));
    return pool.filter((l) => matched.includes(l) || keep.includes(l));
}

// Pure: for a manual search without league words, the leagues where every typed token starts a team word.
function searchCandidates(teamTokens, pool, index) {
    if (!teamTokens.length) return pool;
    const matched = [];
    const open = [];
    for (const l of pool) {
        const entry = index.get(l.key);
        if (!entry) { open.push(l); continue; }
        const hit = (tok) => { for (const w of entry.words) if (w.startsWith(tok)) return true; return false; };
        if (LOOSE_LEAGUES.has(l.key) ? teamTokens.some(hit) : teamTokens.every(hit)) matched.push(l);
    }
    const keep = open.filter((l) => !NO_TEAM_LIST.has(l.key) || !matched.length || matched.some((m) => m.sport === l.sport));
    return pool.filter((l) => matched.includes(l) || keep.includes(l));
}

async function loadTeams(league) {
    const q = league.query.replace(/limit=\d+/, '').replace(/&&/g, '&').replace(/^&|&$/g, '');
    const url = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/teams?${q ? q + '&' : ''}limit=1000`;
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 2) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return (d.sports?.[0]?.leagues?.[0]?.teams || []).map((x) => x.team).filter(Boolean);
}

let teamIndexTimer = null;
async function refreshTeamIndex() {
    const queue = LEAGUES.filter((l) => !NO_TEAM_LIST.has(l.key));
    const worker = async () => {
        for (let l = queue.shift(); l; l = queue.shift()) {
            try {
                const entry = buildIndexEntry(await loadTeams(l));
                if (entry) teamIndex.set(l.key, entry);
            } catch (err) {
                console.warn(`[GameStats] team list ${l.key} failed: ${err.message}`);
            }
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    console.log(`[GameStats] team index: ${teamIndex.size}/${LEAGUES.length} leagues`);
    // retry sooner if any list failed to load
    const missing = LEAGUES.filter((l) => !NO_TEAM_LIST.has(l.key) && !teamIndex.has(l.key)).length;
    teamIndexTimer = setTimeout(refreshTeamIndex, missing ? TEAM_INDEX_RETRY_MS : TEAM_INDEX_REFRESH_MS);
    teamIndexTimer.unref?.();
}
function startTeamIndex() {
    if (teamIndexTimer) return;
    teamIndexTimer = setTimeout(() => {}, 0);
    refreshTeamIndex().catch((err) => console.warn('[GameStats] team index failed:', err.message));
}

// ---- Single-team lookup ("Wrexham", "Wrexham FA Cup", "Arsenal | Champions League") -----------------
// No matchup in the text: if the channel name or program title is just one known team plus optional hint words
// (league / sport / "live" / "FC" ...), show that team's live game, else its nearest one. Anything else in the
// segment ("Boston News Tonight") disqualifies it, so a city or nickname in ordinary text cannot trigger a lookup.
const NOISE_WORDS = new Set('live hd fhd uhd sd tv game match matches channel stream sports sport fc afc cf sc ac club official et pt ct mt est pst cst'.split(' '));
const ALL_LEAGUE_WORDS = new Set(LEAGUES.flatMap((l) => l.words.split(' ')));
const isFiller = (w) => NOISE_WORDS.has(w) || ALL_LEAGUE_WORDS.has(w) || /^\d{1,4}(am|pm)?$/.test(w);

// Pure: { name, keys } where keys are the league feeds (in LEAGUES order) the team plays in and the hints allow.
function singleTeamLeagues(title, index) {
    const segments = String(title || '').split('|').slice(0, 2); // channel name, program title; never the description
    for (const seg of segments) {
        const t = normalize(seg);
        if (!t || t.split(' ').length > 8) continue;
        let best = '';
        const byName = new Map(); // matched name -> league keys
        for (const [key, entry] of index) {
            for (const team of entry.teams) {
                for (const n of team.names) {
                    if (n.length < 4 || !hasWords(t, n)) continue;
                    if (!byName.has(n)) byName.set(n, new Set());
                    byName.get(n).add(key);
                    if (n.length > best.length) best = n;
                }
            }
        }
        if (!best) continue;
        const leftover = ` ${t} `.replace(` ${best} `, ' ').trim().split(' ').filter(Boolean);
        if (!leftover.every(isFiller)) continue;
        // A sibling segment made only of filler ("NCAA mens basketball") adds its words as hints.
        const extra = segments.filter((o) => o !== seg).flatMap((o) => normalize(o).split(' ').filter(Boolean));
        const hints = [...leftover, ...(extra.length && extra.every(isFiller) ? extra : [])].filter((w) => ALL_LEAGUE_WORDS.has(w));
        // Cup feeds list only some clubs, so a hint naming one may add it even if the team list lacks the club.
        const listed = byName.get(best);
        let keys = LEAGUES.map((l) => l.key).filter((k) => listed.has(k) || (hints.length && LOOSE_LEAGUES.has(k)));
        // Hints (league / sport words) narrow the feeds; if none of the team's feeds fits the hints there is no match.
        if (hints.length) {
            const score = (k) => hints.filter((h) => LEAGUES.find((l) => l.key === k).words.split(' ').includes(h)).length;
            const top = Math.max(0, ...keys.map(score));
            keys = top ? keys.filter((k) => score(k) === top) : [];
        }
        if (keys.length) return { name: best, keys };
    }
    return null;
}

// Pure: the best game for a team among events: live first, then the one nearest in time.
function pickTeamGame(name, events, now = Date.now()) {
    let best = null;
    for (const event of events || []) {
        const comps = event.competitions?.[0]?.competitors || [];
        if (!comps.some((c) => [c.team?.location, c.team?.displayName, c.team?.shortDisplayName].map(normalize).includes(name))) continue;
        const live = event.status?.type?.state === 'in';
        const dist = Math.abs(Date.parse(event.date) - now) || 0;
        const rank = live ? -1 : dist;
        if (!best || rank < best.rank) best = { rank, event };
    }
    return best ? best.event : null;
}

async function lookupSingle(title) {
    if (!teamIndex.size) return null; // without the team list a bare word could be anything
    const hit = singleTeamLeagues(title, teamIndex);
    if (!hit) return null;
    const leagues = LEAGUES.filter((l) => hit.keys.includes(l.key));
    const lists = await Promise.all(leagues.map((l) => fetchLeague(l)));
    let best = null;
    leagues.forEach((league, i) => {
        const event = pickTeamGame(hit.name, lists[i]);
        if (!event) return;
        const live = event.status?.type?.state === 'in';
        const rank = live ? -1 : Math.abs(Date.parse(event.date) - Date.now()) || 0;
        if (!best || rank < best.rank) best = { rank, event, league, events: lists[i] };
    });
    return best ? summarize(best.event, best.league, { asOf: best.events.asOf, stale: best.events.stale }) : null;
}

async function lookup(title) {
    title = String(title || '').slice(0, 500);
    if (!looksLikeMatchup(title)) return lookupSingle(title); // a single team name, or nothing
    const sport = sportHint(title);
    const pool = sport ? LEAGUES.filter((l) => l.sport === sport) : LEAGUES;
    const leagues = candidateLeagues(title, pool, teamIndex);
    const lists = await Promise.all(leagues.map((l) => fetchLeague(l)));
    let best = null;
    leagues.forEach((league, i) => {
        const g = findGame(title, lists[i], league);
        if (g && (!best || g.score > best.score)) best = g;
    });
    return best ? best.game : null;
}

// ---- Manual game search ("ncaa mens basketball wisconsin") --------------------------------------------
// Each league lists words that name it (LEAGUES[].words). The leagues sharing the most words with the query are
// searched; the remaining words must each prefix-match a word of a team's name.
const SEARCH_STOP = new Set(['vs', 'v', 'at', 'the', 'game', 'live', 'and', 'of', 'a']);

// Pure: which leagues to search and which tokens must match team names.
function parseQuery(query) {
    const tokens = normalize(query).split(' ').filter((t) => t.length > 1 && !SEARCH_STOP.has(t)).slice(0, 8);
    const words = (l) => new Set((l.words || '').split(' '));
    const scored = LEAGUES.map((l) => ({ l, k: tokens.filter((t) => words(l).has(t)).length }));
    const maxK = scored.length ? Math.max(...scored.map((x) => x.k)) : 0;
    const leagues = scored.filter((x) => x.k === maxK).map((x) => x.l);
    const kw = new Set(maxK > 0 ? leagues.flatMap((l) => [...words(l)]) : []);
    return { leagues, teamTokens: tokens.filter((t) => !kw.has(t)), hadLeagueWords: maxK > 0 };
}

// Pure: events where every token starts a word in one of the two teams' names.
function filterEvents(teamTokens, events) {
    return (events || []).filter((e) => {
        const comps = e.competitions?.[0]?.competitors || [];
        if (comps.length !== 2) return false;
        const words = comps.flatMap((c) => [c.team?.location, c.team?.displayName, c.team?.shortDisplayName, c.team?.abbreviation, c.team?.name])
            .flatMap((n) => normalize(n).split(' ')).filter(Boolean);
        return teamTokens.every((t) => words.some((w) => w.startsWith(t)));
    });
}

async function search(query) {
    let { leagues, teamTokens, hadLeagueWords } = parseQuery(query);
    if (!teamTokens.length && !hadLeagueWords) return [];
    // Names only (no league words): every feed is a candidate, so use the team index to cut that down.
    if (!hadLeagueWords) leagues = searchCandidates(teamTokens, leagues, teamIndex);
    const lists = await Promise.all(leagues.map((l) => fetchLeague(l)));
    const out = [];
    const seen = new Set();
    leagues.forEach((league, i) => {
        for (const e of filterEvents(teamTokens, lists[i])) {
            const g = summarize(e, league, { asOf: lists[i].asOf, stale: lists[i].stale });
            if (g && !seen.has(g.id)) { seen.add(g.id); out.push(g); } // labelled feeds come first, soccer/all dupes dropped
        }
    });
    const rank = { in: 0, pre: 1, post: 2 };
    out.sort((a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3));
    return out.slice(0, 12);
}

// Refresh one pinned game (from the cached scoreboard) by league + event id.
async function gameById(leagueKey, eventId) {
    const league = LEAGUES.find((l) => l.key === leagueKey);
    if (!league || !/^\d{1,20}$/.test(String(eventId))) return null;
    const events = await fetchLeague(league);
    const event = events.find((e) => String(e.id) === String(eventId));
    return event ? summarize(event, league, { asOf: events.asOf, stale: events.stale }) : null;
}

// ---- Lineups -------------------------------------------------------------------------------------
const LINEUP_CACHE_MS = 10_000;   // matches the scoreboard cache; a spoiler delay needs fine-grained snapshots
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

// [label, value] plus ESPN's own description of the stat when it has one (shown as a tooltip by the overlay).
function withDesc(pair, desc) {
    return desc && String(desc).trim() ? [...pair, String(desc).trim()] : pair;
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
                        .map((x) => withDesc([x.shortDisplayName || x.abbreviation || x.displayName, x.displayValue], x.displayName || x.description)) }]
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
                p.groups.push({ title, stats: (block.labels || []).map((l, i) => withDesc([l, (a.stats || [])[i]], (block.descriptions || [])[i])).filter(([, v]) => v != null && v !== '') });
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

// College football: ESPN has no depth chart and no starting lineup, so show who has played (box score) grouped
// by unit, plus the rest of the roster. Before kickoff nobody has played, so the roster itself is listed.
const COLLEGE_FOOTBALL = new Set(['ncaaf', 'ncaaf-fcs']);
const POS_ORDER = ['QB', 'RB', 'FB', 'WR', 'TE', 'OL', 'OT', 'OG', 'C', 'T', 'G', 'DL', 'DE', 'DT', 'NT', 'LB', 'OLB', 'ILB', 'MLB', 'DB', 'CB', 'S', 'FS', 'SS', 'K', 'PK', 'P', 'LS', 'KR', 'PR', 'ATH'];
const OFFENSE = new Set(['QB', 'RB', 'FB', 'WR', 'TE', 'OL', 'OT', 'OG', 'C', 'T', 'G']);
const DEFENSE = new Set(['DL', 'DE', 'DT', 'NT', 'LB', 'OLB', 'ILB', 'MLB', 'DB', 'CB', 'S', 'FS', 'SS']);
const SPECIAL = new Set(['K', 'PK', 'P', 'LS', 'KR', 'PR']);
const unitOf = (pos) => (OFFENSE.has(pos) ? 'Offense' : DEFENSE.has(pos) ? 'Defense' : SPECIAL.has(pos) ? 'Special teams' : 'Other');
const UNIT_ORDER = ['Offense', 'Defense', 'Special teams', 'Other'];
const posRank = (pos) => { const i = POS_ORDER.indexOf(pos); return i < 0 ? 99 : i; };

function collegeRoster(path, teamId) {
    const key = `roster:${path}:${teamId}`;
    const hit = teamCache.get(key);
    if (hit && Date.now() - hit.at < TEAM_CACHE_MS) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = getJson(`https://site.api.espn.com/apis/site/v2/sports/${path}/teams/${teamId}/roster`)
        .then((r) => nflRoster(r))
        .catch((err) => { teamCache.delete(key); console.warn(`[GameStats] roster ${key} failed: ${err.message}`); return []; });
    teamCache.set(key, entry);
    return entry.promise;
}

// Pure (exported for tests): played = boxPlayers() entries, roster = nflRoster() entries.
function collegeTeamLineup(played, roster) {
    // The box score has no position (and sometimes no number) for college players: take them from the roster by id.
    const byId = new Map(roster.map((r) => [r.id, r]));
    const row = (p) => { const r = byId.get(p.id) || {}; const pos = p.pos || r.pos || ''; return { unit: unitOf(pos), num: p.num || r.num || '', name: p.name, pos }; };
    const order = (a, b) => UNIT_ORDER.indexOf(a.unit) - UNIT_ORDER.indexOf(b.unit) || posRank(a.pos) - posRank(b.pos)
        || (parseInt(a.num, 10) || 999) - (parseInt(b.num, 10) || 999);
    const playedRows = played.map(row).sort(order);
    if (!playedRows.length) return { starters: roster.map(row).sort(order), bench: [], rosterOnly: true };
    const seen = new Set(played.map((p) => p.id));
    const rest = roster.filter((p) => !seen.has(p.id)).map(row).sort(order);
    return { starters: playedRows, bench: rest, rosterOnly: false };
}

async function collegeLineups(league, summary) {
    const box = boxPlayers(summary, 'football');
    const comps = summary.header?.competitions?.[0]?.competitors || [];
    return Promise.all(comps.map(async (c) => {
        const played = (box.find((t) => t.homeAway === c.homeAway) || { players: [] }).players;
        const lu = collegeTeamLineup(played, await collegeRoster(league.path, c.team?.id));
        return { homeAway: c.homeAway || '', name: c.team?.shortDisplayName || c.team?.displayName || '', formation: '',
            starters: lu.starters, bench: lu.bench, benchLabel: 'Rest of roster', note: lu.rosterOnly ? 'roster' : 'played' };
    }));
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
        .then(async (d) => {
            if (league.key === 'nfl') return { sport: 'football', note: 'Depth chart (projected starters)', teams: await nflLineups(league, d) };
            if (COLLEGE_FOOTBALL.has(league.key)) {
                const teams = await collegeLineups(league, d);
                return { sport: 'football', teams, note: teams.length && teams.every((t) => t.note === 'roster')
                    ? 'Roster by position: ESPN publishes no college starting lineup and nobody has played yet'
                    : 'Players who have played so far, by unit (ESPN publishes no college starting lineup); the rest of the roster is below' };
            }
            return { sport: league.sport, teams: buildLineups(d, league.sport) };
        })
        .catch((err) => {
            lineupCache.delete(key);
            console.warn(`[GameStats] lineups ${key} failed: ${err.message}`);
            return null;
        });
    lineupCache.set(key, entry);
    if (lineupCache.size > 200) lineupCache.delete(lineupCache.keys().next().value);
    return entry.promise;
}

// ---- Win probability, spread and team stats (from the game summary) ---------------------------------------
const STAT_SETS = {
    basketball: [['fieldGoalPct', 'FG%'], ['threePointFieldGoalPct', '3P%'], ['freeThrowPct', 'FT%'], ['totalRebounds', 'REB'], ['assists', 'AST'], ['turnovers', 'TO'], ['steals', 'STL'], ['blocks', 'BLK']],
    football: [['totalYards', 'Total yds'], ['netPassingYards', 'Pass yds'], ['rushingYards', 'Rush yds'], ['firstDowns', '1st downs'], ['thirdDownEff', '3rd down'], ['turnovers', 'Turnovers'], ['possessionTime', 'Possession']],
    hockey: [['shotsTotal', 'Shots'], ['hits', 'Hits'], ['blockedShots', 'Blocks'], ['powerPlayGoals', 'PP goals'], ['faceoffPercent', 'FO%'], ['takeaways', 'Takeaways'], ['giveaways', 'Giveaways']],
    soccer: [['possessionPct', 'Possession'], ['totalShots', 'Shots'], ['shotsOnTarget', 'On target'], ['wonCorners', 'Corners'], ['foulsCommitted', 'Fouls'], ['yellowCards', 'Yellow'], ['redCards', 'Red'], ['offsides', 'Offsides'], ['saves', 'Saves']]
};

// Pure: { winProb, spread, teamStats } from an ESPN summary. Anything missing is null.
function buildExtra(summary, sport) {
    let winProb = null;
    const wp = summary.winprobability;
    if (Array.isArray(wp) && wp.length) {
        const last = wp[wp.length - 1];
        if (typeof last.homeWinPercentage === 'number') {
            const home = last.homeWinPercentage, tie = last.tiePercentage || 0;
            winProb = { home, away: Math.max(0, 1 - home - tie) };
        }
    }
    const pc = summary.pickcenter?.[0];
    const spread = pc && (pc.details || pc.overUnder != null) ? { text: pc.details || '', overUnder: pc.overUnder ?? null } : null;

    let teamStats = null;
    const set = STAT_SETS[sport];
    const teams = summary.boxscore?.teams || [];
    if (set && teams.length === 2) {
        const away = teams.find((t) => t.homeAway === 'away') || teams[0];
        const home = teams.find((t) => t.homeAway === 'home') || teams[1];
        const get = (t, name) => (t.statistics || []).find((x) => x.name === name);
        const fmt = (name, st) => {
            const v = st?.displayValue;
            if (v == null || v === '') return null;
            return /Pct$|Percent$/.test(name) && !String(v).includes('%') ? v + '%' : v;
        };
        const rows = set.map(([name, label]) => ({ label, away: fmt(name, get(away, name)), home: fmt(name, get(home, name)) }))
            .filter((r) => r.away != null && r.home != null);
        if (rows.length) teamStats = { away: away.team?.abbreviation || away.team?.shortDisplayName || '', home: home.team?.abbreviation || home.team?.shortDisplayName || '', rows };
    }
    return { winProb, spread, teamStats };
}

const extraCache = new Map();
async function extra(leagueKey, eventId) {
    const league = LEAGUES.find((l) => l.key === leagueKey);
    if (!league || !/^\d{1,20}$/.test(String(eventId))) return null;
    const key = `${league.key}:${eventId}`;
    const hit = extraCache.get(key);
    if (hit && Date.now() - hit.at < LINEUP_CACHE_MS) return hit.promise;
    const entry = { at: Date.now(), promise: null };
    entry.promise = getJson(`https://site.api.espn.com/apis/site/v2/sports/${league.path}/summary?event=${eventId}`)
        .then((d) => buildExtra(d, league.sport))
        .catch((err) => { extraCache.delete(key); console.warn(`[GameStats] extra ${key} failed: ${err.message}`); return null; });
    extraCache.set(key, entry);
    if (extraCache.size > 100) extraCache.delete(extraCache.keys().next().value);
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
            if (league.key === 'nfl' || COLLEGE_FOOTBALL.has(league.key)) { // box score only lists players with stats; add the full roster so numbers are searchable
                const comps = d.header?.competitions?.[0]?.competitors || [];
                for (const c of comps) {
                    const t = teams.find((x) => x.homeAway === c.homeAway) || (teams.push({ homeAway: c.homeAway, name: c.team?.shortDisplayName || '', players: [] }), teams[teams.length - 1]);
                    const have = new Set(t.players.map((p) => p.id));
                    const roster = league.key === 'nfl' ? (await nflTeam(league.path, c.team?.id)).roster : await collegeRoster(league.path, c.team?.id);
                    for (const r of roster) if (!have.has(r.id)) t.players.push({ ...r, groups: [] });
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

module.exports = { singleTeamLeagues, pickTeamGame, lookupSingle, startTeamIndex, buildIndexEntry, candidateLeagues, searchCandidates, teamIndex, extra, buildExtra, buildSituation, soccerEvents, search, gameById, parseQuery, filterEvents, players, playerSeason, boxPlayers, lineups, buildLineups, nflTeamStarters, collegeTeamLineup, lookup, findGame, normalize, looksLikeMatchup, sportHint, LEAGUES };
