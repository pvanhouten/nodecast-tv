const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function navContext() {
    const calls = [];
    const context = vm.createContext({
        console,
        window: { location: { hash: '' } },
        document: { addEventListener() {}, querySelectorAll: () => [] },
        history: { replaceState: (s, t, u) => calls.push(['replace', u]), pushState: (s, t, u) => calls.push(['push', u]) },
        localStorage: { getItem() {}, removeItem() {} },
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8'), context);
    const app = vm.runInContext('Object.create(App.prototype)', context);
    app.pages = { live: {}, movies: {}, home: {} };
    return { app, calls };
}

test('navigating to Live TV keeps the channel being watched in the URL', () => {
    const { app, calls } = navContext();
    app.channelList = { currentChannel: { id: 'xtream_1_42' } };
    app.navigateTo('live');
    app.navigateTo('movies');
    assert.deepEqual(calls, [['push', '#live/xtream_1_42'], ['push', '#movies']]);
});

test('Live TV with no channel yet is a plain #live; a pending channel from the URL is preserved on initial load', () => {
    const { app, calls } = navContext();
    app.channelList = { currentChannel: null };
    app.navigateTo('live');
    app.pendingChannelId = 'm3u_2_a b/c';
    app.currentPage = null;
    app.navigateTo('live', true);
    assert.deepEqual(calls, [['push', '#live'], ['replace', '#live/m3u_2_a%20b%2Fc']]);
});

test('channel selection writes the route and the list resumes the URL channel once', () => {
    const src = fs.readFileSync(path.join(__dirname, '../public/js/components/ChannelList.js'), 'utf8');
    assert.match(src, /history\.replaceState\(\{ page: 'live' \}, '', `#live\/\$\{encodeURIComponent\(channel\.id\)\}`\)/);
    assert.match(src, /window\.app\.pendingChannelId = null;\s*if \(this\.channels\.some\(c => c\.id === resume\)\) this\.selectChannel/);
    const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
    assert.match(app, /split\('\/'\)/);
});
