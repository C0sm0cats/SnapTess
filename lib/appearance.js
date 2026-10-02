// Shared by Shell and GTK preferences; no GNOME imports.
export function paddingOptions(settings, scale = 1) {
    if (!settings.get_boolean('independent-padding')) return settings.get_int('padding') * scale;
    return Object.fromEntries(['top', 'right', 'bottom', 'left'].map(edge =>
        [edge, settings.get_int(`padding-${edge}`) * scale]));
}

export function animationDuration(settings, base = 140) {
    const speed = settings.get_string('animation-speed');
    const duration = speed === 'custom' ? Math.max(40, Math.min(500, settings.get_int('animation-duration')))
        : ({fast: 80, normal: 140, slow: 250}[speed] ?? 140);
    return Math.round(base * duration / 140);
}

export function borderOptions(settings, accent) {
    const color = settings.get_string('border-color');
    return {
        color: settings.get_boolean('border-custom-color') && /^#[0-9a-f]{6}$/i.test(color) ? color : accent,
        width: Math.max(1, Math.min(6, settings.get_int('border-width'))),
        style: settings.get_string('border-style') === 'halo' ? 'halo' : 'outline',
    };
}
