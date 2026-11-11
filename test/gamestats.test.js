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
