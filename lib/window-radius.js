const ALPHA_THRESHOLD = 240;

// Read the left edge only, like Tiling Shell. Top and bottom are independent;
// the right corners mirror the corresponding left corners.
export function radiusFromPixels(pixels, rowstride, channels, width, height, hasAlpha = true) {
    if (!pixels || width < 1 || height < 2 || rowstride < width * channels || channels < 3) return null;
    if (!hasAlpha || channels < 4) return {top: 0, bottom: 0};
    const limit = Math.floor(height / 2);
    const opaque = (x, y) => pixels[y * rowstride + x * channels + 3] > ALPHA_THRESHOLD;
    let top = null, bottom = null;
    for (let i = 0; i <= limit; i++) {
        if (top === null && opaque(0, i)) top = i;
        if (bottom === null && opaque(0, height - 1 - i)) bottom = i;
        if (top !== null && bottom !== null) break;
    }
    // Some clients have a transparent strip along the lower left edge which
    // is not their corner. Confirm large vertical gaps against the horizontal
    // edge before treating them as a radius.
    if (width >= 8) {
        const horizontal = fromBottom => {
            for (let inset = 0; inset < Math.min(4, height); inset++) {
                const y = fromBottom ? height - 1 - inset : inset;
                for (let x = 0; x < width; x++) if (opaque(x, y)) return x;
            }
            return null;
        };
        const topEdge = horizontal(false), bottomEdge = horizontal(true);
        if (topEdge !== null) top = top === null ? topEdge : Math.min(top, topEdge);
        if (bottomEdge !== null) bottom = bottom === null ? bottomEdge : Math.min(bottom, bottomEdge);
    }
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
