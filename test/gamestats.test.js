const test = require('node:test');
const assert = require('node:assert');
const { findGame, looksLikeMatchup, normalize, LEAGUES } = require('../server/services/gameStats');

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
