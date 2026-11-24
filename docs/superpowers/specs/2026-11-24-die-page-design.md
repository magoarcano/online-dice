# Die page: design

## Why

The Sender phone sits inside a box and acts as the die. An observer watches the die page on another phone. After a roll, they see the result. While someone holds the box, they see it tilt. The observer should see only the die, the face on top, and whether the stream is live. Nothing on the page should give away how it works.

## Goals

- A Viewer page that shows only three things:
  - the 3D die, moving live with the box
  - the number of the face on top, very big
  - a small status: a dot and a word
- The Sender offers this page's QR code and link next to the existing Viewer ones.

## Non-goals

- Changing what the Sender sends, the protocol, or the normal Viewer.
- Hiding the room from the address bar. It stays there, so a reload rejoins.
- Calibration, detecting when a roll has settled, sound.

## Anti-goals

- Showing the observer the room code, Supabase details, the app name, angles, stats or buttons while in use.
- A die page that stops without saying so. It must keep the screen on, reconnect on its own and show its status.

## Constraints

- One static file (README rule), so the die page is `index.html` opened from a different link.
- Payloads come from anyone in the room, so all text is set with `textContent`. Secret keys never go into links: everything passes through `validateCredentials`, as today.

## Approaches

1. **A die-page look on the existing Viewer (chosen).** The link adds `view=die`. The page runs the normal Viewer, forces the die, and hides everything except the stage.
   - No connection or die code is duplicated, and the existing Viewer tests keep covering it.
   - Cost: the CSS has to hide the Viewer's extras on this page. It does that by listing what stays visible, so anything added to the Viewer later stays hidden here without extra work.
2. **A separate fourth screen with its own die markup.** Its markup is cleaner, but it duplicates the die markup, and every render path has to write to two places.
3. **A separate `die.html`.** It breaks the one-file rule and duplicates the connection code. Ruled out.

The user left the how to us, so approach 1 is our call.

## Design

**Link.** `?room=CODE&view=die#u=…&k=…`
- Credentials work the same as in the Viewer link: they travel in the hash and are scrubbed from the address bar on load.
- `view=die` stays in the address bar, so a reload reopens the die page.
- Without a valid room, `view=die` is ignored and the normal app opens.

**Die page (what the observer sees)**
- It runs Viewer mode underneath: same join, presence (the Sender counts it as a Viewer), watchdog, wake lock and reconnects.
- Full-screen dark stage. It holds only three things:
  - the die, sized to the screen, with pips that scale with it
  - the top-face number below the die, very big, with no label
  - the status in the top-left corner
- The die is forced on. The normal Viewer's saved Phone / Die choice on that phone is left alone.
- No calibration is applied.
- Status wording:

  | Word | Dot | When |
  | --- | --- | --- |
  | Live | green | packets arriving |
  | Connecting… | yellow | joining or reconnecting |
  | Waiting for the die | grey | connected, no packets yet |
  | Weak signal | yellow | stalled: 0.5–2 s without packets |
  | Signal lost | red | offline (over 2 s without packets) or disconnected |

  The number dims while the status isn't Live, as it does today.
- No toasts and no header. The tab title is "Die", without the room code.
- If credentials are missing, only the Supabase settings panel and its error message show. After **Save & Apply**, the page joins the room and the panel hides again.
- Works in portrait and landscape.

**Sender**
- A `Viewer | Die` switch above the QR code. It changes the QR code, its caption, and what Share / Copy Link shares.
- The choice is remembered (`gyrolink_sender_link`). It defaults to Viewer.
- "Include credentials" applies to both links.
- When sharing the die link, the share title is just "Die", with no app name or room code.

**Tests** (`tests/harness.test.js`)
- The switch changes the QR code and link (room, `view=die`, credentials) and is remembered.
- The die link opens Viewer mode with the die forced, without saving the choice.
- The status reads Waiting for the die, then Live, Weak signal and Signal lost.
- The Sender counts the die page as a Viewer.
- Missing credentials show the settings panel.
- A reload keeps `view=die`.

**README:** update the Protocol table (pairing URL), the Sender and Viewer sections (die page), the code map, the test list, the storage keys and the manual checklist.

## Left to the builder

Exact sizes, spacing and colors, within the existing palette.
