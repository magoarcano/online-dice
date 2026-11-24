# GyroLink

Stream live gyroscope (device orientation) data from one phone to another at **10 Hz** over **Supabase Realtime Broadcast**. Delivery is fire-and-forget, the app reconnects on its own, and nothing is ever written to the database.

**Live:** https://magoarcano.github.io/online-dice/

- **Sender** phone: reads `DeviceOrientationEvent` (alpha / beta / gamma) and broadcasts the latest reading every 100 ms.
- **Viewer** phone: creates a room, shows a QR code for pairing, and mirrors the Sender's orientation on a 3D phone model, with rate, jitter, packet-age and dropped-packet stats.

The whole app is one static file, `index.html`, with no build step. (The repo is named `online-dice` for historical reasons; the app is GyroLink.)

---

## Setup

### 1. Supabase project (one time)

1. Create a project at [supabase.com](https://supabase.com). The free plan works.
2. Go to **Project Settings → API Keys** and copy:
   - the **Project URL** (`https://<ref>.supabase.co`)
   - the **anon** key (legacy JWT) **or** a **publishable** key (`sb_publishable_…`)
3. That's all. There are **no tables, SQL, migrations or RLS policies** to create: Broadcast messages never touch Postgres.

> ⚠️ Never use the `service_role` / `sb_secret_…` key. It bypasses RLS. The app rejects secret keys, and deletes one if it finds it saved in the browser.

> If **Realtime → Settings** has public channel access turned off, joining fails with `CHANNEL_ERROR`, because the app uses public channels.

### 2. Pair two phones

1. On the **Viewer** phone, open the live URL and tap **View Live Data**.
2. Open **Supabase Settings**, paste the URL and key, then tap **Save & Apply**. They're stored only in that browser's `localStorage`.
3. On the **Sender** phone, scan the QR code. By default it carries the room code **and** the credentials (in the URL `#hash`), so the Sender is set up with one tap.
4. Tap **Start Streaming**. On iOS, allow **Motion & Orientation** access when asked.

You can also choose **Send Gyroscope Data** on the Sender and type the 4-character room code by hand.

### Requirements

| Requirement | Why |
| --- | --- |
| **HTTPS** (or `localhost`) | Browsers only expose `DeviceOrientationEvent` in secure contexts. GitHub Pages provides HTTPS. |
| iOS 13+ | Motion permission via `DeviceOrientationEvent.requestPermission()`, which needs a tap. |
| Screen Wake Lock (iOS 16.4+, Chrome 84+) | Keeps both screens on. Without it the phone auto-locks and the stream stops. The app still works where it's unsupported. |

Desktop browsers have no gyroscope. After about 1.6 s the Sender offers **Enable Simulated Gyro (Test)**, which is useful for testing with one phone, or none.

---

## Development

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

`localhost` counts as a secure context on desktop, but phones on your LAN reach the server over plain `http://`, which blocks the gyroscope. To test on phones, either push to `main` (Pages redeploys in about 1 minute) or use an HTTPS tunnel, such as `cloudflared tunnel --url http://localhost:8000` or `ngrok http 8000`.

**Deployment:** GitHub Pages serves the root of `main`, with HTTPS enforced. Every push to `main` goes live.

### Tests

```sh
npm test        # same as: node tests/harness.test.js   (Node 18+, no dependencies, ~5 s)
```

`tests/harness.test.js` runs the page's **real inline script** in a Node `vm` sandbox with a fake DOM and a mock Supabase client. The mock copies the realtime-js 2.119.2 behaviors the reconnect logic depends on: same-topic channel reuse, async leave, and throwing on a second `subscribe`. It covers:
- **Reconnects:** `visibilitychange` + `online` firing together leave one channel and one handler, with no extra reconnects. Switch Mode during an in-flight connect leaves no stray channel. The QR-link auto-connect isn't restarted by tapping Start.
- **3D mirror:** feeds poses through the Viewer and compares the actual `.phone-3d` CSS transform (parsed from `index.html`) with the W3C rotation matrix.
- **Sending:** no packets before the first sensor reading, and payloads carry the reading.
- **Settings:** wake lock requested and re-requested, `heartbeatIntervalMs` passed to the client, secret keys rejected and purged, anon/publishable keys accepted.

It can't cover real browsers, sensors or Supabase; use the manual checklist below for those. `package.json` exists only for `npm test`, and the app has no build step.

**Credentials in code (optional):** `SUPABASE_URL` / `SUPABASE_ANON_KEY` at the top of the script are fallbacks used when nothing is saved in `localStorage`. This repo is public, so prefer the in-app settings panel over committing a key.

---

## How it works

### Protocol

| | |
| --- | --- |
| Channel | `gyrolink-room-<CODE>` (public), config `broadcast: { ack: false, self: false }` |
| Event | `gyro` |
| Payload | `{ a, b, g, seq, ts }`: degrees rounded to 0.1, `seq` increases by 1 per sent packet, `ts` = sender `Date.now()` |
| Room code | 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `I L O 0 1`) |
| Pairing URL | `?room=CODE#u=<supabase-url>&k=<key>`. Credentials go in the hash, so they never reach a server. They're cleared from the address bar on load and saved under `gyrolink_supabase_url` / `gyrolink_supabase_anon_key`. |

### Sender
- `deviceorientation` updates the latest reading. A `setInterval(100 ms)` loop broadcasts it, but only after the first real (or simulated) reading, so it never sends a placeholder `0/0/0`.
- Sending is gated on `state.isSubscribed`. Without that gate, `channel.send()` would silently fall back to REST POSTs.
- The iOS permission request must be the **first `await`** in the Start click handler, or iOS loses the user gesture and refuses.

### Viewer
- Renders each packet as it arrives. A watchdog every 120 ms marks the stream **Stalled** after 500 ms without packets and **Sender Offline** after 2000 ms.
- **Jitter** is the mean absolute deviation from 100 ms over the last 25 gaps between packets. **Drops** are counted from gaps in `seq`; a lower `seq` means the Sender restarted, which resets the count.
- **3D model:** `rotateZ(-α) rotateX(-β) rotateY(γ)`. That's the W3C intrinsic Z-X′-Y″ order, adjusted for CSS's downward Y axis, with the camera looking down at a phone lying flat. The angles are unwrapped so the CSS transition never spins the long way around through 360°.
- **Calibrate** subtracts each angle separately. That's approximate and fine for small tilts, but it distorts at large ones.

### Reconnection (script section 8: `connectToRoom`)
Two layers work together:
1. **realtime-js itself** rejoins channels and reconnects the socket. `heartbeatIntervalMs: 5000` (default 25 s) means a half-open socket, e.g. after a Wi-Fi to cellular handoff, is detected in about 10 s.
2. **The app** retries with exponential backoff (1 s → 30 s, +15 % jitter) on `TIMED_OUT` / `CHANNEL_ERROR` / `CLOSED`, and reconnects immediately on `visibilitychange` (tab visible again) and `online`.

Overlapping connect/disconnect calls are serialized:
- `state.connectGen` is a counter bumped by every connect and disconnect. A call that wakes up after an `await` and finds a newer counter value gives up.
- `detachChannel()` / `state.channelTeardown` make sure a new channel is only created after the old one has fully left.

This matters because `client.channel(topic)` **returns any existing channel with the same topic**. Without the wait, a reconnect could pick up the old, half-closed channel, causing double handlers or a "subscribe multiple times" error. The leave timeout is 1.5 s (default 10 s); Phoenix drops the channel on leave `ok` *or* timeout.

### Code map
`index.html` = CSS, then markup (three views: selector / sender / viewer), then one inline script, organized in numbered sections:
`1` config placeholders · `2` constants · `3` state · `4` DOM refs · `5` utils · `6` credentials & URL parsing (`isSecretKey`, `validateCredentials`) · `7` health badge · `8` Realtime transport & backoff · `9` wake lock · `10` sender · `11` viewer (QR, 3D, watchdog) · `12` mode switching · `13` visibility & network recovery · `14` event listeners · `15` init.

---

## Rules for future changes

- Run `npm test` before pushing. Pushing to `main` deploys.
- **supabase-js is pinned to `2.119.2`** (UMD from jsDelivr). The reconnect logic depends on this version's same-topic channel reuse and leave behavior. Before bumping it, check those behaviors in the new realtime-js source, update the mock in `tests/harness.test.js` if they changed, and re-test reconnection on real phones.
- Keep it **one static file with no build step**. Dependencies come from CDNs: supabase-js and `qrcodejs@1.0.0`.
- **No database writes.** Use Broadcast only. Don't switch to Postgres Changes or "Broadcast from Database".
- Never let a secret key into `localStorage`, a QR code or a link. Route all key checks through `validateCredentials`.
- Write user-visible strings with `textContent`, never `innerHTML`, since payloads come from anyone in the room.

## Limits & costs

- **Quota:** each packet counts as 1 message sent plus 1 per viewer receiving it. One Sender and one Viewer is about 20 msg/s, or about 1.7 M messages per day. Check your plan's monthly Realtime message quota; at the time of writing the free plan included 2 M per month.
- **Security model:** channels are public, the room code has about 920 k combinations, and shared links contain the anon key. Anyone with the link can listen in or send fake packets. That's fine for demos. For anything sensitive, move to private channels with RLS on `realtime.messages`.

## Known gaps / TODO

- [ ] Check the 3D tilt directions on real devices. `npm test` checks the math against the spec, but no real devices have been tested yet.
- [ ] Calibration uses per-angle subtraction; quaternions would be correct at large tilts.
- [ ] The Sender can't tell whether a Viewer is connected. Realtime Presence could show it.
- [ ] Two Senders in one room would interleave their packets and inflate the drop count.
- [ ] URL validation accepts `http:`, but its error message says "must start with https://".

### Manual test checklist
1. Viewer: create a room, and the QR code renders. Sender: scan it and start streaming. The Viewer shows **Live** at about 10 Hz.
2. Lock the Sender phone for 10 s, then unlock. The stream resumes on its own.
3. Toggle airplane mode on either phone. It reconnects after the network returns.
4. Leave the Viewer untouched for over 1 minute. The screen stays on (wake lock).
5. Paste a `service_role` key into settings. It's rejected.
