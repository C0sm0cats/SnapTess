// What the preferences show about the version that actually runs. `status` is
// $XDG_RUNTIME_DIR/snaptess/runtime-status.json (null when missing); the disk
// values come from package.json and extension.js in the extension directory.
export function versionNotice(diskVersion, diskLoader, status, hasInstallScript = true) {
    const installed = `v${diskVersion}`;
    if (!status) return {version: diskVersion, notice: 'SnapTess is not running.'};
    if (status.error) return {version: diskVersion, notice: `SnapTess failed to load: ${status.error}`};
    if (!status.release_version)
        return {version: diskVersion, notice: `${installed} is installed but an older version is running. Log out and back in to activate it.`};
    if (status.release_version === diskVersion) return {version: diskVersion, notice: ''};
    if (status.loader_version !== undefined && status.loader_version !== null && status.loader_version === diskLoader)
        return {version: status.release_version, notice: hasInstallScript
            ? `${installed} is installed. Run ./scripts/install.sh or log out and back in to activate it.`
            : `${installed} is installed. Log out and back in to activate it.`};
    return {version: status.release_version, notice: `${installed} is installed. Log out and back in to activate it.`};
}

export function loaderVersionFromSource(source) {
    const match = /^export const LOADER_VERSION = (\d+);$/m.exec(source ?? '');
    return match ? Number(match[1]) : null;
}
