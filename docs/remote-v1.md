# remote-v1: LAN control API (proof of concept)

This fork adds a small WebSocket API so another device on the same network can drive the
effect pipeline of the desktop app. The audio stays on the computer; the client only edits
the pipeline. The API speaks EffeTune's own pipeline format and knows nothing about any
particular client.

This is a proof of concept. It is off by default and has no protection beyond a token.
Use it only on a network you trust.

## Enabling

```
set EFFETUNE_REMOTE=1                 (or pass --remote)
set EFFETUNE_REMOTE_TOKEN=<token>     (optional; otherwise 8 random hex characters)
npm start
```

When the port is listening, the connect string `<LAN IPv4>:47300/<token>` is printed to the
console as `[remote] CONNECT STRING: ...` and appended to the window title.

## Connection

- `ws://<host>:47300/?t=<token>`
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
effect's `params.json`.

## Requests (client → app)

Any request may carry `"seq": <integer>`. When it does, the app answers with
`{"op":"ack","seq":n,"ok":true}` or `{"op":"ack","seq":n,"ok":false,"error":"..."}`. For
requests that also return data, the ack comes first and the data message carries the same
`seq`.

| Request | Effect |
|---|---|
| `{"op":"hello","v":1}` | Replies with `state`. Any other `v` is rejected. Extra fields (such as `"app"`) are ignored. |
| `{"op":"get"}` | Replies with `state`. |
| `{"op":"chain","pipeline":[...]}` | Replaces the whole pipeline (at most 256 items). If any `nm` is unknown, the request fails and nothing changes. Master bypass keeps its state. |
| `{"op":"params","index":i,"params":{...}}` | Applies the keys to stage `i` (0-based) of the current pipeline. Keys that are not given stay as they are. |
| `{"op":"bypass","on":true}` | Sets master bypass. |
| `{"op":"listPresets"}` | Replies `{"op":"presets","names":[...]}`: the presets whose effects all exist in this build. |
| `{"op":"getPreset","name":"..."}` | Replies `{"op":"preset","name":"...","pipeline":[...]}` in the short format. |

## Pushes (app → client)

```json
{"op":"state","rev":12,"app":"2.11.0","masterBypass":false,"pipeline":[...]}
```

Sent in reply to `hello` and `get`, and pushed to every authenticated client whenever the
pipeline changes for any reason, at most 10 times per second. `rev` goes up only when the
content changes. The sender of a change receives the push too.

## Limitations

- Only the active pipeline (A or B) is exposed.
- `chain` goes through the preset loader: it adds an undo entry, shows the "preset loaded"
  message, and clears the current preset name. With master bypass on, the effects may be
  heard for a moment before bypass is restored.
- Effects whose filters are designed in the app (FIR EQ, group-delay EQ, Room EQ, IR reverb)
  take their parameters as given; files they refer to (for example IR files) must already
  exist on the computer.
- No discovery (mDNS). Enter the address by hand.
