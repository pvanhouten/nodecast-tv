const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

process.env.NODECAST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-session-test-'));

function load(days) {
    for (const k of Object.keys(require.cache)) if (k.includes(path.join('server', 'auth.js')) || k.includes(path.join('server', 'config'))) delete require.cache[k];
    if (days === undefined) delete process.env.AUTH_SESSION_DAYS; else process.env.AUTH_SESSION_DAYS = days;
    process.env.JWT_SECRET = 'test-secret';
    return require('../server/auth');
}

test('AUTH_SESSION_DAYS: unset, empty, junk and out-of-range values keep the 24 h default with no renewal', () => {
    const { sessionSettings } = load();
    for (const v of [undefined, '', 'abc', '0', '0.5', '-3', '366', 'Infinity']) {
        assert.deepEqual(sessionSettings({ AUTH_SESSION_DAYS: v }), { seconds: 86400, renew: false }, String(v));
    }
    assert.deepEqual(sessionSettings({ AUTH_SESSION_DAYS: '30' }), { seconds: 30 * 86400, renew: true });
    assert.deepEqual(sessionSettings({ AUTH_SESSION_DAYS: '1' }), { seconds: 86400, renew: true });
});

test('tokens last AUTH_SESSION_DAYS and the cookie matches', () => {
    const auth = load('30');
    const token = auth.generateToken({ id: 1, username: 'a', role: 'viewer', authVersion: 2 });
    const p = jwt.decode(token);
    assert.equal(p.exp - p.iat, 30 * 86400);
    let cookie;
    auth.setAuthCookie({ secure: false }, { cookie: (n, v, o) => { cookie = o; } }, token);
    assert.equal(cookie.maxAge, 30 * 86400 * 1000);
});

test('default build still issues 24 h tokens', () => {
    const auth = load();
    const p = jwt.decode(auth.generateToken({ id: 1, username: 'a', role: 'viewer' }));
    assert.equal(p.exp - p.iat, 86400);
});

test('sliding renewal: cookie tokens past half-life are replaced (keeping authVersion), fresh and bearer tokens are not', () => {
    const auth = load('30');
    const mk = (age) => {
        const iat = Math.floor(Date.now() / 1000) - age;
        return jwt.sign({ id: 5, username: 'phil', role: 'admin', authVersion: 3, kind: 'access', iat }, 'test-secret',
            { expiresIn: 30 * 86400, algorithm: 'HS256', audience: 'nodecast-tv', jwtid: 'old' });
    };
    const run = (token, bearer) => {
        const set = [];
        const req = { headers: bearer ? { authorization: 'Bearer ' + token } : { cookie: 'nodecast_auth=' + token }, secure: false };
        auth.renewCookieToken(req, { headersSent: false, cookie: (n, v, o) => set.push({ n, v, o }) });
        return set;
    };
    // cookie name comes from config; read it rather than hard-code
    const name = require('../server/config/security').authCookieName;
    const runCookie = (t) => { const set = []; auth.renewCookieToken({ headers: { cookie: `${name}=${t}` }, secure: false }, { headersSent: false, cookie: (n, v, o) => set.push({ n, v, o }) }); return set; };
    assert.equal(runCookie(mk(60)).length, 0, 'fresh token is left alone');
    assert.equal(run(mk(20 * 86400), true).length, 0, 'bearer tokens are never swapped');
    const set = runCookie(mk(20 * 86400));
    assert.equal(set.length, 1);
    const p = jwt.verify(set[0].v, 'test-secret', { audience: 'nodecast-tv' });
    assert.equal(p.authVersion, 3); assert.equal(p.id, 5); assert.equal(p.role, 'admin'); assert.equal(p.kind, 'access');
    assert.equal(p.exp - p.iat, 30 * 86400);
    assert.notEqual(p.jti, 'old');
});

test('no renewal when AUTH_SESSION_DAYS is unset', () => {
    const auth = load();
    const name = require('../server/config/security').authCookieName;
    const iat = Math.floor(Date.now() / 1000) - 20 * 3600;
    const t = jwt.sign({ id: 1, kind: 'access', iat }, 'test-secret', { expiresIn: 86400, audience: 'nodecast-tv', jwtid: 'x' });
    const set = [];
    auth.renewCookieToken({ headers: { cookie: `${name}=${t}` } }, { headersSent: false, cookie: () => set.push(1) });
    assert.equal(set.length, 0);
});
