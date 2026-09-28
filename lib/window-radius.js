const MIN_EDGE_ALPHA = 8;
const EDGE_ALPHA_FRACTION = 0.75;

// Read each side independently. The threshold follows the window's own edge
// opacity so a translucent square window is not mistaken for a rounded one.
export function radiusFromPixels(pixels, rowstride, channels, width, height, hasAlpha = true, side = 'left') {
    if (!pixels || width < 1 || height < 2 || rowstride < width * channels || channels < 3) return null;
    if (!hasAlpha || channels < 4) return {top: 0, bottom: 0};
    const limit = Math.floor(height / 2);
    const edgeX = side === 'right' ? width - 1 : 0;
    const horizontalLimit = Math.min(width, 64);
    const alpha = (x, y) => pixels[y * rowstride + x * channels + 3];
    const corner = fromBottom => {
        let reference = 0;
        for (let i = 0; i <= limit; i++)
            reference = Math.max(reference, alpha(edgeX, fromBottom ? height - 1 - i : i));
        for (let inset = 0; inset < Math.min(4, height); inset++) {
            const y = fromBottom ? height - 1 - inset : inset;
            for (let x = 0; x < horizontalLimit; x++)
                reference = Math.max(reference, alpha(side === 'right' ? width - 1 - x : x, y));
        }
        if (reference < MIN_EDGE_ALPHA) return null;
        const threshold = reference * EDGE_ALPHA_FRACTION;
        let vertical = null, horizontal = null;
        for (let i = 0; i <= limit; i++) {
            if (alpha(edgeX, fromBottom ? height - 1 - i : i) >= threshold) {
                vertical = i;
                break;
            }
        }
        for (let inset = 0; inset < Math.min(4, height) && horizontal === null; inset++) {
            const y = fromBottom ? height - 1 - inset : inset;
            for (let x = 0; x < horizontalLimit; x++) {
                if (alpha(side === 'right' ? width - 1 - x : x, y) >= threshold) {
                    horizontal = x;
                    break;
                }
            }
        }
        if (vertical === null) return horizontal;
        if (horizontal === null) return vertical;
        return Math.min(vertical, horizontal);
    };
    const top = corner(false), bottom = corner(true);
    return top === null || bottom === null ? null : {top, bottom};
}

export function radiusStyle(radius, fallback, scale = 1) {
    const top = Math.max(0, Math.round((radius?.top ?? fallback) * scale));
    const bottom = Math.max(0, Math.round((radius?.bottom ?? fallback) * scale));
    return `${top}px ${top}px ${bottom}px ${bottom}px`;
}

// A transparent client-side area can make an edge scan look like an enormous
// rounded corner. Keep plausible independent corners and use the opposite edge
// when only one reading is implausible.
export function plausibleWindowRadius(radius, maximum = 32) {
    if (!radius) return null;
    const top = Number(radius.top), bottom = Number(radius.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom < 0) return null;
    if (top > maximum && bottom > maximum) return null;
    if (top > maximum) return {top: bottom, bottom};
    if (bottom > maximum) return {top, bottom: top};
    return {top, bottom};
}

// Clutter scales around the actor pivot, which is relative to its buffer rather
// than the visible frame. Transform the frame itself before drawing an outline.
export function visualFrameRect(frame, actor) {
    if (!actor) return {...frame};
    const sx = actor.scaleX ?? 1, sy = actor.scaleY ?? 1;
    const ax = actor.x ?? frame.x, ay = actor.y ?? frame.y;
    const px = actor.pivotX ?? 0, py = actor.pivotY ?? 0;
    return {
        x: ax + (frame.x - ax) * sx + (1 - sx) * px * (actor.width ?? frame.width) + (actor.translationX ?? 0),
        y: ay + (frame.y - ay) * sy + (1 - sy) * py * (actor.height ?? frame.height) + (actor.translationY ?? 0),
        width: frame.width * sx,
        height: frame.height * sy,
    };
}
