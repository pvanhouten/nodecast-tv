// Regression tests for behaviour that exists only in the pvanhouten fork (not in upstream):
// the Active Streams dashboard, admin-only source records, the HE-AAC probe rule,
// outbound HTTP proxy routing, and the OIDC-only-account login guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

// Same real-server fixture upstream's authentication tests use: a child process with its own data dir.
async function serverFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodecast-fork-test-'));
    let child, base;
    const stop = async () => {
        if (!child || child.exitCode !== null) return;
        const closed = new Promise(resolve => child.once('close', resolve));
        child.kill();
        await closed;
    };
    const start = async () => {
        child = spawn(process.execPath, ['server/index.js'], { cwd: root,
            env: { ...process.env, PORT: '0', NODECAST_DATA_DIR: dir,
                NODECAST_DISABLE_BACKGROUND_JOBS: 'true', JWT_SECRET: '', SESSION_SECRET: '',
                OIDC_ISSUER_URL: '', ALLOW_LOCAL_MEDIA_URLS: 'true', AUTH_COOKIE_SECURE: 'false' },
            stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        base = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 15000);
            child.stdout.on('data', chunk => {
                output += chunk;
                const match = output.match(/server running on http:\/\/localhost:(\d+)/);
                if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
            });
            child.stderr.on('data', chunk => { output += chunk; });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
            child.once('error', reject);
        });
        return base;
    };
    t.after(async () => {
        await stop();
        assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    await start();
    const request = async (endpoint, options = {}) => {
        const response = await fetch(`${base}${endpoint}`, { ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers } });
        const body = await response.text();
        let parsed = null;
        try { parsed = body ? JSON.parse(body) : null; } catch { parsed = body; }
        return { status: response.status, body: parsed,
            cookie: response.headers.getSetCookie().find(value => value.startsWith('nodecast_auth_')) };
    };
    return { dir, request, start, stop };
}

// ---------------------------------------------------------------------------------------------
// Active Streams: activity tracker
// ---------------------------------------------------------------------------------------------

test('activity tracker keeps one entry per user and only a new manifest changes the stream shown', { timeout: 60_000 }, t => {
    const tracker = require('../server/services/activityTracker');
    let now = 1_000_000;
    t.mock.method(Date, 'now', () => now);
    const manifest = 'http://p.test/live/user/pass/101.m3u8?token=one';
    tracker.touch({ userId: 'u1', username: 'Ann', url: manifest, type: 'Live (proxy)', label: 'News' });
    const get = () => tracker.getActive().filter(entry => entry.userId === 'u1');

    now += 5000; // a segment under a different path keeps the entry alive but never changes it
    tracker.touch({ userId: 'u1', username: 'Ann', url: 'http://cdn.test/segments/seg-1.ts', type: 'Live (proxy)' });
    let [entry] = get();
    assert.equal(get().length, 1);
    assert.deepEqual({ url: entry.url, label: entry.label, startTime: entry.startTime, lastAccess: entry.lastAccess },
        { url: manifest, label: 'News', startTime: 1_000_000, lastAccess: 1_005_000 });
    assert.deepEqual({ id: entry.id, killable: entry.killable, status: entry.status, username: entry.username },
        { id: null, killable: false, status: 'Live (proxy)', username: 'Ann' });

    now += 1000; // the same manifest with a rotated token is the same stream
    tracker.touch({ userId: 'u1', username: 'Ann', url: 'http://p.test/live/user/pass/101.m3u8?token=two',
        type: 'Live (proxy)', label: 'Renamed' });
    [entry] = get();
    assert.equal(entry.label, 'News');
    assert.equal(entry.startTime, 1_000_000);

    now += 1000; // a different manifest is a real channel switch: new label, restarted clock
    tracker.touch({ userId: 'u1', username: 'Ann', url: 'http://p.test/live/user/pass/202.m3u8', type: 'Live (proxy)', label: 'Sports' });
    [entry] = get();
    assert.equal(entry.label, 'Sports');
    assert.equal(entry.startTime, now);

    tracker.touch({ userId: 'u2', username: 'Bo', url: 'http://p.test/movie.mp4', type: 'Remux' });
    assert.equal(tracker.getActive().filter(e => e.userId === 'u2').length, 1, 'users are tracked separately');

    now += 21_000; // idle past the active window: no longer reported
    assert.equal(get().length, 0);
});

test('activity heartbeat keeps a long request visible and stops when the response closes', { timeout: 60_000 }, t => {
    const tracker = require('../server/services/activityTracker');
    t.mock.timers.enable({ apis: ['setInterval'] });
    let now = 5_000_000;
    t.mock.method(Date, 'now', () => now);
    const res = new EventEmitter();
    const lastAccess = () => tracker.getActive().find(entry => entry.userId === 'hb')?.lastAccess;

    tracker.heartbeat(res, { userId: 'hb', username: 'Hal', url: 'http://p.test/movie.mp4', type: 'Remux' });
    assert.equal(lastAccess(), 5_000_000, 'registered immediately');
    now += 10_000; t.mock.timers.tick(10_000);
    assert.equal(lastAccess(), 5_010_000, 'refreshed by the interval');
    now += 10_000; t.mock.timers.tick(10_000);
    assert.equal(lastAccess(), 5_020_000);

    res.emit('close');
    now += 10_000; t.mock.timers.tick(10_000);
    assert.equal(lastAccess(), 5_020_000, 'no further refreshes after the response closes');
});

// ---------------------------------------------------------------------------------------------
// HE-AAC probe rule
// ---------------------------------------------------------------------------------------------

test('probe sends HE-AAC to transcode but lets plain AAC-LC be remuxed', { timeout: 60_000 }, () => {
    const { analyzeProbeResult } = require('../server/routes/probe');
    const probeResult = profile => ({
        format: { format_name: 'mpegts', duration: '60' },
        streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 },
            { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, profile }
        ]
    });
    const lc = analyzeProbeResult(probeResult('LC'), 'http://p.test/live.ts');
    assert.equal(lc.needsTranscode, false);
    assert.equal(lc.needsRemux, true, 'raw TS with browser-safe codecs is a remux, not a transcode');
    for (const profile of ['HE-AAC', 'HE-AACv2', 'SBR']) {
        const he = analyzeProbeResult(probeResult(profile), 'http://p.test/live.ts');
        assert.equal(he.needsTranscode, true, `${profile} must be re-encoded`);
        assert.equal(he.compatible, false);
    }
    const noProfile = analyzeProbeResult(probeResult(undefined), 'http://p.test/live.ts');
    assert.equal(noProfile.needsTranscode, false, 'a missing profile is treated as plain AAC');
});

// ---------------------------------------------------------------------------------------------
// Outbound proxy routing
// ---------------------------------------------------------------------------------------------

test('outbound proxy sends fetch() through http_proxy when set and stays direct otherwise', { timeout: 60_000 }, async t => {
    const seenBy = { proxy: [], target: [] };
    const proxy = http.createServer((req, res) => { seenBy.proxy.push(`${req.method} ${req.url}`); res.end('via-proxy'); });
    const target = http.createServer((req, res) => { seenBy.target.push(`${req.method} ${req.url}`); res.end('direct'); });
    const [proxyPort, targetPort] = [await listen(proxy), await listen(target)];
    t.after(() => { proxy.close(); target.close(); });

    const run = env => new Promise((resolve, reject) => {
        const clean = { ...process.env };
        for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']) delete clean[key];
        const script = `require('./server/outboundProxy');
            fetch('http://127.0.0.1:${targetPort}/probe').then(r => r.text()).then(body => console.log('BODY:' + body));`;
        const child = spawn(process.execPath, ['-e', script], { cwd: root, env: { ...clean, ...env } });
        let output = '';
        // A hung request would otherwise surface only as a bare test timeout; kill it and keep what it printed.
        const watchdog = setTimeout(() => { output += '\n[test] child did not finish in 20s'; child.kill('SIGKILL'); }, 20_000);
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', reject);
        child.once('close', () => { clearTimeout(watchdog); resolve(output); });
    });

    const direct = await run({});
    assert.match(direct, /BODY:direct/);
    assert.doesNotMatch(direct, /\[Proxy\]/);
    assert.equal(seenBy.proxy.length, 0);
    assert.deepEqual(seenBy.target, ['GET /probe']);

    seenBy.target.length = 0;
    const proxied = await run({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}` });
    assert.match(proxied, /\[Proxy\] Outbound fetch\(\) routed through/);
    assert.match(proxied, /BODY:via-proxy/);
    assert.deepEqual(seenBy.proxy, [`GET http://127.0.0.1:${targetPort}/probe`]);
    assert.equal(seenBy.target.length, 0, 'the request must not reach the target directly');
});

// ---------------------------------------------------------------------------------------------
// Real application: admin-only source records, Active Streams listing, OIDC-only login guard
// ---------------------------------------------------------------------------------------------

test('source records stay admin-only, the list is sanitized, and Active Streams reports proxied viewing', { timeout: 60_000 }, async t => {
    const provider = http.createServer((req, res) => { res.setHeader('Content-Type', 'video/mp2t'); res.end('segment-bytes'); });
    const providerPort = await listen(provider);
    t.after(() => provider.close());

    const { request } = await serverFixture(t);
    const admin = await request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    assert.equal(admin.status, 201);
    const adminHeaders = { Cookie: admin.cookie.split(';')[0] };
    assert.equal((await request('/api/auth/users', { ...post({ username: 'Viewer', password: 'password123', role: 'viewer' }), headers: adminHeaders })).status, 201);
    const viewerLogin = await request('/api/auth/login', post({ username: 'Viewer', password: 'password123' }));
    const viewerHeaders = { Cookie: viewerLogin.cookie.split(';')[0] };

    const created = await request('/api/sources', { ...post({ type: 'xtream', name: 'Provider', url: 'http://127.0.0.1:9',
        username: 'provider-user', password: 'provider-secret' }), headers: adminHeaders });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // A viewer can list sources, but never sees the provider password.
    const list = await request('/api/sources', { headers: viewerHeaders });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.doesNotMatch(JSON.stringify(list.body), /provider-secret/);

    // Individual source records carry the provider credentials: admin only, including reads.
    for (const route of [`/api/sources/${id}`, '/api/sources/type/xtream', '/api/sources/status', `/api/sources/${id}/estimate`]) {
        assert.equal((await request(route, { headers: viewerHeaders })).status, 403, `viewer ${route}`);
    }
    const record = await request(`/api/sources/${id}`, { headers: adminHeaders });
    assert.equal(record.status, 200);
    assert.equal(record.body.username, 'provider-user');

    // Clearing a source's cached guide is also admin only.
    assert.equal((await request(`/api/proxy/epg/${id}/cache`, { method: 'DELETE', headers: viewerHeaders })).status, 403);
    assert.notEqual((await request(`/api/proxy/epg/${id}/cache`, { method: 'DELETE', headers: adminHeaders })).status, 403);

    // Active Streams: admin only, and a viewer's proxied playback shows up as a non-killable entry.
    assert.equal((await request('/api/transcode/sessions', { headers: viewerHeaders })).status, 403);
    const before = await request('/api/transcode/sessions', { headers: adminHeaders });
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, []);
    const proxied = await request(`/api/proxy/stream?url=${encodeURIComponent(`http://127.0.0.1:${providerPort}/seg-1.ts`)}`, { headers: viewerHeaders });
    assert.equal(proxied.status, 200);
    const after = await request('/api/transcode/sessions', { headers: adminHeaders });
    assert.equal(after.status, 200);
    const mine = after.body.find(entry => entry.username === 'Viewer');
    assert.ok(mine, 'the viewer appears in Active Streams');
    assert.equal(mine.status, 'Live (proxy)');
    assert.equal(mine.killable, false);
    assert.equal(mine.id, null);
});

test('an account with no local password cannot sign in with a password and gets a 401, not a server error', { timeout: 60_000 }, async t => {
    const fixture = await serverFixture(t);
    await fixture.request('/api/auth/setup', post({ username: 'Admin', password: 'password123' }));
    await fixture.stop();
    const filename = path.join(fixture.dir, 'db.json'), data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    data.users.push({ id: data.nextId++, username: 'SsoOnly', role: 'viewer', passwordHash: null, oidcId: 'sub-123' });
    fs.writeFileSync(filename, JSON.stringify(data));
    await fixture.start();

    for (const password of ['anything-at-all', 'password123']) {
        const login = await fixture.request('/api/auth/login', post({ username: 'SsoOnly', password }));
        assert.equal(login.status, 401);
    }
    const admin = await fixture.request('/api/auth/login', post({ username: 'Admin', password: 'password123' }));
    assert.equal(admin.status, 200, 'normal accounts are unaffected');
});
