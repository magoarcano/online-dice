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

const transformMatch = /\.phone-3d\s*\{[^}]*?transform:\s*([^;]+);/.exec(html);
if (!transformMatch) throw new Error('could not find the .phone-3d transform rule');
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

function boot({ search = '', storedKey = ANON, leaveDelay = 150, joinDelay = 30, server = createServer(), store, share = false } = {}) {
  const els = {};
  const mkEl = id => {
    const listeners = {};
    return {
      id, textContent: '', hidden: false, className: '', value: '', checked: id === 'chk-include-creds',
      type: id === 'cfg-key' ? 'password' : 'text', open: false, innerHTML: '', dataset: {},
      style: { setProperty(k, v) { this[k] = v; } },
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
  const location = { href: `https://example.com/${search}`, protocol: 'https:', hostname: 'example.com', hash: '', search };
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
  };

  // Browsers auto-release screen wake locks when the page is hidden and fire 'release'
  const wake = { requested: 0, released: 0, sentinels: [] };
  wake.autoRelease = () => wake.sentinels.forEach(s => {
    if (!s.released) { s.released = true; s.listeners.forEach(fn => fn()); }
  });
  const shares = [];
  const navigator = {
    wakeLock: {
      request: async () => {
        wake.requested++;
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
    els, mock, wake, store, qr, shares, prompts, location,
    text: id => els[id] && els[id].textContent,
    fireWin: (t, ev) => Promise.all((winListeners[t] || []).map(fn => fn(ev || {}))),
    fireDoc: t => Promise.all((docListeners[t] || []).map(fn => fn({}))),
    hasWinListener: t => (winListeners[t] || []).length > 0,
  };
}

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
// What the page actually renders: the .phone-3d rotate list (in CSS order) with the --rx/--ry/--rz the script set
const renderedCssMatrix = style => cssRotations
  .map(([axis, v]) => R[axis](rad(parseFloat(style[`--${v}`]))))
  .reduce((acc, m) => mul(acc, m));

// --- Tests -----------------------------------------------------------------------------------
const results = [];
const check = (name, cond, detail = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);

(async () => {
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
      worst = Math.max(worst, maxDiff(renderedCssMatrix(t.els['phone-3d'].style), expectedCssMatrix(a, b, g)));
    }
    check('3D transform matches W3C Z-X\'-Y\'\' orientation', worst < 1e-9, `max matrix error=${worst.toExponential(2)}`);
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
    await t.els['btn-toggle-stream'].fire('click'); // stop the 10 Hz interval

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
