# Blockout API reference

Three ways in, all equivalent: the `canvas` CLI (`canvas …` with the plugin, `node bin/canvas.mjs …` in a checkout), JSON ops
(`canvas op '<json>'`, `canvas ops file.json`), and HTTP on `http://127.0.0.1:5317`.

## Scene document

```jsonc
{
  "meta": { "name": "untitled", "width": 1280, "height": 720 },
  "env": { "background": "#e9e7e2", "ground": true, "grid": true, "fog": 0, "sun": [6, 10, 4] },
  "objects": [
    { "id": "tower", "name": "tower", "type": "box", "params": { "w": 2, "h": 6, "d": 2 },
      "position": [-3, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "color": "#d8d4cc", "note": "optional",
      // optional: moves during the shot; position/rotation/scale equal the first key
      "anim": [ { "t": 1, "position": [-3, 0, -2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "ease": "easeInOut" },
                { "t": 3, "position": [-3, 0, 2], "rotation": [0, 0, 0], "scale": [1, 1, 1], "ease": "easeInOut" } ] }
  ],
  // the ACTIVE shot's camera timeline (start: optional, where the shot picks up the action, s)
  "timeline": {
    "duration": 5, "fps": 24, "interp": "smooth", "speed": "linear",
    "keys": [ { "id": "k1", "t": 0, "position": [7, 3.5, 9], "target": [0, 1, 0], "fov": 40, "roll": 0, "ease": "easeInOut" } ]
  },
  // shots in sequence order; the active one (shot) has no timeline here because it is doc.timeline
  "shots": [ { "id": "shot-1", "name": "Wide" }, { "id": "close-up", "name": "Close up", "timeline": { "duration": 3, "...": "..." } } ],
  "shot": "shot-1",
  "controls": {}
}
```

Objects, their moves, env and meta are shared by every shot. Object `anim` key times are action time:
a shot shows the action from its `timeline.start` (default 0). Scenes saved before shots load as one shot.

Rotation is degrees XYZ. `fov` is vertical, in degrees (`--lens` converts from full-frame mm).
`ease` on a key is the curve used from that key to the next. `path` on a key (optional) is how the camera
travels to the next key: absent = the smooth spline; `{ "type": "straight" }`; `{ "type": "orbit", "center":
[x,y,z], "angle": 90, "around": "hero", "move": "orbit", "params": { "angle": 90 } }` (an arc round the vertical axis through center, default the key's
target; angle in degrees, + to the camera's right, picks the direction and how far; around is the object it
was made for); `{ "type": "turn", "angle": -30 }` (pan/tilt on the spot, + pans right); `{ "type": "dollyZoom" }`
(straight, with the fov set from the distance so the frame keeps its width at the target). Ignored on a hold key.

## Ops

Send one op or an array (applied atomically: all or nothing, one undo step).

| op | fields | result |
|---|---|---|
| `add` | `type`, `name?`, `id?`, `position?`, `rotation?`, `scale?` (number or [x,y,z]), `color?`, `note?`, `size?` [a,b,c], or params by name (`w`, `h`, `r`, …), or `params: {}` | `{ id }` |
| `update` | `id` (or name), any `add` field, `move: [dx,dy,dz]`, `type` (resets params) | `{ id }` |
| `remove` | `id` or `ids: []` | `{ removed }` |
| `duplicate` | `id`, `offset?` (default [1,0,0]), `name?` | `{ id }` |
| `clear` | `keys?: true` also removes camera keys | `{ removed }` |
| `env` | `background`, `ground`, `grid`, `fog` (0–0.1 exp density), `sun` [x,y,z] direction | `{ env }` |
| `meta` | `name`, `width`, `height` (export size, even numbers) | `{ meta }` |
| `anim.move` | `id`, `to?` [x,y,z] or `by?`, `rotation?` or `turn?`, `scale?`, `at?` (start s, default 0), `over?` (s, default 1), `ease?`. Starts from where the object is at `at` | `{ id, from, to, keys }` |
| `anim.key` | `id`, `t`, `position?`, `rotation?`, `scale?`, `ease?`. Missing fields keep where it is at `t`; a key already at `t` is replaced | `{ id, t, keys }` |
| `anim.remove` | `id`, `t?` (omit to remove all of its animation) | `{ id, keys }` |
| `key.add` | `t`, `position`, `target`, `fov?`, `roll?`, `ease?`. A key already at `t` is updated instead | `{ id, replaced? }` |
| `key.update` | `id` or `index` (by time order), any key field. `path`: a type name, an object, or `"smooth"` to clear. `shudder`: `{ jerks (1–60), amount (% of the move each jerk pulls back, 0–50), shape (jerk, wobble, stutter), over (even, fade, build), from?, to? (0–1: only that section of the segment) }` makes the camera judder back and forth along the segment after the key, on top of its ease; partial settings keep the rest, `"off"` removes it | `{ id }` |
| `key.easeAll` | `ease` or `from` (a key id), `cuts?` (also overwrite holds), `allShots?` (every shot, not just the active one) | `{ updated, shots, ease }` |
| `cam.move` | `move` (`pan` `tilt` `orbit` `push` `pull-out` `truck` `pedestal` `crane` `zoom` `dollyZoom` `roll`; aliases `push-in` `dolly` `dolly-zoom` `vertigo` `dutch` `arc` `boom`), `t?` (default 0), `over?` (s, default 3), `ease?`, `from?` ({ position, target, fov?, roll? }; default the camera at `t`), and the move's own: `angle` (pan + right, tilt + up, orbit + right, roll), `by` (m: push/dollyZoom + in, truck + right, crane/pedestal + up), `around` (orbit: object id or [x,y,z]; default the aim), `rise` (orbit, m), `lens` or `fov` (zoom). Keys a path + ease at `t` and the end framing at `t + over`, replacing keys in between. The path keeps `move` and `params`. `edit: <keyId|index>` redoes the move starting at that key from its framing, replacing its end key; settings left out keep their values | `{ move, keys: [start, end], from, to, path }` |
| `key.remove` | `id` or `index` | `{ removed }` |
| `key.clear` | | `{ removed }` |
| `timeline` | `duration`, `retime?` (scale key times; object keys too when there is only one shot, from the shot's start, so `start` + `duration` + `retime` together stretch the shot from its left end), `start` (s into the shared action where this shot begins; 0 clears it), `fps` (1–120, decimals allowed e.g. 23.976; default 24), `interp` (`smooth`/`linear`), `speed` (ease, whole shot), `ease` (set every key) | `{ timeline }` |
| `audio` | The scene's one track (`doc.audio`, shared by every shot). `file` (name in the scene's `audio/`, from `POST /api/audio`), `name?`, `offset` (action time where the file starts; negative skips into it), `in` / `out` (trim: seconds into the file, `null` clears), `volume` (0–4), `muted`, `beats` (show the beat grid on the audio lane), `length` (set by the tab), `fit` (the active shot ends where the audio ends), `clear` | `{ audio, duration }` |
| `shot.add` | `name?`, `id?`, `from?` (shot to copy; default the active one), `blank?` (default two-key move instead of a copy), `switch?` (default true), `start?` (action time it picks up at; default where the active shot ends), `duration?` (its length; default the copied shot's), `frame?` (one key instead of a copy: the copied shot's framing at the moment it picks up, what the canvas's "+ New shot" row does). Inserted after the active shot | `{ id, name, start, shots, active }` |
| `shot.split` | `t` (shot time, snapped to a frame, inside the shot), `name?`, `id?`, `switch?` (default true). The active shot ends at `t`; a new shot after it gets the same framing at its first key, the later keys, the rest of the length, `start` = this shot's start + t. Needs a linear shot speed | `{ id, name, at, shots, active }` |
| `shot.use` | `id` (id, name or 1-based position) — make it the active shot | `{ id, name }` |
| `shot.update` | `id?` (default active), `name` | `{ id, name }` |
| `shot.move` | `id?`, `to` (1-based position in the sequence) | `{ id, order }` |
| `shot.remove` | `id?` (not the last shot; removing the active one activates its neighbour) | `{ removed, active }` |
| `controls.set` | `key`, `value` (any JSON; omit to delete) — state for custom controls | `{ key }` |
| `load` | `doc` — replace the whole scene | |
| `batch` | `ops: []` | `{ results }` |

Any op except `shot.*`, `load` and `batch` also takes `shot` (id, name or position): it is applied to that
shot's timeline without switching (CLI: `--shot <id>`). `anim.*` times are shot time (action time minus `start`).

### Primitives (pivot at bottom centre)

| type | params (defaults) | `size` order |
|---|---|---|
| box | w 1, h 1, d 1 | w,h,d |
| sphere | r 0.5 | r |
| cylinder | r 0.5, h 1, rTop (= r) | r,h |
| cone | r 0.5, h 1 | r,h |
| pyramid | w 1, h 1, d 1 | w,h,d |
| capsule | r 0.3, h 1.8 (total height) | r,h |
| torus | r 0.5, tube 0.15 (lies flat) | r,tube |
| plane | w 4, d 4 (on the ground) | w,d |
| ramp | w 1, h 1, d 2 (rises toward −z) | w,h,d |
| stairs | w 1, h 1, d 1.5, steps 6 (rise toward −z) | w,h,d |
| arch | w 2, h 2.5, d 0.5, t 0.4 (doorway, wall thickness t) | w,h,d |
| person | body male\|female\|child (default male), h = standing height (default 1.8 / 1.65 / 1.3 by body), detail high\|low (unset: env.people), pose (default stand; `canvas poses` lists them: walk run sit sit-floor crouch kneel lie lean point wave arms-crossed hands-on-hips reach-up phone), joints `{"kneeL": 90, "shoulderR": [80, 0, 10]}` (degrees, on top of the pose; CLI `--joints "kneeL=90 shoulderR=80,0,10"`). A posed person is always the mannequin; its lowest point is on its pivot, hips over it; faces +z | h |
| model | file (a `.glb` in the scene's `models/`, from `canvas import`), offset 0 (action time where its first clip starts), speed 1, length and h (clip seconds and height, measured at upload; descriptive). Size it with `scale` | — |

### Eases

`linear ease easeIn easeOut easeInOut slowIn slowOut snap anticipate overshoot hold`, or `[x1, y1, x2, y2]`
(CSS cubic-bezier; x in 0–1, y may overshoot). For finer shapes add points: each extra
`px, py, x3, y3, x4, y4` adds a point (px, py) the curve passes through, after the incoming handle
before it (x2, y2) and with its outgoing handle (x3, y3), so the array is 4 + 6 × points long; point x
increases from 0 to 1. The curve editor writes these when you click the curve. `hold` = no motion until the next key, then a hard cut
to it. On camera keys a hold also splits the smooth path: the moves before and after the cut don't
bend toward each other. For a cut between two moving shots, put shot B's first key one frame after
shot A's last (hold) key.

## Example: a batch file

```json
[
  { "op": "clear", "keys": true },
  { "op": "add", "type": "plane", "name": "street", "w": 8, "d": 60, "color": "#bdbab3" },
  { "op": "add", "type": "box", "name": "bldg-l1", "size": [6, 14, 10], "position": [-8, 0, -5] },
  { "op": "add", "type": "box", "name": "bldg-r1", "size": [6, 20, 12], "position": [8, 0, -8] },
  { "op": "add", "type": "person", "name": "hero", "position": [0, 0, 4] },
  { "op": "key.add", "t": 0, "position": [0, 0.5, 14], "target": [0, 1.2, 4], "fov": 30, "ease": "easeInOut" },
  { "op": "key.add", "t": 5, "position": [3, 6, 2], "target": [0, 1.5, 4], "fov": 45 },
  { "op": "timeline", "duration": 5, "fps": 24 }
]
```

## CLI → browser commands (need an open tab)

`seek <s>`, `play`, `pause`, `view shot|free`, `select <id|none>`, `frame [id]`, `key --from-view`,
`snapshot [--t s] [--view shot|free] [--out file]`, `storyboard [--frames n] [--cols n]`,
`export [--fps] [--width --height] [--grid on|off] [--name]` (the whole timeline, every shot in order in one mp4,
with the audio track mixed in; `--shot <id>` for one shot); `snapshot`, `storyboard` and `export` take `--shot <id>`,
`audio --beats [--json]` and `audio --fit` (the tab decodes the file).

`canvas import <file.glb> [--name n] [--pos x,y,z] [--rot x,y,z] [--scale s] [--offset s] [--speed v] [--fit]` uploads a GLB
(`POST /api/model`) and adds it as a `model` object, drawn with its own materials. Its first animation clip plays on the
action time: from `offset`, at `speed`, holding its first frame before and its last frame after. `--fit` makes the active
shot as long as the clip. Move, rotate and scale it like any object (`canvas set`, `canvas move`); `around: <id>` orbits it.
In the browser, a `.glb` dropped on the canvas is uploaded and added where the camera is focused (the first upward
surface below the aim point, else the ground). One dropped in the chat is uploaded to `models/` but not added: the prompt
carries `models: [{ file, name, path, url }]` (`POST /api/prompt` takes `models: [{ file, name }]`, files already in `models/`).

`canvas audio <file> [--offset s] [--in s] [--out s] [--volume v] [--mute on|off] [--show-beats on|off] [--fit]` uploads and sets the audio track;
`canvas audio` alone prints it; `canvas audio --clear` removes it.

## Brief and chat attachments

`canvas brief [--shot id | --all | --timeline] [--beats] [--json]` describes a shot's camera work from the scene doc (no tab
needed, except `--beats`): one line per segment between keys with its times in the exported video (the speed
curve applied), what the camera does (push in, truck, orbit, pan, tilt, zoom, roll, hold, cut), pace and ease,
and the framing it lands on (shot size and side when the aim is a person, camera height and angle, distance,
lens). Also the objects that move during the shot and which seconds of the audio file the shot plays.
`--json` gives `{ shot, start, segments: [{ from, to, kind: move|hold|cut, text, pace, ease, keys, move, end }], objects, audio, beats? }`
(the code is `core/brief.js`). `--timeline` describes the whole timeline as the one video `canvas export`
renders: a `timeline:` line (shots, length, size, cut times), then each shot with a `CUT at <t>s` line and
every time in seconds of that video; `--json` gives `{ timeline: { shots, duration, fps, width, height, ratio, cuts }, shots: [brief + at] }`.

`canvas say --working "text"` shows a "Working" card with a running clock (one card, its line updated by each later `--working`). It counts as a running job: the Stop hook keeps the session going until a final `canvas say` or a `canvas ask` ends it.

`canvas say "text" --attach file[,file…]` puts videos (mp4, webm, mov) or images on a reply; a video plays in
the chat. The text is optional with a file. Files are copied to `.canvas/uploads/`.

## Question cards and keys

`canvas ask <card.json | - | '{…}'> [--reply id] [--title "…"]` asks the user in the chat with a card instead of
a paragraph. The questions show one at a time; when the last is answered the card folds into a summary and the
answers arrive as one prompt (`canvas wait` or the Stop hook), marked `ask`. A card:

```json
{ "title": "Render with Comfy", "questions": [
  { "id": "look", "q": "What should set the look?", "note": "one short line",
    "options": [{ "value": "images", "label": "Reference images", "note": "optional second line" }, "Describe it"],
    "other": "Something else" },
  { "id": "refs", "q": "Add your reference images", "type": "images", "max": 4, "when": { "look": "images" } },
  { "id": "notes", "q": "Anything to add?", "type": "text", "optional": true },
  { "id": "key", "q": "Comfy API key", "type": "secret", "name": "COMFY_API_KEY" },
  { "id": "prompt", "q": "Check the prompt", "type": "review", "file": "renders/x/prompt.txt" },
  { "id": "go", "q": "Ready to render?", "rows": [["Shot", "shot-4 · 1.96s"], ["Cost", "about 170 credits"]],
    "options": ["Render", "Not yet"] } ] }
```

- `type`: `choice` (has `options`; `multi` for several, `other` adds a free-text answer), `text`, `images`
  (`max`, default 4), `review` or `secret`. Left out, it is `choice` with options, `secret` with a `name`,
  `review` with a `body` or `file`, else `text`.
- `review` shows a longer text in full (`body`, or `file`: a path the CLI reads; up to 20,000 characters) for
  the user to check before you use it. They can approve it, edit it in place, or write what to change. The
  answer's `value` is `approved`, `edited` (with their `text`: use it exactly) or `feedback` (with `feedback`,
  and `text` if they also edited: not approved, so revise and show it again). `when` can test it:
  `"when": { "prompt": ["approved", "edited"] }`.
- `rows` puts a short label / value summary above the answer: use it for a confirm step instead of prose.
- `optional` adds Skip. `when` asks a question only if an earlier answer matches (`{ id: value | [values] }`).
- At most 12 questions and 8 options. Keep `q` under about 8 words; put detail in `note`.
- One quick question without a file: `canvas ask "Run it?" --options "Run|Not yet"` (`--multi`, `--other`),
  `canvas ask "Add a frame" --images`, `canvas ask "Check the prompt" --review prompt.txt`,
  `canvas ask "Comfy API key" --secret COMFY_API_KEY` (`--optional`, `--note`).
- The prompt that comes back reads `Answers to "<title>": - <id> (<question>): <answer>`, with image paths for
  image questions; `--json` on `canvas wait` adds `answers: { id: { value | values | text | feedback | images | saved | skipped } }`.
  If the user closes the card the prompt says so (`cancelled`); ask in plain words instead.
- Asking marks the prompt it answers done (the turn is the user's). Ask, then end your turn or `canvas wait`.

`canvas progress "title" [--steps "A|B|C"] [--eta seconds] [--note "…"]` puts a progress card in the chat for
one long job (a render, a big export) and prints its id. Update the same card with
`canvas progress --id <id> [--step n] [--pct 0-100] [--note "…"] [--eta s]`, and end it with `--done ["note"]`
or `--fail "why"`. The card shows the stage, a bar (the percentage if given, else the stage, else moving) and
the time since it started, which it counts by itself between updates; `--eta` adds "about 3 min left". It
does not close the prompt you are working on. Always end a card you started.

A `secret` question is a key block: a password field whose value goes from the tab to the server and into
`~/.blockout/secrets.json` (owner-only; `CANVAS_SECRETS` moves it). It is never in the answers, the chat log
or any command output. You are told only that `NAME` is saved. Use it with
`canvas secret run NAME[,NAME2] -- <command …>`, which runs the command with the keys as environment
variables and masks their values in its output. `canvas secret list` shows names, `canvas secret rm NAME`
removes one. Never read the secrets file, echo a key or ask the user to type one into the chat.

## Shots

`canvas shots`, `canvas shot <id|name|n>` (switch), `canvas shot-add [--name] [--from id] [--blank] [--stay] [--start s] [--length s] [--frame]`,
`canvas shot-cut <t> [--name n] [--stay]` (split the active shot at t), `canvas shot-set [id] [--name n] [--to position] [--start s]`, `canvas shot-rm <id>`. `canvas ls` lists them.

## Save / load

`canvas save [name] [--overwrite]`, `canvas load <name>`, `canvas saves`, `canvas save-rm <name>` (moves it to
`scenes/saved/.deleted/`; the user can also delete from the Scenes menu). Files: `scenes/saved/<name>.json`
(plus `<name>.png` thumbnail when saved from the canvas). Names are slugged (`"Street v1"` → `street-v1`).

## HTTP

| method + path | body / query | returns |
|---|---|---|
| `GET /api/doc` | | `{ rev, doc }` |
| `GET /api/summary` | | readable one-line-per-object summary |
| `GET /api/status` | | `{ agent, listen, waiting, queued, rev, tabs, scene, exports }` |
| `POST /api/op` | `{ ops, label?, amend? }` (amend: not an undo step) | `{ ok, rev, results }` or `{ ok: false, error }` |
| `POST /api/undo`, `/api/redo` | | |
| `GET /api/saves` | | `{ saves: [{ name, savedAt, objects, keys, thumb }] }` |
| `POST /api/save` | `{ name?, overwrite? }` | `{ name, path }`; 409 if it exists |
| `POST /api/load` | `{ name }` | `{ name, objects, keys }` (undoable) |
| `POST /api/save/delete` | `{ name }` | `{ name, moved, current }`: the save and its thumbnail move to `saved/.deleted/` |
| `POST /api/model?name=dancer.glb` | raw GLB bytes | `{ file, name, path, url, bytes, clips: [{ name, length }], height, meshes, skins }`: stored in the scene folder's `models/`; then add it with `{ op: 'add', type: 'model', file }` |
| `POST /api/audio?name=song.mp3` | raw audio bytes | `{ file, name, path, url }`: stored in the scene folder's `audio/`; then set it with the `audio` op |
| `POST /api/rpc` | `{ method, params, timeout? }` (methods: camera, state, seek, play, pause, view, select, frame, snapshot, storyboard, export, audio) | `{ ok, result }` |
| `GET /api/prompt/next?wait=600` | long poll | `{ prompt }` or `{ prompt: null }` on timeout |
| `POST /api/chat/file?name=render.mp4` | raw bytes of a video or image | `{ file, name, type, url, path }`: for `files` on `/api/say` |
| `POST /api/say` | `{ text, reply?, done?, files?: [{ file, name? }] }` | the reply, with any attached files |
| `POST /api/ask` | `{ title?, questions, reply? }` | a question card in the chat: `{ id, questions }` |
| `POST /api/ask/answer` | `{ id, answers, cancelled?, context? }` (sent by the tab) | the answers as a prompt: `{ prompt }`; 409 if already answered |
| `POST /api/progress` | `{ title }` to start, then `{ id, step?, pct?, note?, eta?, steps?, state?: running\|done\|failed }` | `{ id, progress }`: one card in the chat, updated in place |
| `POST /api/secret` | `{ name, value }` (sent by the tab's key block) | `{ name }`; the value is never returned by any route |
| `GET /api/secrets` | | `{ secrets: [{ name, savedAt }] }` |
| `POST /api/chat/new` | | archives the open chat to `.canvas/chats/<id>.json`; `{ kept, archived }` |
| `GET /api/chats` | | past chats, newest first: `{ chats: [{ id, title, startedAt, endedAt, count }] }` |
| `GET /api/chats/get?id=<id>` | | `{ chat: { id, title, startedAt, endedAt, prompts, messages } }` |
| `POST /api/listen` | `{ on, session?, cwd? }` | the agent session that owns listen mode |
| `GET /api/events` | Server-Sent Events: doc, status, prompt, say, rpc, reload | |

Prompt objects: `{ id, text, status: pending|taken|done, context: { selection: [..], time, duration, shot?, view, key, camera: { position, target, fov } } }`
(`shot` is set when the scene has more than one).

RPC `snapshot`, `storyboard` and `export` take `shot`; `export` renders every shot in order unless given `shot` (or `sequence: false` for the active shot), and then returns `shots: [{ id, name, frames }]`.
