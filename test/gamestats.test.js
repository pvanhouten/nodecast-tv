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
