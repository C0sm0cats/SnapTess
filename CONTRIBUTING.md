# Contributing

Keep geometry code in `lib/layout.js` independent of Shell. New Shell signal handlers must be disconnected in `disable()`; timeout sources, modal grabs and actors must also be released. Never enable unsafe mode or modify another extension's settings.

Run `npm test`, `./scripts/build.sh`, and on GNOME 50 or 51 `./scripts/test-shell.sh`. For monitor/space changes, run:

```bash
dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
  --wrap scripts/two-monitors.sh \
  --extension dist/snaptess@c0sm0cats.github.io.shell-extension.zip tests/shell.js
```

The Shell test runs on a private session bus; it does not load SnapTess into your current desktop. SnapTess supports GNOME Shell 50 and 51. CI pins the GitHub-hosted `ubuntu-26.04` preview image for its GNOME Shell 50 packages; `ubuntu-latest` does not guarantee this coverage. GNOME 50 and 51 use `get_maximize_flags()` and no-argument `maximize()`/`unmaximize()`.

For local development, run `./scripts/install.sh` from the checkout. It links the repository into the GNOME extensions directory. After source changes, run `./scripts/install.sh` again: it asks the running loader to reload `runtime.js`, `lib/` and `stylesheet.css` in place, without disabling SnapTess, so the extensions enabled after it keep running. When the loader itself changed (`LOADER_VERSION` in `extension.js`), the script asks for one logout/login instead. Do not use disable/enable: GNOME Shell then also restarts every extension enabled after SnapTess. Hot-reload snapshots live under `$XDG_RUNTIME_DIR/snaptess-hot-reload/` while enabled and are removed on disable.

Preferences use GTK4/libadwaita; Shell UI uses St/Clutter. Do not import GTK in `extension.js`. Keep drafts reversible until Apply. Preserve existing copyright notices for derived layout logic.
