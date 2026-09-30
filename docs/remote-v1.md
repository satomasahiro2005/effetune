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
| `{"op":"hello","v":1}` | Replies with `state`, which also carries `"features":["origin","savePreset","irSync"]`. Any other `v` is rejected. Extra fields (such as `"app"`) are ignored. |
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
- Meters and analyzers (Level Meter, spectrum displays, the Pipeline Analyzer) send nothing
  over this API.
- The IR library window does not refresh while it is open when an IR arrives.
- No discovery (mDNS). Pair with the QR code or enter the address by hand.
