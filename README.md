# GyroLink

Stream live gyroscope (device orientation) and accelerometer data from one phone to another at **10 Hz** over **Supabase Realtime Broadcast**. Delivery is fire-and-forget, the app reconnects on its own, and nothing is ever written to the database.

**Live:** https://magoarcano.github.io/online-dice/

- **Sender** (the phone that moves) hosts the room. It shows the room's QR code and share link, counts connected Viewers, reads `DeviceOrientationEvent` (alpha / beta / gamma) and `DeviceMotionEvent` (acceleration), and broadcasts the latest reading every 100 ms.
- **Viewers** join the Sender's room, as many as you like. Each one mirrors the orientation on a 3D phone model, or a die with a big readout of the number on top, shows the acceleration, and has rate, jitter, packet-age and dropped-packet stats.

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

### 2. Pair the phones

1. On the **Sender** phone, open the live URL and tap **Send Gyroscope Data**. It creates a 4-character room and shows its QR code.
2. Open **Supabase Settings**, paste the URL and key, then tap **Save & Apply**. They're stored only in that browser's `localStorage`, and the QR code now carries them.
3. On each **Viewer**, scan the QR code. Or use **Share Link** / **Copy Link** for Viewers somewhere else. The link carries the room code **and** the credentials (in the URL `#hash`), so every Viewer is set up with one tap. **Viewers Watching** on the Sender counts them as they join.
4. On the Sender, tap **Start Streaming**. On iOS, allow **Motion & Orientation** access when asked. The QR panel collapses; tap it to bring the QR code back for late joiners.

A Viewer can also tap **View Live Data** and type the room code by hand. It then needs the Supabase settings entered itself.

The Sender keeps its room across reloads, so Viewers stay paired. **New** moves to a fresh room, and Viewers must then re-join with the new code. A Viewer's address bar keeps `?room=CODE`, so reloading a Viewer rejoins the same room.

### Requirements

| Requirement | Why |
| --- | --- |
| **HTTPS** (or `localhost`) | Browsers only expose `DeviceOrientationEvent` in secure contexts. GitHub Pages provides HTTPS. |
| iOS 13+ | Motion permission via `DeviceOrientationEvent.requestPermission()` and `DeviceMotionEvent.requestPermission()`, which need a tap. iOS shows one prompt for both. |
| Screen Wake Lock (iOS 16.4+, Chrome 84+) | Keeps both screens on. Without it the phone auto-locks and the stream stops. The app still works where it's unsupported. |

Desktop browsers have no gyroscope. After about 1.6 s the Sender offers **Enable Simulated Gyro (Test)**, which is useful for testing with one phone, or none. It simulates acceleration too, with gravity matching the simulated tilt.

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

`tests/harness.test.js` runs the page's **real inline script** in Node `vm` sandboxes, one per simulated phone, each with a fake DOM and a mock Supabase client. Phones share an in-memory mock server, so broadcasts and presence flow between them. The mock copies the realtime-js 2.119.2 behaviors the app depends on: same-topic channel reuse, async leave, throwing on a second `subscribe`, and presence `track`/`sync`. It covers:
- **Pairing:** the Sender creates, saves and reuses its room, **New** moves rooms, and the QR code and share link carry the room and credentials. Links open Viewer mode, typed codes are cleaned up and validated, and `?room=` is kept for reloads.
- **One Sender, many Viewers:** two Viewers both receive the stream, and the Sender counts 2, then 1 when one leaves.
- **Reconnects:** `visibilitychange` + `online` firing together leave one channel and one handler, with no extra reconnects, and presence is re-tracked. Switch Mode during an in-flight connect leaves no stray channel. Tapping Start doesn't restart the Sender's auto-connect.
- **3D mirror:** feeds poses through the Viewer and compares the actual `.model-3d` CSS transform (parsed from `index.html`) with the W3C rotation matrix.
- **Die:** the `.die-N` faces (parsed from `index.html`) sit on the specified sides, the big number is right for each side resting up and matches the face the drawn die points at the camera across 120 poses, it doesn't flicker near an edge, Calibrate re-zeroes it, and the Phone / Die choice is saved.
- **Sending:** no packets before the first sensor reading, and payloads carry the reading.
- **Acceleration:** with and without gravity in the payload, a tap between two packets caught as the peak, gravity-only devices, malformed values shown as `—`, the Viewer's 1 s peak hold, both iOS permission requests made inside the tap, iOS signs flipped to the W3C convention, and simulated gravity matching the simulated tilt.
- **Settings:** wake lock requested and re-requested, `heartbeatIntervalMs` passed to the client, secret keys rejected and purged, anon/publishable keys accepted.

If a check throws, the run reports a crash and exits 1, never a silent pass.

It can't cover real browsers, sensors or Supabase; use the manual checklist below for those. `package.json` exists only for `npm test`, and the app has no build step.

**Credentials in code (optional):** `SUPABASE_URL` / `SUPABASE_ANON_KEY` at the top of the script are fallbacks used when nothing is saved in `localStorage`. This repo is public, so prefer the in-app settings panel over committing a key.

---

## How it works

### Protocol

| | |
| --- | --- |
| Channel | `gyrolink-room-<CODE>` (public), config `broadcast: { ack: false, self: false }` |
| Event | `gyro` |
| Payload | `{ a, b, g, seq, ts, acc, accg, pk }`: degrees rounded to 0.1, `seq` increases by 1 per sent packet, `ts` = sender `Date.now()`. Acceleration in m/s², rounded to 0.01, W3C device axes: `acc` = `[x, y, z]` without gravity, `accg` = `[x, y, z]` with gravity (about `[0, 0, 9.81]` lying flat, screen up), `pk` = peak \|`acc`\| since the previous packet. `acc`/`accg`/`pk` are left out until the accelerometer reports. `acc` and `pk` are `null` on devices that only report acceleration with gravity. |
| Presence | Viewers `track({ role: 'viewer' })` under a stable per-tab key (`config.presence.key`) and re-track on every (re)join. The Sender listens for `sync` and counts keys with a viewer entry. Presence is in-memory on the Realtime server, with no DB writes. |
| Room code | 4 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `I L O 0 1`). Created by the **Sender** and saved under `gyrolink_sender_room`. |
| Pairing URL | `?room=CODE#u=<supabase-url>&k=<key>` opens **Viewer** mode and joins `CODE`. Credentials go in the hash, so they never reach a server. They're cleared from the address bar on load and saved under `gyrolink_supabase_url` / `gyrolink_supabase_anon_key`. |

### Sender
- Hosts the room. On entering Sender mode it reuses or creates its room code, renders the QR code and connects right away, so the Viewer count is live before streaming starts. Start Streaming reuses that connection, even while it's still joining.
- `deviceorientation` updates the latest reading. A `setInterval(100 ms)` loop broadcasts it, but only after the first real (or simulated) reading, so it never sends a placeholder `0/0/0`.
- `devicemotion` (about 60 Hz) updates the latest acceleration and tracks the peak between ticks. Each packet carries the latest sample plus that peak, so a short tap or bump that falls between two packets still reaches the Viewers. Acceleration rides in the same packet, so it adds bytes, not messages.
- **iOS acceleration signs are flipped** to match the W3C spec. WebKit on iOS passes Core Motion's readings straight through (`WebCoreMotionManager.mm`), and Core Motion's sign is the opposite of the spec's: lying flat, screen up, it reads z = −9.81 instead of +9.81. Both vectors are flipped, since WebKit builds them from the same values. iOS is detected by `DeviceMotionEvent.requestPermission`, which only WebKit on iOS / iPadOS has.
- Sending is gated on `state.isSubscribed`. Without that gate, `channel.send()` would silently fall back to REST POSTs.
- Both iOS permission requests (orientation and motion) must **start before the first `await`** in the Start click handler, or iOS loses the user gesture and refuses. Motion access is optional: if it fails, the Sender streams orientation only.

### Viewer
- Joins with `joinViewerRoom()` from a pairing link or a typed code. Until it has joined, the badge shows **Not Joined**. Switching rooms resets its stats and calibration.
- Renders each packet as it arrives. A watchdog every 120 ms marks the stream **Stalled** after 500 ms without packets and **Sender Offline** after 2000 ms.
- **Jitter** is the mean absolute deviation from 100 ms over the last 25 gaps between packets. **Drops** are counted from gaps in `seq`; a lower `seq` means the Sender restarted, which resets the count.
- **3D model:** `rotateZ(-α) rotateX(-β) rotateY(γ)` on `.model-3d`. That's the W3C intrinsic Z-X′-Y″ order, adjusted for CSS's downward Y axis, with the camera looking down at a phone lying flat. The angles are unwrapped so the CSS transition never spins the long way around through 360°.
- **Acceleration:** each axis card shows acceleration without gravity, with the with-gravity value underneath. **Peak** holds the highest `pk` for 1 s so a short tap stays readable. Malformed values show `—`. Calibrate doesn't affect acceleration.
- **Die:** the **Phone / Die** toggle on the stage swaps the model, and the choice is saved under `gyrolink_viewer_model`. The die's faces follow the phone's sides: screen **1**, back **6**, right **3**, left **4**, top edge **2**, bottom edge **5**. **On Top** shows, in big, the face pointing most nearly up: the largest entry of the W3C rotation matrix's bottom row `[-cos β sin γ, sin β, cos β cos γ]`, signed per face. Alpha doesn't change it. It uses the same calibrated pose as the model, keeps the current face until another is about 3° past the 45° edge (`DIE_HYSTERESIS`), shows `—` before the first packet, and dims while the stream isn't Live.
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
`1` config placeholders · `2` constants · `3` state · `4` DOM refs · `5` utils · `6` credentials & URL parsing (`isSecretKey`, `validateCredentials`) · `7` health badge · `8` Realtime transport, presence count & backoff · `9` wake lock · `10` sender streaming (orientation, acceleration & peak, simulation) · `11` room pairing (Sender: QR, link, saved room) & viewer (3D, die & top face, watchdog) · `12` mode switching (`enterSenderMode`, `enterViewerMode`, `joinViewerRoom`) · `13` visibility & network recovery · `14` event listeners · `15` init.

---

## Rules for future changes

- Run `npm test` before pushing. Pushing to `main` deploys.
- **supabase-js is pinned to `2.119.2`** (UMD from jsDelivr). The reconnect logic depends on this version's same-topic channel reuse and leave behavior. Before bumping it, check those behaviors in the new realtime-js source, update the mock in `tests/harness.test.js` if they changed, and re-test reconnection on real phones.
- Keep it **one static file with no build step**. Dependencies come from CDNs: supabase-js and `qrcodejs@1.0.0`.
- **No database writes.** Use Broadcast only. Don't switch to Postgres Changes or "Broadcast from Database".
- Never let a secret key into `localStorage`, a QR code or a link. Route all key checks through `validateCredentials`.
- Write user-visible strings with `textContent`, never `innerHTML`, since payloads come from anyone in the room.

## Limits & costs

- **Quota:** each packet counts as 1 message sent plus 1 per viewer receiving it. One Sender and one Viewer is about 20 msg/s, or about 1.7 M messages per day, and **each extra Viewer adds about 10 msg/s** (~0.86 M/day). Presence adds only a few messages when Viewers join or leave. Acceleration doesn't add messages; it makes each one about 60 bytes bigger. Check your plan's monthly Realtime message quota; at the time of writing the free plan included 2 M per month.
- **Security model:** channels are public, the room code has about 920 k combinations, and shared links contain the anon key. Anyone with the link can listen in or send fake packets. That's fine for demos. For anything sensitive, move to private channels with RLS on `realtime.messages`.

## Known gaps / TODO

- [ ] Check the acceleration signs on a real Android phone. iPhone is confirmed and fixed: before the flip it read z = −9.81 lying flat.
- [ ] Check the 3D tilt directions on real devices. `npm test` checks the math against the spec, but no real devices have been tested yet.
- [ ] Calibration uses per-angle subtraction; quaternions would be correct at large tilts.
- [ ] Viewers can't tell an idle Sender (online, not streaming) from an absent one. The Sender could also track presence.
- [ ] Two Senders in one room would interleave their packets and inflate the drop count.
- [ ] The Viewer count can lag when a Viewer vanishes without leaving, such as a dead battery, until the Realtime server notices.
- [ ] URL validation accepts `http:`, but its error message says "must start with https://".

### Manual test checklist
1. Sender: the room and QR code render. Two Viewers scan it, and **Viewers Watching** shows 2. Start streaming, and both Viewers show **Live** at about 10 Hz.
2. Lock the Sender phone for 10 s, then unlock. The stream resumes on its own. Reload the Sender: same room, and the Viewers recover without re-pairing.
3. Toggle airplane mode on either phone. It reconnects after the network returns.
4. Leave the Viewer untouched for over 1 minute. The screen stays on (wake lock).
5. Paste a `service_role` key into settings. It's rejected.
6. With the Sender lying flat and screen up, **with g** on the Viewer's Z card reads about +9.81. Tap the Sender on the table: the Viewer's **Peak** jumps and holds for about 1 s.
7. Switch the Viewer to **Die**. Lay the Sender flat, screen up: **On Top** reads 1, and the die shows its 1 face. Screen down: 6. Stand it on its bottom edge: 2. On its top edge: 5. Right edge up: 3. Left edge up: 4. Reload the Viewer: it stays on Die.
