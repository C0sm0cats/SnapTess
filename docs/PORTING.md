# SmartGrid → SnapTess

This is a native GNOME implementation, not a translation of the Win32 calls. Initial target: GNOME Shell 50 / Mutter 18, Wayland. Version 0.1 is a preview.

| SmartGrid behavior | SnapTess 0.1 | Difference / limit |
|---|---|---|
| Auto full/split/master/grid | Implemented | Grids also grow past 15 windows |
| Tiling toggle | Implemented | Stop restores pre-tiling geometry |
| Maximize-safe layout | Implemented | Freeze is per display; explicit layout application can unmaximize |
| Minimize/close compaction | Implemented | Independent options; restore recovers previous ordering when membership is unchanged |
| Floating windows | Implemented | Runtime toggle plus persistent app-ID exclusions |
| Active border | Implemented | Shell overlay, no DWM; respects fullscreen/overview |
| Swap mode and arrows | Implemented | Modal keyboard interaction; Escape/Enter exits |
| Drag preview and same-monitor swap | Implemented | Shell grab signals, translucent target |
| Cross-monitor add/reflow | Implemented | Moves and retile both displays |
| Three workspaces per monitor | Adapted | Native minimization parks windows; not invisible Win32 hiding |
| Layout Manager | Implemented | Modal Studio, draft swaps, preset and monitor/space selection, window assignment library |
| Saved slots | Adapted | Layout and application order, not exact window identity across sessions |
| Settings and global hotkeys | Implemented | libadwaita preferences and GNOME keybindings |
| Tray UI | Adapted | Native top-panel indicator |
| Force arbitrary app geometry | Not promised | Mutter and application minimum sizes remain authoritative |
| Pixel-perfect Windows animation | Replaced | Native window placement with animated guides; not a custom window animation engine |
| Slot-guard polling | Not ported | Event-driven reflow; does not continuously fight app self-resizing |
| Undo | Added | Last ten manual arrangements, including floating membership and profiles |

## Validation

- Node tests check layout transitions, >15 windows, negative monitor coordinates, non-overlap, exact extents, directional neighbors and slot holes.
- A real GNOME 50.4 headless Wayland session exercises four native GTK windows: initial pause, placement, maximize freeze, compaction, spaces, floating/undo, swap, Studio apply, restoration and extension cleanup.
- The two-monitor variant exercises window assignment, independent spaces, cross-display drop handling and reflow.
- GTK4/libadwaita preferences are constructed in an isolated process; shortcut validation, saving and disabling are checked.
- The Studio screenshot is captured from the isolated Shell session, with test applications. It is not a mockup.

Physical mouse drag gestures, mixed-DPI physical screens, suspend/resume and the diversity of third-party application size constraints still need wider desktop testing. The test suite drives the drop handler directly for cross-monitor assertions.

## Space semantics

Native workspace × display × SnapTess space identifies a window group. A space switch minimizes only currently visible windows owned by the outgoing group. SnapTess tracks which minimizations it owns and reverses only those on a space switch. Stopping the extension restores its initial snapshots. A monitor configuration change reveals parked windows and returns groups to space 1 so none remain stranded.

This deliberately does not hide windows from GNOME's overview/dock or change global workspace settings. After a Shell crash, minimized windows remain reachable from GNOME; group membership is not persisted across Shell sessions.
