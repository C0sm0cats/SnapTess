<div align="center">

# SnapTess

**Your windows, beautifully arranged.**

Automatic window tiling for **GNOME Shell 50 · Wayland**.

[![Checks](https://github.com/C0sm0cats/SnapTess/actions/workflows/check.yml/badge.svg)](https://github.com/C0sm0cats/SnapTess/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-8ce8c3)](LICENSE)
[![GNOME 50](https://img.shields.io/badge/GNOME-50-3584e4)](metadata.json)

**One shortcut to arrange. One shortcut to give your desktop back.**

</div>

![SnapTess arranging fifteen real application windows in a 5×3 grid with the focused-window outline, contents blurred](docs/snaptess-overview-blurred.png)

SnapTess is a standalone GNOME Shell extension. It starts paused: enabling it does not rearrange your windows.

## What it does

- **Automatic layouts:** full, split, 60/40 focus-and-stack, and grid presets through 5×5. Classic layouts grow and shrink automatically, and can expand beyond 25 slots.
- **Layout Studio:** a desktop overlay with application icons, numbered slots, drag-to-swap, layout presets, display/space selection, and a window library for assigning windows across displays. Create a named layout from a built-in preset or design custom tiles with splits, merges and percentage dimensions. Edit saved templates or the current space. Edits stay in a draft until applied or saved.
- **Quick layout switcher:** open it from the panel menu or press Ctrl+Alt+L. See how many windows each saved layout will reuse, open, or hide before applying it to the focused display and space. Arrange open windows automatically without opening apps.
- **Drag to snap:** move a tiled window by its title bar, see the translucent target, and release. Same-display drops swap; cross-display drops insert and reflow both displays.
- **Directional focus:** press Ctrl+Super+arrow to activate a neighboring tiled window without moving it. Keep typing immediately; no navigation mode is needed.
- **Linked tile resize:** drag a shared window edge or corner to resize neighboring tiles, with movement continuing into further tiles when a neighbor reaches its minimum. Proportions are saved for that display and space. Undo restores the previous arrangement; Arrange again (Ctrl+Alt+R) resets the proportions.
- **Three spaces per display:** independent window groups within each native GNOME workspace. Switching parks windows with native minimization; stopping reveals and restores them.
- **Stay in control:** floating windows, app exclusions, configurable compaction, maximize/fullscreen freeze, focused-window outline, animated guides, saved layout/app order, and ten-level arrangement undo.
- **Pinned slots:** a compact card marks a reserved tile when its app is minimized, floating, or closed. Click it to restore, retile, or reopen the app; unpinned empty tiles stay clear.
- **Import and export:** save named layouts and per-space profiles as a JSON file from Preferences, then import them on another installation. Import adds layouts and profiles without replacing existing ones.

## Install

Requires GNOME Shell **50** on Wayland and the `gnome-extensions` command. No build tools or source checkout are needed.

Download `snaptess@c0sm0cats.github.io.shell-extension.zip` from the [latest release](https://github.com/C0sm0cats/SnapTess/releases/latest). In the folder containing the downloaded ZIP, run:

```bash
gnome-extensions install --force snaptess@c0sm0cats.github.io.shell-extension.zip
```

On first installation, log out and back in so GNOME discovers the extension. Then enable SnapTess in the Extensions app or run `gnome-extensions enable snaptess@c0sm0cats.github.io`.

Open the grid icon in the top panel, or press **Ctrl+Alt+T** to begin arranging. **Ctrl+Alt+P** opens Layout Studio. Stop with **Ctrl+Alt+Q** to restore the original window geometry.

If another tiling extension is enabled, disable its automatic placement and overlapping shortcuts before using SnapTess. To remove SnapTess:

```bash
gnome-extensions disable snaptess@c0sm0cats.github.io
gnome-extensions uninstall snaptess@c0sm0cats.github.io
```

## Shortcuts

All shortcuts can be changed or disabled in Preferences. Super is usually the Windows key.

| Shortcut | Action |
|---|---|
| Ctrl+Alt+T | Start / stop tiling and restore |
| Ctrl+Alt+P | Layout Studio |
| Ctrl+Alt+L | Change layout |
| Ctrl+Alt+R | Arrange again and reset manually resized tile proportions |
| Ctrl+Alt+F | Float / tile the focused window |
| Ctrl+Alt+S | Enter / leave swap mode |
| Ctrl+Super+← / → / ↑ / ↓ | Focus the tiled window to the left / right / above / below |
| Ctrl+Alt+Z | Undo the last manual arrangement |
| Ctrl+Alt+Y | Redo the last undone manual arrangement |
| Ctrl+Alt+1 / 2 / 3 | Switch space on the focused display |
| Ctrl+Alt+Q | Stop and restore windows |

**Focus navigation:** while tiling is active, Ctrl+Super+arrow activates a visible tiled window on the same display and in the current SnapTess space. It skips empty, minimized and floating tiles, prefers windows in the same row or column, and uses the current geometry after resizing. With no window in that direction, focus stays put; it never wraps around or switches spaces. These defaults avoid GNOME's Ctrl+Alt+arrow workspace shortcuts. Focus navigation is inactive during swap, drag/resize, Overview and the layout dialogs.

**Swap mode:** Ctrl+Alt+S starts a mode in which plain arrow keys exchange window positions. Enter (or Ctrl+Alt+S again) keeps the changes; Escape cancels them. Use directional focus to choose where to type and swap mode to rearrange windows.

## Appearance preferences

- **Make room:** keep one common screen margin or enable separate top, right, bottom and left margins. Window spacing controls the gaps between tiles independently. The live preview reflects these settings.
- **Focus outline:** follow the GNOME accent or choose a custom color, set thickness from 1 to 6 pixels, and choose a plain outline or subtle halo. Each corner continues to follow the window shape.
- **Animations:** choose Fast, Normal, Slow or a custom base duration (40–500 ms), with ease out, linear or ease in and out motion. These settings affect guides, focus effects, Studio and space transitions; native window placement stays immediate. Disable animations with “Animate placement guides”.

## How spaces and profiles work

Spaces are **session-local window groups**, not replacement GNOME workspaces. Each native workspace has its own three groups per display. Windows opened in a group belong to that group. **Choose an app** on a Studio tile can share the same window between Spaces on one display: its existing assignments stay intact, and switching Spaces restores that Space’s layout. Applying a saved layout also reuses matching windows from other Spaces on the same display. Adding a window from another display moves it instead. Manually opening a parked window from the dock brings it into the current group. Windows you minimized yourself remain minimized when switching groups.

Studio marks shared windows with **SHARED**. Hover over a shared tile to see the Spaces that use it; the same information is available to screen readers, including on dense grids.

Layouts and application order are saved by native workspace index, monitor connector and space number. In Studio, select a window and choose **Pin this app to this tile** to reserve its place when it closes and reopens; the tile stays empty while the app is absent. **Clear tile** removes the selected assignment without closing its window or changing other Spaces. **Reset Space** clears all tiles, app assignments and pins in the selected Space. Shared windows stay assigned to their other Spaces; windows belonging only to the reset Space return to floating without being closed. Other Spaces keep their assignments and geometry. Apply saves changes made across all edited displays and spaces as one undoable arrangement. Choosing an installed app reserves its tile in the draft; **Apply arrangement** reuses an existing window or opens the missing app. Changing only a preset or Space never launches applications. Multiple windows from the same app retain their current relative order.

**Saved layouts** are separate named templates in Studio. Save the current draft with **Save layout…** beside **Apply arrangement**, or choose **New layout** to start from a blank built-in preset or **Custom**. Choose an open window or installed app for each tile, leave tiles empty, and pin apps independently. The app picker has separate **Open windows** and **Installed apps** sections, collapsed by default, each with its own search field. Rows and icons are created only when a section is expanded. Open windows updates as windows open or close, keeping the current search. New layout keeps its creation draft, name and undo history while navigating within Studio, independently of saved-template edits. Without a creation draft, it starts as an empty 2 × 2. Saving a new layout leaves the desktop untouched. Studio groups saved layouts into **Custom layouts** and **Preset layouts**; the quick switcher calls these **Saved custom layouts** and **Saved preset layouts**. Both lists are sorted by tile count within each group, and support searching saved layouts by name. Select a template to preview it, rename it with **Rename layout**, or explicitly choose **Restore in this space**. Restore reuses matching windows on the selected display, including other Spaces, launches missing apps when available, restores only the pins chosen in Studio, and minimizes surplus windows without closing them. Undo restores the previous arrangement and minimized state, but does not close newly launched apps. **Ctrl+Alt+Y** or **Redo last arrangement** in the panel menu restores the undone arrangement. Up to ten steps are kept; a new manual arrangement clears Redo. Stopping tiling clears both histories. These global shortcuts are separate from Studio’s draft Undo/Redo. A deleted named layout has its own **Undo delete** action in Studio. Missing or unavailable apps leave their tiles empty; pinned tiles remain reserved. This is an on-demand layout reconstruction, not automatic session or document restoration after login.

### Build a custom layout

1. Open **Layout Studio → New layout → Custom**. Start with one tile covering the available space.
2. Select a tile and use **Split vertically** (left/right) or **Split horizontally** (top/bottom). Drag the green divider handles, or edit **X, Y, Width and Height** in percent; press Enter or leave the field to commit. Shared edges adjust neighboring tiles, keeping complete coverage without overlaps. Outer edges remain fixed. Tiles have a minimum width and height of 3%, with up to 30 tiles.
3. Select the first tile, click **Merge tiles**, then click an orange neighbor to combine them into one rectangle. Only neighbors whose union forms a rectangle can be merged. If both tiles have an app assigned, choose which app to keep. **Undo** and **Redo** navigate geometry, assignment and pin changes. A new edit after Undo clears Redo.
4. Choose an installed app for each tile, leave tiles empty or pin assignments, then **Save layout…**. Saving does not move windows or launch apps. Select **Edit layout** in a saved template's preview to change it later.
5. Use **Restore in this space** or the quick layout switcher to apply the template. Custom geometry is included in JSON export/import and scales to the destination display, with your normal margins and gaps.

Custom layouts retain directional focus, swap and linked resizing. **Arrange again** resets temporary divider changes to the custom template's saved proportions. If more windows need placement than the custom layout has tiles, the existing Auto fallback arranges them; the custom definition is retained. To change the base geometry permanently, edit and restore the named layout.

All classic layouts **grow and shrink automatically** with the number of visible windows and reserved tiles, including restored saved layouts. Studio's **Current space** shows the calculated layout as a read-only **Current layout** label. Preset choices are available in **New layout** and when editing saved templates. Empty unpinned tiles in saved preset templates collapse when applied. **Custom layouts keep their geometry and tile positions.** Pinned apps continue reserving their tiles in either case.

An app that takes time to open keeps its requested Space and tile until its window appears. There is no launch timeout notification. Pending destinations survive extension reloads within the same desktop session, including windows that appeared while it was disabled. Applying Clear tile, replacing the assignment or Reset Space cancels the corresponding pending destination.

When creating or editing a template, Studio dims presets with too few tiles for the draft. Selecting one explains the required capacity without changing the draft. A new layout needs enough tiles to keep every assigned app in its chosen position.

The **quick layout switcher** keeps **Arrange open windows** visible above the saved layouts. Select a saved layout to apply it after reviewing its effects. Escape cancels. Arrange open windows automatically reflows existing windows without launching apps and brings back windows that a saved layout hid. Classic-preset choices are available when building templates in Studio.

In **Preferences → Back up and share**, export a `snaptess-layouts.json` file or import one. Import renames conflicting layouts with an “(imported)” suffix and keeps existing profiles for matching space keys. Profiles are tied to a GNOME workspace index, display connector and SnapTess space, so a profile copied to another computer applies only when those keys match. Named layouts can be restored on any display from Studio or the quick switcher. Import does not rearrange the desktop or launch applications.

Maximizing or fullscreening a managed window freezes automatic layout changes on that display. Restoring resumes tiling. Explicitly applying a layout can unmaximize windows; it never exits fullscreen. Applications can impose minimum client sizes, which GNOME still enforces. If a requested tile is smaller, SnapTess keeps the real client at an allowed size and uniformly scales its compositor actor into the slot, preventing overlap while preserving aspect ratio.

## Contributing

Report your GNOME version, app IDs, monitor resolutions/scales, and exact steps in [an issue](https://github.com/C0sm0cats/SnapTess/issues). Include whether the problem concerns Wayland or XWayland windows.

## Credits

Created by [C0sm0cats](https://github.com/C0sm0cats). MIT licensed; see [LICENSE](LICENSE).
