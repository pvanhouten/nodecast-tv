const test = require('node:test');
const assert = require('node:assert');
const gw = require('../server/services/gamewatchActive');

const now = 1_000_000;
const entry = (over = {}) => ({ userId: 7, username: 'sam', label: 'Fox Sports 1', startTime: now - 90_000, lastAccess: now - 2000, idleMs: 2000, ...over });

test('an active entry with a fresh report becomes a row with the reported channel and programme', () => {
    const reports = new Map();
    gw.record({ userId: 7, username: 'sam', channel: 'Fox Sports 1', title: 'College Basketball: Creighton at Kansas State' }, now - 5000, reports);
    const rows = gw.buildActive({ entries: [entry()], reports, now });
    assert.deepEqual(rows, [{ user: 'sam', channel: 'Fox Sports 1', title: 'College Basketball: Creighton at Kansas State', since: now - 90_000 }]);
});

test('without a report the stream label is the channel and the title is empty; a stale report is ignored', () => {
    const reports = new Map();
    assert.deepEqual(gw.buildActive({ entries: [entry()], reports, now }), [{ user: 'sam', channel: 'Fox Sports 1', title: '', since: now - 90_000 }]);
    gw.record({ userId: 7, username: 'sam', channel: 'Old', title: 'Old show' }, now - 120_000, reports);
    assert.equal(gw.buildActive({ entries: [entry()], reports, now })[0].title, '');
});

test('one row per user, and idle transcode sessions are not counted', () => {
    const rows = gw.buildActive({
        entries: [entry(), entry({ label: 'Other', startTime: 1 }), entry({ userId: 8, username: 'kim', idleMs: 45_000 })],
        reports: new Map(), now
    });
    assert.deepEqual(rows.map((r) => r.user), ['sam']);
});

test('record keeps only short strings', () => {
    const reports = new Map();
    gw.record({ userId: 1, username: 'a', channel: 'x'.repeat(1000), title: 42 }, now, reports);
    const r = reports.get(1);
    assert.equal(r.channel.length, 300);
    assert.equal(r.title, '');
    gw.record({ userId: null, username: 'a', channel: 'x', title: 'y' }, now, reports);
    assert.equal(reports.size, 1);
});

test('secretMatches is false unless a configured secret matches exactly', () => {
    assert.equal(gw.secretMatches('s3cret', 's3cret'), true);
    assert.equal(gw.secretMatches('wrong!', 's3cret'), false);
    assert.equal(gw.secretMatches('', 's3cret'), false);
    assert.equal(gw.secretMatches(undefined, 's3cret'), false);
    assert.equal(gw.secretMatches('anything', ''), false);
    assert.equal(gw.secretMatches('', ''), false);
});
