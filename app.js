/**
 * Chess Review Studio
 * - Stockfish 18 (WASM, runs in a Web Worker) for real engine analysis
 * - Game Analyst: coach comments, best-move arrow, engine lines, advantage graph
 * - Move classification via Expected Points (Chess.com-style thresholds)
 * - Accuracy via the open Lichess accuracy model (win% based, volatility weighted)
 * - Opening book detection (Lichess chess-openings dataset)
 */

const DEFAULT_PGN = `[Event "Paris"]
[Site "Paris FRA"]
[Date "1858.10.21"]
[Round "?"]
[White "Paul Morphy"]
[Black "Duke Karl / Count Isouard"]
[Result "1-0"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const SAMPLE_KASPAROV = `[Event "Wijk aan Zee"]
[Site "Wijk aan Zee NED"]
[Date "1999.01.20"]
[White "Garry Kasparov"]
[Black "Veselin Topalov"]
[Result "1-0"]

1. e4 d6 2. d4 Nf6 3. Nc3 g6 4. Be3 Bg7 5. Qd2 c6 6. f3 b5 7. Nge2 Nbd7 8. Bh6 Bxh6 9. Qxh6 Bb7 10. a3 e5 11. O-O-O Qe7 12. Kb1 a6 13. Nc1 O-O-O 14. Nb3 exd4 15. Rxd4 c5 16. Rd1 Nb6 17. g3 Kb8 18. Na5 Ba8 19. Bh3 d5 20. Qf4+ Ka7 21. Rhe1 d4 22. Nd5 Nbxd5 23. exd5 Qxd6 24. Rxd4 cxd4 25. Re7+ Kb6 26. Qxd4+ Kxa5 27. b4+ Ka4 28. Qc3 Qxd5 29. Ra7 Bb7 30. Rxb7 Qc4 31. Qxf6 Kxa3 32. Qxa6+ Kxb4 33. c3+ Kxc3 34. Qa1+ Kd2 35. Qb2+ Kd1 36. Bf1 Rd2 37. Rd7 Rxd7 38. Bxc4 bxc4 39. Qxh8 Rd3 40. Qa8 c3 41. Qa4+ Ke1 42. f4 f5 43. Kc1 Rd2 44. Qa7 1-0`;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_CP = 10000;

// ---------------------------------------------------------------------------
// Move classes (colours follow the Chess.com palette)
// ---------------------------------------------------------------------------
const CLASS_META = {
  brilliant:  { name: 'Brilliant',  symbol: '!!', bg: '#1baca6', fg: '#ffffff' },
  great:      { name: 'Great',      symbol: '!',  bg: '#5c8bb0', fg: '#ffffff' },
  best:       { name: 'Best',       symbol: '★',  bg: '#81b64c', fg: '#ffffff' },
  excellent:  { name: 'Excellent',  symbol: '👍', bg: '#96bc4b', fg: '#ffffff' },
  good:       { name: 'Good',       symbol: '✓',  bg: '#95b776', fg: '#ffffff' },
  book:       { name: 'Book',       symbol: '📖', bg: '#a88865', fg: '#ffffff' },
  inaccuracy: { name: 'Inaccuracy', symbol: '?!', bg: '#f7c631', fg: '#1b1a17' },
  mistake:    { name: 'Mistake',    symbol: '?',  bg: '#ffa459', fg: '#1b1a17' },
  miss:       { name: 'Miss',       symbol: '✕',  bg: '#ff7769', fg: '#ffffff' },
  blunder:    { name: 'Blunder',    symbol: '??', bg: '#fa412d', fg: '#ffffff' }
};
const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let chess = new Chess();
let board = null;
let movesData = [];          // one entry per half-move
let positions = [];          // FEN before move 0, after move 0, ... (length = moves + 1)
let positionEvals = [];      // engine result for every position (filled progressively)
let currentMoveIdx = -1;
let autoPlayTimer = null;
let isMuted = false;
let flipped = false;
let showBestArrow = false;
let reviewToken = 0;
let currentPgn = DEFAULT_PGN;
let currentExtra = {};
let gameMeta = { white: { name: 'White', rating: '1500' }, black: { name: 'Black', rating: '1500' }, acc: { w: null, b: null } };

const settings = { depth: 14, variant: 'lite' };
try {
  const d = parseInt(localStorage.getItem('csr_depth'), 10);
  if ([12, 14, 18].includes(d)) settings.depth = d;
  const v = localStorage.getItem('csr_variant');
  if (v === 'lite' || v === 'full') settings.variant = v;
} catch (e) { /* storage may be unavailable */ }

// ---------------------------------------------------------------------------
// Sound (one shared AudioContext – creating one per move exhausts the browser limit)
// ---------------------------------------------------------------------------
let audioCtx = null;
const playMoveSound = (isCapture = false) => {
  if (isMuted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = isCapture ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(isCapture ? 320 : 460, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.14);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.14);
  } catch (e) { /* audio can be blocked before user interaction */ }
};

// ---------------------------------------------------------------------------
// Evaluation maths
// ---------------------------------------------------------------------------
/** Win probability in percent (0-100) for the side the centipawn value favours. Lichess/Chess.com sigmoid. */
function winPct(cp) {
  const c = Math.max(-MATE_CP, Math.min(MATE_CP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}
/** Expected points 0-1 from the mover's point of view, given a White-perspective centipawn value. */
function movercp(cpWhite, color) { return color === 'w' ? cpWhite : -cpWhite; }
function expectedPoints(cpWhite, color) { return winPct(movercp(cpWhite, color)) / 100; }

function fmtEval(cp, mate) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return '#';
    return (mate > 0 ? '+M' : '-M') + Math.abs(mate);
  }
  const v = (Math.abs(cp) / 100).toFixed(1);
  return (cp > 0 ? '+' : cp < 0 ? '-' : '') + v;
}

// ---------------------------------------------------------------------------
// Stockfish 18 engine wrapper (Web Worker + UCI)
// ---------------------------------------------------------------------------
// Stockfish.js (nmrugg) is currently at Stockfish 18 – there is no 19.0.0 package, so those URLs always 404.
const SF_PRIMARY = { version: '18.0.0', major: '18' };
const SF_FALLBACK = { version: '17.1.0', major: '17' };

async function listPackageFiles(version) {
  const urls = [
    `https://data.jsdelivr.com/v1/package/npm/stockfish@${version}/flat`,
    `https://data.jsdelivr.com/v1/packages/npm/stockfish@${version}?structure=flat`
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (!r.ok) continue;
      const j = await r.json();
      const files = (j.files || []).map((f) => f.name);
      if (files.length) return files;
    } catch (e) { /* try next */ }
  }
  return null;
}

function pickEngineJs(files, major, variant) {
  const js = files.filter((f) => /\.js$/i.test(f) && /stockfish/i.test(f) && !/asm/i.test(f) && f.includes(major));
  if (variant === 'lite') return js.find((f) => /lite/i.test(f) && /single/i.test(f)) || null;
  return js.find((f) => /single/i.test(f) && !/lite/i.test(f)) || null;
}

async function buildCandidates(variant) {
  const cands = [];
  const addRemote = async (ver, label) => {
    const files = await listPackageFiles(ver.version);
    const paths = [];
    if (files) {
      const p = pickEngineJs(files, ver.major, variant);
      if (p) paths.push(p);
    }
    const guess = `/src/stockfish-${ver.major}${variant === 'lite' ? '-lite' : ''}-single.js`;
    if (!paths.includes(guess)) paths.push(guess);
    const hosts = variant === 'full'
      ? [`https://unpkg.com/stockfish@${ver.version}`, `https://cdn.jsdelivr.net/npm/stockfish@${ver.version}`] // jsDelivr refuses files > 50 MB
      : [`https://cdn.jsdelivr.net/npm/stockfish@${ver.version}`, `https://unpkg.com/stockfish@${ver.version}`];
    for (const h of hosts) for (const p of paths) cands.push({ url: h + p, label: `${label} (${h.includes('unpkg') ? 'unpkg' : 'jsDelivr'})`, shim: true, lite: variant === 'lite' });
  };
  // 1) Your own site first: same-origin worker, no CDN, no shim. Most reliable on mobile.
  const local = /^https?:/.test(location.protocol);
  const localUrl = (lite) => `stockfish/stockfish-${SF_PRIMARY.major}${lite ? '-lite' : ''}-single.js`;
  if (variant === 'full') {
    // Full (~94 MB) is only loaded from your own site. If its files are missing, fall back to Lite automatically.
    if (local) cands.push({ url: localUrl(false), label: `Stockfish ${SF_PRIMARY.major} Full (your site)`, shim: false, lite: false });
    variant = 'lite';
    if (local) cands.push({ url: localUrl(true), label: `Stockfish ${SF_PRIMARY.major} Lite (Full files not found)`, shim: false, lite: true });
  } else if (local) {
    cands.push({ url: localUrl(true), label: `Stockfish ${SF_PRIMARY.major} Lite (your site)`, shim: false, lite: true });
  }
  // 2) CDN fallbacks (Lite only)
  await addRemote(SF_PRIMARY, `Stockfish ${SF_PRIMARY.major}`);
  await addRemote(SF_FALLBACK, `Stockfish ${SF_FALLBACK.major} (fallback)`);
  return cands;
}

/**
 * Browsers refuse `new Worker(<cross-origin url>)`. We create a tiny same-origin blob worker which
 * importScripts() the engine from the CDN, and redirect the engine's .wasm download to the same CDN folder.
 */
function createShimWorker(jsUrl) {
  const dir = jsUrl.replace(/[^/]+$/, '');
  const src = `
    (function () {
      var DIR = ${JSON.stringify(dir)};
      function fix(u) {
        try {
          var s = (typeof u === 'string') ? u : ((u && u.url) || String(u));
          var m = s.match(/([^\\/?#]+\\.wasm)(?:[?#].*)?$/i);
          return m ? DIR + m[1] : u;
        } catch (e) { return u; }
      }
      if (self.fetch) { var _f = self.fetch.bind(self); self.fetch = function (u, o) { return _f(fix(u), o); }; }
      var _o = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { var a = Array.prototype.slice.call(arguments); a[1] = fix(u); return _o.apply(this, a); };
    })();
    importScripts(${JSON.stringify(jsUrl)});
  `;
  return new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
}

class StockfishEngine {
  constructor() {
    this.worker = null;
    this.name = '';
    this.label = '';
    this.variant = 'lite';
    this.handler = null;
    this.searching = false;
    this.chain = Promise.resolve();
    this.gen = 0;
    this.abortLoad = null;
  }

  terminate() {
    if (this.abortLoad) { const f = this.abortLoad; this.abortLoad = null; f(new Error('superseded')); }
    if (this.worker) { try { this.worker.terminate(); } catch (e) { /* noop */ } }
    this.worker = null;
    this.handler = null;
    this.searching = false;
    this.chain = Promise.resolve();
  }

  send(cmd) { if (this.worker) this.worker.postMessage(cmd); }

  async load(variant, onStatus) {
    this.terminate();
    const gen = ++this.gen;
    this.variant = variant;
    onStatus('Finding Stockfish 18 files…');
    const cands = await buildCandidates(variant);
    if (gen !== this.gen) throw new Error('superseded');
    let lastErr = null;
    this.failures = [];
    for (const c of cands) {
      if (gen !== this.gen) throw new Error('superseded');
      try {
        onStatus(`Loading ${c.label}…`);
        await this.start(c, variant === 'full' ? 300000 : 60000, gen);
        this.label = c.label;
        this.variant = c.lite ? 'lite' : variant;
        this.fellBack = variant === 'full' && !!c.lite;
        return;
      } catch (e) {
        if (gen !== this.gen) throw new Error('superseded');
        lastErr = e;
        this.failures.push(`${c.url.replace(/^https?:\/\//, '')} → ${e && e.message ? e.message : e}`);
        console.warn('Engine candidate failed:', c.url, e);
        if (this.worker) { try { this.worker.terminate(); } catch (e2) { /* noop */ } this.worker = null; }
      }
    }
    throw lastErr || new Error('Could not load Stockfish');
  }

  start(cand, timeoutMs, gen) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let stage = 0;
      let pinger = null;
      let timer = null;
      const getText = (ev) => (typeof ev.data === 'string' ? ev.data : (ev.data && ev.data.data) || '');
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(pinger);
        clearTimeout(timer);
        this.abortLoad = null;
        if (err) reject(err); else resolve();
      };
      this.abortLoad = finish;
      timer = setTimeout(() => finish(new Error('Engine load timeout')), timeoutMs);

      let w;
      try {
        w = cand.shim ? createShimWorker(cand.url) : new Worker(cand.url);
      } catch (e) { finish(e); return; }
      this.worker = w;

      w.onerror = (ev) => finish(new Error('Worker error: ' + (ev && ev.message ? ev.message : 'failed to load script')));
      w.onmessage = (ev) => {
        const text = getText(ev);
        if (!text) return;
        if (text.startsWith('id name')) this.name = text.replace('id name', '').trim();
        if (text.startsWith('uciok') && stage === 0) {
          stage = 1;
          clearInterval(pinger);
          w.postMessage('setoption name Hash value 32');
          w.postMessage('setoption name MultiPV value 2');
          w.postMessage('isready');
        } else if (text.startsWith('readyok') && stage === 1) {
          stage = 2;
          w.onmessage = (e2) => this.onLine(getText(e2));
          finish(null);
        }
      };
      // The engine may still be downloading its .wasm; keep asking until it answers.
      const ping = () => { try { w.postMessage('uci'); } catch (e) { /* noop */ } };
      ping();
      pinger = setInterval(ping, 1000);
    });
  }

  onLine(text) { if (this.handler) this.handler(text); }

  stop() { if (this.searching) this.send('stop'); }

  newGame() { this.chain = this.chain.then(() => { this.send('ucinewgame'); }); }

  /** Serialised search. Resolves with { lines:[{cp,mate,pv,depth}], best } in White's perspective. */
  analyze(fen, depth) {
    const job = this.chain.then(() => this.run(fen, depth));
    this.chain = job.catch(() => {});
    return job;
  }

  run(fen, depth) {
    return new Promise((resolve) => {
      const stm = fen.split(' ')[1] || 'w';
      const byPv = new Map();
      let done = false;
      const finishRun = (best) => {
        if (done) return;
        done = true;
        clearTimeout(w1); clearTimeout(w2);
        this.searching = false;
        this.handler = null;
        const lines = [...byPv.keys()].sort((a, b) => a - b).map((k) => byPv.get(k));
        resolve({ lines, best: best && best !== '(none)' ? best : null });
      };
      // watchdogs: ask the engine to stop, then give up on a stuck search
      const w1 = setTimeout(() => this.send('stop'), 90000);
      const w2 = setTimeout(() => finishRun(null), 105000);
      this.searching = true;
      this.handler = (text) => {
        if (text.startsWith('info') && text.includes(' pv ') && text.includes(' score ')) {
          if (/ (lowerbound|upperbound)/.test(text)) return;
          const sc = text.match(/ score (cp|mate) (-?\d+)/);
          if (!sc) return;
          const mpv = parseInt((text.match(/ multipv (\d+)/) || [0, 1])[1], 10);
          const d = parseInt((text.match(/ depth (\d+)/) || [0, 0])[1], 10);
          const pv = text.split(' pv ')[1].trim().split(/\s+/);
          const raw = parseInt(sc[2], 10);
          let cp; let mate = null;
          if (sc[1] === 'mate') {
            const whiteMate = stm === 'w' ? raw : -raw;
            mate = whiteMate;
            cp = (whiteMate > 0 ? 1 : -1) * (MATE_CP - Math.min(Math.abs(whiteMate), 500));
          } else {
            cp = stm === 'w' ? raw : -raw;
          }
          byPv.set(mpv, { cp, mate, pv, depth: d });
        } else if (text.startsWith('bestmove')) {
          finishRun(text.split(/\s+/)[1]);
        }
      };
      this.send('position fen ' + fen);
      this.send('go depth ' + depth);
    });
  }
}

const engine = new StockfishEngine();
let enginePromise = null;
let engineError = null;

function setEnginePill(state, text) {
  const $pill = $('#engineStatusPill');
  const styles = {
    loading: 'bg-[#302e2b] text-amber-300 border-amber-500/30',
    ready: 'bg-[#302e2b] text-emerald-400 border-emerald-500/30',
    error: 'bg-rose-950/60 text-rose-300 border-rose-700/60 cursor-pointer'
  };
  const icon = state === 'loading' ? '<i class="fa-solid fa-circle-notch fa-spin text-[9px]"></i>'
    : state === 'ready' ? '<i class="fa-solid fa-microchip text-[9px]"></i>'
      : '<i class="fa-solid fa-triangle-exclamation text-[9px]"></i>';
  $pill.attr('class', `text-[11px] font-semibold px-2 py-0.5 rounded-full border flex items-center gap-1.5 ${styles[state]}`)
    .html(`${icon}<span id="engineStatusText"></span>`);
  $('#engineStatusText').text(text);
}

function ensureEngine(force = false) {
  if (enginePromise && !force) return enginePromise;
  engineError = null;
  setEnginePill('loading', 'Loading Stockfish 18…');
  let p = null; // declared first: engine.load() calls the status callback synchronously (const here caused a TDZ crash)
  p = engine.load(settings.variant, (msg) => { if (p && enginePromise === p) $('#engineStatusText').text(msg); })
    .then(() => {
      if (enginePromise !== p) return;
      const name = engine.name || 'Stockfish';
      setEnginePill('ready', `${name} • ${engine.variant === 'full' ? 'Full' : 'Lite'}${engine.fellBack ? ' (Full files not found)' : ''}`);
    })
    .catch((err) => {
      if (enginePromise === p && !(err && err.message === 'superseded')) {
        engineError = err;
        setEnginePill('error', 'Engine failed – tap to retry');
      }
      throw err;
    });
  enginePromise = p;
  p.catch(() => { /* surfaced through engineError / reviewPGN */ });
  return p;
}

// ---------------------------------------------------------------------------
// Opening book (Lichess chess-openings dataset, matched by position)
// ---------------------------------------------------------------------------
const bookMap = new Map();
const fenKey = (fen) => fen.split(' ').slice(0, 3).join(' ');

async function loadOpeningBook() {
  const letters = ['a', 'b', 'c', 'd', 'e'];
  const bases = [
    (l) => `https://raw.githubusercontent.com/lichess-org/chess-openings/master/${l}.tsv`,
    (l) => `https://cdn.jsdelivr.net/gh/lichess-org/chess-openings@master/${l}.tsv`
  ];
  const rows = [];
  for (const l of letters) {
    for (const mk of bases) {
      try {
        const r = await fetch(mk(l));
        if (!r.ok) continue;
        const txt = await r.text();
        txt.split('\n').slice(1).forEach((line) => {
          const [eco, name, pgn] = line.split('\t');
          if (pgn && pgn.trim()) rows.push({ eco, name, pgn: pgn.trim() });
        });
        break;
      } catch (e) { /* try the next mirror */ }
    }
  }
  const prefixCache = new Map();
  const c = new Chess();
  for (let i = 0; i < rows.length; i++) {
    const tokens = rows[i].pgn.replace(/\d+\./g, ' ').trim().split(/\s+/);
    c.reset();
    let prefix = '';
    let ok = true;
    for (const t of tokens) {
      prefix += t + ' ';
      let fen = prefixCache.get(prefix);
      if (!fen) {
        if (!c.move(t, { sloppy: true })) { ok = false; break; }
        fen = c.fen();
        prefixCache.set(prefix, fen);
      } else {
        c.load(fen);
      }
    }
    if (ok) bookMap.set(fenKey(c.fen()), { eco: rows[i].eco, name: rows[i].name });
    // also register every position along the line so transpositions inside a line are "book"
    if (i % 120 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  // positions reached on the way to a named opening are book too
  prefixCache.forEach((fen) => {
    const k = fenKey(fen);
    if (!bookMap.has(k)) bookMap.set(k, { eco: '', name: '' });
  });
  return bookMap.size;
}
const bookReady = loadOpeningBook().catch((e) => { console.warn('Opening book unavailable', e); return 0; });

// ---------------------------------------------------------------------------
// Chess helpers
// ---------------------------------------------------------------------------
const MAT_VALS = { p: 1, n: 3, b: 3, r: 5, q: 9 };
function materialFromFen(fen) {
  let w = 0; let b = 0;
  for (const ch of fen.split(' ')[0]) {
    const lower = ch.toLowerCase();
    if (!MAT_VALS[lower]) continue;
    if (ch === lower) b += MAT_VALS[lower]; else w += MAT_VALS[lower];
  }
  return { w, b };
}
const moverMaterial = (fen, color) => { const m = materialFromFen(fen); return color === 'w' ? m.w - m.b : m.b - m.w; };

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

function playUci(fen, ucis, plies) {
  const c = new Chess(fen);
  for (let i = 0; i < Math.min(plies, ucis.length); i++) {
    if (!c.move(uciToMove(ucis[i]))) break;
  }
  return c.fen();
}

function uciToSan(fen, uci) {
  const c = new Chess(fen);
  const m = c.move(uciToMove(uci));
  return m ? m.san : uci;
}

function pvToSan(fen, pv, maxPlies = 6) {
  const c = new Chess(fen);
  const parts = [];
  let moveNo = parseInt(fen.split(' ')[5], 10) || 1;
  let color = c.turn();
  for (let i = 0; i < Math.min(pv.length, maxPlies); i++) {
    const m = c.move(uciToMove(pv[i]));
    if (!m) break;
    if (color === 'w') parts.push(`${moveNo}. ${m.san}`);
    else parts.push(i === 0 ? `${moveNo}... ${m.san}` : m.san);
    if (color === 'b') moveNo++;
    color = color === 'w' ? 'b' : 'w';
  }
  return parts.join(' ');
}

function evaluateTerminal(fen) {
  const c = new Chess(fen);
  if (!c.game_over()) return null;
  if (c.in_checkmate()) {
    const whiteWins = c.turn() === 'b';
    return { cp: whiteWins ? MATE_CP : -MATE_CP, mate: 0, lines: [], best: null, terminal: true };
  }
  return { cp: 0, mate: null, lines: [], best: null, terminal: true };
}

// ---------------------------------------------------------------------------
// Game analysis (engine pass)
// ---------------------------------------------------------------------------
const evalCache = new Map();

async function evaluatePosition(fen, depth, token) {
  const term = evaluateTerminal(fen);
  if (term) return term;
  const key = `${engine.variant}|${depth}|${fen}`;
  if (evalCache.has(key)) return evalCache.get(key);
  const res = await engine.analyze(fen, depth);
  if (!res.lines.length) return null;
  const out = { cp: res.lines[0].cp, mate: res.lines[0].mate, lines: res.lines, best: res.best || res.lines[0].pv[0], terminal: false, fen };
  if (token === reviewToken) evalCache.set(key, out); // a search cut short by "stop" must not be cached
  return out;
}

// ---------------------------------------------------------------------------
// Classification (Expected Points) – thresholds follow Chess.com's published model
//   Best: engine's top move   Excellent <= .02   Good <= .05
//   Inaccuracy <= .10   Mistake <= .20   Blunder > .20
// ---------------------------------------------------------------------------
function classifyAll() {
  const out = [];
  for (let i = 0; i < movesData.length; i++) {
    const m = movesData[i];
    const before = positionEvals[i];
    const after = positionEvals[i + 1];
    const color = m.turn;
    const sign = color === 'w' ? 1 : -1;

    const bestLine = before.lines[0] || null;
    const epBest = bestLine ? expectedPoints(bestLine.cp, color) : expectedPoints(before.cp, color);
    const playedLine = before.lines.find((l) => l.pv[0] === m.uci) || null;
    const isBest = !!bestLine && bestLine.pv[0] === m.uci;

    let epPlayed;
    if (after && after.terminal) epPlayed = expectedPoints(after.cp, color);
    else if (isBest) epPlayed = epBest;
    else if (playedLine) epPlayed = expectedPoints(playedLine.cp, color);
    else epPlayed = after ? expectedPoints(after.cp, color) : epBest;

    const loss = isBest ? 0 : Math.max(0, epBest - epPlayed);
    const epBefore = epBest;
    const prevLoss = i > 0 ? out[i - 1].loss : 0;

    // book
    let bookHit = null;
    if (m.bookEligible) {
      const hit = bookMap.get(fenKey(m.fen));
      if (hit) bookHit = hit;
    }

    let key;
    if (bookHit) {
      key = 'book';
    } else if (isBest || loss <= 0.0005) {
      key = 'best';
      // Great: the only move that holds the position / clearly best
      const second = before.lines[1] || null;
      const gap = second ? epBest - expectedPoints(second.cp, color) : 0;
      const prev = i > 0 ? movesData[i - 1] : null;
      const isRecapture = !!(prev && prev.captured && m.captured && prev.to === m.to);
      if (second && gap >= 0.15 && epBefore < 0.92 && !isRecapture) key = 'great';

      // Brilliant: a real material sacrifice that still keeps the position good
      if (loss <= 0.01 && epPlayed >= 0.5 && epBefore <= 0.92 && after && !after.terminal && m.piece !== 'p') {
        const pv = after.lines[0] ? after.lines[0].pv : [];
        let t = Math.min(4, pv.length);
        if (t > 1 && t % 2 === 1) t -= 1;
        const fenAfterSeq = playUci(m.fen, pv, t);
        const matBefore = moverMaterial(positions[i], color);
        const matAfter = moverMaterial(fenAfterSeq, color);
        if (matBefore - matAfter >= 3) key = 'brilliant';
      }
    } else if (loss <= 0.02) {
      key = 'excellent';
    } else if (loss <= 0.05) {
      key = 'good';
    } else if (loss <= 0.10) {
      key = 'inaccuracy';
    } else if (loss <= 0.20) {
      key = prevLoss >= 0.10 ? 'miss' : 'mistake';
    } else {
      key = 'blunder';
    }

    // best alternative (only meaningful when the played move was not the engine's choice)
    const bestUci = bestLine ? bestLine.pv[0] : null;
    const bestSan = bestUci && bestUci !== m.uci ? uciToSan(positions[i], bestUci) : null;

    out.push({ key, loss, epBefore, epPlayed, isBest, bestUci, bestSan, sign });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Accuracy – Lichess open model (win% drop per move, volatility-weighted + harmonic mean)
// ---------------------------------------------------------------------------
function moveAccuracy(winBefore, winAfter) {
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * (winBefore - winAfter)) - 3.166924740191411 + 1;
  return Math.max(0, Math.min(100, raw));
}

function stdDev(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length);
}

function computeAccuracies(cls) {
  const allWin = positionEvals.map((e) => winPct(e.cp)); // White perspective, length = moves + 1
  const n = allWin.length;
  const windowSize = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const windows = [];
  const first = allWin.slice(0, windowSize);
  for (let i = 0; i < Math.min(n, windowSize) - 2; i++) windows.push(first);
  for (let i = 0; i + windowSize <= n; i++) windows.push(allWin.slice(i, i + windowSize));
  const weights = windows.map((w) => Math.max(0.5, Math.min(12, stdDev(w))));

  const acc = { w: [], b: [] };
  movesData.forEach((m, i) => {
    const color = m.turn;
    const wBefore = 100 * cls[i].epBefore; // mover perspective
    const wAfter = 100 * cls[i].epPlayed;
    const a = moveAccuracy(wBefore, wAfter);
    const weight = weights[i] !== undefined ? weights[i] : 0.5;
    acc[color].push({ a, weight });
  });

  const finalize = (list) => {
    if (!list.length) return null;
    const wSum = list.reduce((s, x) => s + x.weight, 0);
    const weighted = list.reduce((s, x) => s + x.a * x.weight, 0) / wSum;
    const harmonic = list.length / list.reduce((s, x) => s + 1 / Math.max(x.a, 0.0001), 0);
    return (weighted + harmonic) / 2;
  };
  return { w: finalize(acc.w), b: finalize(acc.b) };
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------
function badgeHtml(key, small = true) {
  const m = CLASS_META[key];
  if (!m) return '';
  return `<span class="inline-flex items-center justify-center rounded-full font-bold ${small ? 'text-[10px] min-w-[20px] h-5 px-1' : 'text-xs min-w-[24px] h-6 px-1.5'}" style="background:${m.bg};color:${m.fg}">${m.symbol}</span>`;
}

function updateEvalBar(cp, mate) {
  const pct = cp === null || cp === undefined ? 50 : winPct(cp);
  const whitePercent = Math.min(97, Math.max(3, pct));
  $('#evalWhiteBar').css('height', `${whitePercent}%`);
  $('#evalBlackBar').css('height', `${100 - whitePercent}%`);
  if (cp === null || cp === undefined) {
    $('#evalWhiteText').text('');
    $('#evalBlackText').text('');
    return;
  }
  const label = fmtEval(Math.abs(cp), mate === null || mate === undefined ? null : Math.abs(mate)).replace(/^[+-]/, '');
  if (cp >= 0) {
    $('#evalWhiteText').text(label === '0.0' ? '0.0' : label);
    $('#evalBlackText').text('');
  } else {
    $('#evalBlackText').text(label);
    $('#evalWhiteText').text('');
  }
}

function setStatus(kind, text) {
  const styles = {
    waiting: ['text-slate-300 bg-[#302e2b] border-slate-700/60', 'bg-slate-400'],
    analyzing: ['text-amber-300 bg-amber-950/50 border-amber-900/60', 'bg-amber-300 animate-pulse'],
    done: ['text-emerald-400 bg-emerald-950/50 border-emerald-900/60', 'bg-emerald-400'],
    error: ['text-rose-300 bg-rose-950/50 border-rose-900/60', 'bg-rose-400']
  };
  const [box, dot] = styles[kind];
  $('#reviewStatusBadge').attr('class', `flex items-center gap-1.5 text-[11px] border px-2.5 py-0.5 rounded-full font-medium ${box}`)
    .html(`<span class="w-1.5 h-1.5 rounded-full ${dot}"></span><span id="reviewStatusText">${text}</span>`);
}

function setProgress(done, total, depth) {
  const pct = Math.round((done / total) * 100);
  $('#analysisProgress').removeClass('hidden');
  $('#analysisProgressText').text(`Analyzing position ${done}/${total} • depth ${depth}`);
  $('#analysisProgressPct').text(`${pct}%`);
  $('#analysisProgressBar').css('width', `${pct}%`);
}

function renderPlayers() {
  const w = gameMeta.white; const b = gameMeta.black;
  const fmt = (v) => (v === null || v === undefined ? '--%' : `${v.toFixed(1)}%`);
  const top = flipped ? { p: w, acc: gameMeta.acc.w } : { p: b, acc: gameMeta.acc.b };
  const bottom = flipped ? { p: b, acc: gameMeta.acc.b } : { p: w, acc: gameMeta.acc.w };
  $('#topPlayerName').text(top.p.name);
  $('#topPlayerRating').text(`(${top.p.rating})`);
  $('#topPlayerAccuracy').text(`Acc: ${fmt(top.acc)}`);
  $('#bottomPlayerName').text(bottom.p.name);
  $('#bottomPlayerRating').text(`(${bottom.p.rating})`);
  $('#bottomPlayerAccuracy').text(`Acc: ${fmt(bottom.acc)}`);
  // the king icon colour follows the colour that sits on that side
  $('#topPlayerCard > div:first-child > div:first-child').attr('class', `w-8 h-8 rounded-lg border flex items-center justify-center ${flipped ? 'bg-slate-200 border-slate-300' : 'bg-[#302e2b] border-slate-700'}`);
  $('#topPlayerCard i.fa-chess-king').attr('class', `fa-solid fa-chess-king text-base ${flipped ? 'text-slate-800' : 'text-slate-400'}`);
  $('#bottomPlayerCard > div:first-child > div:first-child').attr('class', `w-8 h-8 rounded-lg border flex items-center justify-center ${flipped ? 'bg-[#302e2b] border-slate-700' : 'bg-slate-200 border-slate-300'}`);
  $('#bottomPlayerCard i.fa-chess-king').attr('class', `fa-solid fa-chess-king text-base ${flipped ? 'text-slate-400' : 'text-slate-800'}`);

  $('#summaryWhiteName').text(w.name);
  $('#summaryBlackName').text(b.name);
  $('#countsWhiteName').text(w.name);
  $('#countsBlackName').text(b.name);
  $('#summaryWhiteAcc').text(fmt(gameMeta.acc.w));
  $('#summaryBlackAcc').text(fmt(gameMeta.acc.b));
  $('#barWhiteAcc').css('width', gameMeta.acc.w === null ? '0%' : `${gameMeta.acc.w}%`);
  $('#barBlackAcc').css('width', gameMeta.acc.b === null ? '0%' : `${gameMeta.acc.b}%`);
}

function renderClassCounts() {
  const counts = { w: {}, b: {} };
  CLASS_ORDER.forEach((k) => { counts.w[k] = 0; counts.b[k] = 0; });
  movesData.forEach((m) => { if (m.cls) counts[m.turn][m.cls.key]++; });
  const html = CLASS_ORDER.map((k) => {
    const meta = CLASS_META[k];
    const cw = counts.w[k]; const cb = counts.b[k];
    return `<div class="grid grid-cols-12 items-center py-1.5 text-xs">
      <div class="col-span-6 flex items-center gap-2 text-slate-300">${badgeHtml(k)}<span>${meta.name}</span></div>
      <div class="col-span-3 text-center font-mono ${cw ? 'text-slate-100 font-bold' : 'text-slate-600'}">${cw}</div>
      <div class="col-span-3 text-center font-mono ${cb ? 'text-slate-100 font-bold' : 'text-slate-600'}">${cb}</div>
    </div>`;
  }).join('');
  $('#classCounts').html(html);
}

// Advantage graph --------------------------------------------------------------
function renderGraph() {
  const svg = document.getElementById('evalGraph');
  if (!svg) return;
  const total = Math.max(1, movesData.length);
  const pts = [];
  for (let i = 0; i < positionEvals.length; i++) {
    if (!positionEvals[i]) break;
    pts.push([(i / total) * 100, 100 - winPct(positionEvals[i].cp)]);
  }
  let html = '<line x1="0" y1="50" x2="100" y2="50" stroke="#4a4742" stroke-width="1" vector-effect="non-scaling-stroke"/>';
  if (pts.length > 1) {
    const d = `M0,100 L${pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' L')} L${pts[pts.length - 1][0].toFixed(2)},100 Z`;
    html = `<path d="${d}" fill="#e9e8e2"/>` + html;
  }
  const cx = ((currentMoveIdx + 1) / total) * 100;
  html += `<line x1="${cx}" y1="0" x2="${cx}" y2="100" stroke="#81b64c" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  svg.innerHTML = html;
}

// Arrows ----------------------------------------------------------------------
function squareCenter(sq) {
  const el = $(`#board .square-${sq}`)[0];
  const wrap = document.getElementById('boardWrap');
  if (!el || !wrap) return null;
  const r = el.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  return { x: r.left - w.left + r.width / 2, y: r.top - w.top + r.height / 2, size: r.width };
}

function renderArrow() {
  const svg = document.getElementById('arrowLayer');
  const wrap = document.getElementById('boardWrap');
  if (!svg || !wrap) return;
  svg.innerHTML = '';
  if (!showBestArrow || !movesData.length || !positionEvals.length) return;

  let uci = null;
  if (currentMoveIdx >= 0 && movesData[currentMoveIdx].cls && !movesData[currentMoveIdx].cls.isBest && movesData[currentMoveIdx].cls.bestUci
    && !['book', 'best', 'great', 'brilliant'].includes(movesData[currentMoveIdx].cls.key)) {
    uci = movesData[currentMoveIdx].cls.bestUci;      // what should have been played
  } else {
    const ev = positionEvals[currentMoveIdx + 1];       // best continuation from here
    if (ev && ev.lines && ev.lines[0]) uci = ev.lines[0].pv[0];
  }
  if (!uci) return;
  const a = squareCenter(uci.slice(0, 2));
  const b = squareCenter(uci.slice(2, 4));
  if (!a || !b) return;
  const w = wrap.clientWidth; const h = wrap.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len; const uy = dy / len;
  const head = a.size * 0.42;
  const sw = a.size * 0.17;
  const x1 = a.x + ux * a.size * 0.25; const y1 = a.y + uy * a.size * 0.25;
  const x2 = b.x - ux * head * 0.6; const y2 = b.y - uy * head * 0.6;
  const px = -uy; const py = ux;
  const tip = `${b.x},${b.y}`;
  const l = `${b.x - ux * head + px * head * 0.6},${b.y - uy * head + py * head * 0.6}`;
  const r = `${b.x - ux * head - px * head * 0.6},${b.y - uy * head - py * head * 0.6}`;
  svg.innerHTML = `<g opacity="0.85" fill="#81b64c" stroke="#81b64c">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${sw}" stroke-linecap="round"/>
    <polygon points="${tip} ${l} ${r}" stroke="none"/></g>`;
}

// Coach / Game Analyst --------------------------------------------------------
function coachSentence(m) {
  const k = m.cls.key;
  const san = `<b class="text-white">${m.san}</b>`;
  switch (k) {
    case 'brilliant': return `${san} is brilliant! A strong sacrifice that keeps the position healthy.`;
    case 'great': return `${san} is a great move — it was the key move in this position.`;
    case 'best': return `${san} is the best move.`;
    case 'excellent': return `${san} is an excellent move.`;
    case 'good': return `${san} is a good move.`;
    case 'book': return `${san} is a book move.`;
    case 'inaccuracy': return `${san} is an inaccuracy.`;
    case 'mistake': return `${san} is a mistake.`;
    case 'miss': return `${san} is a miss — you let a chance slip after your opponent's error.`;
    case 'blunder': return `${san} is a blunder.`;
    default: return san;
  }
}

function renderCoach() {
  const $body = $('#coachBody');
  const $lines = $('#engineLines');
  const posIdx = currentMoveIdx + 1;
  const ev = positionEvals[posIdx];

  // opening name
  let opening = '';
  for (let i = currentMoveIdx; i >= 0; i--) { if (movesData[i].opening) { opening = movesData[i].opening; break; } }
  $('#openingName').text(opening);

  if (!movesData.length) { $body.text('Load a game to see the analysis.'); $lines.addClass('hidden'); return; }

  if (currentMoveIdx === -1) {
    $body.html(ev ? `Starting position. Engine evaluation: <b class="text-white font-mono">${fmtEval(ev.cp, ev.mate)}</b>` : 'Starting position.');
  } else {
    const m = movesData[currentMoveIdx];
    if (!m.cls) {
      $body.html(`<b class="text-white">${m.san}</b> — analysis in progress…`);
    } else {
      const k = m.cls.key;
      const meta = CLASS_META[k];
      let html = `<div class="flex items-start gap-2">${badgeHtml(k, false)}<div class="flex-1">${coachSentence(m)}`;
      const before = positionEvals[currentMoveIdx];
      const bestLine = before && before.lines[0];
      const sign = m.turn === 'w' ? 1 : -1;
      if (['inaccuracy', 'mistake', 'miss', 'blunder'].includes(k) && m.cls.bestSan) {
        html += `<div class="mt-1 text-slate-400">Best was <b class="text-emerald-300">${m.cls.bestSan}</b>.</div>`;
        if (bestLine && bestLine.mate !== null && bestLine.mate * sign > 0) {
          html += `<div class="mt-1 text-rose-300">You missed a forced mate in ${Math.abs(bestLine.mate)}.</div>`;
        }
      }
      if (ev && ev.lines[0] && ev.lines[0].mate !== null && ev.lines[0].mate * sign < 0 && !ev.terminal) {
        html += `<div class="mt-1 text-rose-300">This allows a forced mate in ${Math.abs(ev.lines[0].mate)}.</div>`;
      }
      html += `<div class="mt-1 text-slate-500">Evaluation: <span class="font-mono text-slate-300">${ev ? fmtEval(ev.cp, ev.mate) : '…'}</span> • Expected-points loss: <span class="font-mono text-slate-300">${(m.cls.loss * 100).toFixed(1)}</span></div>`;
      html += '</div></div>';
      $body.html(html);
    }
  }

  // engine lines for the position now on the board
  if (ev && ev.lines && ev.lines.length) {
    const fen = positions[posIdx];
    const rows = ev.lines.slice(0, 2).map((l) => {
      const sanLine = pvToSan(fen, l.pv, 6);
      const tone = l.cp >= 0 ? 'bg-[#e9e8e2] text-slate-900' : 'bg-[#302e2b] text-slate-100';
      return `<div class="flex items-start gap-2 text-[11px]"><span class="font-mono font-bold px-1.5 py-0.5 rounded ${tone} flex-shrink-0">${fmtEval(l.cp, l.mate)}</span><span class="font-mono text-slate-400 leading-snug">${sanLine}</span></div>`;
    }).join('');
    $lines.html(`<div class="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Engine lines • depth ${ev.lines[0].depth}</div>${rows}`).removeClass('hidden');
  } else {
    $lines.addClass('hidden');
  }

  $('#btnBestArrowText').text(showBestArrow ? 'Hide best move' : 'Show best move');
}

// Move list -----------------------------------------------------------------------
function renderMoveHistoryTable() {
  const $list = $('#moveList');
  $list.empty();
  if (!movesData.length) return;

  let moveNo = parseInt(positions[0].split(' ')[5], 10) || 1;
  const rows = [];
  movesData.forEach((m, idx) => {
    if (m.turn === 'w') {
      rows.push({ no: moveNo, w: idx, b: null });
    } else {
      const last = rows[rows.length - 1];
      if (last && last.w !== null && last.b === null) last.b = idx;
      else rows.push({ no: moveNo, w: null, b: idx });
      moveNo++;
    }
  });

  const cell = (idx) => {
    if (idx === null) return '<div class="col-span-5 p-1"></div>';
    const m = movesData[idx];
    const badge = m.cls ? badgeHtml(m.cls.key) : '';
    return `<div class="col-span-5 move-cell flex items-center justify-between pr-2 p-1 rounded hover:bg-[#363430]" data-idx="${idx}">
      <span class="text-slate-200 font-semibold">${m.san}</span>${badge}</div>`;
  };

  rows.forEach((r) => {
    $list.append(`<div class="move-row grid grid-cols-12 py-1.5 px-2.5 hover:bg-[#302e2b] cursor-pointer items-center transition">
      <div class="col-span-2 text-slate-500 font-bold">${r.no}.</div>${cell(r.w)}${cell(r.b)}</div>`);
  });

  $('.move-cell').on('click', function () {
    const idx = parseInt($(this).attr('data-idx'), 10);
    if (!isNaN(idx)) jumpToMove(idx);
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function jumpToMove(idx, silent = false) {
  currentMoveIdx = idx;

  $('#board .square-55d63').removeClass('highlight-from highlight-to');
  $('#badgeOverlay').hide();
  $('.move-cell').removeClass('active-move');
  $('.move-row').removeClass('active');

  const posIdx = idx + 1;
  const ev = positionEvals[posIdx];

  if (idx === -1) {
    chess = new Chess(positions[0]);
    board.position(positions[0], true);
  } else {
    const item = movesData[idx];
    chess.load(item.fen);
    board.position(item.fen, true);
    if (!silent) playMoveSound(item.captured);

    $(`#board .square-${item.from}`).addClass('highlight-from');
    $(`#board .square-${item.to}`).addClass('highlight-to');

    if (item.cls) {
      const sq = $(`#board .square-${item.to}`)[0];
      const wrap = document.getElementById('boardWrap');
      if (sq && wrap) {
        const r = sq.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        const meta = CLASS_META[item.cls.key];
        $('#badgeOverlay')
          .html(`<span class="inline-flex items-center justify-center rounded-full font-bold shadow-lg border border-black/20 text-[11px] min-w-[22px] h-[22px] px-1" style="background:${meta.bg};color:${meta.fg}">${meta.symbol}</span>`)
          .css({ top: r.top - w.top - 8, left: r.right - w.left - 16, display: 'block' });
      }
    }

    $(`.move-cell[data-idx="${idx}"]`).addClass('active-move');
    const rowEl = $(`.move-cell[data-idx="${idx}"]`).closest('.move-row');
    rowEl.addClass('active');
    const container = document.getElementById('moveList');
    if (rowEl[0] && container) container.scrollTo({ top: rowEl[0].offsetTop - 100, behavior: 'smooth' });
  }

  if (ev) updateEvalBar(ev.cp, ev.mate); else updateEvalBar(null);
  renderCoach();
  renderArrow();
  renderGraph();
}

// ---------------------------------------------------------------------------
// Main review pipeline
// ---------------------------------------------------------------------------
function stopAutoPlay() {
  if (autoPlayTimer) {
    clearInterval(autoPlayTimer);
    autoPlayTimer = null;
    $('#playIcon').removeClass('fa-pause').addClass('fa-play');
  }
}

async function reviewPGN(pgnString, extra = {}) {
  const tempChess = new Chess();
  const valid = tempChess.load_pgn(pgnString, { sloppy: true });
  if (!valid) {
    alert('Invalid PGN format! Please check the PGN input.');
    return;
  }

  stopAutoPlay();
  const token = ++reviewToken;
  engine.stop();
  currentPgn = pgnString;
  currentExtra = extra;

  const headers = tempChess.header();
  const startFen = headers.FEN && headers.SetUp !== '0' ? headers.FEN : START_FEN;
  gameMeta = {
    white: { name: headers.White || 'White', rating: headers.WhiteElo || '?' },
    black: { name: headers.Black || 'Black', rating: headers.BlackElo || '?' },
    acc: { w: null, b: null }
  };
  $('#gameResultBadge').text(headers.Result || '*');
  $('#gameEventInfo').text(`${headers.Event || 'Game'} • ${headers.Date || 'Recent'}`);

  // Replay the game
  const history = tempChess.history({ verbose: true });
  const replay = new Chess(startFen);
  positions = [replay.fen()];
  movesData = [];
  positionEvals = [];
  const standardStart = fenKey(startFen) === fenKey(START_FEN);
  let inBook = standardStart;

  history.forEach((m, idx) => {
    const turn = replay.turn();
    replay.move(m);
    const fen = replay.fen();
    positions.push(fen);
    movesData.push({
      moveIdx: idx,
      san: m.san,
      uci: m.from + m.to + (m.promotion || ''),
      from: m.from,
      to: m.to,
      piece: m.piece,
      fen,
      turn,
      captured: !!m.captured,
      cls: null,
      opening: '',
      bookEligible: false
    });
  });

  // mark which moves are still "in book" territory (book only continues while previous positions were book)
  renderPlayers();
  renderMoveHistoryTable();
  renderClassCounts();
  jumpToMove(-1, true);
  setStatus('analyzing', 'Waiting for engine…');
  $('#analysisProgress').removeClass('hidden');
  $('#analysisProgressText').text('Starting engine…');
  $('#analysisProgressPct').text('0%');
  $('#analysisProgressBar').css('width', '0%');

  if (!movesData.length) {
    setStatus('done', 'No moves');
    $('#analysisProgress').addClass('hidden');
    return;
  }

  // Engine
  try {
    await (engineError ? ensureEngine(true) : ensureEngine());
  } catch (e) {
    if (token !== reviewToken) return;
    if (e && e.message === 'superseded') return;
    setStatus('error', 'Engine unavailable');
    $('#analysisProgress').addClass('hidden');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const failList = (engine.failures && engine.failures.length) ? engine.failures : [String(e && e.message ? e.message : e)];
    const details = failList.map((f) => `<li class="break-all">${esc(f)}</li>`).join('');
    $('#coachBody').html('<span class="text-rose-300">Stockfish could not be loaded.</span> Upload <code>stockfish-18-lite-single.js</code> and <code>stockfish-18-lite-single.wasm</code> into a <code>stockfish/</code> folder next to index.html, redeploy, then tap the red engine badge to retry.'
      + (details ? `<div class="mt-2 text-[10px] text-slate-500">What failed:</div><ul class="list-disc pl-4 text-[10px] text-slate-400 space-y-1">${details}</ul>` : ''));
    return;
  }
  if (token !== reviewToken) return;

  // Opening book (max a few seconds of waiting)
  await Promise.race([bookReady, new Promise((r) => setTimeout(r, 6000))]);
  if (token !== reviewToken) return;
  movesData.forEach((m, i) => {
    if (standardStart && inBook) {
      const hit = bookMap.get(fenKey(m.fen));
      if (hit) { m.bookEligible = true; if (hit.name) m.opening = hit.name; } else { inBook = false; }
    }
  });
  // carry the last opening name forward through consecutive book moves only (shown by renderCoach lookup)

  engine.newGame();
  const depth = settings.depth;
  for (let i = 0; i < positions.length; i++) {
    if (token !== reviewToken) return;
    setProgress(i, positions.length, depth);
    const res = await evaluatePosition(positions[i], depth, token);
    if (token !== reviewToken) return;
    if (!res) { positionEvals.push({ cp: 0, mate: null, lines: [], best: null, terminal: true }); } else { positionEvals.push(res); }
    if (currentMoveIdx + 1 === i) { updateEvalBar(positionEvals[i].cp, positionEvals[i].mate); renderCoach(); }
    if (i % 2 === 0 || i === positions.length - 1) renderGraph();
  }
  if (token !== reviewToken) return;

  // Classification + accuracy
  const cls = classifyAll();
  movesData.forEach((m, i) => { m.cls = cls[i]; });
  const acc = computeAccuracies(cls);
  gameMeta.acc = acc;

  renderPlayers();
  renderMoveHistoryTable();
  renderClassCounts();
  jumpToMove(currentMoveIdx, true);

  let note = '';
  if (extra.accuracies && extra.accuracies.white !== undefined) {
    note = ` • Chess.com: ${Number(extra.accuracies.white).toFixed(1)} / ${Number(extra.accuracies.black).toFixed(1)}`;
  }
  setStatus('done', `Reviewed • d${depth}${note}`);
  $('#analysisProgress').addClass('hidden');
}

// ---------------------------------------------------------------------------
// Chess.com Public API Client
// ---------------------------------------------------------------------------
async function fetchChessComGames(username) {
  const cleanUsername = username.trim().toLowerCase();
  if (!cleanUsername) return;

  const $status = $('#chessComStatusMsg');
  const $spinner = $('#fetchBtnSpinner');
  const $list = $('#chessComGamesList');

  $status.removeClass('hidden bg-rose-950/60 border-rose-800 text-rose-300 bg-emerald-950/60 border-emerald-800 text-emerald-300')
    .addClass('bg-slate-900 border-slate-700 text-slate-300')
    .text(`Fetching archives for ${cleanUsername}...`);
  $spinner.removeClass('hidden');
  $list.empty().addClass('hidden');

  try {
    const archiveRes = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(cleanUsername)}/games/archives`);
    if (!archiveRes.ok) throw new Error(`Chess.com user "${cleanUsername}" not found.`);

    const archiveData = await archiveRes.json();
    const archives = archiveData.archives || [];
    if (archives.length === 0) {
      $status.removeClass('text-slate-300').addClass('bg-yellow-950/60 border-yellow-800 text-yellow-300')
        .text(`No games archive found for ${cleanUsername}.`);
      $spinner.addClass('hidden');
      return;
    }

    const gamesRes = await fetch(archives[archives.length - 1]);
    if (!gamesRes.ok) throw new Error('Failed to fetch recent month games.');
    let games = (await gamesRes.json()).games || [];

    if (games.length === 0 && archives.length > 1) {
      const prevRes = await fetch(archives[archives.length - 2]);
      if (prevRes.ok) games = (await prevRes.json()).games || [];
    }

    if (games.length === 0) {
      $status.removeClass('text-slate-300').addClass('bg-yellow-950/60 border-yellow-800 text-yellow-300')
        .text(`No games played recently by ${cleanUsername}.`);
      $spinner.addClass('hidden');
      return;
    }

    games.reverse();
    $status.removeClass('bg-slate-900 border-slate-700 text-slate-300')
      .addClass('bg-emerald-950/60 border-emerald-800 text-emerald-300')
      .text(`Found ${games.length} recent games! Click any game to review.`);

    $list.empty();
    games.slice(0, 25).forEach((g) => {
      const isWhite = (g.white.username || '').toLowerCase() === cleanUsername;
      const userObj = isWhite ? g.white : g.black;
      const oppObj = isWhite ? g.black : g.white;

      let resultBadge = '<span class="text-slate-400 font-bold">DRAW</span>';
      if (userObj.result === 'win') resultBadge = '<span class="text-emerald-400 font-bold">WIN</span>';
      else if (oppObj.result === 'win') resultBadge = '<span class="text-rose-400 font-bold">LOSS</span>';

      const timeClass = g.time_class ? g.time_class.toUpperCase() : 'GAME';
      const dateStr = g.end_time ? new Date(g.end_time * 1000).toLocaleDateString() : '';

      const gameItem = $(`
        <div class="p-3 hover:bg-[#2c2a26] cursor-pointer flex items-center justify-between transition group">
          <div class="flex items-center gap-3">
            <span class="w-2.5 h-2.5 rounded-full ${isWhite ? 'bg-white' : 'bg-slate-950 border border-slate-600'}"></span>
            <div>
              <div class="font-semibold text-xs text-slate-200">
                vs <span class="text-white font-bold">${oppObj.username}</span>
                <span class="text-slate-500 font-mono">(${oppObj.rating})</span>
              </div>
              <div class="text-[10px] text-slate-400 flex items-center gap-2 mt-0.5">
                <span class="bg-[#302e2b] px-1.5 py-0.2 rounded font-semibold text-slate-300">${timeClass}</span>
                <span>${dateStr}</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <span class="text-xs font-mono">${resultBadge}</span>
            <button class="bg-[#81b64c] group-hover:bg-[#96c95d] text-white px-3 py-1 rounded-lg text-xs font-bold transition shadow">Review</button>
          </div>
        </div>
      `);

      gameItem.on('click', () => {
        if (g.pgn) {
          $('#chessComModal').addClass('hidden');
          reviewPGN(g.pgn, { accuracies: g.accuracies });
        } else {
          alert('PGN not available for this game.');
        }
      });
      $list.append(gameItem);
    });

    $list.removeClass('hidden');
  } catch (err) {
    $status.removeClass('bg-slate-900 border-slate-700 text-slate-300')
      .addClass('bg-rose-950/60 border-rose-800 text-rose-300')
      .text(err.message || 'Error fetching Chess.com games.');
  } finally {
    $spinner.addClass('hidden');
  }
}

// ---------------------------------------------------------------------------
// Board init
// ---------------------------------------------------------------------------
function initBoard() {
  board = Chessboard('board', {
    draggable: false,
    position: 'start',
    moveSpeed: 240,
    snapSpeed: 80,
    snapbackSpeed: 60,
    pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png'
  });
  $(window).on('resize', () => {
    board.resize();
    setTimeout(() => { jumpToMove(currentMoveIdx, true); }, 60);
  });
}

// ---------------------------------------------------------------------------
// Document ready
// ---------------------------------------------------------------------------
$(document).ready(() => {
  initBoard();
  $('#depthSelect').val(String(settings.depth));
  $('#engineSelect').val(settings.variant);
  renderClassCounts();
  ensureEngine();
  reviewPGN(DEFAULT_PGN);

  // Controls
  $('#btnFirst').on('click', () => jumpToMove(-1));
  $('#btnPrev').on('click', () => { if (currentMoveIdx > -1) jumpToMove(currentMoveIdx - 1); });
  $('#btnNext').on('click', () => { if (currentMoveIdx < movesData.length - 1) jumpToMove(currentMoveIdx + 1); });
  $('#btnLast').on('click', () => { if (movesData.length > 0) jumpToMove(movesData.length - 1); });

  $('#btnFlip').on('click', () => {
    board.flip();
    flipped = !flipped;
    renderPlayers();
    setTimeout(() => { renderArrow(); jumpToMove(currentMoveIdx, true); }, 80);
  });

  $('#btnSound').on('click', () => {
    isMuted = !isMuted;
    $('#soundIcon').toggleClass('fa-volume-high fa-volume-xmark');
  });

  $('#btnBestArrow').on('click', () => {
    showBestArrow = !showBestArrow;
    renderCoach();
    renderArrow();
  });

  // Click on the advantage graph to jump
  $('#evalGraphWrap').on('click', (e) => {
    if (!movesData.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const pos = Math.round(ratio * movesData.length);
    jumpToMove(pos - 1);
  });

  // Engine badge: retry when failed
  $('#engineStatusPill').on('click', () => {
    if (engineError) {
      ensureEngine(true).then(() => reviewPGN(currentPgn, currentExtra)).catch(() => {});
    }
  });

  // Settings
  $('#depthSelect').on('change', function () {
    settings.depth = parseInt($(this).val(), 10);
    try { localStorage.setItem('csr_depth', String(settings.depth)); } catch (e) { /* noop */ }
    reviewPGN(currentPgn, currentExtra);
  });
  $('#engineSelect').on('change', function () {
    settings.variant = $(this).val();
    try { localStorage.setItem('csr_variant', settings.variant); } catch (e) { /* noop */ }
    reviewToken++;
    engine.stop();
    evalCache.clear();
    ensureEngine(true).then(() => reviewPGN(currentPgn, currentExtra)).catch(() => {});
  });

  // Auto-play
  $('#btnAutoPlay').on('click', () => {
    if (autoPlayTimer) { stopAutoPlay(); return; }
    $('#playIcon').removeClass('fa-play').addClass('fa-pause');
    autoPlayTimer = setInterval(() => {
      if (currentMoveIdx < movesData.length - 1) {
        jumpToMove(currentMoveIdx + 1);
      } else {
        stopAutoPlay();
      }
    }, 900);
  });

  // Keyboard Navigation
  $(document).on('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if ($('#pgnModal').is(':visible') || $('#chessComModal').is(':visible')) return;
    if (e.key === 'ArrowLeft') $('#btnPrev').click();
    if (e.key === 'ArrowRight') $('#btnNext').click();
    if (e.key === 'Home') $('#btnFirst').click();
    if (e.key === 'End') $('#btnLast').click();
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); $('#btnAutoPlay').click(); }
    if (e.key === 'f' || e.key === 'F') $('#btnFlip').click();
  });

  // Chess.com Modal Events
  $('#openChessComModalBtn').on('click', () => $('#chessComModal').removeClass('hidden'));
  $('#closeChessComModalBtn').on('click', () => $('#chessComModal').addClass('hidden'));
  $('#fetchChessComGamesBtn').on('click', () => fetchChessComGames($('#chessComUsernameInput').val()));
  $('#chessComUsernameInput').on('keypress', (e) => { if (e.which === 13) fetchChessComGames($('#chessComUsernameInput').val()); });
  $('.quick-user-btn').on('click', function () {
    const username = $(this).data('username');
    $('#chessComUsernameInput').val(username);
    fetchChessComGames(username);
  });

  // PGN Modal Events
  $('#openPgnModalBtn').on('click', () => $('#pgnModal').removeClass('hidden'));
  $('#closePgnModalBtn, #cancelPgnBtn').on('click', () => $('#pgnModal').addClass('hidden'));
  $('#sampleOperaGame').on('click', () => $('#pgnInput').val(DEFAULT_PGN));
  $('#sampleImmortal').on('click', () => $('#pgnInput').val(SAMPLE_KASPAROV));
  $('#loadPgnBtn').on('click', () => {
    const pgn = $('#pgnInput').val().trim();
    if (!pgn) { alert('Please paste a PGN first!'); return; }
    $('#pgnModal').addClass('hidden');
    reviewPGN(pgn);
  });
});
