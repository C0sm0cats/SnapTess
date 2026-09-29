const MIN_EDGE_ALPHA = 8;
const EDGE_ALPHA_FRACTION = 0.75;

// Read each side independently. Compare the corner with the straight edges
// nearby: client-side transparent strips can offset an edge without rounding it.
export function radiusFromPixels(pixels, rowstride, channels, width, height, hasAlpha = true, side = 'left') {
    if (!pixels || width < 1 || height < 2 || rowstride < width * channels || channels < 3) return null;
    if (!hasAlpha || channels < 4) return {top: 0, bottom: 0};
    const verticalLimit = Math.floor(height / 2) + 1;
    const horizontalLimit = Math.min(width, 64);
    const alpha = (x, y) => pixels[y * rowstride + x * channels + 3];
    const corner = fromBottom => {
        const sample = (x, y) => alpha(side === 'right' ? width - 1 - x : x,
            fromBottom ? height - 1 - y : y);
        let reference = 0;
        for (let y = 0; y < Math.min(verticalLimit, 64); y++)
            for (let x = 0; x < horizontalLimit; x++) reference = Math.max(reference, sample(x, y));
        for (let y = 64; y < verticalLimit; y++) reference = Math.max(reference, sample(0, y));
        if (reference < MIN_EDGE_ALPHA) return null;
        const threshold = reference * EDGE_ALPHA_FRACTION;
        const firstX = y => {
            for (let x = 0; x < horizontalLimit; x++) {
                if (sample(x, y) >= threshold) return x;
            }
            return null;
        };
        const firstY = x => {
            for (let y = 0; y < verticalLimit; y++) {
                if (sample(x, y) >= threshold) return y;
            }
            return null;
        };
        // At 32 px, a plausible rounded corner has reached its straight edge.
        // A persistent transparent strip still has an inset; subtract that
        // baseline instead of reporting the strip width as a corner radius.
        let sideInset = null;
        for (let y = Math.min(32, verticalLimit - 1); y < verticalLimit && sideInset === null; y++)
            sideInset = firstX(y);
        const topInset = horizontalLimit > 32 ? firstY(32) : 0;
        if (sideInset === null || topInset === null) return null;
        const horizontal = firstX(topInset);
        const vertical = firstY(sideInset);
        if (horizontal === null && vertical === null) return null;
        if (horizontal === null) return Math.max(0, vertical - topInset);
        if (vertical === null) return Math.max(0, horizontal - sideInset);
        return Math.max(0, Math.min(horizontal - sideInset, vertical - topInset));
    };
    const top = corner(false), bottom = corner(true);
    return top === null || bottom === null ? null : {top, bottom};
}

export function radiusStyle(radius, fallback, scale = 1) {
    const top = Math.max(0, Math.round((radius?.top ?? fallback) * scale));
    const bottom = Math.max(0, Math.round((radius?.bottom ?? fallback) * scale));
    return `${top}px ${top}px ${bottom}px ${bottom}px`;
}

// An unmeasurable corner must not inherit the shape of its opposite corner.
export function plausibleWindowRadius(radius, maximum = 32) {
    if (!radius) return null;
    const top = Number(radius.top), bottom = Number(radius.bottom);
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || top < 0 || bottom < 0) return null;
    if (top > maximum && bottom > maximum) return null;
    return {top: top > maximum ? 0 : top, bottom: bottom > maximum ? 0 : bottom};
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
