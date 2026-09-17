# Contributing

Keep geometry code in `lib/layout.js` independent of Shell. New Shell signal handlers must be disconnected in `disable()`; timeout sources, modal grabs and actors must also be released. Never enable unsafe mode or modify another extension's settings.

Run `npm test`, `./scripts/build.sh`, and on GNOME 50 `./scripts/test-shell.sh`. For monitor/space changes, run:

```bash
dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
  --wrap scripts/two-monitors.sh \
  --extension dist/snaptess@c0sm0cats.github.io.shell-extension.zip tests/shell.js
```

The Shell test runs on a private session bus; it does not load SnapTess into your current desktop. Do not claim additional Shell versions without testing their API and lifecycle. GNOME 50 uses `get_maximize_flags()` and no-argument `maximize()`/`unmaximize()`.

For local development, run `./scripts/install.sh` from the checkout. It links the repository into the GNOME extensions directory. After source changes, disable and re-enable SnapTess to hot-reload `runtime.js` and `lib/`; an older installation may need one logout/login to activate the loader. Hot-reload snapshots live under `$XDG_RUNTIME_DIR/snaptess-hot-reload/` while enabled and are removed on disable.

Preferences use GTK4/libadwaita; Shell UI uses St/Clutter. Do not import GTK in `extension.js`. Keep drafts reversible until Apply. Preserve existing copyright notices for derived layout logic.
