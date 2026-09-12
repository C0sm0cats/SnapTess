# Maximize/fullscreen restoration: structural diagnosis (runtime 7)

Baseline: `f778b1cacc95f0fc9d4a701722b55fdb81e23479`, runtime revision 6.

## Established defect versus desktop reproduction

The old runtime has an unbounded **size-feedback path**, independent of its
1,400 ms restore deadline:

`size-changed → scheduleWindowScale → correctWindowScale → move_resize_frame → client commit → size-changed`

`correctWindowScale()` treats every observed frame size as a new minimum for
`fitMinimumSize()`. Its request key includes the **observed** frame, so each
changed reply bypasses deduplication. `place()` also clears that key, requests the
minimum-based frame again, and resets the actor transform. During restoration,
position/size events, effects completion, and the final stabilization callback can
all call `place()`. These are competing size negotiations, not just visual fixes.
Even the second maximize-property notification schedules a full `tile()` in
revision 6 after the first notification has started restoration.

The new Node regression executes the actual runtime with simulated asynchronous
commits: revision 6 makes **17 resize requests**, versus **2** with revision 7
(initial placement plus one measured backing fit). The mock deliberately supplies
successive sizes; it does **not** prove that Chromium uses those particular sizes
or that client rounding alone causes infinite growth.

No GNOME desktop, Brave, or ChatGPT Community reproduction was available in the
implementation environment. The structural feedback defect is demonstrated; the
exact origin of each movement on the reported desktop still needs a trace.
Do not interpret green unit tests or packaging CI as that desktop reproduction.

## GNOME 50 source findings

The supported version is Shell 50. These findings come from the `50.0` sources:

- [Mutter core/window.c](https://github.com/GNOME/mutter/blob/50.0/src/core/window.c):
  `meta_window_set_unmaximize_flags()` clears the relevant state, derives the
  target from `saved_rect`, starts the compositor size change, requests geometry,
  then freezes/queues/thaws the two property notifications. Do not assume a fixed
  horizontal/vertical notification order. Unfullscreen similarly uses
  `saved_rect_fullscreen` and notifies after requesting restoration. Size hints
  and the unmaximize work-area limit can adjust the saved size; it need not equal
  the SnapTess slot. These private restore bounds are not writable through the
  extension's public API, and this fix does not modify them.
- In `meta_window_move_resize_internal()`, an effective position change emits
  `position-changed`, then an effective size change emits `size-changed`, then
  geometry is synchronized to the compositor. Thus the actor can still describe
  the previous buffer **inside** a MetaWindow signal handler.
- [Mutter wayland/meta-window-wayland.c](https://github.com/GNOME/mutter/blob/50.0/src/wayland/meta-window-wayland.c):
  a resize request is not a synchronous client resize. The finish path processes
  later committed geometry and its acknowledged configuration. It updates frame
  extents from window geometry, derives position from configuration/gravity, and
  applies surface offsets. With some gravities a requested/committed size mismatch
  also changes position. Old acknowledgements, new client sizes, and state
  notifications therefore cannot be treated as one atomic event. A MetaWindow
  signal does not expose which protocol serial or process caused it.
- [Shell js/ui/windowManager.js](https://github.com/GNOME/gnome-shell/blob/50.0/js/ui/windowManager.js):
  `_prepareAnimationInfo()` freezes the actor **before** transitions exist.
  `_sizeChangedWindow()` animates scale **and translation**; completion resets
  those transforms and clears animation info before reporting completion.
  Runtime 7's effect guard explicitly depends on Shell 50's private
  `actor.__animationInfo` for that pre-transition interval, plus Clutter transition
  queries. Recheck this dependency when porting Shell versions. No private
  animation state is modified.

A normal-state property notification can consequently arrive while a client
still owes geometry commits. `effects-completed` ends the compositor effect; it
is not an acknowledgement that all future client geometry is settled.

`frame_rect` describes the visible frame; `buffer_rect` includes client-side
extents/shadows. Scaling is anchored at the frame's offset within that buffer,
using the actual actor allocation. The pivot preserves that visible origin; it
cannot repair a moved MetaWindow origin. An actor-only change with unchanged
frame/buffer should be investigated as a compositor transform, not diagnosed as
a client move. SnapTess does not set actor x/y or translations for window placement.

Chromium/Electron may run as native Wayland clients or through XWayland. App name
alone does not identify the backend. Native Wayland configure/ack/commit reasoning
must not be applied unchanged to X11 clients. The trace records `clientType`; no
app-specific exception is used. A manual drag occurs in a different grab/state
context, and a new explicit placement supersedes restoration; its success is
consistent with a restore race but does not by itself identify the writer.

## Revision 7 invariants

- Explicit placement publishes its tile/backing target before making any geometry
  request. It cancels an older restore transaction and permits at most one
  measured-size fallback. Normal-size observations do not consume that fallback.
- Once a fallback is used, later sizes only recompute the visual scale. They never
  feed back as new minimums. A client that rejects the fitted aspect ratio may
  leave unused space on one axis; preserving aspect ratio and avoiding an endless
  size negotiation take precedence over forcing exact gap equality.
- Restoration requests the pre-maximize backing target once. Subsequent restore
  events repair position with `move_frame`, without explicitly requesting another
  width/height. Identical positions are no-ops. Synchronous signals emitted inside
  our own geometry request cannot requeue restoration.
- Position repair retains the existing 1,400 ms deadline and adds an eight-request
  ceiling against asynchronous move rejection/echoes. The ceiling is a safety
  limit, not a convergence assumption or a new delay. Exhaustion stops writes;
  an application that keeps moving independently can still escape the slot.
- The final callback does not restart size negotiation. Active compositor effects
  resume from their completion signal, including effects longer than the normal
  deadline, rather than scale polling. Grabs, stop, floating/minimized windows,
  new special states and unmanaged windows prevent inappropriate restoration.
- Duplicate state notifications do not trigger a full retile. Restore/request
  geometry does not schedule monitor-driven retiling. There is no new permanent
  polling loop or permanent actor geometry observer.

## Temporary targeted trace

With runtime 7 loaded, enable tracing for the exact `WM_CLASS`, or use `*` and
maximize only the window being investigated:

```sh
mkdir -p "$XDG_RUNTIME_DIR/snaptess"
printf '%s\n' '*' > "$XDG_RUNTIME_DIR/snaptess/trace-restore"
journalctl --user -f -o cat | rg --line-buffered '\[SnapTess:restore\]'
```

If Shell logs are absent from the user journal on your distribution, use
`journalctl -f -o cat _COMM=gnome-shell` with the same filter.

Reproduce: tiled → maximize → normal → initial return → wait at least ten seconds.
Then repeat with fullscreen, and finally with a manual drag for comparison.

The marker is read only on special-state notifications. It attaches actor
property observers for **ten seconds after the last matching notification**,
then disconnects them. Unmanage and disable also disconnect them. Remove the
marker to prevent another capture (an active capture ends within ten seconds):

```sh
rm "$XDG_RUNTIME_DIR/snaptess/trace-restore"
```

Each JSON line includes wall-clock and monotonic timestamps, stable window ID,
backend, event, frame/buffer/tile/backing rectangles, actor allocation, scale,
translation, pivot, effect state, fullscreen/maximize flags, grab state, restore
state, request sequence and whether a SnapTess request is executing.

- `request:place`, `request:restore`, `request:backing-fit`,
  `request:restore-position`, `request:original-state`: an actual SnapTess geometry
  call, with its requested rectangle; `returned:*` captures the immediate result.
- `position-changed` / `size-changed` with `inSnapTessRequest: true`: synchronous
  notification inside that request. `false` means a later observation, **not proof
  that SnapTess was uninvolved**: asynchronous replies can arrive after return.
- `actor:*` with unchanged frame/buffer: compositor/allocation/transform change.
- `apply-scale`: SnapTess visual correction, with no associated geometry request
  after the one permitted backing fit.

Match request sequences to subsequent frame/actor observations. This identifies
SnapTess writes exactly and separates them from later observations, but cannot
uniquely attribute an asynchronous geometry change to a client, an older configure,
Mutter constraints, or another extension. If that remains ambiguous, collect the
native client's Wayland protocol log (configure serials, ack_configure,
set_window_geometry and commits) alongside this trace; the public MetaWindow
signals alone cannot provide that attribution.

## Validation

`npm test` includes runtime regressions for successive asynchronous replies,
several post-unmaximize position/size commits, duplicate notifications, nested
fullscreen/maximize, long/frozen compositor effects, synchronous reentrancy,
rejected move limits, grabs/stopped tiling and manual-placement cancellation.
The original runtime fails the feedback regression (17 requests vs 2).

Local packaging/headless Shell execution was attempted but unavailable because
`glib-compile-schemas`, GNOME Shell and its test tool are absent. GitHub's existing
Checks workflow runs the Node suite, syntax checks and extension packaging; it
does not run `scripts/test-shell.sh`. That real Shell 50 test and the reported
applications remain desktop validation tasks.
