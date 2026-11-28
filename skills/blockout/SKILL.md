---
name: blockout
description: Operate Blockout, the three.js blockout tool for 3D scenes and camera moves: build and edit the scene, drive the camera timeline, answer prompts typed in the Blockout chat, and export blockout videos for generative video models. Use only for Blockout work: after /blockout:start, when the user names Blockout, when a prompt arrives from the Blockout hooks, or when the user asks to block out a 3D scene or camera move for a video. Not for other canvases (design canvases, HTML canvas, Figma).
allowed-tools: Bash(canvas:*), Bash(node bin/canvas.mjs:*)
---

# Blockout

Blockout is a minimal three.js blockout tool that **you** operate. The user looks at the canvas
in their browser; you change it with the `canvas` CLI. The scene is a JSON document owned by a small
local server, so every change you make shows up live in the user's tab, is undoable (`⌘Z`), and is
saved to `scenes/scene.json` (in `~/Blockout/` when installed as a plugin, in the repo for a checkout).

The end product is a **blockout video**: a camera move through primitive shapes, exported as an MP4
that the user passes to a generative video model as a structure/motion reference.

`canvas` below is the Blockout CLI. With the Claude Code plugin installed it is a command on your
PATH and works from any folder. In a repo checkout without the plugin, run `node bin/canvas.mjs` from the
repo root instead (and `npm install` once). `command -v canvas` tells you which you have.

## 1. Start

```bash
canvas up        # starts the server in the background and opens http://127.0.0.1:5317
canvas listen on # Claude Code: prompts typed in the canvas now come to this session
canvas ls        # ALWAYS read the scene before changing it
```

The user starts a session with `/blockout:start` (plugin), which runs all three and asks what to
block out. When they ask for Blockout by name without it, do the same: run all three, then ask in one
line what they want to block out, and mention they can type it in the canvas or here. Don't send them to a
README or ask them to run commands themselves.

`up` is idempotent. `status` tells you whether a browser tab is open: rendering commands
(`snapshot`, `storyboard`, `export`, `seek`, `view`, `select`, `key --from-view`) need one.
If none is open, run `canvas open` and tell the user.

## 2. The working loop

1. `canvas ls` to see objects (id, type, size, position) and camera keys.
2. **Plan the whole change, then apply it in as few calls as possible.** Anything beyond one or two
   edits goes in one JSON array of ops applied with `canvas ops file.json` (atomic, one undo step);
   use single `add / set / key` commands only for quick one-offs. See [references/api.md](references/api.md).
3. **Look at your work.** `canvas snapshot --t <s>`, `canvas snapshot --from x,y,z --target x,y,z`
   (your own camera) or `canvas storyboard` prints a PNG path: open it with your image-reading tool and
   check composition, scale and overlaps. Render the angles you need in parallel. Do this before you
   say you are done with anything visual.
4. Tell the user what changed in one or two lines (and `canvas say` it if the request came from the canvas).

## 2b. Work fast without cutting corners

Most of the time goes into round trips, so do as much per step as you can:

- **Batch.** Plan the whole change, then apply it as one `canvas ops` file (any size; atomic; one undo).
  Avoid long runs of single `add`/`set` calls.
- **Run independent commands together.** Reads and checks that don't depend on each other (`ls`,
  several snapshots, reading reference images) go in the same turn as parallel tool calls.
- **Check from your own camera** with `canvas snapshot --from x,y,z --target x,y,z --lens 28`: it never moves
  the user's view, so you can check while they look around.
- **Fan out big, separable builds** to helper agents (several areas of ~10+ objects each): you plan the
  layout and brief them, they build in parallel inside their own id prefix and bounds, you integrate, then
  do the camera and review. Read [references/orchestration.md](references/orchestration.md) first; it
  says when it pays off (not for tweaks or one-area scenes, where it is slower), the brief to give, and
  how to review. Camera, timeline, replies and `wait` always stay with you. Keep the user posted with
  `canvas say --working --reply <id> "…"` at each stage (plan, building, joining up, camera).

## 2c. High detail: build it properly, then review it from every side

A prompt the user sent with the composer's **High detail** pill on arrives with a `detail: HIGH` line. Take your
time: plan the real proportions and a parts list by sub-assembly (a hero asset is often 40 to 150 primitives: trims,
chamfers, panel lines, handles, hinges, lights, frames), give the asset one id prefix (`van-`), and build it one
sub-assembly per `canvas ops` batch. Then review it in passes:

```bash
canvas inspect van- --close van-mirror-l   # the asset alone from 6 angles (+ close-ups), with a 1.8 m figure
# open the PNG; read the "may be floating" / "below the ground" lines it prints
canvas review "rear wheels float 5 cm | no door handles"   # what is wrong on this pass (or "no problems")
# fix it in one batch, then inspect again
```

Look for floating or sunken parts, gaps, overlaps poking through, wrong scale against the figure, missing parts
and anything that only looks wrong from one side. The chat shows each pass on a Review card. Your final
`canvas say` is refused until you have done at least 2 passes, written each up, and the last inspect came
after your last change; keep going until a pass finds nothing. If you truly cannot finish (no tab to render
with), end it honestly with `canvas review --skip "why"`. `canvas inspect` works on any request too, whenever you
want to check one object properly.

## 3. Scene conventions

- Units are meters, Y is up, the ground is y = 0. Every primitive's pivot is at its **bottom centre**,
  so `--pos x,0,z` stands it on the ground. Stack by adding the height of what is below.
- Rotations are degrees (`--rot 0,45,0` turns around the vertical axis). `--scale` multiplies size.
- Types: `box(w,h,d) sphere(r) cylinder(r,h,rTop) cone(r,h) pyramid(w,h,d) capsule(r,h) torus(r,tube)
  plane(w,d) ramp(w,h,d) stairs(w,h,d,steps) arch(w,h,d,t) person(h,body,detail,pose,joints)`. `--size a,b,c` fills the
  main params in that order.
- Use `person` (faces +z) for people and as a scale reference. `--body male|female|child` picks the
  body (default male); height defaults to 1.8 / 1.65 / 1.3 m, or set `--h`. Mix bodies in crowds and
  street scenes rather than repeating one.
- People come in two levels of detail: `low` (the default) is a box body with a cube head and a
  drawn-on face, `high` a jointed artist's mannequin. Keep low unless the user asks for more
  detailed or realistic people; then switch the whole scene with `canvas env --people high`,
  or one person with `--detail high` (`--detail null` follows the scene again).
- **Poses.** When someone should sit, crouch, kneel, lie, lean, walk, run, point, wave, fold their arms, put
  hands on hips, reach up or hold a phone, give the person `--pose <name>` (`canvas poses` lists them with
  placement notes). Any pose but `stand` draws the jointed mannequin, even in a low-detail scene. The pivot
  stays under the hips and the lowest point (feet, knee or seat) sits on it: a seated person stands on the
  floor with its pivot under the seat (knees 0.3 × h ahead), seat top at about 0.27 × h; `sit-floor` and
  `lie` sit on the floor itself.
- **Custom poses.** For anything the named poses miss ("left hand raised", "looking over her shoulder"), set
  joints on top of the closest pose: `canvas set hero --pose stand --joints "shoulderL=0,150 elbowL=20 neck=0,0,60"`.
  Joints: body spine neck (bend forward, lean to its left, turn to its left), shoulder/hip/wrist L|R (raise
  forward, raise out, twist), elbow/knee L|R (bend), ankle L|R (toes up). L/R are the figure's own sides.
  Always snapshot a posed person close up and fix what reads wrong before replying.
- Give objects meaningful names (`--name hero-car`); the name becomes the id.
- Keep blockouts grey (default `#d8d4cc`). Use colour only to tell the subject apart from the set
  (one or two muted colours), because the video model reads colour and shape.
- Large sets: ground-level `plane`s for roads/water, `box`es for buildings, repeat with `dup --offset`.

## 4. Camera and timeline

The shot camera is defined by keys: `t` (seconds), `pos`, `target` (look-at point), `fov` or `lens` (mm),
`roll`, and `ease` (how the camera travels **from this key to the next**).

```bash
canvas key --t 0 --pos 8,1.6,10 --target 0,1.2,0 --lens 35
canvas key --t 4 --pos 2,1.4,4 --target 0,1.2,0 --lens 50 --ease slowOut
canvas timeline --duration 4 --fps 24
canvas key --t 2 --from-view          # key whatever the user is looking at right now
```

- Eases: `linear ease easeIn easeOut easeInOut slowIn slowOut snap anticipate overshoot hold`, or a
  custom cubic bezier `--ease 0.2,0,0,1` (add `,px,py,x3,y3,x4,y4` per extra point for a multi-point curve).
  `hold` freezes until the next key, then cuts to it.
- Hard cuts inside one shot: a `hold` key ends a move and the next key starts a new one; the path on each
  side of the cut is independent. For a different camera setup on the same set (a wide, then a close-up,
  then a reverse) make separate **shots** instead (section 4d): each gets its own timeline and export. To cut from one moving shot straight into another, give the last key of shot A
  `--ease hold` at the cut time and put the first key of shot B one frame later (t + 1/fps):
  `canvas key --t 3 --pos ... --ease hold` then `canvas key --t 3.042 --pos ...` at 24 fps.
- `canvas ease-all slowOut` gives every camera segment one ease (cuts stay cuts); `--from <keyId>`
  copies a key's ease to all the others; `--all-shots` does every shot. Use it for "make the whole move feel the same".
- `canvas timeline --speed easeIn` remaps time across the whole shot (a speed ramp), on top of segment eases.
- Path interpolation is a smooth spline through all keys (`--interp linear` for straight segments), except
  where a key has a move's path (section 4e).
- Defaults that work for video models: 24 fps (decimals such as 23.976 are allowed), 3–8 s, 1280×720 (`canvas meta --width --height`).
  Lens: 24–28 mm wide/establishing, 35 mm natural, 50–85 mm close/portrait. Camera height 1.4–1.7 m
  reads as a person; low (0.3–0.6 m) reads as heroic.
- Keep the target moving smoothly too; a still target with a moving camera reads as an orbit.
- Check the move with `canvas storyboard --frames 8` before exporting.

## 4e. Named camera moves (`canvas cam`)

When the prompt names a move (pan, tilt, orbit / arc, push in, pull out, truck, crane, pedestal, zoom,
dolly zoom / vertigo, dutch), use a preset instead of working out the positions yourself:

```bash
canvas cam                                         # list the moves and their params
canvas cam orbit --angle 90 --around hero --t 1 --over 4 --ease easeInOut
canvas cam push --by 2 --t 5 --over 1.5            # pull-out, or a negative --by, goes back
canvas cam dolly-zoom --by 3 --over 4              # the lens widens so the subject keeps its size
canvas cam pan --angle -30 --over 2                # signs: + is right (pan, orbit, truck), up (tilt, crane)
```

A move starts on the camera's framing at `--t` (default the playhead), writes a key there carrying the
move's **path** and ease, and a key where it ends; keys in between are replaced. A key's path says how the
camera travels to the next key: `smooth` (the spline, default), `straight`, `orbit` (an arc round a point,
so two keys make a real circle), `turn` (pan/tilt on the spot) or `dollyZoom`. The keys stay ordinary:
drag, re-key or re-ease them; `canvas key-set <id> --path smooth` turns the move back into a plain segment.
A move remembers its settings: `canvas cam --edit <keyId> --angle 180 --over 4` redoes it from the same
start framing (settings left out keep their values; name another move to switch it).
`canvas ls` shows a path as `→ orbit 90° around hero`. Chain moves by starting the next at the previous
one's end time. Check with a storyboard.

**Shudder / judder** (the camera jerks back and forth during a move): don't fake it with extra keys or
ease points. `canvas key-set <id> --shudder 6,4` gives the segment after that key 6 jerks that each pull
back 4% of the move, on top of its ease; `--shape jerk|wobble|stutter`, `--over even|fade|build`, and
`--shudder off`; `--shudder-from 0.4 --shudder-to 0.8` limits it to that part of the segment (shares
of its length). The keys still land exactly. `canvas ls` shows it as `shudder=6 jerks, 4% back, even`.

## 4a. Moving objects

Objects can move during the shot. Each move adds keys on the shot timeline; between keys an object
travels in a straight line with the segment's ease, and before its first / after its last key it holds still.
Translate a prompt like "over 3s have the character enter the house" into `move` commands:

```bash
canvas ls                                   # find the character, the house and its door
canvas move hero --rot 0,180,0 --at 0 --over 0.3        # face the door first (person faces +z)
canvas move hero --to 0,0,-1.5 --at 0.3 --over 2.7 --ease easeInOut   # walk to and through the doorway
canvas storyboard --frames 6                # check it, then reply
```

- `--at` is when the move starts (default 0), `--over` how long it takes (default 1 s). Each move
  starts from where the object is at `--at`, so chain moves back to back to build a path (around a
  corner = two moves). `--to` is an absolute position, `--by` a relative offset; `--rot` / `--turn`
  rotate (absolute / relative degrees), `--scale` scales.
- To face the direction of travel, set the Y rotation to `atan2(dx, dz)` in degrees (a person faces +z).
- Moves past the end of the shot lengthen it. Fit moves inside `canvas timeline --duration` unless
  the user asked for a longer shot.
- `canvas okey <id> --t 2 --pos ...` keys a single moment; `canvas okey-rm <id> [--t 2]` removes one key
  (or all of an object's animation). `canvas set` on an animated object shifts its whole move.
- `canvas ls` prints each object's keys (`anim: 1s@0,0,4 → 3s@0,0,-2`). In the canvas, the selected
  object's keys show as circles under the camera keys; dragging an animated object with the gizmo keys it
  at the playhead.

## 4a2. Imported models: a GLB as the subject or the set

When the user gives you a `.glb` (a captured performance, a scanned character, a ready-made set), import it
instead of blocking that part out. Its first animation plays on the shared action time, so every shot sees
the same moment of it.

```bash
canvas import ~/Downloads/dancer.glb --name dancer --fit   # upload, add at the origin, shot = clip length
canvas set dancer --pos 0,0,-2 --rot 0,90,0                 # place it like any object (pivot = its origin)
canvas set dancer --offset 1.5 --speed 0.5                  # start its clip 1.5 s into the action, half speed
```

- `canvas ls` shows its clip length and height; aim at it by id (`around: "dancer"`, `canvas frame dancer`).
- Look at a storyboard before keying: captured clips can sit off the ground or face away from +z; fix that
  with `canvas set --pos / --rot`, never by editing the file.

## 4c. Audio: pace the shot to music or dialogue

The scene can hold one audio track, shared by every shot. It sits on the action-time axis the shots
share, so each shot plays the part under its span of the action (shots that follow on play it straight
through). It shows as a waveform under the shots, plays with the playhead and is mixed into the export
(AAC). The user trims it by dragging the clip's ends and slides it by dragging the middle.

```bash
canvas audio ~/Music/track.mp3            # load it (or the user drops a file on the timeline)
canvas audio --offset -1.5                # start 1.5 s into the file (positive: audio starts later)
canvas audio --in 4 --out 20              # trim: play only 4–20 s of the file (--in none clears it)
canvas audio --fit                        # make the active shot end where the audio ends
canvas audio --beats                      # tempo, beat times and strong onsets inside the shot
canvas audio --mute on | --volume 0.5 | --clear
```

To cut or key on the music, read `canvas audio --beats` and put keys and cuts on those times (snap to
the frame grid). `canvas ls` shows the audio line.

## 4d. Shots: several cameras on one set

A scene has one or more **shots**. The set, the people and their moves are shared; each shot has its
own camera keys, length, fps and speed curve (the audio track is shared), and exports on its own or as part of the sequence.
Move a prop once and every shot sees it. Camera, timeline, audio and render commands work on the
**active** shot (the one on the user's timeline); `canvas ls` lists the shots and marks the active one.

```bash
canvas shots                                  # 1 shot-1 "Shot 1" ... (* = active)
canvas shot-add --name "Close up"             # new shot after this one, a copy of its camera; switches to it
canvas key-set 0 --pos 2,1.6,3 --target 0,1.5,0 --lens 50   # re-frame the copy
canvas shot-add --name Reverse --blank        # or start from the default two-key move
canvas shot 1                                 # switch by position, id or name
canvas key --t 2 --pos ... --target ... --shot close-up    # --shot: edit another shot without switching
canvas shot-cut 2.5 --name "Second half"      # cut the active shot at 2.5 s: the rest becomes a new shot
canvas shot-set close-up --name "CU hero" --to 1           # rename / move to position 1 in the sequence
canvas shot-set close-up --start 2            # this shot picks up the action 2 s in
canvas shot-rm reverse
canvas storyboard --shot close-up             # render any shot without switching
canvas export                                 # the whole timeline: every shot in order, cut together, one mp4
```

- The user asks for "another angle", "a close-up of this", "cut to", "coverage": add a shot rather than
  a hold-cut, unless they want one continuous clip. "Cut here" = `canvas shot-cut <t>`: the shot ends at t
  and a new one carries on from the same framing; re-frame the new shot's first key.
- Object moves are in **action time**, shared by every shot. A new shot picks up the action where the
  current one ends (shot 1 is 0–3 s → the new shot starts at 3 s), so a sequence continues across cuts.
  For coverage of the same moment from another angle, use `shot-add --start 0` (or the start you want);
  `shot-set <id> --start s` changes it later.
  `move`, `okey` and `okey-rm` take shot time (like the playhead); `ls` prints object keys in action time.
- Stretching a shot with `timeline --duration --retime` only stretches that shot's camera keys when there
  are several shots (the shared action keeps its timing).
- `export` renders the whole timeline into one mp4 (`<scene>-<time>.mp4`) at `--fps` or the active shot's fps,
  each shot through its own camera, with the audio running under the cuts (each shot's span of the action).
  `export --shot <id>` renders one shot on its own, named `<scene>-<shot>-<time>.mp4`.
- The user's key track stacks the shots, one row per shot on the action-time axis
  (clicking or scrubbing anywhere switches to the shot covering that moment; dragging a bar sideways sets
  `--start`, up or down reorders; dragging a bar's left or right end retimes the shot, stretching its camera
  keys, same as `timeline --duration s --retime [--start s]`, and Alt-drag trims it instead; Delete on a clicked bar removes it; Shift or Cmd/Ctrl-click or a Shift-drag box picks
  several bars, which then move sideways together (one `timeline --start` per shot, one undo step) or delete together;
  Play all plays through the cuts).
  They add a shot from the "+ New shot" row under the shots (click = next shot, drag = any span; same as
  `shot-add --frame [--start s] [--length s]`) or Shift+N, switch with `[` / `]`, move one with Shift+`[` / `]`, and
  the Export menu has Export full video (the whole timeline), Export shot (the active shot) and Render with Comfy.
  Canvas prompts carry `shot:` (the active shot) when there are several.

## 4b. Save and load versions

The scene autosaves continuously, and once it has been saved under a name every change also autosaves into that named version (`meta.name`). Before a big rework (or when the user says "save this"), keep a
named version: `canvas save street-v1`. `canvas saves` lists versions; `canvas load street-v1`
restores one (undoable with `canvas undo`). `canvas new` starts an empty scene (also undoable; the Scenes menu has a New button). Saving over an existing name needs `--overwrite`;
prefer a new name such as `street-v2`.

## 5. Export

```bash
canvas export                 # mp4 (H.264) of the whole timeline (every shot) at the doc's size/fps; prints the path
canvas export --fps 24 --width 1920 --height 1080 --grid off --name street-chase
canvas export --shot close-up # just that one shot
```

Exports land in `scenes/exports/`. Give the user the path. Grid lines are kept by default because
they help the video model read ground motion; `--grid off` removes them.

`canvas brief` puts the shot's camera work into words: each move with its exact times, pace and ease, the
framing it lands on, the objects that move, and the part of the audio it plays (`--beats` adds the beat
times, `--all` covers every shot, `--json` has the numbers). Use it whenever you describe a shot, for
example when the user wants a prompt for the video model to go with the export: take the times from the
brief instead of estimating them.

Rendering the export into a finished shot with ComfyUI (Seedance and other reference-to-video workflows) is
a separate, optional skill: `blockout-render`. Load it when the user asks to render a shot.

## 6. Prompts typed in the canvas

The canvas has a chat sidebar. Prompts queue on the server and come back to **this session** with the
user's selection, playhead time and camera pose attached. Pick one up, do it, then reply:

```bash
canvas wait --timeout 600      # blocks until a prompt arrives; prints it with context
# ... make the change, check a snapshot ...
canvas say --reply <promptId> "Raised the tower to 10 m and keyed a slower push-in"
```

`canvas say` shows the reply in the canvas and marks the prompt done. Use `--working` for progress
notes that should not close it (the chat shows a "Working" card with a clock, and you cannot go idle
until your final reply or a question card ends it), `--attach file.mp4` (or an image) to show a video in the reply, where it
plays in place, and **always finish with a final `say`** (without `--working`):
otherwise the user sees "no reply yet". When you need something from the user (a choice, an image, a
confirmation, an API key), ask with a question card, `canvas ask` (references/api.md, "Question cards and
keys"), not a paragraph of questions: it shows them one at a time and the answers come back as the next
prompt. For a job that takes minutes, show a progress card (`canvas progress`, same section). Then call `canvas wait` again straight away; a prompt is
only delivered to an agent that is waiting. Calling `wait` also marks any prompt you already took
as done and turns listen mode on. "this", "it" or "here" in a prompt refer to the `selected:` object and
the `playhead:` time printed with it. When the user attaches images (references, sketches,
screenshots), the prompt has an `images attached:` line with their file paths: open each one with
your Read tool before acting on the prompt. A `.glb` the user drops in the chat comes as a `GLB models attached,
NOT in the scene yet` line with its path: add it (`canvas import <path> --pos …`) only if the message asks for it
(a `.glb` dropped on the canvas is already in the scene, where the camera was focused). When the user points back to an earlier conversation
("like last time"), `canvas chats` lists past chats and `canvas chats <id>` prints one.

How to listen depends on the agent:
- **Claude Code**: run `canvas listen on`. The Stop hook (from the plugin, or `.claude/settings.json` in a
  checkout) then keeps this session waiting for the next canvas prompt each time you finish, and hands it to you as a new
  instruction in the same thread. `canvas listen off` stops it. The UserPromptSubmit hook also passes
  along prompts queued while you were busy. Without hooks, run `canvas wait` as a background command
  and handle its output when it completes, then start it again.
- **Codex** (or any agent without hooks): loop `canvas wait --timeout 600`; after handling a prompt,
  call `canvas wait` again. If it times out, run it again unless the user told you to stop.

Keep listening until the user says to stop.

## 7. Adding controls to the canvas

The base UI is intentionally only the timeline. When the user asks for a new control (a slider for
fog, a lens picker, an object list…), follow `docs/DESIGN.md` in the repo:

1. Copy `app/controls/_template.js` to `app/controls/<id>.js`.
2. Build it only from `app/ui/kit.js` components; read state from `ctx`, change the scene only through
   `ctx.op(...)`. New behaviour that needs new data gets a new op in `core/doc.js` (and a CLI flag).
3. Register it in `app/controls/index.js`. Open tabs reload automatically when `app/` changes.
4. Run `npm test`, and check the page loads without console errors.

## 8. Troubleshooting

- `canvas server is not running` → `canvas up`.
- `no canvas tab is open` → `canvas open`, then retry.
- An op error lists valid values (types, params, ease names): fix the call rather than editing JSON by hand.
- `canvas undo` reverts your last change. The scene file can also be edited directly; the server
  reloads it on save.
