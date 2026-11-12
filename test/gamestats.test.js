const test = require('node:test');
const assert = require('node:assert');
const gs = require('../server/services/gameStats');
const { looksLikeMatchup, normalize, sportHint, LEAGUES } = gs;
const findGame = (...a) => gs.findGame(...a)?.game ?? null;

const team = (location, name, extra = {}) => ({
    homeAway: extra.homeAway, score: extra.score ?? '0',
    team: { location, name, displayName: `${location} ${name}`, shortDisplayName: location, abbreviation: location.slice(0, 4).toUpperCase() }
});
const ev = (home, away, state = 'in', detail = 'Halftime') => ({
    competitions: [{ competitors: [{ ...home, homeAway: 'home' }, { ...away, homeAway: 'away' }] }],
    status: { type: { state, shortDetail: detail }, displayClock: '0:00', period: 2 },
    links: [{ rel: ['summary'], href: 'https://espn.example/game' }]
});
const league = LEAGUES[0];

test('matches an NCAAB channel name to its game', () => {
    const events = [
        ev(team('Rutgers', 'Scarlet Knights'), team('NJIT', 'Highlanders')),
        ev(team('Wisconsin', 'Badgers', { score: '20' }), team('Fairfield', 'Stags', { score: '52' }))
    ];
    const g = findGame('NCAAB 6 Fairfield @ Wisconsin 8PM', events, league);
    assert.equal(g.home.name, 'Wisconsin');
    assert.equal(g.away.score, '52');
    assert.equal(g.detail, 'Halftime');
    assert.equal(g.link, 'https://espn.example/game');
});

test('matches the Dazn-style title too', () => {
    const events = [ev(team('Wisconsin', 'Badgers'), team('Fairfield', 'Stags'))];
    assert.ok(findGame('(CA) Dazn  15: NCAA Mens Basketball: Fairfield @ Wisconsin Nov 10 08:30 PM', events, league));
});

test('both teams must appear; one team alone is not a match', () => {
    const events = [ev(team('Wisconsin', 'Badgers'), team('Fairfield', 'Stags'))];
    assert.equal(findGame('NCAAB 1 NJIT @ Rutgers 6pm', events, league), null);
    assert.equal(findGame('NCAAB 6 Purdue @ Wisconsin', events, league), null);
});

test('prefers the longer team name (Michigan State vs Michigan)', () => {
    const events = [
        ev(team('Purdue', 'Boilermakers'), team('Michigan', 'Wolverines')),
        ev(team('Purdue', 'Boilermakers'), team('Michigan State', 'Spartans'))
    ];
    const g = findGame('NCAAB 3 Michigan State @ Purdue 7PM', events, league);
    assert.equal(g.away.name, 'Michigan State');
});

test('empty slots and non-matchups are ignored', () => {
    assert.equal(looksLikeMatchup('NCAAB 34'), false);
    assert.equal(looksLikeMatchup('NCAAB 6 Fairfield @ Wisconsin 8PM'), true);
    assert.equal(looksLikeMatchup('Wisconsin vs. Purdue (2026-11-21)'), true);
    assert.equal(findGame('NCAAB 34', [ev(team('Wisconsin', 'Badgers'), team('Fairfield', 'Stags'))], league), null);
    assert.equal(normalize('Texas A&M'), 'texas a and m');
});

test('soccer: abbreviations, FC prefixes and diacritics still match', () => {
    const soccer = LEAGUES.find((l) => l.key === 'soccer');
    const t2 = (loc, short, disp) => ({ location: loc, displayName: disp || loc, shortDisplayName: short || loc });
    const mk = (h, a) => ({ competitions: [{ competitors: [{ homeAway: 'home', score: '1', team: h }, { homeAway: 'away', score: '2', team: a }] }], status: { type: { state: 'in', shortDetail: "67'" } } });
    const events = [
        mk(t2('Paris Saint-Germain', 'PSG'), t2('Bayern Munich', 'Bayern Munich')),
        mk(t2('Real Madrid'), t2('Paris FC'))
    ];
    const g = findGame('US (ESPN+ 046) | Soccer: PSG vs. FC Bayern (ESP) (PSG vs. FC Bayern (ESP)) (2026-11-10 14:45:10)', events, soccer);
    assert.equal(g.home.name, 'PSG');
    assert.equal(g.detail, "67'");
    assert.ok(findGame('Soccer: Real Madrid vs. Paris FC (ESP)', events, soccer));
    assert.equal(normalize('Bayern M\u00fcnchen'), 'bayern munchen');
    assert.equal(normalize('Man Utd'), 'manchester united');
});

test('sport hints keep a soccer title out of basketball', () => {
    assert.equal(sportHint('US (ESPN+ 191) | Soccer: Arkansas vs. Kentucky'), 'soccer');
    assert.equal(sportHint('NCAAB 6 Fairfield @ Wisconsin 8PM'), 'basketball');
    assert.equal(sportHint('(CA) Dazn 03: Basketball Champions League: A vs B'), 'basketball');
    assert.equal(sportHint('Arsenal vs Chelsea'), null);
});

test('lineups: soccer starters ordered by formation place, subs flagged', () => {
    const r = (homeAway, name, players) => ({ homeAway, formation: '4-3-3', team: { shortDisplayName: name }, roster: players });
    const pl = (jersey, n, starter, place, extra = {}) => ({ jersey, starter, formationPlace: place, athlete: { displayName: n }, position: { abbreviation: starter ? 'X' : 'SUB' }, ...extra });
    const out = gs.buildLineups({ rosters: [r('home', 'PSG', [pl('9', 'Striker', true, 9), pl('1', 'Keeper', true, 1, { subbedOut: true }), pl('20', 'Sub', false, 0, { subbedIn: true })])] }, 'soccer');
    assert.equal(out[0].formation, '4-3-3');
    assert.deepEqual(out[0].starters.map((p) => p.num), ['1', '9']);
    assert.equal(out[0].starters[0].out, true);
    assert.equal(out[0].bench[0].in, true);
});

test('lineups: basketball starters/bench with stat line; DNP hidden', () => {
    const a = (n, num, starter, st, dnp = false) => ({ starter, didNotPlay: dnp, stats: st, athlete: { displayName: n, jersey: num, position: { abbreviation: 'G' } } });
    const summary = { header: { competitions: [{ competitors: [{ id: '7', homeAway: 'home' }] }] },
        boxscore: { players: [{ team: { id: '7', shortDisplayName: 'Wisconsin' }, statistics: [{ labels: ['MIN', 'PTS', 'REB', 'AST'], athletes: [
            a('Starter', '3', true, ['30', '14', '6', '3']), a('Bench', '11', false, ['5', '2', '0', '0']), a('Idle', '99', false, [], true)] }] }] } };
    const [t] = gs.buildLineups(summary, 'basketball');
    assert.equal(t.homeAway, 'home');
    assert.equal(t.starters[0].stat, '14 pts, 6 reb, 3 ast');
    assert.deepEqual(t.bench.map((p) => p.name), ['Bench']);
});

test('lineups: unsupported sports return nothing; bad ids/leagues rejected', async () => {
    assert.deepEqual(gs.buildLineups({}, 'hockey'), []);
    assert.equal(await gs.lineups('../etc', '1'), null);
    assert.equal(await gs.lineups('soccer', '1/../../x'), null);
});

test('lineups: NFL depth chart joined with roster jersey numbers', () => {
    const depth = { depthchart: [
        { name: '3WR 1TE', positions: { qb: { athletes: [{ id: '1', displayName: 'Starting QB' }, { id: '2', displayName: 'Backup' }] }, wr1: { athletes: [{ id: '3', displayName: 'Wide Out' }] } } },
        { name: 'Base 4-3 D', positions: { lde: { athletes: [{ id: '4', displayName: 'Edge' }] } } }
    ] };
    const roster = { athletes: [{ items: [{ id: '1', jersey: '8' }, { id: '3', jersey: '81' }, { id: '4', jersey: '97' }] }] };
    const out = gs.nflTeamStarters(depth, roster);
    assert.deepEqual(out.map((p) => [p.unit, p.pos, p.num, p.name]), [
        ['Offense', 'QB', '8', 'Starting QB'], ['Offense', 'WR', '81', 'Wide Out'], ['Defense', 'LDE', '97', 'Edge']]);
});

test('players: box score merges stat groups per athlete (NFL-style)', () => {
    const ath = (id, n, jersey) => ({ athlete: { id, displayName: n, jersey, position: { abbreviation: 'QB' } }, stats: ['16/26', '242'] });
    const summary = { header: { competitions: [{ competitors: [{ id: '33', homeAway: 'home' }] }] },
        boxscore: { players: [{ team: { id: '33', shortDisplayName: 'Ravens' }, statistics: [
            { name: 'passing', labels: ['C/ATT', 'YDS'], athletes: [ath('1', 'Lamar', '8')] },
            { name: 'rushing', labels: ['CAR', 'YDS'], athletes: [{ athlete: { id: '1', displayName: 'Lamar', jersey: '8' }, stats: ['7', '50'] }] }] }] } };
    const [t] = gs.boxPlayers(summary, 'football');
    assert.equal(t.homeAway, 'home');
    assert.equal(t.players.length, 1);
    assert.deepEqual(t.players[0].groups.map((g) => g.title), ['Passing', 'Rushing']);
    assert.deepEqual(t.players[0].groups[1].stats, [['CAR', '7'], ['YDS', '50']]);
});

test('players: soccer drops zero stats; bad ids rejected', async () => {
    const summary = { rosters: [{ homeAway: 'away', team: { shortDisplayName: 'PSG' }, roster: [{ jersey: '10', starter: true, athlete: { id: '5', displayName: 'Ace' }, position: { abbreviation: 'F' },
        stats: [{ shortDisplayName: 'G', displayValue: '2' }, { shortDisplayName: 'YC', displayValue: '0' }] }] }] };
    const [t] = gs.boxPlayers(summary, 'soccer');
    assert.deepEqual(t.players[0].groups[0].stats, [['G', '2']]);
    assert.equal(await gs.players('nope', '1'), null);
    assert.equal(await gs.playerSeason('nfl', '1;x'), null);
});

test('lineups: hockey lists skaters and goalies by unit', () => {
    const summary = { header: { competitions: [{ competitors: [{ id: '4', homeAway: 'away' }] }] },
        boxscore: { players: [{ team: { id: '4', shortDisplayName: 'Avalanche' }, statistics: [
            { name: 'forwards', labels: ['G', 'A'], athletes: [{ athlete: { id: '9', displayName: 'Winger', jersey: '13', position: { abbreviation: 'RW' } }, stats: ['1', '2'] }] },
            { name: 'goalies', labels: ['SV%'], athletes: [{ athlete: { id: '8', displayName: 'Goalie', jersey: '39', position: { abbreviation: 'G' } }, stats: ['.903'] }] }] }] } };
    const [t] = gs.buildLineups(summary, 'hockey');
    assert.deepEqual(t.starters.map((p) => [p.unit, p.num, p.stat]), [['Forwards', '13', '1 G, 2 A'], ['Goalies', '39', '.903 SV%']]);
});

test('EPG program title with the matchup is enough (generic channel name)', () => {
    const events = [ev(team('Kansas State', 'Wildcats'), team('Creighton', 'Bluejays')),
                    ev(team('Kansas', 'Jayhawks'), team('Kentucky', 'Wildcats'))];
    const text = 'Fox Sports 1 | College Basketball : Creighton at Kansas State \u1d38\u1da6\u1d5b\u1d49 | From Bramlage Coliseum in Mahnattan, Kan.';
    const g = findGame(text, events, league);
    assert.equal(g.home.name, 'Kansas State');
    assert.equal(g.away.name, 'Creighton');
    assert.equal(sportHint(text), 'basketball');
    assert.equal(looksLikeMatchup(text), true);
    assert.equal(findGame('Fox Sports 1 | The Herd with Colin Cowherd', events, league), null);
});

test('manual search: league words pick the league, the rest must match team names', () => {
    let q = gs.parseQuery('ncaa mens basketball wisconsin');
    assert.deepEqual(q.leagues.map((l) => l.key), ['ncaam']);
    assert.deepEqual(q.teamTokens, ['wisconsin']);
    q = gs.parseQuery("NCAA men's basketball Wisc");
    assert.deepEqual(q.leagues.map((l) => l.key), ['ncaam']);
    assert.deepEqual(q.teamTokens, ['wisc']);
    q = gs.parseQuery('womens soccer duke');
    assert.deepEqual(q.leagues.map((l) => l.key), ['ncaa-soccer-w']);
    q = gs.parseQuery('wisconsin');
    assert.equal(q.leagues.length, LEAGUES.length);          // no league words: search everything
    assert.deepEqual(q.teamTokens, ['wisconsin']);
    q = gs.parseQuery('nba');
    assert.deepEqual([q.leagues.map((l) => l.key), q.teamTokens], [['nba'], []]);
});

test('manual search: events filtered by prefix-matching team words', () => {
    const events = [ev(team('Wisconsin', 'Badgers'), team('Fairfield', 'Stags')), ev(team('Purdue', 'Boilermakers'), team('Iowa', 'Hawkeyes'))];
    assert.equal(gs.filterEvents(['wisc'], events).length, 1);
    assert.equal(gs.filterEvents(['wisconsin', 'fairfield'], events).length, 1);
    assert.equal(gs.filterEvents(['wisconsin', 'iowa'], events).length, 0);
    assert.equal(gs.filterEvents([], events).length, 2);
});

test('manual search/pin: bad league or event id rejected', async () => {
    assert.equal(await gs.gameById('nope', '1'), null);
    assert.equal(await gs.gameById('nfl', '1;x'), null);
});

test('situation: NFL down & distance + possession; MLB count/outs/runners; nothing when absent', () => {
    const comp = { competitors: [{ team: { id: '1', abbreviation: 'BAL' } }, { team: { id: '2', abbreviation: 'JAX' } }] };
    const abbr = (id) => comp.competitors.find((c) => c.team.id === id)?.team.abbreviation || '';
    assert.equal(gs.buildSituation({ situation: { possession: '1', downDistanceText: '2nd & 7 at JAX 35', isRedZone: false } }, 'football', abbr), 'BAL ball · 2nd & 7 at JAX 35');
    assert.equal(gs.buildSituation({ situation: { possession: '2', shortDownDistanceText: '1st & 10', isRedZone: true } }, 'football', abbr), 'JAX ball · 1st & 10 · Red zone');
    assert.equal(gs.buildSituation({ situation: { balls: 2, strikes: 1, outs: 1, onFirst: true, onThird: true, batter: { athlete: { shortName: 'J. Chourio' } } } }, 'baseball', abbr),
        '2-1 · 1 out · runners on 1st, 3rd · AB: J. Chourio');
    assert.equal(gs.buildSituation({ situation: { balls: 0, strikes: 0, outs: 0, onFirst: true, onSecond: true, onThird: true } }, 'baseball', abbr), '0-0 · 0 out · bases loaded');
    assert.equal(gs.buildSituation({}, 'football', abbr), '');
    assert.equal(gs.buildSituation({ situation: { lastPlay: {} } }, 'basketball', abbr), '');
});

test('soccer events: goals and cards only, own goals/pens tagged, last 8', () => {
    const abbr = (id) => ({ 9: 'RMA', 7: 'AEK' }[id] || '');
    const d = (min, extra, id = '9', who = 'Player') => ({ clock: { displayValue: min }, team: { id }, athletesInvolved: [{ displayName: who }], ...extra });
    const comp = { details: [d("12'", { scoringPlay: true }, '7', 'Koita'), d("20'", { scoringPlay: false }), d("34'", { yellowCard: true }, '7'),
        d("50'", { scoringPlay: true, penaltyKick: true }), d("60'", { scoringPlay: true, ownGoal: true }), d("70'", { redCard: true })] };
    const ev = gs.soccerEvents(comp, abbr);
    assert.deepEqual(ev.map((e) => [e.min, e.kind, e.team]), [["12'", 'goal', 'AEK'], ["34'", 'yellow', 'AEK'], ["50'", 'pen', 'RMA'], ["60'", 'og', 'RMA'], ["70'", 'red', 'RMA']]);
    assert.equal(ev[0].player, 'Koita');
    const many = { details: Array.from({ length: 12 }, (_, i) => d(`${i}'`, { scoringPlay: true })) };
    assert.equal(gs.soccerEvents(many, abbr).length, 8);
});

test('extra: win probability, line and team stats from a summary', () => {
    const stat = (name, displayValue) => ({ name, displayValue });
    const summary = {
        winprobability: [{ homeWinPercentage: 0.4, tiePercentage: 0 }, { homeWinPercentage: 0.75, tiePercentage: 0 }],
        pickcenter: [{ details: 'PHX -3.5', overUnder: 224.5 }],
        boxscore: { teams: [
            { homeAway: 'away', team: { abbreviation: 'LAC' }, statistics: [stat('fieldGoalPct', '40'), stat('totalRebounds', '33'), stat('assists', '21')] },
            { homeAway: 'home', team: { abbreviation: 'PHX' }, statistics: [stat('fieldGoalPct', '53'), stat('totalRebounds', '41'), stat('assists', '26')] }] }
    };
    const x = gs.buildExtra(summary, 'basketball');
    assert.deepEqual(x.winProb, { home: 0.75, away: 0.25 });
    assert.deepEqual(x.spread, { text: 'PHX -3.5', overUnder: 224.5 });
    assert.equal(x.teamStats.away, 'LAC');
    assert.deepEqual(x.teamStats.rows[0], { label: 'FG%', away: '40%', home: '53%' });
    assert.deepEqual(x.teamStats.rows.map((r) => r.label), ['FG%', 'REB', 'AST']);
    const none = gs.buildExtra({}, 'soccer');
    assert.deepEqual(none, { winProb: null, spread: null, teamStats: null });
    const soc = gs.buildExtra({ boxscore: { teams: [{ homeAway: 'home', team: { abbreviation: 'A' }, statistics: [stat('possessionPct', '56.5')] }, { homeAway: 'away', team: { abbreviation: 'B' }, statistics: [stat('possessionPct', '43.5')] }] } }, 'soccer');
    assert.deepEqual(soc.teamStats.rows[0], { label: 'Possession', away: '43.5%', home: '56.5%' });
});

test('soccer competitions are separate labelled feeds; league words route searches', () => {
    const labels = (q) => gs.parseQuery(q).leagues.map((l) => l.label);
    assert.deepEqual(labels('premier league'), ['Premier League']);
    assert.deepEqual(labels('champions league arsenal'), ['Champions League']);
    assert.ok(labels('soccer arsenal').includes('Premier League') && labels('soccer arsenal').includes('Soccer'));
    assert.deepEqual(gs.parseQuery('premier league arsenal').teamTokens, ['arsenal']);
    // labelled feeds precede the catch-all so they win ties
    const keys = LEAGUES.map((l) => l.key);
    assert.ok(keys.indexOf('soc-eng.1') < keys.indexOf('soccer'));
    assert.equal(keys[keys.length - 1], 'soccer');
});

test('team index narrows which leagues a lookup or search has to fetch', () => {
    const mk = (...names) => gs.buildIndexEntry(names.map((n) => ({ location: n, displayName: n + ' X', shortDisplayName: n, abbreviation: n.slice(0, 3), name: 'X' })));
    const index = new Map([
        ['nba', mk('Miami', 'Utah', 'Boston')],
        ['nfl', mk('Green Bay', 'Chicago', 'Miami')],
        ['ncaam', mk('Wisconsin', 'Fairfield', 'Utah')],
        ['soc-eng.1', mk('Arsenal', 'Chelsea')],
        ['soc-eng.fa', mk('Arsenal', 'Luton')]
    ]);
    const keys = (title, pool = LEAGUES) => gs.candidateLeagues(title, pool, index).map((l) => l.key);
    // both teams must exist in a league; unindexed leagues (e.g. ncaaw here) stay in play
    const k1 = keys('Miami at Utah');
    assert.ok(!k1.includes('ncaam') && !k1.includes('nfl') && k1.includes('nba')); // ncaam holds only Utah
    // a recognised soccer team keeps the soccer catch-all; a recognised non-soccer pair drops it
    assert.ok(keys('Arsenal vs Chelsea').includes('soccer'));
    assert.ok(!keys('Miami at Utah').includes('soccer'));
    // cup feeds only need one recognised club (lower-league opponents are not in their list)
    assert.ok(keys('Arsenal v Nobodytown United').includes('soc-eng.fa'));
    assert.ok(!keys('Arsenal v Nobodytown United').includes('soc-eng.1'));
    // nothing recognised at all -> only the catch-all and unindexed leagues
    const none = keys('Zzyzx vs Qwerty');
    assert.ok(none.includes('soccer') && !none.includes('nba'));
    // no index at all -> everything, exactly as before
    assert.equal(gs.candidateLeagues('Miami at Utah', LEAGUES, new Map()).length, LEAGUES.length);
    // manual search by names only
    const sk = (toks) => gs.searchCandidates(toks, LEAGUES, index).map((l) => l.key);
    assert.ok(sk(['wisc']).includes('ncaam') && !sk(['wisc']).includes('nba'));
    assert.ok(sk(['miami']).includes('nba') && sk(['miami']).includes('nfl'));
    assert.ok(!sk(['miami', 'utah']).includes('nfl')); // every token must start a team word in the league
    assert.ok(!sk(['wisc']).includes('soccer'));
});

test('single team name (plus optional hints) resolves to leagues; ordinary text does not', () => {
    const mk = (...names) => gs.buildIndexEntry(names.map((n) => ({ location: n, displayName: n + ' X', shortDisplayName: n, abbreviation: n.slice(0, 3), name: 'X' })));
    const index = new Map([
        ['nba', mk('Miami', 'Utah')],
        ['nfl', mk('Miami', 'Chicago')],
        ['soc-eng.2', mk('Wrexham', 'Leeds')],
        ['soc-eng.league_cup', mk('Wrexham')],
        ['soc-eng.fa', mk('Arsenal')]
    ]);
    const one = (t) => gs.singleTeamLeagues(t, index);
    assert.deepEqual(one('Wrexham'), { name: 'wrexham', keys: ['soc-eng.2', 'soc-eng.league_cup'] });
    assert.equal(one('Wrexham AFC | Live').name, 'wrexham'); // filler words are fine
    assert.deepEqual(one('Wrexham | Championship').keys, ['soc-eng.2']); // hint in the same text or the other segment
    assert.deepEqual(one('Wrexham | League Cup').keys, ['soc-eng.league_cup']);
    assert.deepEqual(one('Miami NBA').keys, ['nba']);
    assert.deepEqual(one('Miami').keys, ['nba', 'nfl']); // ambiguous without a hint: every feed it plays in
    // cup hint adds a cup feed even when its (partial) team list lacks the club
    assert.deepEqual(one('Wrexham FA Cup').keys, ['soc-eng.fa']);
    // hint contradicting the team's feeds, or ordinary words around a city name: no match
    assert.equal(one('Wrexham NBA'), null);
    assert.equal(one('Miami Vice Marathon'), null);
    assert.equal(one('CNN | Miami Weather Report'), null);
    // the description (third segment) is never used
    assert.equal(one('Cooking Show | Dinner at 8 | Tonight Miami joins us'), null);
    assert.equal(one(''), null);
});

test('team game pick: live first, otherwise nearest in time', () => {
    const now = Date.parse('2026-11-11T12:00:00Z');
    const e = (state, date, home = 'Wrexham') => ({ date, status: { type: { state } }, competitions: [{ competitors: [{ team: { location: home, displayName: home } }, { team: { location: 'Other', displayName: 'Other' } }] }] });
    const live = e('in', '2026-11-11T11:00:00Z');
    const nearFinal = e('post', '2026-11-11T09:00:00Z');
    const farPre = e('pre', '2026-11-14T15:00:00Z');
    assert.equal(gs.pickTeamGame('wrexham', [farPre, nearFinal, live], now), live);
    assert.equal(gs.pickTeamGame('wrexham', [farPre, nearFinal], now), nearFinal);
    assert.equal(gs.pickTeamGame('wrexham', [e('in', '2026-11-11T11:00:00Z', 'Leeds')], now), null);
});

test('players: ESPN stat descriptions ride along as a third element (only when ESPN sends one)', () => {
    const summary = { boxscore: { players: [{ team: { id: '1', shortDisplayName: 'A' }, statistics: [{
        labels: ['PTS', 'OREB'], descriptions: ['Points', ''], athletes: [{ athlete: { id: '9', displayName: 'X Y', jersey: '3' }, stats: ['10', '2'] }] }] }] } };
    const [t] = gs.boxPlayers(summary, 'basketball');
    assert.deepEqual(t.players[0].groups[0].stats, [['PTS', '10', 'Points'], ['OREB', '2']]);
});
