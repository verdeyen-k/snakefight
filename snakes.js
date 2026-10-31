// Snake Fight: 2 to 8 snakes on one field. Eat fruit to grow, crash and you're out. Last snake standing wins.
(() => {
  // ── The field ────────────────────────────────────────────────────────────
  const N = 36;                // the field is N x N cells
  const START_LEN = 4;
  const SHRINK_AFTER = 75;     // seconds before the walls start closing in
  const SHRINK_EVERY = 4;      // seconds between each wall step
  const MIN_ARENA = 12;

  const FRUITS = [
    { emoji: '🍎', grow: 1, weight: 40 },
    { emoji: '🍇', grow: 2, weight: 25 },
    { emoji: '🍊', grow: 3, weight: 17 },
    { emoji: '🍌', grow: 4, weight: 11 },
    { emoji: '🍉', grow: 5, weight: 7 },
  ];
  const COLORS = ['#ff5a5a', '#ff9f3d', '#ffe14d', '#5fd35f', '#3fd6c6', '#4d8dff', '#a46bff', '#ff6fc8'];
  const COLOR_NAMES = ['Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Purple', 'Pink'];
  const BOT_NAMES = ['Noodle', 'Zigzag', 'Hissy', 'Wiggles', 'Fang', 'Sir Squiggle', 'Slinky'];
  const MAX_PLAYERS = COLORS.length;
  const SPEEDS = { Slow: 160, Normal: 115, Fast: 80 };

  // Directions are numbers so they're easy to send: 0 up, 1 right, 2 down, 3 left. The opposite of d is (d + 2) % 4.
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // ── Online rooms ─────────────────────────────────────────────────────────
  // Bump with the ?v= on the script in index.html whenever what goes in the room changes.
  const VERSION = 1;
  const OUTDATED = 'That room is using a different version of Snake Fight. Everyone needs to refresh the page.';
  const ROOMS = 'snakefight/rooms';

  const db = window.firebase ? (firebase.initializeApp({
    apiKey:            'AIzaSyAsJboNGVuESMhkivllUD0o8MUB5LUCMRQ',
    authDomain:        'kvgames.firebaseapp.com',
    databaseURL:       'https://kvgames-default-rtdb.firebaseio.com',
    projectId:         'kvgames',
    storageBucket:     'kvgames.firebasestorage.app',
    messagingSenderId: '463308384695',
    appId:             '1:463308384695:web:5d57623ebd52101ad26032',
  }), firebase.database()) : null;
  let clockOffset = 0;  // server clock minus ours, so every device counts down to the same moment
  if (db) db.ref('.info/serverTimeOffset').on('value', s => { clockOffset = s.val() || 0; });
  const now = () => Date.now() + clockOffset;

  const $ = id => document.getElementById(id);
  const show = id => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
    if (id !== 'game') $('over').hidden = true;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const swatch = slot => `<span class="sw" style="background:${COLORS[slot]}"></span>`;
  const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

  const myId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  // The room is split in two: meta (players, phase: changes rarely) and live (the field and everyone's turns).
  // The host runs the whole game and sends the field after every step. Everyone else just sends their turns.
  let room = null;  // { code, ref, meta, inputs, joining, listeners }

  const playerList = meta => Object.entries((meta && meta.players) || {}).filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ id, ...p })).sort((a, b) => a.slot - b.slot);

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function busy(on) { for (const b of document.querySelectorAll('#menu button')) b.disabled = on; }
  function myName() {
    const name = $('name').value.trim().slice(0, 14);
    if (!name) { $('menu-error').textContent = 'Type your name first.'; $('name').focus(); return null; }
    store.set('snakefight-name', name);
    return name;
  }
  const NO_SERVER = "Can't reach the game server. Check the internet connection.";
  // How hard the computer snakes play in practice.
  const LEVELS = ['Very Easy', 'Easy', 'Medium', 'Hard', 'Insane'];
  const savedLevel = () => { const n = Number(store.get('snakefight-level') ?? 2); return LEVELS[n] ? n : 2; };
  let botLevel = 2;
  const savedSpeed = () => SPEEDS[store.get('snakefight-speed')] ? store.get('snakefight-speed') : 'Normal';

  async function createRoom(name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    try {
      let code, ref;
      for (let i = 0; i < 10; i++) {
        code = genCode();
        ref = db.ref(`${ROOMS}/${code}`);
        if (!(await ref.child('meta').get()).exists()) break;
      }
      await ref.set({ meta: { host: myId, v: VERSION, created: firebase.database.ServerValue.TIMESTAMP, phase: 'lobby', speed: savedSpeed(),
        players: { [myId]: { name, slot: 0 } } } });
      ref.onDisconnect().remove();
      await enterRoom(code, ref);
    } catch (e) {
      $('menu-error').textContent = "Couldn't create a room. Check the internet connection.";
    }
    busy(false);
  }

  async function joinRoom(code, name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    const ref = db.ref(`${ROOMS}/${code}`);
    try {
      const meta = await enterRoom(code, ref, true);
      const problem = !meta || !meta.host ? `There's no room ${code}.` : meta.v !== VERSION ? OUTDATED
        : meta.phase !== 'lobby' ? 'That game has already started. Wait for it to finish, then join.'
        : playerList(meta).length >= MAX_PLAYERS ? `That room is full (${MAX_PLAYERS} snakes).` : null;
      if (problem) throw new Error(problem);
      // A transaction, so two people joining at once can't take the same color.
      const res = await ref.child('meta/players').transaction(cur => {
        if (!cur) return;
        const taken = new Set(Object.values(cur).filter(p => p && p.name).map(p => p.slot));
        const slot = COLORS.findIndex((_, i) => !taken.has(i));
        if (slot < 0) return;
        cur[myId] = { name, slot };
        return cur;
      });
      if (!res.committed) throw new Error(`That room is full (${MAX_PLAYERS} snakes).`);
      ref.child(`meta/players/${myId}`).onDisconnect().remove();
      ref.child(`live/in/${myId}`).onDisconnect().remove();
      room.joining = false;
      render();
    } catch (e) {
      leaveRoom();
      show('menu');
      $('menu-error').textContent = e.message && !/^FIREBASE|permission/i.test(e.message) ? e.message
        : "Couldn't join. Check the code and the internet connection.";
    }
    busy(false);
  }

  // Start listening to the room. Resolves with its first meta, so a join can check it before taking a seat.
  function enterRoom(code, ref, joining = false) {
    leaveRoom();
    room = { code, ref, meta: null, inputs: {}, joining, listeners: [] };
    const r = room;
    const listen = (path, ev, fn) => { const q = ref.child(path); q.on(ev, fn); r.listeners.push([q, ev, fn]); };
    listen('live/in', 'value', snap => { if (room === r) r.inputs = snap.val() || {}; });
    listen('live/state', 'value', snap => { if (room === r) applyState(snap.val()); });
    return new Promise(resolve => {
      listen('meta', 'value', snap => {
        if (room !== r) return;
        r.meta = snap.val();
        if (resolve) { const f = resolve; resolve = null; f(r.meta); if (joining) return; }
        if (!r.joining) render();
      });
    });
  }
  function leaveRoom() {
    const r = room;
    stopGame();
    if (!r) return;
    room = null;
    for (const [q, ev, fn] of r.listeners) q.off(ev, fn);
    if (r.meta && r.meta.host === myId) { r.ref.onDisconnect().cancel(); r.ref.remove(); }
    else if (!r.joining) {
      for (const path of [`meta/players/${myId}`, `live/in/${myId}`]) { const c = r.ref.child(path); c.onDisconnect().cancel(); c.remove(); }
    }
  }

  function startOnline() {
    const meta = room && room.meta;
    if (!meta || meta.host !== myId || playerList(meta).length < 2) return;
    room.ref.child('live').remove();
    room.ref.child('meta').update({ phase: 'play', order: playerList(meta).map(p => p.id), startAt: now() + 3500, winner: null });
  }
  function playAgain() {
    if (game && !game.online) { startPractice(); return; }
    if (!room || !room.meta || room.meta.host !== myId) return;
    room.ref.child('live').remove();
    room.ref.child('meta').update({ phase: 'lobby', order: null, startAt: null, winner: null });
  }

  // ── The game ─────────────────────────────────────────────────────────────
  // game: { online, host, startAt, speed, tick, wall, foods, snakes, over, ... } — rebuilt for each game.
  // The host (or this device, in practice) moves every snake. Everyone else draws what the host sends.
  let game = null;

  // Snakes start spread around a ring, facing the middle.
  function spawn(k, n) {
    const a = (k / n) * Math.PI * 2 - Math.PI / 2;
    const cx = Math.round(N / 2 + Math.cos(a) * N * 0.36);
    const cy = Math.round(N / 2 + Math.sin(a) * N * 0.36);
    const dx = N / 2 - cx, dy = N / 2 - cy;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    const body = [];
    for (let i = 0; i < START_LEN; i++) body.push([cx - DIRS[dir][0] * i, cy - DIRS[dir][1] * i]);
    return { body, dir };
  }

  function newGame(online, host, startAt, speed, list) {
    stopGame();
    game = {
      online, host, startAt, speed, tick: 0, wall: 0, secs: 0, foods: [], over: null, timer: 0, turns: 0, sent: '',
      snakes: list.map((p, k) => ({
        pid: p.id, slot: p.slot, name: p.name, bot: !!p.bot, ...spawn(k, list.length),
        grow: 0, alive: true, place: 0, diedAt: 0, queue: [], handled: 0,
        greed: 0.6 + Math.random() * 0.8,  // how much a computer snake chases big fruit
        target: null,
      })),
    };
    if (host) {
      topUpFood();
      publish();
      const g = game;
      g.timer = setTimeout(() => loop(g), Math.max(0, startAt - now()));
    }
    $('over').hidden = true;
    renderBoard();
    updateStatus();
  }
  function stopGame() {
    if (game) clearTimeout(game.timer);
    game = null;
  }

  function startPractice() {
    leaveRoom();
    const bots = Number(store.get('snakefight-bots')) || 7;
    const list = [{ id: myId, slot: 0, name: 'You' }];
    for (let k = 1; k <= bots; k++) list.push({ id: 'bot' + k, slot: k, name: BOT_NAMES[k - 1], bot: true });
    newGame(false, true, now() + 3000, SPEEDS[savedSpeed()], list);
    show('game');
    resize();
  }

  const mine = () => game && game.snakes.find(s => s.pid === myId);
  const inside = (x, y) => x >= game.wall && y >= game.wall && x < N - game.wall && y < N - game.wall;
  const foodAt = (x, y) => game.foods.findIndex(f => f.x === x && f.y === y);

  function loop(g) {
    if (game !== g || g.over) return;
    step();
    publish();
    if (g.over) return;
    const me = mine();
    // Fast-forward a practice game once you're out.
    g.timer = setTimeout(() => loop(g), g.online || (me && me.alive) ? g.speed : g.speed / 2.5);
  }

  function pickFruit() {
    let r = Math.random() * FRUITS.reduce((s, f) => s + f.weight, 0);
    for (let k = 0; k < FRUITS.length; k++) if ((r -= FRUITS[k].weight) < 0) return k;
    return 0;
  }
  function occupied() {
    const grid = new Uint8Array(N * N);
    for (const s of game.snakes) if (s.alive) for (const [x, y] of s.body) if (inside(x, y)) grid[y * N + x] = 1;
    return grid;
  }
  function addFood(x, y, k) {
    if (inside(x, y) && foodAt(x, y) < 0) game.foods.push({ x, y, k });
  }
  function topUpFood() {
    const want = 8 + game.snakes.filter(s => s.alive).length * 1.5;
    const grid = occupied(), w = game.wall;
    for (let tries = 0; game.foods.length < want && tries < 500; tries++) {
      const x = w + Math.floor(Math.random() * (N - 2 * w)), y = w + Math.floor(Math.random() * (N - 2 * w));
      if (!grid[y * N + x]) addFood(x, y, pickFruit());
    }
  }

  // Turns sent by a player on another device: n counts every turn they've made, q holds the last few.
  function pullTurns(s) {
    const v = room && room.inputs && room.inputs[s.pid];
    if (!v || typeof v.q !== 'string') return;
    const fresh = Math.min(v.n - s.handled, v.q.length);
    if (fresh > 0) for (const c of v.q.slice(-fresh)) s.queue.push(+c);
    s.handled = v.n;
  }

  function step() {
    const g = game;
    g.tick++;
    g.secs = g.tick * g.speed / 1000;
    if (g.secs > SHRINK_AFTER && N - 2 * (g.wall + 1) >= MIN_ARENA && Math.floor((g.secs - SHRINK_AFTER) / SHRINK_EVERY) + 1 > g.wall) {
      g.wall++;
      g.foods = g.foods.filter(f => inside(f.x, f.y));
    }
    const alive = g.snakes.filter(s => s.alive);

    // 1. Everyone picks a direction. Turning straight back is ignored.
    for (const s of alive) {
      if (s.bot) { s.dir = botDir(s); continue; }
      if (g.online && s.pid !== myId) pullTurns(s);
      while (s.queue.length) {
        const d = s.queue.shift();
        if (d !== (s.dir + 2) % 4) { s.dir = d; break; }
      }
    }

    // 2. Everyone moves and eats.
    for (const s of alive) {
      const [hx, hy] = s.body[0];
      const head = [hx + DIRS[s.dir][0], hy + DIRS[s.dir][1]];
      s.body.unshift(head);
      const fi = foodAt(head[0], head[1]);
      if (fi >= 0) { s.grow += FRUITS[g.foods[fi].k].grow; g.foods.splice(fi, 1); }
      if (s.grow > 0) s.grow--;
      else s.body.pop();
    }

    // 3. Who crashed?
    const bodies = new Uint8Array(N * N);
    for (const s of alive) for (let i = 1; i < s.body.length; i++) {
      const [x, y] = s.body[i];
      if (x >= 0 && y >= 0 && x < N && y < N) bodies[y * N + x]++;
    }
    const dying = alive.filter(s => {
      const [x, y] = s.body[0];
      if (!inside(x, y) || bodies[y * N + x]) return true;
      // Head-to-head: the longest snake survives, ties all lose.
      return alive.some(o => o !== s && o.body[0][0] === x && o.body[0][1] === y && o.body.length >= s.body.length);
    });
    if (dying.length) {
      const place = alive.length - dying.length + 1;
      for (const s of dying) {
        s.alive = false;
        s.place = place;
        s.diedAt = g.tick;
        const [x, y] = s.body[0];
        if (x < 0 || y < 0 || x >= N || y >= N) s.body.shift();
        // A crashed snake turns into a trail of apples.
        s.body.forEach(([bx, by], i) => { if (i > 0 && i % 2 === 0) addFood(bx, by, 0); });
      }
    }

    const left = g.snakes.filter(s => s.alive);
    if (left.length <= 1) {
      if (left[0]) left[0].place = 1;
      g.over = { winner: left[0] ? left[0].pid : null };
      if (g.online) { publish(); room.ref.child('meta').update({ phase: 'over', winner: g.over.winner }); }
      else showOver();
    } else topUpFood();
    if (dying.length || g.tick % 5 === 0 || g.over) renderBoard();
    updateStatus();
  }

  // ── Sending the field ────────────────────────────────────────────────────
  // A cell is 2 base-36 characters (36 x 36 = 1296 cells, exactly what fits).
  const cellStr = (x, y) => (y * N + x).toString(36).padStart(2, '0');
  const strCell = s => { const c = parseInt(s, 36); return [c % N, Math.floor(c / N)]; };

  function publish() {
    const g = game;
    if (!g || !g.online || !g.host || !room) return;
    room.ref.child('live/state').set({
      t: g.tick, w: g.wall, c: Math.floor(g.secs),
      f: g.foods.map(f => cellStr(f.x, f.y) + f.k).join(''),
      s: g.snakes.map(s => `${s.dir}${s.alive ? 1 : 0}${s.place}` + s.body.map(([x, y]) => cellStr(x, y)).join('')),
    });
  }

  function applyState(v) {
    const g = game;
    if (!g || !g.online || g.host || !v || !v.s || v.t < g.tick) return;
    g.tick = v.t; g.wall = v.w || 0; g.secs = v.c || 0;
    g.foods = [];
    for (let i = 0; i + 3 <= (v.f || '').length; i += 3) { const [x, y] = strCell(v.f.slice(i, i + 2)); g.foods.push({ x, y, k: +v.f[i + 2] }); }
    let died = false;
    g.snakes.forEach((s, k) => {
      const str = v.s[k];
      if (typeof str !== 'string') return;
      const alive = str[1] === '1';
      if (s.alive && !alive) { s.diedAt = v.t; died = true; }
      s.dir = +str[0]; s.alive = alive; s.place = +str[2];
      s.body = [];
      for (let i = 3; i + 2 <= str.length; i += 2) s.body.push(strCell(str.slice(i, i + 2)));
    });
    if (died || v.t % 5 === 0) renderBoard();
    updateStatus();
  }

  // ── Computer snakes ──────────────────────────────────────────────────────
  // How hard they play, from Very Easy to Insane (Medium is how they always played). slip: chance of a random
  // turn; look: how far ahead they check for dead ends (0 = not at all); dodge: keep away from bigger heads;
  // hunt: how much they go for smaller snakes' heads; retarget: ticks between picking new fruit; noise: randomness.
  const SNAKE_LEVELS = [
    { slip: 0.2, look: 0, dodge: false, hunt: 0, retarget: 40, noise: 12 },
    { slip: 0.07, look: 1, dodge: false, hunt: 0, retarget: 25, noise: 8 },
    { slip: 0, look: 2, dodge: true, hunt: 30, retarget: 15, noise: 6 },
    { slip: 0, look: 3, dodge: true, hunt: 45, retarget: 6, noise: 2 },
    { slip: 0, look: 4, dodge: true, hunt: 80, retarget: 1, noise: 0 },
  ];
  function botDir(s) {
    const g = game, grid = occupied(), L = SNAKE_LEVELS[botLevel];
    // Tails that are about to move out of the way aren't really in the way.
    for (const o of g.snakes) if (o.alive && o.grow === 0) {
      const [tx, ty] = o.body[o.body.length - 1];
      if (inside(tx, ty)) grid[ty * N + tx] = 0;
    }
    const [hx, hy] = s.body[0];
    if (!s.target || foodAt(s.target.x, s.target.y) < 0 || g.tick % L.retarget === 0) s.target = chooseTarget(s);
    const walls = g.wall > 0 || g.secs > SHRINK_AFTER - 5;

    let best = s.dir, bestScore = -Infinity;
    const open = [];
    for (let d = 0; d < 4; d++) {
      if (d === (s.dir + 2) % 4) continue;
      const x = hx + DIRS[d][0], y = hy + DIRS[d][1];
      if (!inside(x, y) || grid[y * N + x]) continue;
      open.push(d);
      let score = 0;
      // Room to move: don't drive into a dead end.
      if (L.look) {
        const space = floodFill(grid, x, y, s.body.length * L.look + 10);
        if (space < s.body.length + 2) score -= 1000 - space * 10;
        else score += Math.min(space, 60);
      }
      // Stay away from heads of snakes that would win a bump.
      if (L.dodge) for (const o of g.snakes) {
        if (!o.alive || o === s) continue;
        const [ox, oy] = o.body[0];
        if (Math.abs(ox - x) + Math.abs(oy - y) === 1) score += o.body.length >= s.body.length ? -200 : L.hunt;
      }
      // Keep off the edges once the walls are moving.
      if (walls && Math.min(x - g.wall, y - g.wall, N - 1 - g.wall - x, N - 1 - g.wall - y) < 2) score -= 40;
      if (s.target) score -= (Math.abs(s.target.x - x) + Math.abs(s.target.y - y)) * 4;
      if (d === s.dir) score += 2;
      score += Math.random() * L.noise;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    if (open.length && Math.random() < L.slip) return open[Math.floor(Math.random() * open.length)];
    return best;
  }

  function chooseTarget(s) {
    const [hx, hy] = s.body[0];
    let best = null, bestScore = -Infinity;
    for (const f of game.foods) {
      const score = Math.pow(FRUITS[f.k].grow, s.greed) / (Math.abs(f.x - hx) + Math.abs(f.y - hy) + 1);
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  }

  function floodFill(grid, sx, sy, limit) {
    const seen = new Uint8Array(N * N);
    const stack = [sx, sy];
    seen[sy * N + sx] = 1;
    let count = 0;
    while (stack.length && count < limit) {
      const y = stack.pop(), x = stack.pop();
      count++;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        if (!inside(nx, ny)) continue;
        const k = ny * N + nx;
        if (seen[k] || grid[k]) continue;
        seen[k] = 1;
        stack.push(nx, ny);
      }
    }
    return count;
  }

  // ── Drawing ──────────────────────────────────────────────────────────────
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  let cell = 16;

  function resize() {
    const f = $('field');
    if ($('game').hidden) return;
    const size = Math.max(180, Math.min(f.clientWidth - 24, f.clientHeight - 8));
    cell = Math.max(4, Math.floor(size / N));
    const px = cell * N, dpr = devicePixelRatio || 1;
    canvas.width = px * dpr; canvas.height = px * dpr;
    canvas.style.width = canvas.style.height = px + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);

  const EMOJI_FONT = 'system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';

  function draw() {
    const g = game, px = cell * N;
    // Grass.
    ctx.fillStyle = '#2f6b45';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#2a6140';
    for (let y = 0; y < N; y++) for (let x = y % 2; x < N; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);

    // The closing walls.
    if (g.wall > 0) {
      const w = g.wall * cell;
      ctx.fillStyle = '#5a3b2a';
      ctx.fillRect(0, 0, px, w); ctx.fillRect(0, px - w, px, w);
      ctx.fillRect(0, 0, w, px); ctx.fillRect(px - w, 0, w, px);
      ctx.strokeStyle = '#ffb84d'; ctx.lineWidth = 2;
      ctx.strokeRect(w, w, px - 2 * w, px - 2 * w);
    }

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(cell * 0.95)}px ${EMOJI_FONT}`;
    for (const f of g.foods) ctx.fillText(FRUITS[f.k].emoji, f.x * cell + cell / 2, f.y * cell + cell / 2 + 1);

    // Crashed snakes first, so live ones draw on top.
    for (const s of [...g.snakes].sort((a, b) => a.alive - b.alive)) drawSnake(s);
  }

  function drawSnake(s) {
    if (!s.alive && game.tick - s.diedAt > 6) return;  // gone a moment after crashing
    if (!s.body.length) return;
    const color = COLORS[s.slot], c = i => s.body[i][0] * cell + cell / 2, r = i => s.body[i][1] * cell + cell / 2;
    ctx.globalAlpha = s.alive ? 1 : 0.4;
    ctx.strokeStyle = color;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.lineWidth = cell * 0.78;
    ctx.beginPath();
    ctx.moveTo(c(0), r(0));
    for (let i = 1; i < s.body.length; i++) ctx.lineTo(c(i), r(i));
    ctx.stroke();

    // Head with googly eyes.
    const cx = c(0), cy = r(0), [dx, dy] = DIRS[s.dir];
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(cx, cy, cell * 0.5, 0, Math.PI * 2); ctx.fill();
    for (const k of [-1, 1]) {
      const ex = cx + dx * cell * 0.15 - dy * k * cell * 0.22, ey = cy + dy * cell * 0.15 + dx * k * cell * 0.22;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(ex, ey, cell * 0.16, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath(); ctx.arc(ex + dx * cell * 0.05, ey + dy * cell * 0.05, cell * 0.08, 0, Math.PI * 2); ctx.fill();
    }
    if (s.pid === myId && s.alive) {  // a crown so you can spot yourself
      ctx.font = `${Math.round(cell * 0.8)}px ${EMOJI_FONT}`;
      ctx.fillText('👑', cx, cy - cell * 0.85);
    }
    ctx.globalAlpha = 1;
  }

  function renderBoard() {
    const list = [...game.snakes].sort((a, b) => (b.alive - a.alive) || (b.alive ? b.body.length - a.body.length : a.place - b.place));
    $('board').innerHTML = list.map(s => `<div class="chip${s.alive ? '' : ' dead'}${s.pid === myId ? ' me' : ''}">${swatch(s.slot)}`
      + `<span>${esc(s.name)}</span><b>${s.alive ? s.body.length : ordinal(s.place)}</b></div>`).join('');
  }

  function updateStatus() {
    const g = game, me = mine(), left = g.snakes.filter(s => s.alive).length;
    let text = `${left} snake${left === 1 ? '' : 's'} left`;
    if (me && !me.alive && !g.over) text = `You came ${ordinal(me.place)}. Watching…`;
    else if (g.wall > 0) text += ' · 🧱 Walls closing in!';
    else if (g.secs > SHRINK_AFTER - 10) text += ` · Walls move in ${Math.ceil(SHRINK_AFTER - g.secs)}…`;
    $('status').textContent = text;
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!game || $('game').hidden) return;
    const left = game.startAt - now();
    $('count').hidden = left < -600;
    $('count').textContent = left > 0 ? Math.ceil(left / 1000) : 'GO!';
    draw();
  }
  requestAnimationFrame(frame);

  // ── Screens ──────────────────────────────────────────────────────────────
  function showOver() {
    const g = game, o = g.over;
    if (!o) return;
    $('over').hidden = false;
    const w = o.winner && g.snakes.find(s => s.pid === o.winner);
    $('winner').innerHTML = !w ? 'Everyone crashed! Nobody wins. 💥' : w.pid === myId ? `${swatch(w.slot)} You win! 🏆` : `${swatch(w.slot)} ${esc(w.name)} wins! 🏆`;
    const me = mine();
    $('my-place').textContent = me && me.place > 1 ? `You came ${ordinal(me.place)} of ${g.snakes.length}.` : '';
    $('places').innerHTML = [...g.snakes].sort((a, b) => a.place - b.place).map(s =>
      `<li><span class="who">${swatch(s.slot)}<span class="pname">${esc(s.name)}</span></span><span class="muted">${ordinal(s.place)} · ${s.body.length} long</span></li>`).join('');
    const canAgain = !g.online || room.meta.host === myId;
    $('again').hidden = !canAgain;
    $('again-wait').hidden = canAgain;
  }

  function render() {
    const meta = room && room.meta;
    if (!room) { show('menu'); return; }
    if (!meta || !meta.host) { leaveRoom(); show('menu'); $('menu-error').textContent = 'The host left, so the room closed.'; return; }
    if (!meta.players || !meta.players[myId]) { leaveRoom(); show('menu'); $('menu-error').textContent = 'You left the room.'; return; }
    const players = playerList(meta), host = meta.host === myId;

    if (meta.phase === 'lobby') {
      stopGame();
      show('lobby');
      $('code').textContent = room.code;
      $('lobby-players').innerHTML = players.map(p => `<li>${swatch(p.slot)}<span class="pname">${esc(p.name)}</span>
        <span class="muted">${COLOR_NAMES[p.slot]}${p.id === meta.host ? ' · host' : ''}${p.id === myId ? ' · you' : ''}</span></li>`).join('');
      speedSeg($('room-speed'), meta.speed, host);
      $('start').hidden = !host;
      $('start').disabled = players.length < 2;
      $('start').textContent = players.length > 1 ? `Start (${players.length} snakes)` : 'Start (needs 2 snakes)';
      $('lobby-wait').hidden = host;
      return;
    }

    if (!game || !game.online || game.startAt !== meta.startAt) {
      const order = (meta.order ? Object.values(meta.order) : []).filter(Boolean);
      const list = order.map(id => ({ id, slot: meta.players[id] ? meta.players[id].slot : 0, name: meta.players[id] ? meta.players[id].name : '?' }));
      show('game');
      newGame(true, host, meta.startAt, SPEEDS[meta.speed] || SPEEDS.Normal, list);
    }
    show('game');
    resize();
    if (meta.phase === 'over') {
      if (!game.over) game.over = { winner: meta.winner || null };
      renderBoard();
      showOver();
    }
  }

  function speedSeg(el, value, enabled) {
    el.innerHTML = Object.keys(SPEEDS).map(k => `<button type="button" data-v="${k}" class="${k === value ? 'on' : ''}"${enabled ? '' : ' disabled'}>${k}</button>`).join('');
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  function turn(d) {
    const g = game, me = mine();
    if (!g || g.over || !me || !me.alive) return;
    if (g.host) { if (me.queue.length < 3) me.queue.push(d); return; }
    g.turns++;
    g.sent = (g.sent + d).slice(-4);
    room.ref.child(`live/in/${myId}`).set({ n: g.turns, q: g.sent });
  }

  const KEYS = { ArrowUp: 0, w: 0, W: 0, ArrowRight: 1, d: 1, D: 1, ArrowDown: 2, s: 2, S: 2, ArrowLeft: 3, a: 3, A: 3 };
  document.addEventListener('keydown', e => {
    if ($('game').hidden) return;
    if (!$('over').hidden) {
      if ((e.key === 'Enter' || e.key === ' ') && !$('again').hidden) { e.preventDefault(); playAgain(); }
      return;
    }
    if (e.key in KEYS) { e.preventDefault(); turn(KEYS[e.key]); }
  });
  for (const b of document.querySelectorAll('#pad button')) {
    b.addEventListener('pointerdown', e => { e.preventDefault(); turn(+b.dataset.dir); });
  }
  // Swipe anywhere on the field.
  let swipe = null;
  $('field').addEventListener('pointerdown', e => { swipe = [e.clientX, e.clientY]; });
  $('field').addEventListener('pointermove', e => {
    if (!swipe) return;
    const dx = e.clientX - swipe[0], dy = e.clientY - swipe[1];
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    swipe = [e.clientX, e.clientY];
  });
  for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, () => { swipe = null; });

  // How many computer snakes in practice, and how fast.
  const levelSeg = $('level');
  levelSeg.innerHTML = LEVELS.map((name, n) => `<button type="button" data-n="${n}">${name}</button>`).join('');
  const drawLevel = () => { botLevel = savedLevel(); for (const b of levelSeg.children) b.classList.toggle('on', Number(b.dataset.n) === botLevel); };
  levelSeg.onclick = e => { const b = e.target.closest('button'); if (b) { store.set('snakefight-level', b.dataset.n); drawLevel(); } };
  drawLevel();
  const botSeg = $('bot-count');
  botSeg.innerHTML = [1, 2, 3, 4, 5, 6, 7].map(n => `<button type="button" data-n="${n}">${n}</button>`).join('');
  const drawBots = () => { const n = Number(store.get('snakefight-bots')) || 7; for (const b of botSeg.children) b.classList.toggle('on', Number(b.dataset.n) === n); };
  botSeg.onclick = e => { const b = e.target.closest('button'); if (b) { store.set('snakefight-bots', b.dataset.n); drawBots(); } };
  drawBots();
  speedSeg($('practice-speed'), savedSpeed(), true);
  $('practice-speed').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    store.set('snakefight-speed', b.dataset.v);
    speedSeg($('practice-speed'), b.dataset.v, true);
  };
  $('room-speed').onclick = e => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !room || !room.meta || room.meta.host !== myId) return;
    store.set('snakefight-speed', b.dataset.v);
    room.ref.child('meta/speed').set(b.dataset.v);
  };

  // Some touchscreens say they have a mouse, so show the arrows whenever there's a touchscreen at all.
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) document.body.classList.add('touch');

  $('practice').onclick = startPractice;
  $('name').value = store.get('snakefight-name') || '';
  $('create').onclick = () => { const n = myName(); if (n) createRoom(n); };
  $('join').onclick = () => {
    const n = myName(); if (!n) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { $('menu-error').textContent = 'Room codes are 4 letters.'; return; }
    joinRoom(code, n);
  };
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  $('start').onclick = startOnline;
  $('again').onclick = playAgain;
  for (const id of ['lobby-leave', 'game-leave', 'over-leave']) $(id).onclick = () => { leaveRoom(); show('menu'); };
  window.addEventListener('pagehide', leaveRoom);

  // For testing: ?debug lets a test script reach the game.
  if (/[?&]debug\b/.test(location.search)) window.snakeGame = () => game;

  if (!db) $('menu-error').textContent = NO_SERVER;
  show('menu');
})();
