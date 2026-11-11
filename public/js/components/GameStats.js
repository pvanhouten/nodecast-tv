/**
 * GameStats: a small live-score overlay on the Live TV player.
 * Self-contained (injects its own CSS and DOM). It listens for the existing `channelChanged` event,
 * asks /api/gamestats about the channel name, and shows a scorebug if the title names a real game
 * (e.g. "NCAAB 6 Fairfield @ Wisconsin 8PM"). Drag the header to move it (double-click the header to reset),
 * the "-" button minimizes it to a one-line score pill, and "Lineups" opens player names/numbers plus search.
 * Position and minimized state are remembered in localStorage.
 */
const GameStats = {
    POLL_MS: 15000,
    RETRY_MS: 60000,
    timer: null,
    title: '',
    el: null,
    game: null,
    lineupsOpen: false,
    lineupTimer: null,
    query: '',
    selected: null,   // player id shown in the stat card
    playersData: null,
    playersAt: 0,
    seasonCache: {},
    min: false,
    channel: null,
    programs: new Map(), // channel name -> { title, desc } of its current EPG program (fed by the player)
    pos: null,        // { x, y } in px from the video container's top-left, or null = default corner

    init() {
        try {
            this.min = localStorage.getItem('gamestats-min') === '1';
            this.pos = JSON.parse(localStorage.getItem('gamestats-pos') || 'null');
        } catch (_) { /* storage unavailable: defaults */ }
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
        this.injectStyles();
        window.addEventListener('channelChanged', (e) => this.setChannel(e.detail));
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
        this.closeLineups();
        this.query = ''; this.selected = null; this.playersData = null; this.seasonCache = {};
        this.channel = channel || null;
        this.title = '';
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
        if (/\s(@|at|vs\.?|v)\s/i.test(text)) {
            try {
                const res = await fetch('/api/gamestats?title=' + encodeURIComponent(text), { credentials: 'same-origin' });
                if (res.ok) game = (await res.json()).game;
            } catch (_) { /* overlay is optional; ignore */ }
            if (channel !== this.channel || text !== this.title) return; // channel/program changed while waiting
        }
        this.render(game);
        this.timer = setTimeout(() => this.tick(), game && game.state !== 'post' ? this.POLL_MS : this.RETRY_MS);
    },

    container() {
        return document.getElementById('video-container');
    },

    render(game) {
        const host = this.container();
        if (!host) return;
        if (!game) { if (this.el) this.el.hidden = true; return; }
        if (!this.el || !host.contains(this.el)) {
            this.el = document.createElement('div');
            this.el.className = 'gamestats';
            // Keep double-clicks (and taps) on the overlay from reaching the player (fullscreen toggle).
            this.el.addEventListener('dblclick', (e) => e.stopPropagation());
            this.el.addEventListener('click', (e) => {
                if (e.target.closest('.gs-min-btn')) { this.toggleMin(); return; }
                if (e.target.closest('.gs-lineups-btn')) this.toggleLineups();
            });
            this.bindDrag();
            this.el.classList.toggle('min', this.min);
            host.appendChild(this.el);
            if (window.ResizeObserver) new ResizeObserver(() => this.applyPos()).observe(this.el);
        }
        this.el.hidden = false;
        // The lineups panel (search box, results, columns) is built once per game and never re-rendered by a
        // score refresh, otherwise the search box would lose focus/text every poll.
        if (!this.game || this.game.id !== game.id || !this.el.querySelector('.gs-lineups')) {
            this.query = ''; this.selected = null; this.playersData = null; this.seasonCache = {};
            this.el.innerHTML = `<div class="gs-top"></div>
                <div class="gs-lineups" hidden>
                  <div class="gs-search"><input type="search" class="gs-q" placeholder="Find player: name or #" autocomplete="off" spellcheck="false">
                    <div class="gs-results"></div></div>
                  <div class="gs-cols"></div></div>`;
            this.bindSearch();
            this.lineupsOpen = false;
            clearTimeout(this.lineupTimer);
        }
        const row = (t) => `
            <div class="gs-row${t.winner ? ' win' : ''}">
              ${t.logo ? `<img class="gs-logo" src="${this.esc(t.logo)}" alt="" referrerpolicy="no-referrer">` : ''}
              <span class="gs-name">${t.rank ? `<i>${t.rank}</i> ` : ''}${this.esc(t.name)}</span>
              <span class="gs-rec">${this.esc(t.record)}</span>
              <span class="gs-score">${this.esc(t.score)}</span>
            </div>`;
        const live = game.state === 'in';
        this.game = game;
        const canLineup = game.id && /^(soccer|ncaa-soccer|ncaam|ncaaw|nba|nfl|nhl|mlb)/.test(game.leagueKey || '');
        this.el.querySelector('.gs-top').innerHTML = `
            <div class="gs-head" title="Drag to move \u00b7 double-click to reset"><span class="gs-league">${this.esc(game.league)}</span>
              <span class="gs-mini">${this.esc(game.away.abbr || game.away.name)} ${this.esc(game.away.score)}\u2013${this.esc(game.home.score)} ${this.esc(game.home.abbr || game.home.name)}</span>
              <span class="gs-status${live ? ' live' : ''}">${this.esc(game.detail)}</span>
              <button type="button" class="gs-min-btn" title="${this.min ? 'Expand' : 'Minimize'}">${this.min ? '+' : '\u2013'}</button></div>
            <div class="gs-body">
              ${row(game.away)}${row(game.home)}
              ${game.lastPlay ? `<div class="gs-play">${this.esc(game.lastPlay)}</div>` : ''}
              ${canLineup ? `<button type="button" class="gs-lineups-btn">${this.lineupsOpen ? 'Hide lineups' : 'Lineups'}</button>` : ''}
            </div>`;
        this.applyPos();
    },

    toggleMin() {
        this.min = !this.min;
        this.el.classList.toggle('min', this.min);
        const b = this.el.querySelector('.gs-min-btn');
        if (b) { b.textContent = this.min ? '+' : '\u2013'; b.title = this.min ? 'Expand' : 'Minimize'; }
        try { localStorage.setItem('gamestats-min', this.min ? '1' : '0'); } catch (_) {}
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
            try { this.el.releasePointerCapture(e.pointerId); localStorage.setItem('gamestats-pos', JSON.stringify(this.pos)); } catch (_) {}
        };
        this.el.addEventListener('pointerup', end);
        this.el.addEventListener('pointercancel', end);
        this.el.addEventListener('dblclick', (e) => {
            if (!e.target.closest('.gs-head') || e.target.closest('button')) return;
            this.pos = null;
            try { localStorage.removeItem('gamestats-pos'); } catch (_) {}
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

    toggleLineups() {
        this.lineupsOpen = !this.lineupsOpen;
        const btn = this.el.querySelector('.gs-lineups-btn');
        const box = this.el.querySelector('.gs-lineups');
        if (btn) btn.textContent = this.lineupsOpen ? 'Hide lineups' : 'Lineups';
        if (box) box.hidden = !this.lineupsOpen;
        clearTimeout(this.lineupTimer);
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
        const teams = (data && data.teams) || [];
        if (!teams.length || !teams.some((t) => t.starters.length)) {
            box.innerHTML = '<div class="gs-empty">Lineups not posted yet</div>';
        } else {
            const p = (x) => `<div class="gs-p${x.out ? ' out' : ''}${x.in ? ' in' : ''}"><b>${this.esc(x.num)}</b><span>${this.esc(x.name)}</span><em>${this.esc(x.stat || x.pos)}</em></div>`;
            const col = (t) => `<div class="gs-col"><h4>${this.esc(t.name)}${t.formation ? ` <small>${this.esc(t.formation)}</small>` : ''}</h4>
                ${t.starters.map((x, i) => (x.unit && x.unit !== (t.starters[i - 1] || {}).unit ? `<h5>${this.esc(x.unit)}</h5>` : '') + p(x)).join('')}
                ${t.bench.length ? `<h5>Bench</h5>${t.bench.map((x) => p(x)).join('')}` : ''}</div>`;
            box.innerHTML = teams.map(col).join('') + (data.note ? `<div class="gs-note">${this.esc(data.note)}</div>` : '');
        }
        clearTimeout(this.lineupTimer);
        this.lineupTimer = setTimeout(() => this.loadLineups(), 30000);
    },

    // ---- Player search: type a name or jersey number, click a result for that player's stats ----
    bindSearch() {
        const input = this.el.querySelector('.gs-q');
        if (!input) return;
        // The page has global shortcuts (space, F, arrows); keep typing here from triggering them.
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
        return `<div class="gs-card"><div class="gs-card-h"><b>${p.num ? '#' + this.esc(p.num) + ' ' : ''}${this.esc(p.name)}</b>
            <em>${this.esc(p.team)}${p.pos ? ' \u00b7 ' + this.esc(p.pos) : ''}</em></div>
          ${groups.length ? groups.map((g) => `<h5>${this.esc(g.title)}</h5><div class="gs-kvs">${kv(g.stats)}</div>`).join('') : '<div class="gs-empty">No stats in this game yet</div>'}
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
  color:#fff;font:13px/1.35 Inter,system-ui,sans-serif;user-select:none;pointer-events:auto}
.gamestats[hidden]{display:none}
.gs-head{display:flex;align-items:center;gap:8px;font-size:11px;margin-bottom:4px;cursor:grab;touch-action:none}
.gs-head .gs-league,.gs-head .gs-status{opacity:.85}.gs-head .gs-status{margin-left:auto}
.gs-mini{display:none;font-weight:600;font-variant-numeric:tabular-nums}
.gs-min-btn{width:22px;height:22px;padding:0;border:0;border-radius:5px;background:rgba(255,255,255,.1);color:#fff;font-size:14px;line-height:1;cursor:pointer}
.gs-min-btn:hover{background:rgba(255,255,255,.22)}
.gamestats.dragging{cursor:grabbing;opacity:.92}.gamestats.dragging .gs-head{cursor:grabbing}
.gamestats.min{min-width:0;max-width:none;padding:4px 8px}
.gamestats.min .gs-head{margin:0}.gamestats.min .gs-mini{display:inline}
.gamestats.min .gs-body,.gamestats.min .gs-lineups{display:none}
.gs-league{font-weight:700;letter-spacing:.04em}
.gs-status.live{color:#ff6b6b;font-weight:700}
.gs-row{display:flex;align-items:center;gap:6px;padding:2px 0}
.gs-row.win .gs-name,.gs-row.win .gs-score{font-weight:700}
.gs-logo{width:18px;height:18px;object-fit:contain}
.gs-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gs-name i{font-style:normal;opacity:.6;font-size:11px}
.gs-rec{font-size:11px;opacity:.55}
.gs-score{min-width:28px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.gs-play{margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.12);font-size:11px;opacity:.8}
.gs-lineups-btn{margin-top:6px;width:100%;padding:3px 0;border:1px solid rgba(255,255,255,.2);border-radius:6px;background:rgba(255,255,255,.08);color:#fff;font:inherit;font-size:11px;cursor:pointer}
.gs-lineups-btn:hover{background:rgba(255,255,255,.16)}
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
.gs-note{flex-basis:100%;font-size:10px;opacity:.55}
.gs-empty{opacity:.7;font-size:12px}
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
