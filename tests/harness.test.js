#!/usr/bin/env node
// Behavioral tests for index.html. No dependencies. Run: node tests/harness.test.js (Node 18+)
//
// Runs the page's real inline <script> in a vm sandbox with a fake DOM and a mock Supabase
// client. The mock copies the realtime-js 2.119.2 behaviors the reconnect logic depends on:
//   - client.channel(topic) returns an existing channel with the same topic instead of a new one
//   - channel.unsubscribe() (leave) is async; the channel leaves the client's list once it closes
//   - subscribe() throws if called twice on the same channel instance
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const ANON = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'anon', iss: 'supabase' })}.sig_sig_sig_sig`;
const SERVICE = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'service_role', iss: 'supabase' })}.sig_sig_sig_sig`;

function boot({ search = '', storedKey = ANON, leaveDelay = 150, joinDelay = 30 } = {}) {
  const errors = [];
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
    constructor(topic) { this.topic = topic; this.state = 'closed'; this.joinedOnce = false; this.handlers = []; this.cb = null; }
    on(type, filter, cb) { this.handlers.push(cb); return this; }
    subscribe(cb) {
      if (this.joinedOnce) { mock.subscribeThrows++; throw new Error('tried to subscribe multiple times'); }
      this.joinedOnce = true; this.state = 'joining'; this.cb = cb;
      setTimeout(() => { if (this.state === 'joining') { this.state = 'joined'; cb('SUBSCRIBED'); } }, mock.joinDelay);
      return this;
    }
    unsubscribe() {
      this.state = 'leaving';
      return new Promise(res => setTimeout(() => {
        this.state = 'closed';
        mock.channels = mock.channels.filter(c => c !== this);
        if (this.cb) this.cb('CLOSED');
        res('ok');
      }, mock.leaveDelay));
    }
    teardown() {}
    send(msg) { mock.sent.push(msg); return Promise.resolve('ok'); }
  }
  const client = {
    channel(name) {
      const topic = `realtime:${name}`;
      const existing = mock.channels.find(c => c.topic === topic);
      if (existing) return existing;
      mock.created++;
      const c = new MockChannel(topic);
      mock.channels.push(c);
      return c;
    },
    removeAllChannels: async () => {},
    realtime: { isConnected: () => mock.connected },
  };

  const store = new Map([['gyrolink_supabase_url', 'https://abc.supabase.co'], ['gyrolink_supabase_anon_key', storedKey]]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  function QRCode() {}
  QRCode.CorrectLevel = { L: 1, M: 0 };
  const window = {
    location: { href: `https://example.com/${search}`, protocol: 'https:', hostname: 'example.com', hash: '', search },
    history: { replaceState() {} },
    addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
    removeEventListener(t, fn) { winListeners[t] = (winListeners[t] || []).filter(f => f !== fn); },
    supabase: { createClient: (url, key, opts) => { mock.createClientOpts = opts; return client; } },
    QRCode,
    crypto: require('crypto').webcrypto,
    prompt() {},
  };

  // Browsers auto-release screen wake locks when the page is hidden and fire 'release'
  const wake = { requested: 0, released: 0, sentinels: [] };
  wake.autoRelease = () => wake.sentinels.forEach(s => {
    if (!s.released) { s.released = true; s.listeners.forEach(fn => fn()); }
  });
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
  };

  const ctx = vm.createContext({
    window, document, localStorage, navigator, console, atob, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, performance,
  });
  process.removeAllListeners('unhandledRejection');
  process.on('unhandledRejection', e => errors.push(String((e && e.message) || e)));
  vm.runInContext(code, ctx);
  return {
    els, mock, wake, store, errors,
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
  // 1. Viewer: resume fires 'visibilitychange' + 'online' together while the socket looks dead
  {
    const t = boot();
    await t.els['btn-choose-viewer'].fire('click');
    await sleep(100);
    check('viewer subscribes', t.els['health-badge-text'].textContent === 'Connected', t.els['health-badge-text'].textContent);
    check('viewer requests wake lock', t.wake.requested === 1, `requests=${t.wake.requested}`);
    check('heartbeatIntervalMs=5000 passed to client', t.mock.createClientOpts.realtime.heartbeatIntervalMs === 5000);

    const createdBefore = t.mock.created;
    t.mock.connected = false; // socket looks dead on resume
    t.wake.autoRelease();     // page was hidden -> browser dropped the wake lock
    t.fireDoc('visibilitychange');
    t.fireWin('online');
    await sleep(t.mock.leaveDelay + 300);
    t.mock.connected = true;
    await sleep(1500); // long enough for any spurious backoff reconnect (1 s base) to fire
    const ch = t.mock.channels;
    check('resume race: exactly one live channel', ch.length === 1 && ch[0].state === 'joined', `channels=${ch.length} states=${ch.map(c => c.state)}`);
    check('resume race: one broadcast handler (no double-counting)', ch.length === 1 && ch[0].handlers.length === 1, `handlers=${ch.map(c => c.handlers.length)}`);
    check('resume race: no double-subscribe throw', t.mock.subscribeThrows === 0 && t.errors.length === 0, t.errors.join('; '));
    check('resume race: one new channel, no spurious extra reconnects', t.mock.created - createdBefore === 1, `new channels=${t.mock.created - createdBefore}`);
    check('resume race: badge back to Connected', t.els['health-badge-text'].textContent === 'Connected', t.els['health-badge-text'].textContent);
    check('wake lock re-requested on visibility', t.wake.requested === 2, `requests=${t.wake.requested}`);

    // 2. Switch Mode while a reconnect is mid-flight -> nothing left subscribed
    t.mock.leaveDelay = 300;
    t.fireWin('online'); // starts a connect that waits on the slow leave
    await sleep(50);
    await t.els['btn-viewer-back'].fire('click');
    await sleep(600);
    check('disconnect during in-flight connect: no orphan channel', t.mock.channels.length === 0, `channels=${t.mock.channels.length}`);
    check('disconnect during in-flight connect: badge Idle', t.els['health-badge-text'].textContent === 'Idle', t.els['health-badge-text'].textContent);
  }

  // 2b. 3D mirror matches the W3C orientation, using the real CSS rule and real script output
  {
    const t = boot();
    await t.els['btn-choose-viewer'].fire('click');
    await sleep(100);
    const ch = t.mock.channels[0];
    const poses = [[0, 0, 0], [90, 0, 0], [0, 90, 0], [0, 0, 45], [30, 90, 0], [120.5, -35.2, 60.1], [300, 170, -80], [45, -90, 10]];
    let worst = 0;
    for (const [a, b, g] of poses) {
      ch.handlers[0]({ payload: { a, b, g, seq: 1, ts: Date.now() } });
      worst = Math.max(worst, maxDiff(renderedCssMatrix(t.els['phone-3d'].style), expectedCssMatrix(a, b, g)));
    }
    check('3D transform matches W3C Z-X\'-Y\'\' orientation', worst < 1e-9, `max matrix error=${worst.toExponential(2)}`);
    await t.els['btn-viewer-back'].fire('click'); // stop the watchdog interval
  }

  // 3. Sender via QR link: tapping Start before SUBSCRIBED must not restart the join
  {
    const t = boot({ search: '?room=AB12', joinDelay: 150 });
    await sleep(10); // init -> enterSenderMode -> auto connect (joining)
    await t.els['btn-toggle-stream'].fire('click');
    await sleep(400);
    check('QR flow: Start during join reuses it (1 channel created)', t.mock.created === 1, `created=${t.mock.created}`);
    check('QR flow: subscribed', t.els['s-channel'].textContent === 'SUBSCRIBED', t.els['s-channel'].textContent);

    // 4. No packets until a real sensor reading arrives
    check('no 0/0/0 packets before sensor data', t.mock.sent.length === 0, `sent=${t.mock.sent.length}`);
    check('deviceorientation listener attached', t.hasWinListener('deviceorientation'));
    await t.fireWin('deviceorientation', { alpha: 12.34, beta: -5.67, gamma: 8.9 });
    await sleep(350);
    const last = t.mock.sent[t.mock.sent.length - 1];
    check('packets flow after first reading', t.mock.sent.length >= 2, `sent=${t.mock.sent.length}`);
    check('payload carries the reading', last && last.payload.a === 12.3 && last.payload.b === -5.7 && last.payload.g === 8.9, JSON.stringify(last && last.payload));
    await t.els['btn-toggle-stream'].fire('click'); // stop the 10 Hz interval
  }

  // 5. Secret keys rejected and purged
  {
    const t = boot({ storedKey: SERVICE });
    check('stored service_role key purged on load', !t.store.has('gyrolink_supabase_anon_key'));
    check('settings error shown', t.els['settings-error'].hidden === false && /secret/.test(t.els['settings-error'].textContent));
    t.els['cfg-url'].value = 'https://abc.supabase.co';
    for (const [label, key] of [['service_role JWT', SERVICE], ['sb_secret_ key', 'sb_secret_abcdefghijklmnopqrstuvwxyz']]) {
      t.els['cfg-key'].value = key;
      await t.els['settings-form'].fire('submit');
      check(`settings rejects ${label}`, !t.store.has('gyrolink_supabase_anon_key') && /secret/.test(t.els['settings-error'].textContent));
    }
    for (const [label, key] of [['anon JWT', ANON], ['sb_publishable_ key', 'sb_publishable_abcdefghijklmnopqrstuvwxyz']]) {
      t.els['cfg-key'].value = key;
      await t.els['settings-form'].fire('submit');
      check(`settings accepts ${label}`, t.store.get('gyrolink_supabase_anon_key') === key);
    }
  }

  console.log(results.join('\n'));
  const failed = results.filter(r => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
