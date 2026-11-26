#!/usr/bin/env node
// Behavioral tests for index.html. No dependencies. Run: node tests/harness.test.js (Node 18+)
//
// Runs the page's real inline <script> in vm sandboxes (one per simulated phone) with a fake DOM
// and a mock Supabase client. Phones that share a MockServer exchange broadcasts and presence.
// The mock copies the realtime-js 2.119.2 behaviors the app depends on:
//   - client.channel(topic) returns an existing channel with the same topic instead of a new one
//   - channel.unsubscribe() (leave) is async; the channel leaves the client's list once it closes
//   - subscribe() throws if called twice on the same channel instance
//   - track() adds presence under config.presence.key; 'sync' fires for presence listeners
// If supabase-js is bumped, re-check those behaviors and update the mock.
//
// Not covered: real browsers, real sensors, real Supabase. Use the README's manual checklist for those.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (inlineScripts.length !== 1) throw new Error(`expected 1 inline <script>, found ${inlineScripts.length}`);
const code = inlineScripts[0];

const transformMatch = /\.model-3d\s*\{[^}]*?transform:\s*([^;]+);/.exec(html);
if (!transformMatch) throw new Error('could not find the .model-3d transform rule');
// e.g. [['Z','rz'], ['X','rx'], ['Y','ry']] in the order CSS composes them
const cssRotations = [...transformMatch[1].matchAll(/rotate([XYZ])\(var\(--(r[xyz])/g)].map(m => [m[1], m[2]]);

const ROOM_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const unhandled = [];
process.on('unhandledRejection', e => unhandled.push(String((e && e.message) || e)));

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ANON = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'anon', iss: 'supabase' })}.sig_sig_sig_sig`;
const SERVICE = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'service_role', iss: 'supabase' })}.sig_sig_sig_sig`;

// In-memory stand-in for the Realtime server: joined channels per topic, broadcast fan-out, presence.
function createServer() {
  const topics = new Map();   // topic -> Set<MockChannel> (joined)
  const presence = new Map(); // topic -> Map<presenceKey, meta[]>
  const members = t => topics.get(t) || new Set();
  const presenceOf = t => (presence.has(t) ? presence.get(t) : presence.set(t, new Map()).get(t));
  const notifySync = t => members(t).forEach(ch => (ch.handlers.presence || []).forEach(fn => fn()));
  return {
    join(ch) {
      if (!topics.has(ch.topic)) topics.set(ch.topic, new Set());
      topics.get(ch.topic).add(ch);
      (ch.handlers.presence || []).forEach(fn => fn()); // presence_state on join
    },
    leave(ch) {
      members(ch.topic).delete(ch);
      if (ch.tracked) {
        ch.tracked = false;
        presenceOf(ch.topic).delete(ch.presenceKey);
        notifySync(ch.topic);
      }
    },
    broadcast(from, payload) {
      members(from.topic).forEach(ch => {
        if (ch !== from) setTimeout(() => (ch.handlers.broadcast || []).forEach(fn => fn({ payload })), 5);
      });
    },
    track(ch, meta) {
      ch.tracked = true;
      presenceOf(ch.topic).set(ch.presenceKey, [{ ...meta, presence_ref: `ref-${ch.presenceKey}` }]);
      notifySync(ch.topic);
    },
    presenceState: t => Object.fromEntries([...presenceOf(t)].map(([k, metas]) => [k, metas.map(m => ({ ...m }))])),
  };
}

function boot({ search = '', hash = '', wakeDeny = false, storedKey = ANON, leaveDelay = 150, joinDelay = 30, server = createServer(), store, share = false, windowExtras = {} } = {}) {
  const els = {};
  const mkEl = id => {
    const listeners = {};
    return {
      id, textContent: '', hidden: false, className: '', value: '', checked: id === 'chk-include-creds',
      type: id === 'cfg-key' ? 'password' : 'text', open: false, innerHTML: '', dataset: {},
      style: { setProperty(k, v) { this[k] = v; } },
      attrs: {}, setAttribute(k, v) { this.attrs[k] = String(v); },
      classList: { add() {}, remove() {} },
      addEventListener(t, fn) { (listeners[t] ||= []).push(fn); },
      fire(t, ev = {}) { return Promise.all((listeners[t] || []).map(fn => fn({ preventDefault() {}, ...ev }))); },
      focus() {},
    };
  };
  const docListeners = {};
  const winListeners = {};
  const document = {
    title: '', visibilityState: 'visible',
    getElementById: id => (els[id] ||= mkEl(id)),
    addEventListener(t, fn) { (docListeners[t] ||= []).push(fn); },
  };

  const mock = { created: 0, channels: [], sent: [], subscribeThrows: 0, leaveDelay, joinDelay, connected: true, createClientOpts: null };
  class MockChannel {
    constructor(topic, params) {
      this.topic = topic; this.state = 'closed'; this.joinedOnce = false; this.handlers = {}; this.cb = null;
      const key = params && params.config && params.config.presence && params.config.presence.key;
      this.presenceKey = key || `anon-${Math.random().toString(36).slice(2)}`;
      this.tracked = false;
    }
    on(type, filter, cb) { (this.handlers[type] ||= []).push(cb); return this; }
    subscribe(cb) {
      if (this.joinedOnce) { mock.subscribeThrows++; throw new Error('tried to subscribe multiple times'); }
      this.joinedOnce = true; this.state = 'joining'; this.cb = cb;
      setTimeout(() => {
        if (this.state !== 'joining') return;
        this.state = 'joined';
        server.join(this);
        cb('SUBSCRIBED');
      }, mock.joinDelay);
      return this;
    }
    unsubscribe() {
      this.state = 'leaving';
      return new Promise(res => setTimeout(() => {
        this.state = 'closed';
        server.leave(this);
        mock.channels = mock.channels.filter(c => c !== this);
        if (this.cb) this.cb('CLOSED');
        res('ok');
      }, mock.leaveDelay));
    }
    teardown() {}
    send(msg) {
      mock.sent.push(msg);
      if (this.state === 'joined' && msg.type === 'broadcast') server.broadcast(this, msg.payload);
      return Promise.resolve('ok');
    }
    track(meta) {
      if (this.state !== 'joined') return Promise.resolve('error');
      server.track(this, meta);
      return Promise.resolve('ok');
    }
    presenceState() { return server.presenceState(this.topic); }
  }
  const client = {
    channel(name, params) {
      const topic = `realtime:${name}`;
      const existing = mock.channels.find(c => c.topic === topic);
      if (existing) return existing;
      mock.created++;
      const c = new MockChannel(topic, params);
      mock.channels.push(c);
      return c;
    },
    removeAllChannels: async () => {},
    realtime: { isConnected: () => mock.connected },
  };

  store ||= new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', storedKey]]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const qr = [];
  function QRCode(el, opts) { qr.push(opts.text); }
  QRCode.CorrectLevel = { L: 1, M: 0 };
  const prompts = [];
  const location = { href: `https://example.com/${search}${hash}`, protocol: 'https:', hostname: 'example.com', hash, search };
  const window = {
    location,
    history: {
      replaceState(_s, _t, url) {
        const u = new URL(url);
        Object.assign(location, { href: u.href, search: u.search, hash: u.hash });
      },
    },
    addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { winListeners[t] = (winListeners[t] || []).filter(f => f !== fn); },
    supabase: { createClient: (url, key, opts) => { mock.createClientOpts = opts; return client; } },
    QRCode,
    crypto: require('crypto').webcrypto,
    prompt: (msg, text) => { prompts.push(text); },
    ...windowExtras,
  };

  // Browsers auto-release screen wake locks when the page is hidden and fire 'release'
  const wake = { requested: 0, released: 0, sentinels: [], deny: wakeDeny }; // deny: the browser refuses requests
  wake.autoRelease = () => wake.sentinels.forEach(s => {
    if (!s.released) { s.released = true; s.listeners.forEach(fn => fn()); }
  });
  const shares = [];
  const navigator = {
    wakeLock: {
      request: async () => {
        wake.requested++;
        if (wake.deny) throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
        const s = {
          released: false, listeners: [],
          addEventListener(t, fn) { if (t === 'release') this.listeners.push(fn); },
          release: async () => { wake.released++; s.released = true; },
        };
        wake.sentinels.push(s);
        return s;
      },
    },
    ...(share ? { share: async data => { shares.push(data); } } : {}),
  };

  const ctx = vm.createContext({
    window, document, localStorage, navigator, console, atob, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, performance,
  });
  vm.runInContext(code, ctx);
  return {
    els, mock, wake, store, qr, shares, prompts, location, doc: document,
    text: id => els[id] && els[id].textContent,
    fireWin: (t, ev) => Promise.all((winListeners[t] || []).map(fn => fn(ev || {}))),
    fireDoc: t => Promise.all((docListeners[t] || []).map(fn => fn({}))),
    hasWinListener: t => (winListeners[t] || []).length > 0,
  };
}

boot.noEl = { fire: async () => {} };

// --- 3D math helpers -------------------------------------------------------------------------
const rad = d => (d * Math.PI) / 180;
const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
const R = {
  X: t => [[1, 0, 0], [0, Math.cos(t), -Math.sin(t)], [0, Math.sin(t), Math.cos(t)]],
  Y: t => [[Math.cos(t), 0, Math.sin(t)], [0, 1, 0], [-Math.sin(t), 0, Math.cos(t)]],
  Z: t => [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]],
};
const FLIP_Y = [[1, 0, 0], [0, -1, 0], [0, 0, 1]]; // CSS y points down
const maxDiff = (A, B) => Math.max(...A.flat().map((v, i) => Math.abs(v - B.flat()[i])));
// W3C DeviceOrientation: intrinsic Z-X'-Y'' = Rz(alpha)·Rx(beta)·Ry(gamma), right-handed (x right, y top, z out
// of screen). Camera looks down at a flat phone, so in CSS coordinates the expected matrix is S·R·S.
const expectedCssMatrix = (a, b, g) => mul(mul(FLIP_Y, mul(mul(R.Z(rad(a)), R.X(rad(b))), R.Y(rad(g)))), FLIP_Y);
// What the page actually renders: the .model-3d rotate list (in CSS order) with the --rx/--ry/--rz the script set
const renderedCssMatrix = style => cssRotations
  .map(([axis, v]) => R[axis](rad(parseFloat(style[`--${v}`]))))
  .reduce((acc, m) => mul(acc, m));
// Faces as drawn: each `.<prefix>-N { transform: rotate…(θ)… translateZ(…) }` rule, as the face's rotation matrix
// in the model's CSS axes (x right, y down, z out of the screen)
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const faceRotations = prefix => Object.fromEntries([...html.matchAll(new RegExp(`\\.${prefix}-(\\d+)\\s*\\{\\s*transform:\\s*([^;]+);`, 'g'))]
  .map(([, n, t]) => [n, [...t.matchAll(/rotate([XYZ])\((-?[\d.]+)deg\)/g)].reduce((acc, [, axis, deg]) => mul(acc, R[axis](rad(+deg))), I3)]));
// A face's outward normal is its rotation applied to (0, 0, 1)
const normalsOf = rots => Object.fromEntries(Object.entries(rots).map(([n, m]) => [n, m.map(row => row[2])]));
const dieFaceNormals = normalsOf(faceRotations('die'));
const d20Rotations = faceRotations('d20');
const d20FaceNormals = normalsOf(d20Rotations);
// Height of each drawn face's normal once the model is rotated: CSS z points at the camera, i.e. up
const drawnFaceHeights = (style, normals = dieFaceNormals) => {
  const M = renderedCssMatrix(style);
  return Object.entries(normals)
    .map(([n, v]) => [n, M[2].reduce((s, m, i) => s + m * v[i], 0)])
    .sort((x, y) => y[1] - x[1]);
};

// --- Tests -----------------------------------------------------------------------------------
const results = [];
const check = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);

(async () => {
  // 0. Markup: every id in index.html is unique (the fake DOM keeps one element per id, so a repeat would hide here but break getElementById in a browser)
  {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    check('every element id in index.html is unique', ids.length > 50 && dupes.length === 0, dupes.join());
  }

  // 1. Viewer opened from a pairing link joins the Sender's room
  {
    const t = boot({ search: '?room=AB12' });
    await sleep(100);
    const ch0 = t.mock.channels[0];
    check('link opens Viewer and joins the room', t.text('health-badge-text') === 'Connected' && ch0 && ch0.topic === 'realtime:gyrolink-room-AB12', `${t.text('health-badge-text')} ${ch0 && ch0.topic}`);
    check('link prefills the room code input', t.els['viewer-room-input'].value === 'AB12');
    check('viewer URL keeps ?room= for reloads', t.location.search === '?room=AB12', t.location.search);
    check('viewer tracks presence as a viewer', ch0 && ch0.tracked && ch0.presenceState()[ch0.presenceKey][0].role === 'viewer');
    check('viewer requests wake lock', t.wake.requested === 1, `requests=${t.wake.requested}`);
    check('heartbeatIntervalMs=5000 passed to client', t.mock.createClientOpts.realtime.heartbeatIntervalMs === 5000);

    // Resume fires 'visibilitychange' + 'online' together while the socket looks dead
    const createdBefore = t.mock.created;
    t.mock.connected = false;
    t.wake.autoRelease(); // page was hidden -> browser dropped the wake lock
    t.fireDoc('visibilitychange');
    t.fireWin('online');
    await sleep(t.mock.leaveDelay + 300);
    t.mock.connected = true;
    await sleep(1500); // long enough for any spurious backoff reconnect (1 s base) to fire
    const ch = t.mock.channels;
    check('resume race: exactly one live channel', ch.length === 1 && ch[0].state === 'joined', `channels=${ch.length} states=${ch.map(c => c.state)}`);
    const handlerCounts = ch.map(c => (c.handlers.broadcast || []).length);
    check('resume race: one broadcast handler (no double-counting)', ch.length === 1 && handlerCounts[0] === 1, `handlers=${handlerCounts}`);
    check('resume race: no double-subscribe throw', t.mock.subscribeThrows === 0 && unhandled.length === 0, unhandled.join('; '));
    check('resume race: one new channel, no spurious extra reconnects', t.mock.created - createdBefore === 1, `new channels=${t.mock.created - createdBefore}`);
    check('resume race: re-tracks presence after rejoin', ch.length === 1 && ch[0].tracked);
    check('resume race: badge back to Connected', t.text('health-badge-text') === 'Connected', t.text('health-badge-text'));
    check('wake lock re-requested on visibility', t.wake.requested === 2, `requests=${t.wake.requested}`);

    // Switch Mode while a reconnect is mid-flight -> nothing left subscribed
    t.mock.leaveDelay = 300;
    t.fireWin('online'); // starts a connect that waits on the slow leave
    await sleep(50);
    await t.els['btn-viewer-back'].fire('click');
    await sleep(600);
    check('disconnect during in-flight connect: no orphan channel', t.mock.channels.length === 0, `channels=${t.mock.channels.length}`);
    check('disconnect during in-flight connect: badge Idle', t.text('health-badge-text') === 'Idle', t.text('health-badge-text'));
    check('leaving Viewer clears ?room= from the URL', t.location.search === '', t.location.search);
  }

  // 2. 3D mirror matches the W3C orientation, using the real CSS rule and real script output
  {
    const t = boot({ search: '?room=AB12' });
    await sleep(100);
    const ch = t.mock.channels[0];
    const poses = [[0, 0, 0], [90, 0, 0], [0, 90, 0], [0, 0, 45], [30, 90, 0], [120.5, -35.2, 60.1], [300, 170, -80], [45, -90, 10]];
    let worst = 0;
    for (const [a, b, g] of poses) {
      ch.handlers.broadcast[0]({ payload: { a, b, g, seq: 1, ts: Date.now() } });
      worst = Math.max(worst, maxDiff(renderedCssMatrix(t.els['model-3d'].style), expectedCssMatrix(a, b, g)));
    }
    check('3D transform matches W3C Z-X\'-Y\'\' orientation', worst < 1e-9, `max matrix error=${worst.toExponential(2)}`);

    // Acceleration: shown when valid, '—' when missing or malformed (packets come from anyone)
    const accText = () => ['v-acc-x', 'v-acc-y', 'v-accg-z', 'v-acc-peak'].map(id => t.text(id)).join(' | ');
    check('packet without acceleration shows —', t.text('v-acc-x') === '—' && t.text('v-acc-peak') === '—', accText());
    const send = p => ch.handlers.broadcast[0]({ payload: { a: 0, b: 0, g: 0, seq: 1, ts: Date.now(), ...p } });
    send({ acc: [1.234, -0.5, 0], accg: [1.234, -0.5, 9.81], pk: 4 });
    check('viewer shows acceleration and peak', accText() === '1.23 | -0.50 | with g 9.81 | 4.00', accText());
    send({ acc: [0.1, 0, 0], accg: [0.1, 0, 9.81], pk: 0.1 });
    check('viewer holds the peak', t.text('v-acc-x') === '0.10' && t.text('v-acc-peak') === '4.00', accText());
    await sleep(1100);
    send({ acc: [0.1, 0, 0], accg: [0.1, 0, 9.81], pk: 0.1 });
    check('peak hold expires after 1 s', t.text('v-acc-peak') === '0.10', accText());
    send({ acc: ['1', 2, 3], accg: [0, null, 9.81], pk: 'x' });
    check('malformed acceleration shows —', t.text('v-acc-x') === '—' && t.text('v-accg-x') === '' && t.text('v-acc-peak') === '—', accText());
    await t.els['btn-viewer-back'].fire('click'); // stop the watchdog interval
  }

  // 3. Viewer opened without a link: joins by typing the code
  {
    const t = boot();
    await t.els['btn-choose-viewer'].fire('click');
    check('viewer without a room shows Not Joined', t.text('health-badge-text') === 'Not Joined' && t.mock.created === 0, t.text('health-badge-text'));
    t.els['viewer-room-input'].value = 'ab';
    await t.els['viewer-join-form'].fire('submit');
    check('short code is rejected with an alert', t.els['viewer-alert'].hidden === false && t.mock.created === 0);
    t.els['viewer-room-input'].value = 'k7-m9';
    await t.els['viewer-room-input'].fire('input');
    check('room input is sanitized', t.els['viewer-room-input'].value === 'K7M9', t.els['viewer-room-input'].value);
    await t.els['viewer-join-form'].fire('submit');
    await sleep(100);
    check('typed code joins that room', t.mock.channels[0] && t.mock.channels[0].topic === 'realtime:gyrolink-room-K7M9' && t.text('health-badge-text') === 'Connected', t.text('health-badge-text'));
    check('typed code is written to ?room=', t.location.search === '?room=K7M9', t.location.search);
    await t.els['btn-viewer-back'].fire('click');
  }

  // 4. Sender hosts the room
  {
    const store = new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', ANON]]);
    const t = boot({ store, joinDelay: 150 });
    await t.els['btn-choose-sender'].fire('click');
    const room = t.text('s-room-code');
    check('sender creates a room code', ROOM_RE.test(room), room);
    check('sender room is persisted', store.get('gyrolink_sender_room') === room);
    const qrText = t.qr[t.qr.length - 1] || '';
    check('QR code opens the room with credentials in the hash', qrText.includes(`?room=${room}#`) && qrText.includes('u=https') && qrText.includes('k='), qrText.slice(0, 80));
    check('sender connects on entering (before streaming)', t.mock.created === 1 && t.mock.channels[0].topic === `realtime:gyrolink-room-${room}`);

    // Start while the auto-connect is still joining must reuse it
    await t.els['btn-toggle-stream'].fire('click');
    await sleep(400);
    check('Start during join reuses it (1 channel created)', t.mock.created === 1, `created=${t.mock.created}`);
    check('sender subscribed', t.text('s-channel') === 'SUBSCRIBED', t.text('s-channel'));
    check('viewer count shows 0 with nobody watching', t.text('s-viewers') === '0', t.text('s-viewers'));
    check('QR panel collapses once streaming', t.els['pairing-panel'].open === false);

    // No packets until a real sensor reading arrives
    check('no 0/0/0 packets before sensor data', t.mock.sent.length === 0, `sent=${t.mock.sent.length}`);
    check('deviceorientation listener attached', t.hasWinListener('deviceorientation'));
    await t.fireWin('deviceorientation', { alpha: 12.34, beta: -5.67, gamma: 8.9 });
    await sleep(350);
    const last = t.mock.sent[t.mock.sent.length - 1];
    check('packets flow after first reading', t.mock.sent.length >= 2, `sent=${t.mock.sent.length}`);
    check('payload carries the reading', last && last.payload.a === 12.3 && last.payload.b === -5.7 && last.payload.g === 8.9, JSON.stringify(last && last.payload));
    check('no acceleration fields before the accelerometer reports', last && !('acc' in last.payload) && !('pk' in last.payload), JSON.stringify(last && last.payload));

    // A tap between two ticks: the packet carries the latest sample, and the tap as its peak
    check('devicemotion listener attached', t.hasWinListener('devicemotion'));
    const motion = (x, y, z) => ({ acceleration: { x, y, z }, accelerationIncludingGravity: { x, y, z: z + 9.81 } });
    let before = t.mock.sent.length;
    t.fireWin('devicemotion', motion(3, 4, 0));
    t.fireWin('devicemotion', motion(0.1, 0, 0));
    await sleep(250);
    const [p1, p2] = t.mock.sent.slice(before).map(m => m.payload);
    check('payload carries acceleration with and without gravity', p1 && JSON.stringify(p1.acc) === '[0.1,0,0]' && JSON.stringify(p1.accg) === '[0.1,0,9.81]', JSON.stringify(p1));
    check('peak catches a tap between two packets', p1 && p1.pk === 5, JSON.stringify(p1));
    check('peak window resets every packet', p2 && p2.pk === 0.1, JSON.stringify(p2));
    check('sender shows its own acceleration', t.text('s-acc-x') === '0.10' && t.text('s-accg-z') === 'with g 9.81', `${t.text('s-acc-x')} | ${t.text('s-accg-z')}`);

    // Some devices report only acceleration with gravity
    before = t.mock.sent.length;
    t.fireWin('devicemotion', { acceleration: { x: null, y: null, z: null }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 } });
    await sleep(150);
    const p3 = t.mock.sent.length > before && t.mock.sent[t.mock.sent.length - 1].payload;
    check('device without linear acceleration sends gravity only', p3 && p3.acc === null && JSON.stringify(p3.accg) === '[0,0,9.81]' && p3.pk === null, JSON.stringify(p3));
    await t.els['btn-toggle-stream'].fire('click'); // stop the 10 Hz interval
    check('stopping clears the acceleration readout', t.text('s-acc-x') === '—' && t.text('s-acc-peak') === '—', t.text('s-acc-x'));

    // "New" moves to a fresh room
    await t.els['btn-new-room'].fire('click');
    await sleep(400);
    const room2 = t.text('s-room-code');
    check('New creates a different room', ROOM_RE.test(room2) && room2 !== room, `${room} -> ${room2}`);
    check('New room is persisted and joined', store.get('gyrolink_sender_room') === room2 && t.mock.channels.length === 1 && t.mock.channels[0].topic === `realtime:gyrolink-room-${room2}`);
    check('New room re-renders the QR code', (t.qr[t.qr.length - 1] || '').includes(`?room=${room2}`));
    await t.els['btn-sender-back'].fire('click');

    // Reloading the Sender keeps the same room, so Viewers stay paired
    const t2 = boot({ store });
    await t2.els['btn-choose-sender'].fire('click');
    check('sender reload keeps its room', t2.text('s-room-code') === room2, t2.text('s-room-code'));
    await t2.els['btn-sender-back'].fire('click');
  }

  // 5. One Sender, many Viewers
  {
    const server = createServer();
    const sender = boot({ server });
    await sender.els['btn-choose-sender'].fire('click');
    await sleep(100);
    const room = sender.text('s-room-code');
    const v1 = boot({ server, search: `?room=${room}` });
    const v2 = boot({ server, search: `?room=${room}` });
    await sleep(150);
    check('sender counts 2 viewers', sender.text('s-viewers') === '2', sender.text('s-viewers'));
    check('pairing pill shows the count', sender.text('pairing-room-pill') === `${room} · 2 watching`, sender.text('pairing-room-pill'));

    await sender.els['btn-toggle-stream'].fire('click');
    await sender.fireWin('deviceorientation', { alpha: 33.3, beta: 10, gamma: -20 });
    await sleep(350);
    check('both viewers receive the stream', v1.text('v-alpha') === '33.3°' && v2.text('v-alpha') === '33.3°', `${v1.text('v-alpha')} / ${v2.text('v-alpha')}`);
    check('both viewers show Live', v1.text('health-badge-text') === 'Live' && v2.text('health-badge-text') === 'Live', `${v1.text('health-badge-text')} / ${v2.text('health-badge-text')}`);
    sender.fireWin('devicemotion', { acceleration: { x: 0.5, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0.5, y: 0, z: 9.81 } });
    await sleep(250);
    check('both viewers receive acceleration', v1.text('v-acc-x') === '0.50' && v2.text('v-accg-z') === 'with g 9.81', `${v1.text('v-acc-x')} / ${v2.text('v-accg-z')}`);

    await v2.els['btn-viewer-back'].fire('click');
    await sleep(250);
    check('sender count drops when a viewer leaves', sender.text('s-viewers') === '1', sender.text('s-viewers'));
    check('remaining viewer keeps streaming', v1.text('health-badge-text') === 'Live', v1.text('health-badge-text'));

    await sender.els['btn-toggle-stream'].fire('click');
    await v1.els['btn-viewer-back'].fire('click');
    await sender.els['btn-sender-back'].fire('click');
  }

  // 6. Share link uses the share sheet when available
  {
    const t = boot({ share: true });
    await t.els['btn-choose-sender'].fire('click');
    const room = t.text('s-room-code');
    check('link button is labeled Share Link', t.text('btn-copy-link') === 'Share Link', t.text('btn-copy-link'));
    await t.els['btn-copy-link'].fire('click');
    const shared = t.shares[0];
    check('share sheet gets the room link with credentials', shared && shared.url.includes(`?room=${room}#u=`) && shared.url.includes('k='), shared && shared.url.slice(0, 80));
    await t.els['btn-sender-back'].fire('click');
  }

  // 7. Secret keys rejected and purged
  {
    const t = boot({ storedKey: SERVICE });
    check('stored service_role key purged on load', !t.store.has('gyrolink_supabase_anon_key'));
    check('settings error shown', t.els['settings-error'].hidden === false && /secret/.test(t.text('settings-error')));
    t.els['cfg-url'].value = 'https://abc.supabase.co';
    for (const [label, key] of [['service_role JWT', SERVICE], ['sb_secret_ key', 'sb_secret_abcdefghijklmnopqrstuvwxyz']]) {
      t.els['cfg-key'].value = key;
      await t.els['settings-form'].fire('submit');
      check(`settings rejects ${label}`, !t.store.has('gyrolink_supabase_anon_key') && /secret/.test(t.text('settings-error')));
    }
    for (const [label, key] of [['anon JWT', ANON], ['sb_publishable_ key', 'sb_publishable_abcdefghijklmnopqrstuvwxyz']]) {
      t.els['cfg-key'].value = key;
      await t.els['settings-form'].fire('submit');
      check(`settings accepts ${label}`, t.store.get('gyrolink_supabase_anon_key') === key);
    }
  }

  // 8. iOS permissions, and the simulated sensors
  {
    const calls = [];
    const api = (name, ok) => ({
      requestPermission: () => { calls.push(name); return ok ? Promise.resolve('granted') : Promise.reject(new Error('denied')); },
    });
    const t = boot({ windowExtras: { DeviceOrientationEvent: api('orientation', true), DeviceMotionEvent: api('motion', false) } });
    await t.els['btn-choose-sender'].fire('click');
    t.els['btn-toggle-stream'].fire('click');
    // Nothing awaited yet, so both requests were made inside the tap's user gesture
    check('iOS: orientation and motion permission requested inside the tap', calls.join() === 'orientation,motion', calls.join());
    await sleep(300);
    check('iOS: streams even when motion permission fails', t.text('btn-toggle-stream-label') === 'Stop Streaming' && t.hasWinListener('devicemotion'), t.text('btn-toggle-stream-label'));

    // iOS passes Core Motion's signs through: flat and screen up reads z = -9.81. Packets use W3C signs.
    t.fireWin('deviceorientation', { alpha: 0, beta: 0, gamma: 0 });
    t.fireWin('devicemotion', { acceleration: { x: 0.5, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0.5, y: 0, z: -9.81 } });
    await sleep(150);
    const ios = t.mock.sent.length && t.mock.sent[t.mock.sent.length - 1].payload;
    check('iOS: acceleration flipped to W3C signs', ios && JSON.stringify(ios.acc) === '[-0.5,0,0]' && JSON.stringify(ios.accg) === '[-0.5,0,9.81]', JSON.stringify(ios));

    await t.els['btn-toggle-sim'].fire('click');
    await sleep(250);
    const p = t.mock.sent.length && t.mock.sent[t.mock.sent.length - 1].payload;
    const ok = p && Array.isArray(p.acc) && Array.isArray(p.accg);
    // Gravity (accg - acc) should be what a phone tilted to the simulated beta/gamma feels at rest
    const expected = ok && [-Math.sin(rad(p.g)) * Math.cos(rad(p.b)), Math.sin(rad(p.b)), Math.cos(rad(p.g)) * Math.cos(rad(p.b))].map(v => v * 9.81);
    const err = ok ? Math.max(...p.accg.map((v, i) => Math.abs(v - p.acc[i] - expected[i]))) : Infinity;
    check('simulated acceleration includes gravity matching the simulated tilt', err < 0.05, `max error=${err} ${JSON.stringify(p)}`);
    await t.els['btn-toggle-stream'].fire('click');
    await t.els['btn-sender-back'].fire('click');
  }

  // 9. Die model: faces where the spec puts them, and the big number is the face the drawn die has on top
  {
    // Model CSS axes: x right, y down (the phone's top edge is -y), z out of the screen
    const want = { 1: [0, 0, 1], 6: [0, 0, -1], 4: [1, 0, 0], 3: [-1, 0, 0], 2: [0, -1, 0], 5: [0, 1, 0] };
    const placed = Object.keys(dieFaceNormals).length === 6 && Object.keys(want).every(n =>
      dieFaceNormals[n] && dieFaceNormals[n].every((v, i) => Math.abs(v - want[n][i]) < 1e-9));
    check('die faces: front 1, back 6, right 4, left 3, top 2, bottom 5', placed, JSON.stringify(dieFaceNormals));

    const store = new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', ANON]]);
    const t = boot({ search: '?room=AB12', store });
    await sleep(100);
    const stage = t.els['v-stage'];
    const pressed = () => `${t.els['btn-model-phone'].attrs['aria-pressed']},${t.els['btn-model-die'].attrs['aria-pressed']}`;
    check('viewer shows the phone by default', stage.dataset.model === 'phone' && pressed() === 'true,false', `${stage.dataset.model} ${pressed()}`);
    await t.els['btn-model-die'].fire('click');
    check('Die button switches to the die and saves the choice', stage.dataset.model === 'die' && pressed() === 'false,true' && store.get('gyrolink_viewer_model') === 'die', `${stage.dataset.model} ${pressed()}`);
    check('top number is — before any packet', t.text('v-die-top') === '—', t.text('v-die-top'));

    const ch = t.mock.channels[0];
    const send = (a, b, g) => ch.handlers.broadcast[0]({ payload: { a, b, g, seq: 1, ts: Date.now() } });
    const top = (a, b, g) => (send(a, b, g), t.text('v-die-top'));
    const sides = [[[0, 0, 0], '1'], [[0, 180, 0], '6'], [[0, 90, 0], '2'], [[0, -90, 0], '5'], [[0, 0, -80], '4'], [[0, 0, 80], '3'], [[217, 85, 20], '2'], [[40, -170, 5], '6']];
    const got = sides.map(([pose]) => top(...pose));
    check('top number for each side resting up', got.join() === sides.map(s => s[1]).join(), got.join());

    // Across many poses, the number is the face the drawn die points at the camera (skip poses within the hysteresis band)
    let tested = 0;
    const mismatches = [];
    for (const a of [0, 135, 290]) for (const b of [-170, -120, -60, -20, 20, 60, 120, 170]) for (const g of [-75, -30, 0, 30, 75]) {
      send(a, b, g);
      const [[drawn, h1], [, h2]] = drawnFaceHeights(t.els['model-3d'].style);
      if (h1 - h2 < 0.1) continue;
      tested++;
      if (t.text('v-die-top') !== drawn) mismatches.push(`${a}/${b}/${g}: shows ${t.text('v-die-top')}, drawn ${drawn}`);
    }
    check('top number matches the face the drawn die has on top', tested > 60 && mismatches.length === 0, `tested=${tested} ${mismatches.slice(0, 3).join('; ')}`);

    const band = [44, 47, 50, 43, 40].map(b => top(0, b, 0)).join();
    check('top number holds near an edge (no flicker)', band === '1,1,2,2,1', band);

    send(0, 90, 0);
    await t.els['btn-calibrate'].fire('click');
    check('calibrate re-zeroes the die like the model', t.text('v-die-top') === '1', t.text('v-die-top'));
    await t.els['btn-viewer-back'].fire('click');

    const t2 = boot({ store });
    check('die choice is remembered on reload', t2.els['v-stage'].dataset.model === 'die', t2.els['v-stage'].dataset.model);
    await t2.els['btn-model-phone'].fire('click');
    check('Phone button switches back and saves the choice', t2.els['v-stage'].dataset.model === 'phone' && store.get('gyrolink_viewer_model') === 'phone');
  }

  // 9b. D20: geometry and numbering as drawn, then the Viewer's D20 tab
  {
    const toDev = v => [v[0], -v[1], v[2]];
    const near = (u, v) => u.every((x, i) => Math.abs(x - v[i]) < 1e-3);
    const deg = r => r * 180 / Math.PI;
    const N = Object.fromEntries(Object.entries(d20FaceNormals).map(([n, v]) => [n, toDev(v)])); // device axes
    const nums = Object.keys(N).map(Number).sort((a, b) => a - b);
    check('d20: faces 1–20 drawn', nums.join() === Array.from({ length: 20 }, (_, i) => i + 1).join(), nums.join());
    // Corners of each drawn triangle: edge 1, centroid at the origin, apex toward local +y, pushed out by the inradius
    const local = [[0, 0.57735], [0.5, -0.288675], [-0.5, -0.288675]];
    const corners = Object.entries(d20Rotations).flatMap(([n, M]) => local.map(([x, y]) =>
      ({ n: +n, p: toDev(M.map(row => row[0] * x + row[1] * y + row[2] * 0.755761)) })));
    const verts = []; // cluster corners that coincide
    for (const c of corners) {
      const v = verts.find(v => near(v.p, c.p));
      v ? v.faces.push(c.n) : verts.push({ p: c.p, faces: [c.n] });
    }
    check('d20: drawn triangles close into an icosahedron', verts.length === 12 && verts.every(v => v.faces.length === 5), `corners=${verts.length}`);
    check('d20: 1 on the screen side, 20 on the back', near(N[1], [0, 0, 1]) && near(N[20], [0, 0, -1]));
    check('d20: opposite faces add up to 21', nums.every(n => near(N[n], N[21 - n].map(x => -x))));
    check("d20: a corner of 20 points along the phone's top edge", verts.some(v => v.faces.includes(20) && Math.abs(v.p[0]) < 1e-3 && v.p[1] > 0));
    const sums = verts.map(v => v.faces.reduce((s, n) => s + n, 0));
    check('d20: every corner sums to 52 or 53', sums.every(s => s === 52 || s === 53), sums.join());

    // CSS: which parts each model shows. Every `.stage-container[data-model="X"] .cls` / `:not([data-model="X"]) .cls`
    // selector in a display: none rule is read; one that doesn't fit the pattern fails the check instead of being ignored.
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const hides = []; // { not, model, cls }
    let unparsed = 0;
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/display:\s*none/.test(body)) continue;
      for (const s of sel.split(',').map(x => x.trim()).filter(x => x.includes('data-model') && x.includes('stage-container'))) {
        const m = s.match(/^\.stage-container(:not\()?\[data-model="(\w+)"\]\)?\s+\.([\w-]+)$/);
        m ? hides.push({ not: !!m[1], model: m[2], cls: m[3] }) : unparsed++;
      }
    }
    const shown = (model, cls) => !hides.some(h => h.cls === cls && (h.not ? h.model !== model : h.model === model));
    const visible = model => ['phone-face', 'die-face', 'd20-face', 'die-top-readout'].filter(c => shown(model, c)).join();
    const wantVis = { phone: 'phone-face', die: 'die-face,die-top-readout', d20: 'd20-face,die-top-readout' };
    const gotVis = Object.fromEntries(Object.keys(wantVis).map(m => [m, visible(m)]));
    check('stage CSS shows the right parts for Phone, D6 and D20', unparsed === 0 && Object.keys(wantVis).every(m => gotVis[m] === wantVis[m]), `${unparsed} unparsed ${JSON.stringify(gotVis)}`);

    // Viewer: D20 tab
    const store = new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', ANON]]);
    const t = boot({ search: '?room=AB12', store });
    await sleep(100);
    const stage = t.els['v-stage'];
    const pressed = () => ['phone', 'die', 'd20'].map(m => t.els[`btn-model-${m}`].attrs['aria-pressed']).join();
    await t.els['btn-model-d20'].fire('click');
    check('D20 tab shows the d20 and saves the choice', stage.dataset.model === 'd20' && pressed() === 'false,false,true' && store.get('gyrolink_viewer_model') === 'd20', `${stage.dataset.model} ${pressed()}`);
    check('d20 top number is — before any packet', t.text('v-die-top') === '—', t.text('v-die-top'));

    const ch = t.mock.channels[0];
    const send = (a, b, g) => ch.handlers.broadcast[0]({ payload: { a, b, g, seq: 1, ts: Date.now() } });
    const top = (a, b, g) => (send(a, b, g), t.text('v-die-top'));
    // Rest the box so each drawn face points straight up: up = [-cos β sin γ, sin β, cos β cos γ]
    const pose = v => [0, deg(Math.asin(v[1])), deg(Math.atan2(-v[0], v[2]))];
    const read = nums.map(n => top(...pose(N[n])));
    check('d20: every face reads its own number when it is on top', read.join() === nums.join(), read.join());

    // Across many poses, the number is the face the drawn d20 points at the camera (skip poses within the hysteresis band)
    let tested = 0;
    const mismatches = [];
    for (const a of [0, 135, 290]) for (const b of [-170, -120, -60, -20, 20, 60, 120, 170]) for (const g of [-75, -30, 0, 30, 75]) {
      send(a, b, g);
      const [[drawn, h1], [, h2]] = drawnFaceHeights(t.els['model-3d'].style, d20FaceNormals);
      if (h1 - h2 < 0.05) continue;
      tested++;
      if (t.text('v-die-top') !== drawn) mismatches.push(`${a}/${b}/${g}: shows ${t.text('v-die-top')}, drawn ${drawn}`);
    }
    check('d20 top number matches the face the drawn d20 has on top', tested > 60 && mismatches.length === 0, `tested=${tested} ${mismatches.slice(0, 3).join('; ')}`);

    const band = [18, 22, 25, 22, 19, 16].map(b => top(0, b, 0)).join();
    check('d20 top number holds near an edge (no flicker)', band === '1,1,7,7,7,1', band);

    // A corner of face 1 (faces 1, 8, 16, 12, 15 meet) is straight up at β ≈ -37.38°
    const first = top(0, -37.38, 0);
    const jitter = [[-36.6, 0.8], [-38.2, -0.8], [-37.4, 1], [-36.8, -1], [-38, 0.6]].map(([b, g]) => top(0, b, g));
    check('d20 top number holds on a corner', ['1', '8', '12', '15', '16'].includes(first) && jitter.every(x => x === first), `${first} ${jitter}`);

    // Switching dice recomputes at once and never carries the old die's face over
    await t.els['btn-model-die'].fire('click');
    const cube = top(0, -36, -4);   // cube: 1. d20: 8, only 0.023 above its face 1
    await t.els['btn-model-d20'].fire('click');
    const d20 = t.text('v-die-top');
    await t.els['btn-model-die'].fire('click');
    const back = t.text('v-die-top');
    check('switching D6 → D20 → D6 shows each die\'s own number at once', `${cube},${d20},${back}` === '1,8,1', `${cube},${d20},${back}`);
    await t.els['btn-model-d20'].fire('click');
    send(0, 60, 20);
    await t.els['btn-calibrate'].fire('click');
    check('calibrate re-zeroes the d20 like the model', t.text('v-die-top') === '1', t.text('v-die-top'));
    await t.els['btn-viewer-back'].fire('click');

    const t2 = boot({ store });
    check('d20 choice is remembered on reload', t2.els['v-stage'].dataset.model === 'd20', t2.els['v-stage'].dataset.model);
    for (const junk of ['foo', 'toString']) {
      const j = boot({ store: new Map([...store, ['gyrolink_viewer_model', junk]]) });
      check(`saved model "${junk}" falls back to the phone`, j.els['v-stage'].dataset.model === 'phone', j.els['v-stage'].dataset.model);
    }
  }

  // 10. Die page: the Viewer with only the die, the top number and the status
  {
    const shell = p => (p.els['app-shell'] || { dataset: {} }).dataset; // undefined until the script looks it up
    const creds = () => new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', ANON]]);
    const server = createServer();
    const sender = boot({ server });
    await sender.els['btn-choose-sender'].fire('click');
    await sleep(100);
    const room = sender.text('s-room-code');
    const store = creds();
    const d = boot({ server, store, search: `?room=${room}&view=die` });
    await sleep(150);
    check('die link opens the die page', shell(d).page === 'die' && d.text('health-badge-text') === 'Connected', `${shell(d).page} ${d.text('health-badge-text')}`);
    check('die page forces the die without saving it', d.els['v-stage'].dataset.model === 'die' && !store.has('gyrolink_viewer_model'), d.els['v-stage'].dataset.model);
    check('die page title hides the room', d.doc.title === 'Die', d.doc.title);
    check('die page keeps room and view in the URL for reloads', d.location.search === `?room=${room}&view=die`, d.location.search);
    check('die page status: Waiting for the die', d.text('v-stream-pill') === 'Waiting for the die', d.text('v-stream-pill'));
    check('sender counts the die page as a viewer', sender.text('s-viewers') === '1', sender.text('s-viewers'));
    check('die page keeps the screen on', d.wake.requested === 1, `requests=${d.wake.requested}`);

    await sender.els['btn-toggle-stream'].fire('click');
    await sender.fireWin('deviceorientation', { alpha: 0, beta: 90, gamma: 0 });
    await sleep(350);
    check('die page shows Live and the top face', d.text('v-stream-pill') === 'Live' && d.text('v-die-top') === '2', `${d.text('v-stream-pill')} ${d.text('v-die-top')}`);
    await sender.els['btn-toggle-stream'].fire('click');
    await sleep(700);
    check('die page status: Weak signal', d.text('v-stream-pill') === 'Weak signal', d.text('v-stream-pill'));
    await sleep(1600);
    check('die page status: Signal lost', d.text('v-stream-pill') === 'Signal lost', d.text('v-stream-pill'));

    // The normal Viewer on the same phone is untouched
    const v = boot({ server, store, search: `?room=${room}` });
    await sleep(150);
    check('normal Viewer after the die page: own model, own wording', shell(v).page !== 'die' && v.els['v-stage'].dataset.model === 'phone' && v.text('v-stream-pill') === 'Waiting for Sender', `${v.els['v-stage'].dataset.model} ${v.text('v-stream-pill')}`);

    // view=die needs a valid room
    for (const search of ['?view=die', '?room=ab&view=die']) {
      const x = boot({ search });
      check(`${search} opens the normal app`, shell(x).page !== 'die' && x.text('health-badge-text') === 'Idle', x.text('health-badge-text'));
    }

    // No credentials: settings only, then join after saving
    const empty = boot({ store: new Map(), search: '?room=AB12&view=die' });
    await sleep(50);
    check('die page without credentials shows only the settings', shell(empty).setup === 'needed' && empty.els['settings-panel'].open === true && empty.mock.created === 0, `${shell(empty).setup} open=${empty.els['settings-panel'].open}`);
    empty.els['cfg-url'].value = 'https://abc.supabase.co';
    empty.els['cfg-key'].value = ANON;
    await empty.els['settings-form'].fire('submit');
    await sleep(100);
    check('saving settings on the die page joins and hides them', shell(empty).setup === 'done' && empty.mock.channels[0] && empty.mock.channels[0].topic === 'realtime:gyrolink-room-AB12', `${shell(empty).setup}`);

    // supabase-js failed to load (CDN blocked): the observer gets the die page's own wording
    const noLib = boot({ search: '?room=AB12&view=die', windowExtras: { supabase: undefined } });
    await sleep(50);
    check('die page without supabase-js says Signal lost', noLib.text('v-stream-pill') === 'Signal lost', noLib.text('v-stream-pill'));

    // An ignored view=die must not come back once the normal Viewer joins a room
    const stray = boot({ search: '?view=die' });
    await stray.els['btn-choose-viewer'].fire('click');
    stray.els['viewer-room-input'].value = 'CD34';
    await stray.els['viewer-join-form'].fire('submit');
    await sleep(100);
    check('ignored view=die is dropped from the URL', stray.location.search === '?room=CD34', stray.location.search);

    // Old engines drop a whole rule over one selector they can't parse, e.g. a :not() selector list
    const dieRules = [...html.matchAll(/([^{}]*\[data-page="die"\][^{}]*)\{[^}]*display:\s*none/g)].map(m => m[1]);
    const listNot = dieRules.flatMap(sel => sel.match(/:not\([^)]*,[^)]*\)/g) || []);
    check('die-page hide rules avoid :not() selector lists', dieRules.length > 0 && listNot.length === 0, `rules=${dieRules.length} ${listNot.join(' ')}`);

    for (const p of [d, v, empty, noLib, stray]) await p.els['btn-viewer-back'].fire('click'); // stop watchdogs
    await sender.els['btn-sender-back'].fire('click');
  }

  // 11. Sender: Viewer | Die switch picks which page the QR code and link open
  {
    // Elements exist in the fake DOM only once the script looks them up
    const pressedOf = (p, id) => (p.els[id] || { attrs: {} }).attrs['aria-pressed'];
    const shell = p => (p.els['app-shell'] || { dataset: {} }).dataset;
    const server = createServer();
    const store = new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', ANON]]);
    const t = boot({ server, store, share: true });
    await t.els['btn-choose-sender'].fire('click');
    const room = t.text('s-room-code');
    const lastQr = () => t.qr[t.qr.length - 1] || '';
    const pressed = () => `${pressedOf(t, 'btn-link-viewer')},${pressedOf(t, 'btn-link-die')}`;
    check('sender QR opens the Viewer by default', pressed() === 'true,false' && !lastQr().includes('view=die'), `${pressed()} ${lastQr().slice(0, 60)}`);
    await (t.els['btn-link-die'] || boot.noEl).fire('click');
    check('Die switch: QR opens the die page with credentials', pressed() === 'false,true' && lastQr().includes(`?room=${room}&view=die#u=`) && lastQr().includes('k=') && store.get('gyrolink_sender_link') === 'die', `${pressed()} ${lastQr().slice(0, 60)}`);
    await t.els['btn-copy-link'].fire('click');
    check('Die switch: Share Link shares the die link titled Die', t.shares[0] && t.shares[0].url === lastQr() && t.shares[0].title === 'Die', JSON.stringify(t.shares[0]).slice(0, 80));

    // Scanning that QR code: the hash is scrubbed, view=die stays, the Sender counts it
    const u = new URL(lastQr());
    const d = boot({ server, store: new Map(), search: u.search, hash: u.hash });
    await sleep(150);
    check('scanned die QR opens the die page and joins', shell(d).page === 'die' && d.location.search === `?room=${room}&view=die` && d.location.hash === '' && d.text('health-badge-text') === 'Connected', `${shell(d).page} ${d.location.search} ${d.text('health-badge-text')}`);
    check('sender counts the scanned die page', t.text('s-viewers') === '1', t.text('s-viewers'));

    t.els['chk-include-creds'].checked = false;
    await t.els['chk-include-creds'].fire('change');
    check('die link without credentials', lastQr() === `https://example.com/?room=${room}&view=die`, lastQr());
    t.els['chk-include-creds'].checked = true;
    await t.els['chk-include-creds'].fire('change');

    await t.els['btn-new-room'].fire('click');
    await sleep(300);
    const room2 = t.text('s-room-code');
    check('New keeps the die link on the new room', lastQr().includes(`?room=${room2}&view=die#`), lastQr().slice(0, 60));
    await d.els['btn-viewer-back'].fire('click');
    await t.els['btn-sender-back'].fire('click');

    const t2 = boot({ store });
    await t2.els['btn-choose-sender'].fire('click');
    const lastQr2 = () => t2.qr[t2.qr.length - 1] || '';
    check('die link choice is remembered on reload', pressedOf(t2, 'btn-link-die') === 'true' && lastQr2().includes('&view=die'), lastQr2().slice(0, 60));
    await (t2.els['btn-link-viewer'] || boot.noEl).fire('click');
    check('Viewer switch goes back to the Viewer link', store.get('gyrolink_sender_link') === 'viewer' && !lastQr2().includes('view=die'), lastQr2().slice(0, 60));
    await t2.els['btn-sender-back'].fire('click');
  }

  // 12. Screen wake lock: asked for again when the browser drops it, and on a tap after a refusal
  {
    const held = p => p.wake.sentinels.filter(s => !s.released).length;
    // Browser drops the lock while the page stays visible (e.g. battery saver)
    const d = boot({ search: '?room=AB12&view=die' });
    await sleep(100);
    d.wake.autoRelease();
    await sleep(1300);
    check('wake lock asked for again when dropped while visible', d.wake.requested === 2 && held(d) === 1, `requests=${d.wake.requested} held=${held(d)}`);

    // Hidden page: wait for visibilitychange instead of asking in the background
    d.doc.visibilityState = 'hidden';
    d.wake.autoRelease();
    await sleep(1300);
    check('no wake lock request while the page is hidden', d.wake.requested === 2, `requests=${d.wake.requested}`);
    d.doc.visibilityState = 'visible';
    await d.fireDoc('visibilitychange');
    await sleep(50);

    // Refused on load (no tap yet): the next tap anywhere asks again, once
    const r = boot({ search: '?room=AB12&view=die', wakeDeny: true });
    await sleep(100);
    check('die page wake lock refused on load', r.wake.requested === 1 && held(r) === 0, `requests=${r.wake.requested}`);
    r.wake.deny = false;
    await sleep(1300);
    check('a refusal is not retried without a tap', r.wake.requested === 1, `requests=${r.wake.requested}`);
    r.fireDoc('pointerup');
    r.fireDoc('pointerup');
    await sleep(50);
    check('a tap asks for the wake lock again', r.wake.requested === 2 && held(r) === 1, `requests=${r.wake.requested} held=${held(r)}`);
    await r.fireDoc('pointerup');
    await sleep(50);
    check('taps while the lock is held ask nothing', r.wake.requested === 2, `requests=${r.wake.requested}`);

    // Intentional release (Sender stops streaming) is not undone
    const s = boot();
    await s.els['btn-choose-sender'].fire('click');
    await s.els['btn-toggle-stream'].fire('click');
    await sleep(100);
    const before = s.wake.requested;
    await s.els['btn-toggle-stream'].fire('click');
    await sleep(1300);
    await s.fireDoc('pointerup');
    await sleep(50);
    check('stopping the stream releases the wake lock for good', before === 1 && s.wake.requested === 1 && held(s) === 0, `before=${before} requests=${s.wake.requested} held=${held(s)}`);

    for (const p of [d, r]) await p.els['btn-viewer-back'].fire('click');
    await s.els['btn-sender-back'].fire('click');
  }

  check('no unhandled promise rejections', unhandled.length === 0, unhandled.join('; '));

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  // A throwing check must fail the run loudly, not end it silently with exit code 0
  console.log(results.join('\n'));
  console.error(`\nHARNESS CRASHED after ${results.length} checks:\n${(err && err.stack) || err}`);
  process.exit(1);
});
