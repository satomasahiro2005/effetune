# remote-v1: LAN control API (proof of concept)

This fork adds a small WebSocket API so another device on the same network can drive the
effect pipeline of the desktop app. The audio stays on the computer; the client only edits
the pipeline, the presets and the IR library. The API speaks EffeTune's own pipeline format
and knows nothing about any particular client.

This is a proof of concept. It is off by default and has no protection beyond a token.
Use it only on a network you trust.

## Enabling

Open **Settings > Remote Control...**. The window has an on/off switch; while it is on it
shows a QR code and the pairing link as text. The switch and the token are saved in
`config.json` in the user-data folder, so the server comes back after a restart. **New token**
replaces the token; clients that are connected are closed with 4401 and must pair again.
Turning the switch off closes all clients (1001) and releases the port.

In the main window, the Effect Pipeline header has a Remote Control icon (broadcast symbol,
tooltip "Remote Control", Electron app only). It is dimmed while the server is off, drawn in the
accent color while it listens, and shows a small badge with the number of connected devices.
Clicking it opens the same Remote Control window.

The port is **47300 unless it is busy**. When another process (for example a previous instance
that is still shutting down) holds it, the app retries the same port 4 times, 750 ms apart, then
moves up to the next free port (47301 ... 47309). The pairing link, QR code, connect string and
window title always carry the port that was actually bound, and the Remote Control window shows
it (with a note such as "47300 was busy"). If every port from 47300 to 47309 is taken, the window
reports the error.

Overrides, mainly for tests:

```
set EFFETUNE_REMOTE=1                 (or pass --remote)   start the server regardless of the switch
set EFFETUNE_REMOTE_TOKEN=<token>     use this token instead of the saved one
set EFFETUNE_REMOTE_PORT=<port>       first port to try instead of 47300 (fallback: <port>+1 ... <port>+9)
npm start
```

While the server is listening, `[remote] CONNECT STRING: <LAN IPv4>:<port>/<token>` and
`[remote] PAIRING URL: ...` are printed to the console, and the connect string is appended to
the window title.

## Pairing

The QR code encodes the connection URL itself, so any client can use it:

```
ws://<LAN IPv4>:<port>/?t=<token>
```

The address is the computer's private IPv4 address (192.168.x, 10.x, 172.16-31.x). Virtual
adapters (VirtualBox, Hyper-V, VMware, WSL, Docker, Tailscale's 100.64/10, VPNs) are left out
where they can be recognised by name or MAC prefix. If several addresses remain, the window
offers a choice between them.

## Connection

- `ws://<host>:<port>/?t=<token>`
- A missing or wrong token: the socket is closed with code **4401**.
- At most 16 authenticated clients; extra ones are closed with **1013**.
- Frames are JSON text, at most 4 MB.
- Requests that arrive while the window is still starting (or reloading) are held for up to
  20 s, then answered with `renderer-unavailable`.

## Pipeline format

Items use the "short" serialization, the same one used by `?p=` share links and undo history
(`getSerializablePluginStateShort` in `js/utils/serialization-utils.js`):

```json
[{"nm":"Volume","en":true,"vl":-3},
 {"nm":"5Band PEQ","en":true,"f0":100,"ch":"L","ib":1,"ob":2}]
```

`nm` is the effect's display name, and the other keys are the parameter keys from each
effect's `params.json`. IR Reverb refers to its impulse response by library id: `"ir":"<24 hex>"`.

## Requests (client → app)

Any request may carry `"seq": <integer>`. When it does, the app answers with
`{"op":"ack","seq":n,"ok":true}` or `{"op":"ack","seq":n,"ok":false,"error":"..."}`. For
requests that also return data, the ack comes first and the data message carries the same
`seq` (except `getIR`, see below).

| Request | Effect |
|---|---|
| `{"op":"hello","v":1}` | Replies with `state`, which also carries `"features":["origin","savePreset","irSync","telemetry","overlays"]`. Any other `v` is rejected. Extra fields (such as `"app"`) are ignored. |
| `{"op":"get"}` | Replies with `state`. |
| `{"op":"chain","pipeline":[...]}` | Replaces the whole pipeline (at most 256 items). If any `nm` is unknown, the request fails and nothing changes. Master bypass keeps its state. |
| `{"op":"params","index":i,"params":{...}}` | Applies the keys to stage `i` (0-based) of the current pipeline. Keys that are not given stay as they are. |
| `{"op":"bypass","on":true}` | Sets master bypass. |
| `{"op":"listPresets"}` | Replies `{"op":"presets","names":[...]}`: the presets whose effects all exist in this build. |
| `{"op":"getPreset","name":"..."}` | Replies `{"op":"preset","name":"...","pipeline":[...]}` in the short format. |
| `{"op":"savePreset","name":"...","pipeline":[...]}` | Saves the pipeline as a preset under `name`, overwriting one with the same name. Same file and format as the preset dialog's Save. Fails if any `nm` is unknown or the name is empty. The live pipeline does not change. |
| `{"op":"listIRs"}` | Replies `{"op":"irs","items":[{"id","name","bytes","ext","channels","sampleRate","frames"}]}`. |
| `{"op":"getIR","id":"..."}` | Sends the IR file (see IR transfer). Unknown id: `ok:false`. |
| `{"op":"putIR", ...}` | Uploads an IR file into the library (see IR transfer). |
| `{"op":"telemetry","on":true,"fps":15,"overlays":true}` | Subscribes this connection to the analyzer mirror (see Telemetry); `"on":false` ends it. `fps` is optional (default 15, clamped to 1..30); a non-number is rejected with `invalid fps`. `overlays` is optional (default false): `true` adds the PEQ spectrum overlay frames (see PEQ spectrum overlay); a value that is not a boolean is rejected with `overlays must be boolean`, and it has no effect without `"on":true`. A repeat call replaces the previous setting. The subscription ends when the socket closes. |

## Pushes (app → client)

```json
{"op":"state","rev":12,"app":"2.11.0","masterBypass":false,"pipeline":[...],"origin":"local"}
```

Sent in reply to `hello` and `get`, and pushed to every authenticated client whenever the
pipeline changes for any reason, at most 10 times per second. `rev` goes up only when the
content changes.

`origin` says where the change came from:

- `"local"`: made on the computer (the app's UI, undo, loading a preset there, ...).
- `"remote"`: caused by a client's `chain`, `params` or `bypass`. The copy sent to the client
  that issued the command also carries that command's `"seq"`; the other clients get no `seq`
  and should treat the change like an external one.

Changes that arrive within 300 ms after a command finished are counted as that command's.
When one push covers changes of several origins, it is `"local"` if any of them was local,
and it carries no `seq` if they came from different clients. A client can therefore follow
the computer by applying every push that does not carry one of its own `seq` values.

Replies to `hello` and `get` carry the request's `seq` and `"origin":"remote"`. They are
snapshots, not echoes of an edit: always apply them. A command that leaves the pipeline as it
was produces no push, so do not wait for one to confirm a command; the ack does that.

### Telemetry

While a connection is subscribed with `{"op":"telemetry","on":true}`, the app pushes the
readings of its Analyzer stages (Level Meter, Oscilloscope, Spectrum Analyzer, Spectrogram,
Stereo Meter, Chroma Spiral, Note Spectrogram, Pitch Meter) in the active pipeline:

```json
{"op":"telemetry","frames":[
  {"index":3,"nm":"Spectrum Analyzer","type":4,"data":"<base64>"},
  {"index":5,"nm":"Level Meter","type":1,"data":"<base64>"}]}
```

- At most `fps` pushes per second, never with an empty `frames` array, and without `seq`.
- `index`: the stage's 0-based position in the pipeline when the push was built (the same
  index as `params.index` and `state.pipeline`). `nm`: its display name, as in `state`.
- `type`: the frame type, copied from the header as a hint; the header is authoritative.
- `data`: base64 of one DSP telemetry frame, exactly `16 + payloadBytes` bytes, no padding.
  All fields are little-endian:

  | Offset | Field |
  |---|---|
  | 0 | u16 frameType |
  | 2 | u16 formatVersion |
  | 4 | u32 tapId (the app's internal id; ignore or overwrite it) |
  | 8 | u32 sequence |
  | 12 | u16 payloadBytes |
  | 14 | u16 flags (bit 0: the app dropped frames before this one) |
  | 16 | payload (the layout of `dsp/core/telemetry.cpp` and `js/audio/telemetry-hub.js`) |

  Frame types: Level Meter 1 (v1), Oscilloscope 3 (v2), Spectrum Analyzer 4 (v1, v2 in HQ
  mode), Chroma Spiral 4 (v2), Spectrogram 5 (v1, v2 in HQ mode), Stereo Meter 6 (v2), Note
  Spectrogram 24 (v3), Pitch Meter 26 (v1). Check `formatVersion` before reading a payload.
- Only the latest frame per stage and type is sent; older ones are dropped, not queued.
  Scrolling displays (Spectrogram, Note Spectrogram, Stereo Meter) therefore get one column
  per push; use `sequence` to skip a frame already seen.
- A push holds at most 64 frames and 1 MiB of raw frame bytes. Frames that did not fit go
  first in the next push (still latest only). A connection whose send buffer holds more
  than 512 KiB skips pushes until it drains.
- Nothing is sent while the app is in master bypass, idle or suspended, or for a disabled
  analyzer. While any client is subscribed the app keeps its analyzers running even when
  its window is hidden or minimized.

### PEQ spectrum overlay

With `"overlays":true` the same pushes also carry the spectrum before and after every
5Band PEQ, 15Band PEQ and 5Band FIR PEQ stage of the active pipeline (the app's own
After/Compare overlay, measured separately for the client):

```json
{"index":2,"nm":"5Band PEQ","type":4,"role":"before","data":"<base64>"}
{"index":2,"nm":"5Band PEQ","type":4,"role":"after","data":"<base64>"}
```

- `role` is `"before"` (the stage's input, delayed by the stage's own latency so both
  cover the same stretch of audio) or `"after"` (its output). Analyzer frames carry no
  `role`. Overlay frames go only to connections that asked for them.
- The stages are found again on every push by the app's own plugin id, so `index` and
  `nm` follow edits on either side the same way as for analyzers.
- Only the latest frame per stage and role is sent. Each `data` is a Spectrum Analyzer
  v1 frame of 16420 bytes (little-endian):

  | Offset | Field | Value |
  |---|---|---|
  | 0 | u16 frameType | 4 |
  | 2 | u16 formatVersion | 1 |
  | 4 | u32 tapId | the app's plugin id (overwrite it) |
  | 8 | u32 sequence | per stage and role, +1 per frame |
  | 12 | u16 payloadBytes | 16404 |
  | 14 | u16 flags | 0 |
  | 16 | f32 sampleRate | |
  | 20 | u32 binCount | 2049 |
  | 24 | u16 points | 12 |
  | 26 | u16 flags | 0 |
  | 28 | f32 current[2049] | dB per bin, DC to Nyquist |
  | 8224 | f32 peaks[2049] | a copy of `current` |

- `current` is not smoothed: a 4096-point Hann-windowed FFT of the mono sum (the app's
  overlay FFT, `plugins/spectrum-overlay.js`), `10*log10(re² + im² + 1e-24)` plus 6.02 dB
  at DC and 12.04 dB elsewhere, the scale of the Spectrum Analyzer. The client does its own
  smoothing and peak hold.
- Overlay frames are sent as soon as they are measured, without the app's visual-sync
  delay (analyzer frames wait for it), so on outputs with a long latency the two can be
  slightly apart.
- Switching overlays on moves the audio thread from the fused DSP pipeline to the
  per-effect path, as turning on the app's own overlay does. The app's own overlay mode,
  quality and peak hold are not changed.
- Size: one frame is 21896 base64 characters, so each PEQ adds about 650 KB/s at 15 fps
  (measured: 655 KB/s for one PEQ, 1.98 MB/s of JSON for three). Nothing is sent for a
  disabled PEQ, in master bypass or while idle; the client keeps the last frame.

## IR transfer

IRs are identified the same way as in the app's IR library (`js/ir-library/ir-library-id.js`):
the first 24 hex characters of the SHA-256 of the file's bytes. Files are sent as they are
(WAV, FLAC, AIFF, ...), base64 encoded, in chunks of at most 512 KiB of raw data. Files may
be up to 64 MiB and up to 16 channels.

Download:

```
→ {"op":"getIR","id":"6fc4…","seq":7}
← {"op":"irChunk","id":"6fc4…","name":"Hall.wav","ext":"wav","index":0,"total":3,"bytes":1234567,"data":"<base64>","seq":7}
← ... index 1, 2 ...
← {"op":"ack","seq":7,"ok":true}
```

All chunks come before the ack.

Upload: send the chunks in order on one connection, starting at `index` 0:

```
→ {"op":"putIR","id":"6fc4…","name":"Hall.wav","ext":"wav","index":0,"total":3,"bytes":1234567,"data":"<base64>","seq":8}
← {"op":"ack","seq":8,"ok":true}
→ ... index 1, 2 ...
```

Every chunk that carries `seq` is acked. After the last chunk the app checks that the bytes
hash to `id` and imports the file through the same call as the library's Import button, so the
id and name are registered as usual; the last ack says whether that worked (`id mismatch`,
`unsupported file type`, `import failed`, ...). A chunk out of order, or a size that does not
add up, cancels the upload. At most two uploads can be in progress per connection. `name` is
the file name; `ext` is added when `name` does not already end with it. Uploading a file that
is already in the library succeeds and changes nothing.

Only single-file IRs are listed and transferred. A true-stereo pair (two stereo files named
L/R) has a combined id and is left out.

## Limitations

- Only the active pipeline (A or B) is exposed.
- `chain` goes through the preset loader: it adds an undo entry, shows the "preset loaded"
  message, and clears the current preset name. With master bypass on, the effects may be
  heard for a moment before bypass is restored.
- Effects whose filters are designed in the app (FIR EQ, group-delay EQ, Room EQ) take their
  parameters as given. IR Reverb finds its file by id, so upload the IR before sending a chain
  that uses it; an IR Reverb that is already showing "IR not found" does not pick up a later
  upload by itself.
- Only Analyzer stages and the PEQ spectrum overlays (5Band, 15Band and 5Band FIR PEQ) are
  mirrored; other effects' overlays, per-effect meters (GR bars etc.) and the Pipeline
  Analyzer are not. Overlay frames are full-resolution and sent for every PEQ at the push
  rate, whether or not the client is showing them.
- The IR library window does not refresh while it is open when an IR arrives.
- No discovery (mDNS). Pair with the QR code or enter the address by hand.
