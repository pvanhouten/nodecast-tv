/**
 * GameStats: a small live-score overlay on the Live TV player.
 * Self-contained (injects its own CSS and DOM). It listens for the existing `channelChanged` event and builds a
 * lookup text from the channel name plus its current EPG program, asks /api/gamestats which game that is (e.g.
 * "NCAAB 6 Fairfield @ Wisconsin 8PM" or "College Basketball : Creighton at Kansas State") and shows a scorebug.
 *
 *  - Header: drag to move (double-click resets), \ud83d\udd0d find a game by hand (pinned per channel for 8h), \u2699 settings,
 *    "-" minimize to a one-line pill. Press G to show/hide the whole overlay.
 *  - Body: score, situation (NFL down & distance, MLB count/runners), soccer goals/cards, win probability, line/spread,
 *    last play. Buttons open Lineups (+ player search/stat cards) and Team stats.
 *  - Spoiler guard (\u2699): delay the displayed data by N seconds (IPTV is usually behind ESPN) and/or hide scores.
 *  - Auto-minimizes when a game you were watching ends; fades when the player's controls hide.
 * Position, minimized state and settings are remembered in localStorage.
 */
const GameStats = {
    POLL_MS: 15000,
    POLL_FAST_MS: 8000,   // used while a spoiler delay is set so delayed snapshots have fine granularity
    RETRY_MS: 60000,
    EXTRA_MS: 30000,
    timer: null,
    title: '',
    el: null,
    game: null,           // game currently shown (possibly delayed)
    live: null,           // newest game from the server
    shown: null,
    snaps: [],            // [{ t, game }] recent server snapshots, for the spoiler delay
    snapGame: null,
    lastOkAt: 0,
    prevState: null,
    prevStateId: null,
    lineupsOpen: false,
    tstatsOpen: false,
    settingsOpen: false,
    finderOpen: false,
    lineupTimer: null,
    extraTimer: null,
    extra: null,          // { winProb, spread, teamStats } for the shown game
    query: '',
    selected: null,       // player id shown in the stat card
    playersData: null,
    playersAt: 0,
    seasonCache: {},
    min: false,
    off: false,
    autoMinGame: null,    // game id auto-minimized because it ended
    autoMinSeen: null,
    channel: null,
    pinned: null,         // { leagueKey, id } chosen by hand for the current channel
    finderTimer: null,
    shellGame: undefined,
    programs: new Map(),  // channel name -> { title, desc } of its current EPG program (fed by the player)
    pos: null,            // { x, y } in px from the video container's top-left, or null = default corner
    settings: { delay: 0, hideScores: false, autoMin: true, dim: true },

    init() {
        try {
            this.min = localStorage.getItem('gamestats-min') === '1';
            this.off = localStorage.getItem('gamestats-off') === '1';
            this.pos = JSON.parse(localStorage.getItem('gamestats-pos') || 'null');
            Object.assign(this.settings, JSON.parse(localStorage.getItem('gamestats-settings') || '{}'));
        } catch (_) { /* storage unavailable: defaults */ }
        this.settings.delay = Math.max(0, Math.min(180, Number(this.settings.delay) || 0));
        // Learn each channel's current EPG program (e.g. "College Basketball : Creighton at Kansas State") by
        // listening in on the player's updateNowPlaying, without modifying the player itself.
        const VP = window.VideoPlayer;
        if (VP && VP.prototype && !VP.prototype.__gsWrapped) {
            const orig = VP.prototype.updateNowPlaying;
            const self = this;
            VP.prototype.updateNowPlaying = function (channel, epgData) {
                const r = orig.apply(this, arguments);
                try { self.onNowPlaying(channel, epgData); } catch (_) { /* overlay is optional */ }
                return r;
            };
            VP.prototype.__gsWrapped = true;
        }
        window.addEventListener('resize', () => this.applyPos());
        document.addEventListener('fullscreenchange', () => setTimeout(() => this.applyPos(), 50));
        document.addEventListener('keydown', (e) => this.onKey(e));
        this.injectStyles();
        window.addEventListener('channelChanged', (e) => this.setChannel(e.detail));
        setInterval(() => this.refreshView(), 1000);
    },

    saveSettings() {
        try { localStorage.setItem('gamestats-settings', JSON.stringify(this.settings)); } catch (_) { /* ignore */ }
    },

    spoilerSafe() {
        return this.settings.hideScores || this.settings.delay > 0;
    },

    // ---- Show/hide shortcut (G). Space is the player's play/pause, so it is not used here. ----
    onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if ((e.key || '').toLowerCase() !== 'g') return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        const host = this.container();
        if (!host || !this.channel || host.offsetParent === null) return; // only on the Live player with a channel tuned
        e.preventDefault();
        this.off = !this.off;
        try { localStorage.setItem('gamestats-off', this.off ? '1' : '0'); } catch (_) { /* ignore */ }
        if (this.el) this.el.hidden = this.off || (!this.shown && !this.channel);
        this.toast(this.off ? 'Game overlay hidden \u00b7 press G to show' : 'Game overlay shown');
        if (!this.off) this.render(this.shown || null);
    },

    toast(msg) {
        const host = this.container();
        if (!host) return;
        let t = host.querySelector('.gs-toast');
        if (!t) { t = document.createElement('div'); t.className = 'gs-toast'; host.appendChild(t); }
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
    },

    onNowPlaying(channel, epgData) {
        if (!channel) return;
        const name = channel.name || channel.tvgName || '';
        const cur = epgData && epgData.current;
        const before = this.currentText();
        this.programs.set(name, cur ? { title: cur.title || '', desc: cur.description || '' } : null);
        if (this.channel && (this.channel.name || this.channel.tvgName || '') === name && this.currentText() !== before) this.tick();
    },

    // Text to look a game up by: channel name plus the current program's title and start of its description.
    currentText() {
        const ch = this.channel;
        if (!ch) return '';
        const name = ch.name || ch.tvgName || '';
        let prog = null;
        try { // the guide is the freshest source: the program changes while the channel stays tuned
            const guide = window.app && window.app.epgGuide;
            const p = guide && guide.getCurrentProgram && guide.getCurrentProgram(ch.tvgId, ch.name);
            if (p) prog = { title: p.title, desc: p.desc };
        } catch (_) { /* fall through */ }
        if (!prog) prog = this.programs.get(name) || null;
        return [name, prog && prog.title, prog && String(prog.desc || '').slice(0, 200)].filter(Boolean).join(' | ');
    },

    setChannel(channel) {
        clearTimeout(this.timer);
        clearTimeout(this.extraTimer);
        this.closeLineups();
        this.query = ''; this.selected = null; this.playersData = null; this.seasonCache = {};
        this.channel = channel || null;
        this.pinned = this.loadPin();
        this.shellGame = undefined; // fresh panels for a new channel
        this.title = '';
        this.live = null; this.snaps = []; this.snapGame = null; this.shown = null; this.extra = null; this.game = null;
        this.finderOpen = false; this.settingsOpen = false; this.tstatsOpen = false;
        this.render(null);
        if (this.channel) this.tick();
    },

    // One lookup cycle. Cheap when the text names no matchup (no network); keeps running for as long as the
    // channel is tuned so a studio show turning into a game (or back) is picked up without a channel change.
    async tick() {
        clearTimeout(this.timer);
        const channel = this.channel;
        if (!channel) return;
        const text = this.currentText();
        this.title = text;
        let game = null;
        let failed = false;
        if (this.pinned) {
            try {
                const res = await fetch('/api/gamestats/game?league=' + encodeURIComponent(this.pinned.leagueKey) + '&event=' + encodeURIComponent(this.pinned.id), { credentials: 'same-origin' });
                if (res.ok) game = (await res.json()).game; else failed = true;
            } catch (_) { failed = true; }
            if (channel !== this.channel) return;
            if (!game && !failed) { this.savePin(null); this.pinned = null; } // dropped off the scoreboard: back to automatic
        }
        if (!game && !failed && !this.pinned && /\s(@|at|vs\.?|v)\s/i.test(text)) {
            try {
                const res = await fetch('/api/gamestats?title=' + encodeURIComponent(text), { credentials: 'same-origin' });
                if (res.ok) game = (await res.json()).game; else failed = true;
            } catch (_) { failed = true; }
            if (channel !== this.channel || text !== this.title) return; // channel/program changed while waiting
        }
        if (failed && this.live) {
            // Network hiccup: keep showing the last data (the footer turns amber as it ages).
        } else {
            this.ingest(game);
            this.render(this.shownGame());
        }
        const active = (this.live && this.live.state !== 'post') || (failed && this.live);
        this.timer = setTimeout(() => this.tick(), active ? (this.settings.delay > 0 ? this.POLL_FAST_MS : this.POLL_MS) : this.RETRY_MS);
    },

    // ---- Server snapshots + spoiler delay ----
    ingest(game) {
        if (!game) { this.live = null; this.snaps = []; this.snapGame = null; return; }
        if (this.snapGame !== game.id) { this.snaps = []; this.snapGame = game.id; }
        const t = game.asOf || Date.now();
        const last = this.snaps[this.snaps.length - 1];
        if (!last || last.t !== t) this.snaps.push({ t, game });
        const keep = Date.now() - (this.settings.delay * 1000 + 120000);
        const newest = this.snaps[this.snaps.length - 1];
        this.snaps = this.snaps.filter((s) => s.t >= keep || s === newest);
        this.live = game;
        this.lastOkAt = Date.now();
    },

    // What to display now: the newest data, or (spoiler delay) the newest snapshot that is at least `delay` old.
    shownGame() {
        const live = this.live;
        if (!live) return null;
        const d = this.settings.delay * 1000;
        if (!d) return live;
        const cutoff = Date.now() - d;
        let pick = null;
        for (const s of this.snaps) if (s.t <= cutoff) pick = s;
        if (pick) return pick.game;
        // Nothing old enough yet: show the teams, but no score, and say why.
        if (!this._mask || this._mask.src !== live.id || this._mask.delay !== this.settings.delay) {
            this._mask = { src: live.id, delay: this.settings.delay, game: {
                ...live, away: { ...live.away, score: '\u2022', winner: false }, home: { ...live.home, score: '\u2022', winner: false },
                state: 'pre', detail: `syncing ${this.settings.delay}s delay\u2026`, lastPlay: '', situation: '', events: [] } };
        }
        return this._mask.game;
    },

    refreshView() {
        if (!this.channel) return;
        const shown = this.shownGame();
        if (shown !== this.shown && (shown || this.shown)) this.render(shown);
        this.paintFooter();
    },

    container() {
        return document.getElementById('video-container');
    },

    isMin() {
        return this.min || (this.autoMinGame != null && !!this.game && this.autoMinGame === this.game.id);
    },

    syncPanels() {
        if (!this.el) return;
        this.el.classList.toggle('panel', !!(this.lineupsOpen || this.tstatsOpen || this.settingsOpen || this.finderOpen));
        this.el.classList.toggle('open', !!(this.finderOpen || this.settingsOpen)); // keeps the empty-state pill visible
    },

    // Fade when the player's own controls hide, so it stays out of the way during play.
    syncDim() {
        if (!this.el) return;
        const c = document.getElementById('player-controls-overlay');
        this.el.classList.toggle('dim', !!(this.settings.dim && c && c.classList.contains('hidden')));
    },

    render(game) {
        const host = this.container();
        if (!host) return;
        this.shown = game || null;
        if (!game && !this.channel) { if (this.el) this.el.hidden = true; return; }
        if (!this.el || !host.contains(this.el)) {
            this.el = document.createElement('div');
            this.el.className = 'gamestats';
            // Keep double-clicks (and taps) on the overlay from reaching the player (fullscreen toggle).
            this.el.addEventListener('dblclick', (e) => e.stopPropagation());
            this.el.addEventListener('click', (e) => {
                const hit = (sel) => e.target.closest(sel);
                if (hit('.gs-min-btn')) this.toggleMin();
                else if (hit('.gs-find-btn')) this.toggleFinder();
                else if (hit('.gs-set-btn')) this.toggleSettings();
                else if (hit('.gs-unpin-btn')) this.unpin();
                else if (hit('.gs-tstats-btn')) this.toggleTstats();
                else if (hit('.gs-lineups-btn')) this.toggleLineups();
            });
            this.bindDrag();
            host.appendChild(this.el);
            if (window.ResizeObserver) new ResizeObserver(() => this.applyPos()).observe(this.el);
            const controls = document.getElementById('player-controls-overlay');
            if (controls && window.MutationObserver) new MutationObserver(() => this.syncDim()).observe(controls, { attributes: true, attributeFilter: ['class'] });
        }
        this.el.hidden = this.off;
        const empty = !game;
        this.el.classList.toggle('empty', empty);
        // The panels (inputs, results) are built once per game and never re-rendered by a score refresh,
        // otherwise the inputs would lose focus/text every poll.
        const gid = game ? game.id : null;
        if (!this.el.querySelector('.gs-lineups') || this.shellGame !== gid) {
            this.query = ''; this.selected = null; this.playersData = null; this.seasonCache = {};
            this.el.innerHTML = `<div class="gs-top"></div>
                <div class="gs-finder" hidden>
                  <input type="search" class="gs-fq" placeholder="Find game, e.g. ncaa mens basketball wisconsin" autocomplete="off" spellcheck="false">
                  <div class="gs-fresults"></div></div>
                <div class="gs-settings" hidden>
                  <label>Spoiler delay <select class="gs-set-delay">${[0, 10, 20, 30, 45, 60, 90, 120].map((s) => `<option value="${s}">${s ? s + ' seconds' : 'Off'}</option>`).join('')}</select></label>
                  <label><input type="checkbox" class="gs-set-hide"> Hide scores</label>
                  <label><input type="checkbox" class="gs-set-automin"> Minimize when the game ends</label>
                  <label><input type="checkbox" class="gs-set-dim"> Fade when player controls hide</label>
                  <div class="gs-note">Press G to show or hide this overlay. IPTV is usually behind live: set a delay so scores match what you see.</div></div>
                <div class="gs-tstats" hidden></div>
                <div class="gs-lineups" hidden>
                  <div class="gs-search"><input type="search" class="gs-q" placeholder="Find player: name or #" autocomplete="off" spellcheck="false">
                    <div class="gs-results"></div></div>
                  <div class="gs-cols"></div></div>`;
            this.shellGame = gid;
            this.bindSearch();
            this.bindFinder();
            this.bindSettings();
            this.lineupsOpen = false;
            this.finderOpen = false;
            this.settingsOpen = false;
            this.tstatsOpen = false;
            clearTimeout(this.lineupTimer);
            clearTimeout(this.extraTimer);
            this.extra = null;
            if (game) this.loadExtra(game);
        }
        this.syncPanels();
        this.syncDim();
        if (game) {
            this.game = game;
            this.paintTop(game);
        } else {
            this.el.classList.remove('min');
            this.paintTop(null);
        }
        this.applyPos();
    },

    // The always-visible part: header, score rows, situation, win probability, line, events, buttons, footer.
    paintTop(game) {
        const top = this.el && this.el.querySelector('.gs-top');
        if (!top) return;
        const findBtn = '<button type="button" class="gs-find-btn" title="Find a game">\u{1F50D}</button>';
        const setBtn = '<button type="button" class="gs-set-btn" title="Settings: spoiler delay, hide scores">\u2699</button>';
        if (!game) {
            top.innerHTML = `<div class="gs-head" title="Drag to move"><span class="gs-league">Find a game</span>${findBtn}${setBtn}</div>`;
            return;
        }
        // Auto-minimize once, when a game we watched live turns final.
        if (this.prevStateId !== game.id) { this.prevStateId = game.id; this.prevState = null; }
        if (this.settings.autoMin && game.state === 'post' && this.prevState === 'in' && this.autoMinSeen !== game.id) {
            this.autoMinGame = game.id; this.autoMinSeen = game.id;
        }
        this.prevState = game.state;
        const minNow = this.isMin();
        this.el.classList.toggle('min', minNow);

        const hide = this.settings.hideScores;
        const safe = this.spoilerSafe();
        const sc = (v) => (hide ? '\u2022' : this.esc(v));
        const live = game.state === 'in';
        const row = (t) => `
            <div class="gs-row${t.winner && !hide ? ' win' : ''}">
              ${t.logo ? `<img class="gs-logo" src="${this.esc(t.logo)}" alt="" referrerpolicy="no-referrer">` : ''}
              <span class="gs-name">${t.rank ? `<i>${t.rank}</i> ` : ''}${this.esc(t.name)}</span>
              <span class="gs-rec">${this.esc(t.record)}</span>
              <span class="gs-score">${sc(t.score)}</span>
            </div>`;
        const x = this.extra;
        let wp = '';
        if (!safe && live && x && x.winProb) {
            const a = Math.round(x.winProb.away * 100), h = Math.round(x.winProb.home * 100);
            if (a + h > 0) wp = `<div class="gs-wp" title="Win probability"><span class="gs-wp-a" style="flex:${a}"></span><span class="gs-wp-h" style="flex:${h}"></span></div>
                <div class="gs-wp-l"><span>${this.esc(game.away.abbr || game.away.name)} ${a}%</span><span>${this.esc(game.home.abbr || game.home.name)} ${h}%</span></div>`;
        }
        const line = x && x.spread && game.state !== 'post'
            ? `<div class="gs-line">Line ${this.esc(x.spread.text)}${x.spread.overUnder != null ? ' \u00b7 O/U ' + this.esc(x.spread.overUnder) : ''}</div>` : '';
        const icon = { goal: '\u26bd', pen: '\u26bd (pen)', og: '\u26bd (og)', yellow: '\ud83d\udfe8', red: '\ud83d\udfe5' };
        const events = !hide && game.events && game.events.length
            ? `<div class="gs-events">${game.events.slice(-4).map((e) => `<div>${this.esc(e.min)} ${icon[e.kind] || ''} ${this.esc(e.player)} <em>${this.esc(e.team)}</em></div>`).join('')}</div>` : '';
        const sit = !hide && game.situation ? `<div class="gs-sit">${this.esc(game.situation)}</div>` : '';
        const play = !hide && game.lastPlay ? `<div class="gs-play">${this.esc(game.lastPlay)}</div>` : '';
        const canLineup = game.id && (game.sport === 'soccer' || ['ncaam', 'ncaaw', 'nba', 'nfl', 'nhl', 'mlb'].includes(game.leagueKey));
        const canTstats = !safe && x && x.teamStats;
        top.innerHTML = `
            <div class="gs-head" title="Drag to move \u00b7 double-click to reset"><span class="gs-league">${this.esc(game.league)}</span>
              <span class="gs-mini">${this.esc(game.away.abbr || game.away.name)} ${sc(game.away.score)}\u2013${sc(game.home.score)} ${this.esc(game.home.abbr || game.home.name)}</span>
              <span class="gs-status${live ? ' live' : ''}">${this.esc(game.detail)}</span>
              ${this.pinned ? '<button type="button" class="gs-unpin-btn" title="Pinned by hand \u00b7 click to go back to automatic">\u{1F4CC}</button>' : ''}
              ${findBtn}${setBtn}
              <button type="button" class="gs-min-btn" title="${minNow ? 'Expand' : 'Minimize'}">${minNow ? '+' : '\u2013'}</button></div>
            <div class="gs-body">
              ${row(game.away)}${row(game.home)}
              ${wp}${sit}${events}${line}${play}
              <div class="gs-btns">
                ${canLineup ? `<button type="button" class="gs-lineups-btn">${this.lineupsOpen ? 'Hide lineups' : 'Lineups'}</button>` : ''}
                ${canTstats ? `<button type="button" class="gs-tstats-btn">${this.tstatsOpen ? 'Hide stats' : 'Team stats'}</button>` : ''}
              </div>
              <div class="gs-foot"><span class="gs-upd"></span></div>
            </div>`;
        this.paintFooter();
    },

    // "Updated 8s ago", turning amber when the data is stale; also notes the spoiler guard.
    paintFooter() {
        const el = this.el && this.el.querySelector('.gs-upd');
        if (!el) return;
        const live = this.live;
        if (!live) { el.textContent = ''; return; }
        const age = Math.max(0, Math.round((Date.now() - (live.asOf || Date.now())) / 1000));
        const sinceOk = Math.round((Date.now() - this.lastOkAt) / 1000);
        const stale = !!live.stale || age > 75 || sinceOk > 75;
        const fmt = (s) => (s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h');
        let t = stale ? `ESPN data stale \u00b7 ${fmt(Math.max(age, sinceOk))} old` : `Updated ${fmt(age)} ago`;
        if (this.settings.delay > 0) t += ` \u00b7 ${this.settings.delay}s delay`;
        if (this.settings.hideScores) t += ' \u00b7 scores hidden';
        el.textContent = t;
        el.classList.toggle('stale', stale);
    },

    // ---- Win probability / line / team stats (one summary fetch, cached on the server) ----
    async loadExtra(game) {
        game = game || this.game;
        if (!game || !game.id) return;
        clearTimeout(this.extraTimer);
        let extra = null;
        try {
            const res = await fetch('/api/gamestats/extra?league=' + encodeURIComponent(game.leagueKey) + '&event=' + encodeURIComponent(game.id), { credentials: 'same-origin' });
            if (res.ok) extra = (await res.json()).extra;
        } catch (_) { /* optional */ }
        if (!this.game || this.game.id !== game.id) return;
        this.extra = extra;
        this.paintTop(this.game);
        this.renderTstats();
        this.extraTimer = setTimeout(() => this.loadExtra(), this.EXTRA_MS);
    },

    toggleTstats() {
        this.tstatsOpen = !this.tstatsOpen;
        const box = this.el.querySelector('.gs-tstats');
        if (box) box.hidden = !this.tstatsOpen;
        this.syncPanels();
        this.renderTstats();
        this.paintTop(this.game);
    },

    renderTstats() {
        const box = this.el && this.el.querySelector('.gs-tstats');
        if (!box || box.hidden) return;
        const t = this.extra && this.extra.teamStats;
        if (!t || this.spoilerSafe()) {
            box.innerHTML = `<div class="gs-empty">${this.spoilerSafe() ? 'Hidden by spoiler guard' : 'Team stats not available yet'}</div>`;
            return;
        }
        box.innerHTML = `<div class="gs-ts-r gs-ts-h"><b>${this.esc(t.away)}</b><span></span><b>${this.esc(t.home)}</b></div>`
            + t.rows.map((r) => `<div class="gs-ts-r"><b>${this.esc(r.away)}</b><span>${this.esc(r.label)}</span><b>${this.esc(r.home)}</b></div>`).join('');
    },

    // ---- Settings ----
    bindSettings() {
        const box = this.el.querySelector('.gs-settings');
        if (!box) return;
        ['keydown', 'keyup', 'keypress'].forEach((ev) => box.addEventListener(ev, (e) => e.stopPropagation()));
        const q = (s) => box.querySelector(s);
        q('.gs-set-delay').value = String(this.settings.delay);
        q('.gs-set-hide').checked = !!this.settings.hideScores;
        q('.gs-set-automin').checked = !!this.settings.autoMin;
        q('.gs-set-dim').checked = !!this.settings.dim;
        box.addEventListener('change', () => {
            this.settings.delay = Number(q('.gs-set-delay').value) || 0;
            this.settings.hideScores = q('.gs-set-hide').checked;
            this.settings.autoMin = q('.gs-set-automin').checked;
            this.settings.dim = q('.gs-set-dim').checked;
            this.saveSettings();
            this.syncDim();
            this._mask = null;
            this.shown = undefined;       // force a repaint with the new rules
            this.refreshView();
            if (this.game) { this.paintTop(this.game); this.renderTstats(); }
            if (this.lineupsOpen) this.loadLineups();
            if (this.selected) this.runSearch();
            if (this.live) this.tick();   // re-time polling for the new delay
        });
    },

    toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
        const box = this.el.querySelector('.gs-settings');
        if (box) box.hidden = !this.settingsOpen;
        this.syncPanels();
    },

    // ---- Manual game search / pin ----
    loadPin() {
        try {
            const all = JSON.parse(localStorage.getItem('gamestats-pins') || '{}');
            const name = this.channel && (this.channel.name || this.channel.tvgName);
            const p = name && all[name];
            return p && Date.now() - p.at < 8 * 3600 * 1000 ? { leagueKey: p.leagueKey, id: p.id } : null;
        } catch (_) { return null; }
    },

    savePin(pin) {
        try {
            const name = this.channel && (this.channel.name || this.channel.tvgName);
            if (!name) return;
            const all = JSON.parse(localStorage.getItem('gamestats-pins') || '{}');
            for (const k of Object.keys(all)) if (Date.now() - all[k].at > 8 * 3600 * 1000) delete all[k];
            if (pin) all[name] = { leagueKey: pin.leagueKey, id: pin.id, at: Date.now() }; else delete all[name];
            localStorage.setItem('gamestats-pins', JSON.stringify(all));
        } catch (_) { /* storage unavailable: pin lasts until the channel changes */ }
    },

    pin(game) {
        this.pinned = { leagueKey: game.leagueKey, id: game.id };
        this.savePin(this.pinned);
        this.finderOpen = false;
        this.ingest(game);
        this.render(this.shownGame());   // rebuilds the panels for the new game (closes the finder)
        this.tick();
    },

    unpin() {
        this.pinned = null;
        this.savePin(null);
        this.tick();
    },

    toggleFinder() {
        this.finderOpen = !this.finderOpen;
        const box = this.el.querySelector('.gs-finder');
        if (box) box.hidden = !this.finderOpen;
        this.syncPanels();
        if (this.finderOpen) { const i = this.el.querySelector('.gs-fq'); if (i) i.focus(); }
    },

    bindFinder() {
        const input = this.el.querySelector('.gs-fq');
        if (!input) return;
        ['keydown', 'keyup', 'keypress'].forEach((ev) => input.addEventListener(ev, (e) => e.stopPropagation()));
        const run = async () => {
            const out = this.el && this.el.querySelector('.gs-fresults');
            const q = input.value.trim();
            if (!out) return;
            if (q.length < 2) { out.innerHTML = ''; return; }
            let games = [];
            try {
                const res = await fetch('/api/gamestats/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
                if (res.ok) games = (await res.json()).games || [];
            } catch (_) { /* optional */ }
            if (!out.isConnected || input.value.trim() !== q) return;
            this.finderGames = games;
            const safe = this.spoilerSafe();
            out.innerHTML = games.length ? games.map((g, i) => `<button type="button" class="gs-fhit" data-i="${i}">
                <span class="gs-fstate ${g.state === 'in' ? 'live' : ''}">${g.state === 'in' ? 'LIVE' : g.state === 'post' ? 'FINAL' : 'SOON'}</span>
                <span class="gs-fname">${this.esc(g.away.name)} ${g.state === 'pre' || safe ? 'at' : this.esc(g.away.score) + '\u2013' + this.esc(g.home.score)} ${this.esc(g.home.name)}</span>
                <em>${this.esc(g.league)} \u00b7 ${this.esc(g.detail)}</em></button>`).join('') : '<div class="gs-empty">No games found</div>';
            out.querySelectorAll('.gs-fhit').forEach((b) => b.addEventListener('click', () => this.pin(this.finderGames[+b.dataset.i])));
        };
        input.addEventListener('input', () => { clearTimeout(this.finderTimer); this.finderTimer = setTimeout(run, 250); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(this.finderTimer); run(); } });
    },

    toggleMin() {
        if (this.isMin()) { this.min = false; this.autoMinGame = null; } else { this.min = true; }
        try { localStorage.setItem('gamestats-min', this.min ? '1' : '0'); } catch (_) { /* ignore */ }
        if (this.game) this.paintTop(this.game);
        this.applyPos();
    },

    // ---- Move: drag the header; position is clamped inside the video area ----
    bindDrag() {
        let drag = null;
        this.el.addEventListener('pointerdown', (e) => {
            const head = e.target.closest('.gs-head');
            if (!head || e.target.closest('button') || e.button !== 0) return;
            const host = this.container().getBoundingClientRect();
            const r = this.el.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, host };
            this.el.setPointerCapture(e.pointerId);
            this.el.classList.add('dragging');
            e.preventDefault();
        });
        this.el.addEventListener('pointermove', (e) => {
            if (!drag) return;
            this.pos = this.clampPos({ x: e.clientX - drag.host.left - drag.dx, y: e.clientY - drag.host.top - drag.dy });
            this.applyPos();
        });
        const end = (e) => {
            if (!drag) return;
            drag = null;
            this.el.classList.remove('dragging');
            try { this.el.releasePointerCapture(e.pointerId); localStorage.setItem('gamestats-pos', JSON.stringify(this.pos)); } catch (_) { /* ignore */ }
        };
        this.el.addEventListener('pointerup', end);
        this.el.addEventListener('pointercancel', end);
        this.el.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.gs-head') || e.target.closest('button')) return;
            this.pos = null;
            try { localStorage.removeItem('gamestats-pos'); } catch (_) { /* ignore */ }
            this.applyPos();
        });
    },

    clampPos(p) {
        const host = this.container();
        if (!host || !this.el) return p;
        const hw = host.clientWidth, hh = host.clientHeight;
        return { x: Math.round(Math.min(Math.max(0, p.x), Math.max(0, hw - this.el.offsetWidth))),
                 y: Math.round(Math.min(Math.max(0, p.y), Math.max(0, hh - 40))) };
    },

    applyPos() {
        if (!this.el || this.el.hidden) return;
        const host = this.container();
        if (!this.pos || !host) {
            this.el.style.left = this.el.style.top = this.el.style.bottom = this.el.style.maxHeight = '';
            return;
        }
        this.pos = this.clampPos(this.pos);
        this.el.style.left = this.pos.x + 'px';
        this.el.style.top = this.pos.y + 'px';
        this.el.style.bottom = 'auto';
        this.el.style.maxHeight = Math.max(80, host.clientHeight - this.pos.y - 8) + 'px';
    },

    // ---- Lineups ----
    toggleLineups() {
        this.lineupsOpen = !this.lineupsOpen;
        const box = this.el.querySelector('.gs-lineups');
        if (box) box.hidden = !this.lineupsOpen;
        clearTimeout(this.lineupTimer);
        this.syncPanels();
        this.paintTop(this.game);
        if (this.lineupsOpen) this.loadLineups();
    },

    closeLineups() {
        this.lineupsOpen = false;
        clearTimeout(this.lineupTimer);
    },

    async loadLineups() {
        const game = this.game;
        const box = this.el && this.el.querySelector('.gs-cols');
        if (!game || !box) return;
        let data = null;
        try {
            const q = 'league=' + encodeURIComponent(game.leagueKey) + '&event=' + encodeURIComponent(game.id);
            const res = await fetch('/api/gamestats/lineups?' + q, { credentials: 'same-origin' });
            if (res.ok) data = (await res.json()).lineups;
        } catch (_) { /* optional */ }
        if (!this.game || game.id !== this.game.id || !this.lineupsOpen) return;
        const safe = this.spoilerSafe();
        const teams = (data && data.teams) || [];
        if (!teams.length || !teams.some((t) => t.starters.length)) {
            box.innerHTML = '<div class="gs-empty">Lineups not posted yet</div>';
        } else {
            // Live numbers and substitutions would spoil a delayed stream, so the spoiler guard shows names only.
            const p = (x) => `<div class="gs-p${!safe && x.out ? ' out' : ''}${!safe && x.in ? ' in' : ''}"><b>${this.esc(x.num)}</b><span>${this.esc(x.name)}</span><em>${this.esc(safe ? x.pos : (x.stat || x.pos))}</em></div>`;
            const col = (t) => `<div class="gs-col"><h4>${this.esc(t.name)}${t.formation ? ` <small>${this.esc(t.formation)}</small>` : ''}</h4>
                ${t.starters.map((x, i) => (x.unit && x.unit !== (t.starters[i - 1] || {}).unit ? `<h5>${this.esc(x.unit)}</h5>` : '') + p(x)).join('')}
                ${t.bench.length ? `<h5>Bench</h5>${t.bench.map((x) => p(x)).join('')}` : ''}</div>`;
            box.innerHTML = teams.map(col).join('')
                + (data.note ? `<div class="gs-note">${this.esc(data.note)}</div>` : '')
                + (safe ? '<div class="gs-note">Live stats hidden by the spoiler guard.</div>' : '');
        }
        clearTimeout(this.lineupTimer);
        this.lineupTimer = setTimeout(() => this.loadLineups(), 30000);
    },

    // ---- Player search: type a name or jersey number, click a result for that player's stats ----
    bindSearch() {
        const input = this.el.querySelector('.gs-q');
        if (!input) return;
        // The page has global shortcuts (space, F, arrows, G); keep typing here from triggering them.
        ['keydown', 'keyup', 'keypress'].forEach((ev) => input.addEventListener(ev, (e) => e.stopPropagation()));
        let t;
        input.addEventListener('input', () => {
            this.query = input.value;
            this.selected = null;
            clearTimeout(t);
            t = setTimeout(() => this.runSearch(), 150);
        });
        if (this.query) this.runSearch();
    },

    async ensurePlayers() {
        const game = this.game;
        if (this.playersData && Date.now() - this.playersAt < 30000) return this.playersData;
        try {
            const q = 'league=' + encodeURIComponent(game.leagueKey) + '&event=' + encodeURIComponent(game.id);
            const res = await fetch('/api/gamestats/players?' + q, { credentials: 'same-origin' });
            if (res.ok) { this.playersData = (await res.json()).players; this.playersAt = Date.now(); }
        } catch (_) { /* optional */ }
        return this.game && game.id === this.game.id ? this.playersData : null;
    },

    norm(v) {
        return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    },

    async runSearch() {
        const out = this.el && this.el.querySelector('.gs-results');
        if (!out) return;
        const raw = this.query.trim().replace(/^#/, '');
        if (!raw) { out.innerHTML = ''; return; }
        const data = await this.ensurePlayers();
        if (!this.el || !out.isConnected) return;
        const all = ((data && data.teams) || []).flatMap((t) => t.players.map((p) => ({ ...p, team: t.name })));
        const q = this.norm(raw);
        const hits = (/^\d+$/.test(q) ? all.filter((p) => String(p.num) === q) : all.filter((p) => this.norm(p.name).includes(q))).slice(0, 8);
        this.hits = hits;
        if (!hits.length) { out.innerHTML = '<div class="gs-empty">No player found</div>'; return; }
        const sel = hits.find((p) => p.id === this.selected) || (hits.length === 1 ? hits[0] : null);
        if (sel) { this.selected = sel.id; out.innerHTML = this.card(sel); this.loadSeason(sel); return; }
        out.innerHTML = hits.map((p) => `<button type="button" class="gs-hit" data-id="${this.esc(p.id)}"><b>${this.esc(p.num)}</b><span>${this.esc(p.name)}</span><em>${this.esc(p.team)}${p.pos ? ' \u00b7 ' + this.esc(p.pos) : ''}</em></button>`).join('');
        out.querySelectorAll('.gs-hit').forEach((b) => b.addEventListener('click', () => {
            const p = hits.find((x) => x.id === b.dataset.id);
            if (!p) return;
            this.selected = p.id;
            out.innerHTML = this.card(p);
            this.loadSeason(p);
        }));
    },

    card(p) {
        const kv = (arr) => arr.map(([l, v]) => `<div class="gs-kv"><b>${this.esc(v)}</b><span>${this.esc(l)}</span></div>`).join('');
        const groups = (p.groups || []).filter((g) => g.stats.length);
        const body = this.spoilerSafe()
            ? '<div class="gs-empty">This game\u2019s stats are hidden by the spoiler guard</div>'
            : groups.length ? groups.map((g) => `<h5>${this.esc(g.title)}</h5><div class="gs-kvs">${kv(g.stats)}</div>`).join('') : '<div class="gs-empty">No stats in this game yet</div>';
        return `<div class="gs-card"><div class="gs-card-h"><b>${p.num ? '#' + this.esc(p.num) + ' ' : ''}${this.esc(p.name)}</b>
            <em>${this.esc(p.team)}${p.pos ? ' \u00b7 ' + this.esc(p.pos) : ''}</em></div>
          ${body}
          <div class="gs-season" data-season="${this.esc(p.id)}"></div></div>`;
    },

    async loadSeason(p) {
        const host = this.el && this.el.querySelector('.gs-season');
        if (!host || !this.game) return;
        const key = this.game.leagueKey + ':' + p.id;
        if (!(key in this.seasonCache)) {
            let season = null;
            try {
                const res = await fetch('/api/gamestats/season?league=' + encodeURIComponent(this.game.leagueKey) + '&athlete=' + encodeURIComponent(p.id), { credentials: 'same-origin' });
                if (res.ok) season = (await res.json()).season;
            } catch (_) { /* optional */ }
            this.seasonCache[key] = season;
        }
        const s = this.seasonCache[key];
        if (!s || this.selected !== p.id || !host.isConnected) return;
        host.innerHTML = `<h5>Season \u00b7 ${this.esc(String(s.title).replace(/career stats/i, '').trim())} ${this.esc(s.split)}</h5><div class="gs-kvs">${s.labels.map((l, i) => `<div class="gs-kv"><b>${this.esc(s.values[i])}</b><span>${this.esc(l)}</span></div>`).join('')}</div>`;
    },

    esc(v) {
        return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    injectStyles() {
        if (document.getElementById('gamestats-css')) return;
        const s = document.createElement('style');
        s.id = 'gamestats-css';
        s.textContent = `
.gamestats{box-sizing:border-box;position:absolute;left:12px;bottom:84px;z-index:20;min-width:210px;max-width:320px;max-height:calc(100% - 100px);overflow-y:auto;padding:8px 10px;
  background:rgba(12,14,20,.78);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.12);border-radius:10px;
  color:#fff;font:13px/1.35 Inter,system-ui,sans-serif;user-select:none;pointer-events:auto;transition:opacity .35s}
.gamestats[hidden]{display:none}
.gamestats.dim:not(:hover):not(.panel):not(.empty):not(.dragging){opacity:.42}
.gs-head{display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:4px;cursor:grab;touch-action:none}
.gs-head .gs-league,.gs-head .gs-status{opacity:.85}.gs-head .gs-status{margin-left:auto}
.gs-mini{display:none;font-weight:600;font-variant-numeric:tabular-nums}
.gs-min-btn,.gs-find-btn,.gs-unpin-btn,.gs-set-btn{width:22px;height:22px;padding:0;border:0;border-radius:5px;background:rgba(255,255,255,.1);color:#fff;font-size:11px;line-height:1;cursor:pointer;flex:none}
.gs-min-btn{font-size:14px}
.gs-min-btn:hover,.gs-find-btn:hover,.gs-unpin-btn:hover,.gs-set-btn:hover{background:rgba(255,255,255,.22)}
.gs-unpin-btn{background:rgba(91,217,140,.25)}
.gs-finder,.gs-settings,.gs-tstats{margin-top:6px;cursor:default;user-select:text}
.gs-finder[hidden],.gs-settings[hidden],.gs-tstats[hidden]{display:none}
.gs-fq{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:12px}
.gs-fhit{display:flex;align-items:baseline;gap:6px;width:100%;margin-top:3px;padding:4px 6px;border:0;border-radius:5px;background:rgba(255,255,255,.07);color:#fff;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gs-fhit:hover{background:rgba(255,255,255,.16)}
.gs-fstate{font-size:9px;font-weight:700;letter-spacing:.05em;opacity:.7;min-width:34px}.gs-fstate.live{color:#ff6b6b;opacity:1}
.gs-fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gs-fhit em{font-style:normal;font-size:10px;opacity:.55;white-space:nowrap}
.gs-settings label{display:flex;align-items:center;gap:8px;font-size:12px;padding:2px 0}
.gs-settings select{margin-left:auto;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:5px;font:inherit;font-size:12px;padding:2px 4px}
.gs-settings select option{color:#000}
.gamestats.empty{min-width:0;max-width:min(420px,92vw);padding:4px 8px;opacity:0;pointer-events:none}
#video-container:hover .gamestats.empty,.video-container:hover .gamestats.empty,.gamestats.empty.open{opacity:1;pointer-events:auto}
.gamestats.empty.open{min-width:320px}
.gamestats.empty .gs-head{margin:0}.gamestats.empty .gs-lineups,.gamestats.empty .gs-tstats{display:none}
@media (hover:none){.gamestats.empty{opacity:.5;pointer-events:auto}}
.gamestats.dragging{cursor:grabbing;opacity:.92}.gamestats.dragging .gs-head{cursor:grabbing}
.gamestats.min{min-width:0;max-width:none;padding:4px 8px}
.gamestats.min .gs-head{margin:0}.gamestats.min .gs-mini{display:inline}
.gamestats.min .gs-body,.gamestats.min .gs-lineups,.gamestats.min .gs-tstats{display:none}
.gs-league{font-weight:700;letter-spacing:.04em}
.gs-status.live{color:#ff6b6b;font-weight:700}
.gs-row{display:flex;align-items:center;gap:6px;padding:2px 0}
.gs-row.win .gs-name,.gs-row.win .gs-score{font-weight:700}
.gs-logo{width:18px;height:18px;object-fit:contain}
.gs-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-name i{font-style:normal;opacity:.6;font-size:11px}
.gs-rec{font-size:11px;opacity:.55}
.gs-score{min-width:28px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.gs-sit{margin-top:4px;font-size:11px;font-weight:600;color:#ffd166}
.gs-events{margin-top:4px;font-size:11px}.gs-events em{font-style:normal;opacity:.55}
.gs-line{margin-top:3px;font-size:10px;opacity:.65}
.gs-wp{display:flex;height:5px;margin-top:6px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,.12)}
.gs-wp-a{background:#6ea8fe}.gs-wp-h{background:#f0883e}
.gs-wp-l{display:flex;justify-content:space-between;font-size:10px;opacity:.7;margin-top:2px}
.gs-play{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.12);font-size:11px;opacity:.8}
.gs-btns{display:flex;gap:6px;margin-top:6px}.gs-btns:empty{display:none}
.gs-lineups-btn,.gs-tstats-btn{flex:1;padding:3px 0;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:11px;cursor:pointer}
.gs-lineups-btn:hover,.gs-tstats-btn:hover{background:rgba(255,255,255,.16)}
.gs-foot{margin-top:5px;font-size:9px;opacity:.5}.gs-upd.stale{color:#ffb454;opacity:1;font-weight:600}
.gs-ts-r{display:grid;grid-template-columns:1fr 1.4fr 1fr;gap:6px;font-size:12px;padding:1px 0;text-align:center}
.gs-ts-r span{font-size:10px;opacity:.6;align-self:center}.gs-ts-r b{font-variant-numeric:tabular-nums}.gs-ts-h b{opacity:.8}
.gs-lineups{margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);cursor:default;min-width:420px;user-select:text}
.gs-lineups[hidden]{display:none}
.gamestats:has(.gs-lineups:not([hidden])){max-width:min(520px,92vw)}
.gs-cols{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px}
.gs-q{width:100%;box-sizing:border-box;padding:5px 8px;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:12px}
.gs-hit{display:flex;align-items:baseline;gap:6px;width:100%;margin-top:3px;padding:3px 6px;border:0;border-radius:5px;background:rgba(255,255,255,.07);color:#fff;font:inherit;font-size:12px;text-align:left;cursor:pointer}
.gs-hit:hover{background:rgba(255,255,255,.16)}
.gs-hit b{min-width:22px;text-align:right;opacity:.75}.gs-hit span{flex:1}.gs-hit em{font-style:normal;font-size:10px;opacity:.55}
.gs-card{margin-top:6px;padding:8px;border-radius:8px;background:rgba(255,255,255,.07)}
.gs-card-h{display:flex;justify-content:space-between;gap:8px;margin-bottom:2px}.gs-card-h em{font-style:normal;font-size:11px;opacity:.6}
.gs-card h5{margin:8px 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.55}
.gs-kvs{display:flex;flex-wrap:wrap;gap:4px 10px}
.gs-kv{display:flex;flex-direction:column;align-items:center;min-width:34px}.gs-kv b{font-size:13px;font-variant-numeric:tabular-nums}.gs-kv span{font-size:9px;opacity:.55}
.gs-col{flex:1;min-width:150px}
.gs-col h4{margin:0 0 4px;font-size:12px}.gs-col h4 small{opacity:.6;font-weight:400}
.gs-col h5{margin:8px 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;opacity:.55}
.gs-p{display:flex;align-items:baseline;gap:6px;font-size:12px;padding:1px 0}
.gs-p b{min-width:20px;text-align:right;font-variant-numeric:tabular-nums;opacity:.75}
.gs-p span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-p em{font-style:normal;font-size:10px;opacity:.55}
.gs-p.out span{opacity:.5;text-decoration:line-through}.gs-p.in span::after{content:' \u2191';color:#5bd98c}
.gs-note{flex-basis:100%;font-size:10px;opacity:.55;margin-top:4px}
.gs-empty{opacity:.7;font-size:12px}
.gs-toast{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:30;padding:5px 12px;border-radius:8px;background:rgba(12,14,20,.85);color:#fff;font:12px Inter,system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .25s}
.gs-toast.show{opacity:1}
@media (max-width:640px){.gamestats{bottom:110px;left:8px;min-width:170px}.gs-lineups{min-width:0}.gs-cols{flex-direction:column}}
`;
        document.head.appendChild(s);
    }
};
if (typeof window !== 'undefined') {
    window.GameStats = GameStats;
    GameStats.init();
}
if (typeof module !== 'undefined') module.exports = GameStats;
