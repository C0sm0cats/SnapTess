# Contributing

Keep geometry code in `lib/layout.js` independent of Shell. New Shell signal handlers must be disconnected in `disable()`; timeout sources, modal grabs and actors must also be released. Never enable unsafe mode or modify another extension's settings.

Run `npm test`, `./scripts/build.sh`, and on GNOME 50 `./scripts/test-shell.sh`. For monitor/space changes, run the two-monitor command in the README. Do not claim additional Shell versions without testing their API and lifecycle. GNOME 50 uses `get_maximize_flags()` and no-argument `maximize()`/`unmaximize()`.

Preferences use GTK4/libadwaita; Shell UI uses St/Clutter. Do not import GTK in `extension.js`. Keep drafts reversible until Apply. Preserve SmartGrid attribution for derived layout logic.
