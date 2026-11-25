# Blockout guide

Everything you can do in the canvas, in one place. For setup, see the [README](../README.md).

<img src="screenshot.jpg" alt="Blockout in Shot view: a vertical shot of a figure by a car, the shot timeline with the music track below, and the chat on the right" width="100%">

- [Chat with your agent](#chat-with-your-agent)
- [Mouse and keyboard](#mouse-and-keyboard)
- [Timeline and keys](#timeline-and-keys)
- [Camera moves](#camera-moves)
- [Shots](#shots)
- [Export](#export)
- [Render with ComfyUI](#render-with-comfyui)
- [Saving and loading](#saving-and-loading)
- [Adding controls](#adding-controls)
- [How it works](#how-it-works)

## Chat with your agent

Type in the chat sidebar on the right (`/` focuses it; Enter sends, Shift+Enter adds a line). The message goes
to your agent together with what you have selected, the playhead time and the camera pose (shown as chips
above the input), so "make this taller" or "slow the camera down here" just work.

Tell your agent to listen first:

- **Claude Code:** say "listen to the canvas". It runs `canvas listen on`, and the Stop hook keeps the session
  waiting for your next canvas prompt and feeds it into the same thread. Press Esc in the terminal to
  interrupt; "stop listening" turns it off. (`/blockout:start` does this for you.)
- **Codex:** say "listen to the canvas". It loops `canvas wait`, which blocks until you send a prompt.

The sidebar header shows **Listening** (green), **Working** (orange) or **Not listening** (prompts queue
until the agent picks them up). A prompt the agent took but never answered shows "no reply yet" instead of
spinning forever.

The conversation survives reloads. The compose button starts a new chat and keeps the old one under the
history button, where you can read it back (your agent can too, with `canvas chats`). Hide the sidebar with
the panel button; a dot on the chat button marks unread replies.

## Mouse and keyboard

| Input | What it does |
|---|---|
| Click | Aim the camera at the clicked point. In Shot view, press `K` to key the new aim. |
| Ctrl-click / ⌘-click | Select an object; on empty space, deselect |
| Drag · right-drag · scroll | Orbit · pan · zoom. Double-click frames the selection. |
| `W` `A` `S` `D` · `Q` `E` · `Z` `X` | Fly: move, down / up, roll (Dutch tilt). `Shift` faster, `Alt` slower. Hold the right mouse button to look around with the mouse; scroll then sets the fly speed. |
| Ctrl-scroll / ⌘-scroll / pinch | Change the lens (focal length) |
| `1` `2` `3` | Move / rotate / scale gizmo |
| `F` · `Shift D` (`⌘D`) · `⌫` · `Esc` | Frame · duplicate · delete · deselect |
| `C` | Toggle **Free** (orbit the set, see the camera path) and **Shot** (look through the timeline camera at the export size) |
| `K` | Key the current view at the playhead |
| `[` `]` · `Shift [` `]` · `Shift N` | Previous / next shot · move the shot earlier / later · new shot |
| `Space` · `←` `→` · `Home` | Play · step a frame (`Shift`: 1 s) · go to start |
| `⌘Z` / `⇧⌘Z` | Undo / redo (agent changes too) |

In Shot view, flying, clicking and changing the lens reframe the shot camera; press `K` to key it. The **Lens**
(mm) and **roll** (°) fields in the timeline bar edit the selected key and the free view.

## Timeline and keys

- Drag the playhead to scrub. Drag a key (◆) to retime it (snaps to frames; Shift for free).
- Double-click the track to add a key from the current view; right-click a key to delete it.
- Select a key and its settings open in a small card above it: its ease, the path to the next key, "set to
  current view" and delete.
- The curve button opens the editor. **Segment** edits the bezier ease between two keys (the shaded area is
  the camera's speed; click the curve to add a point, double-click a point to remove it). **Shot speed**
  remaps time across the whole shot for speed ramps.

## Camera moves

The caret on the **Key** button applies a preset move from the playhead: pan, tilt, orbit, push in, truck,
crane, pedestal, zoom, dolly zoom or dutch. A move is two ordinary keys; the first remembers how the camera
travels to the second (an arc round the subject, a turn on the spot, a dolly zoom). The agent does the same
with `canvas cam`.

## Shots

One set can have several cameras. The set, the people and their moves are shared, so moving a prop updates
every shot; each shot has its own keys, length and fps. One audio track plays under all of them.

- The key track shows each shot as a bar on a shared action-time axis. The active shot's row is the full key
  editor.
- **+ New shot** (or Shift+N) adds the next shot from where the current one ends. Drag across that row to
  draw any span; it snaps to 0, the playhead and each shot's ends.
- Click a shot name to switch; drag it up or down to reorder. Drag a bar sideways to change where it picks up
  the action. Click a bar and press Delete (or right-click it) to remove it.
- Shift or ⌘/Ctrl-click bars to pick several, then drag or delete them together.
- **Play all** (hover the Play button; Loop is there too) plays on through the cuts.

Agents use `canvas shots`, `canvas shot <id>`, `canvas shot-add`, `canvas shot-cut` and `--shot`.

## Export

The **Export** menu has three items:

- **Export full video** (`canvas export`): every shot in order, with the audio, as one MP4.
- **Export shot** (`canvas export --shot <id>`): just the current shot.
- **Render with Comfy**: see below.

Frames go through the shot camera at the scene size and fps and are encoded as H.264 in the browser. Files
land in `scenes/exports/`.

## Render with ComfyUI

Optional. Choose **Render with Comfy** in the Export menu, or ask in the chat ("render this with Seedance").
The whole timeline goes over as one reference video and comes back as one render.

The agent asks for what it needs with question cards: your reference images, the model, and an API key if one
is needed (the key block saves it on your machine; the agent never sees it). The `blockout-render` skill fits
one of your saved ComfyUI workflows ("recipes") to the timeline, writes a timed prompt from the camera moves
(`canvas brief`), and shows you the full prompt to review, then a confirm card with the cost. Nothing that costs
credits runs until you press **Render**. A progress card shows the job; the finished video plays in the chat
and is saved in `scenes/renders/` with the exact workflow and prompt that made it. **Beside shot** under any
video in the chat puts it next to the shot frame, the two centred together and in step with the timeline (play
and scrub move both); the chat hides until you close the video with its ×.

It runs on [Comfy Cloud](https://docs.comfy.org/agent-tools/mcp) or your own ComfyUI, through the Comfy Cloud
MCP, `comfy-mcp` or the `comfy` command line. A Seedance 2.5 recipe is included; put your own workflows (API
format) in `scenes/recipes/`. There is no ComfyUI code in Blockout itself.

## Saving and loading

The scene autosaves to `scenes/scene.json` on every change. To keep a version, press **⌘S** (or the scene
menu, top right), name it and press Enter: that writes `scenes/saved/<name>.json` with a thumbnail. **Load**
in the same menu replaces the scene with a save, and ⌘Z undoes the load. Agents use `canvas save <name>`,
`canvas load <name>` and `canvas saves`.

## Adding controls

The base ships with no side panels. Ask your agent, e.g. "add a control for fog and sun direction". It copies
`app/controls/_template.js`, builds the panel from the UI kit following [DESIGN.md](DESIGN.md), registers it
in `app/controls/index.js`, and open tabs reload. See `app/controls/examples/environment.js`.

## How it works

```
 you ── chat sidebar in the canvas ──▶ bridge server ──▶ your agent session (same thread)
  ▲                                      │                      │
  └──────── live scene updates ◀─────────┴──── canvas CLI ◀─────┘
```

- `server/index.mjs` owns the scene document, applies ops with undo history, streams changes to open tabs
  over Server-Sent Events, forwards render requests to a tab, keeps the prompt inbox
  (`scenes/.canvas/inbox.jsonl`) and stores exports. Zero dependencies.
- `core/` is shared by server, CLI and browser: the document model, primitives, ops, and the easing and
  camera-path math.
- `app/` is plain ES modules with three.js from `node_modules` via an import map. No build step.
- Video export uses WebCodecs through [mediabunny](https://mediabunny.dev). If the browser can only encode
  VP9 and `ffmpeg` is installed, the server transcodes to H.264.
- People (`person`, `--body male|female|child`) come in two levels of detail: a low-poly box figure
  (`app/blockman.js`, the default) and a jointed artist's mannequin (`app/mannequin.js`, about 3.4k
  triangles). Ask for detailed people, or run `canvas env --people high`.

### Environment variables

| Variable | Default | |
|---|---|---|
| `CANVAS_PORT` | `5317` | Server port |
| `CANVAS_DATA` | the repo (checkout), `~/Blockout` (plugin) | Where scenes live |
| `CANVAS_SCENE` | `<data>/scenes/scene.json` | Scene file |
| `CANVAS_EXPORTS` | `<data>/scenes/exports` | Export folder |
| `CANVAS_LISTEN_SECONDS` | `3300` | How long the Stop hook waits for a canvas prompt |
