// Geometry is deliberately independent of GNOME, for reuse by future backends.
export const PRESETS = [
    ['auto', 'Auto'], ['full', 'Full'], ['split', 'Split'], ['master', 'Focus'],
    ['2x2', '2 × 2'], ['3x2', '3 × 2'], ['3x3', '3 × 3'], ['4x3', '4 × 3'],
    ['5x3', '5 × 3'], ['4x4', '4 × 4'], ['5x4', '5 × 4'], ['5x5', '5 × 5'],
];

export function autoLayout(count) {
    if (count <= 1) return 'full';
    if (count === 2) return 'split';
    if (count === 3) return 'master';
    if (count === 4) return '2x2';
    if (count <= 6) return '3x2';
    if (count <= 9) return '3x3';
    if (count <= 12) return '4x3';
    if (count <= 15) return '5x3';
    const cols = Math.ceil(Math.sqrt(count));
    return `${cols}x${Math.ceil(count / cols)}`;
}

export function capacity(preset) {
    if (preset === 'full') return 1;
    if (preset === 'split') return 2;
    if (preset === 'master') return 3;
    const m = /^(\d+)x(\d+)$/.exec(preset);
    return m ? Number(m[1]) * Number(m[2]) : 0;
}

export function sortedSavedLayouts(savedLayouts) {
    return savedLayouts.map((item, index) => ({item, index}))
        .sort((a, b) => b.item.slotCount - a.item.slotCount || a.index - b.index)
        .map(({item}) => item);
}

// Keep the client at or above its minimum geometry, then scale the compositor actor
// uniformly back into the requested slot. This preserves aspect ratio and prevents a
// constrained GTK/Wayland window from overlapping neighboring tiles.
export function fitMinimumSize(rect, minWidth = 0, minHeight = 0) {
    minWidth = Math.max(0, Number(minWidth) || 0);
    minHeight = Math.max(0, Number(minHeight) || 0);
    let scale = 1;
    if (minWidth > rect.width) scale = Math.min(scale, rect.width / minWidth);
    if (minHeight > rect.height) scale = Math.min(scale, rect.height / minHeight);
    if (scale >= 0.999) return {frame: {...rect}, scale: 1};
    scale = Math.max(0.05, scale);
    return {
        frame: {
            x: rect.x,
            y: rect.y,
            width: Math.ceil(rect.width / scale),
            height: Math.ceil(rect.height / scale),
        },
        scale,
    };
}

// MetaWindowActor transforms are relative to the compositor buffer, while tiling targets
// the user-visible frame. Anchor scaling at the frame's top-left inside that buffer so
// client-side shadows/invisible borders do not shift the visible window and its gaps.
export function frameScalePivot(frame, buffer, actorWidth = 0, actorHeight = 0) {
    const width = Math.max(1, Number(actorWidth) || Number(buffer?.width) || 1);
    const height = Math.max(1, Number(actorHeight) || Number(buffer?.height) || 1);
    return {
        x: ((Number(frame?.x) || 0) - (Number(buffer?.x) || 0)) / width,
        y: ((Number(frame?.y) || 0) - (Number(buffer?.y) || 0)) / height,
    };
}

export function layout(area, count, {preset = 'auto', gap = 12, padding = 12, ratio = 0.6} = {}) {
    if (count <= 0 || area.width <= 0 || area.height <= 0) return [];
    let kind = preset;
    if (kind === 'auto' || capacity(kind) < count) kind = autoLayout(count);
    padding = Math.max(0, Math.min(padding, Math.floor((Math.min(area.width, area.height) - 1) / 2)));
    const x = Math.round(area.x + padding), y = Math.round(area.y + padding);
    const w = Math.max(1, Math.floor(area.width - padding * 2));
    const h = Math.max(1, Math.floor(area.height - padding * 2));
    const rect = (rx, ry, rw, rh) => ({x: rx, y: ry, width: rw, height: rh});
    if (kind === 'full') return [rect(x, y, w, h)];
    if (kind === 'master') {
        gap = Math.max(0, Math.min(gap, w - 2, h - 2));
        const mw = Math.max(1, Math.min(w - gap - 1, Math.round((w - gap) * ratio)));
        const sh = Math.floor((h - gap) / 2);
        return [rect(x, y, mw, h), rect(x + mw + gap, y, w - mw - gap, sh),
            rect(x + mw + gap, y + sh + gap, w - mw - gap, h - sh - gap)].slice(0, count);
    }
    const [cols, rows] = kind === 'split' ? [2, 1] : kind.split('x').map(Number);
    gap = Math.max(0, Math.min(gap, Math.floor((w - cols) / Math.max(1, cols - 1)),
        Math.floor((h - rows) / Math.max(1, rows - 1))));
    const availableW = w - gap * (cols - 1), availableH = h - gap * (rows - 1);
    return Array.from({length: count}, (_, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const left = Math.floor(c * availableW / cols), top = Math.floor(r * availableH / rows);
        return rect(x + left + c * gap, y + top + r * gap,
            Math.max(1, Math.floor((c + 1) * availableW / cols) - left),
            Math.max(1, Math.floor((r + 1) * availableH / rows) - top));
    });
}

// Move one shared divider. When a tile reaches its minimum, pass the remaining
// movement to the next aligned band instead of snapping the dragged tile back.
// A corner resize can call this once for each axis.
export function resizeDivider(rects, index, edge, delta, minSize = 80, alignmentsLeft = 4) {
    if (!Number.isFinite(delta) || !rects[index] || !['E', 'W', 'N', 'S'].includes(edge)) return rects;
    const horizontal = edge === 'E' || edge === 'W';
    const low = edge === 'W' || edge === 'N';
    const start = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    const otherStart = horizontal ? 'y' : 'x', otherSize = horizontal ? 'height' : 'width';
    const selected = rects[index];
    const boundary = selected[start] + (low ? 0 : selected[size]);
    const overlaps = (a, b) => Math.min(a[otherStart] + a[otherSize], b[otherStart] + b[otherSize]) >
        Math.max(a[otherStart], b[otherStart]);
    const touches = (r, group) => group.some(item => overlaps(r, item.r));
    const candidates = rects.filter(r => r !== selected && overlaps(r, selected) &&
        (low ? r[start] + r[size] <= boundary : r[start] >= boundary));
    if (!candidates.length) return rects;
    const opposite = low ? Math.max(...candidates.map(r => r[start] + r[size])) :
        Math.min(...candidates.map(r => r[start]));
    const leftEdge = low ? opposite : boundary;
    const rightEdge = low ? boundary : opposite;
    const entries = rects.map((r, i) => ({r, i}));
    const atDivider = entries.filter(({r}) => r[start] + r[size] === leftEdge || r[start] === rightEdge);
    // Keep a single row/column local. Expand only when a window spans multiple
    // rows/columns, since its shared edge must stay straight on both sides.
    const connected = new Set([index]);
    let added;
    do {
        added = false;
        const group = atDivider.filter(({i}) => connected.has(i));
        for (const item of atDivider) if (!connected.has(item.i) && touches(item.r, group)) {
            connected.add(item.i); added = true;
        }
    } while (added);
    const left = atDivider.filter(({r, i}) => connected.has(i) && r[start] + r[size] === leftEdge);
    const right = atDivider.filter(({r, i}) => connected.has(i) && r[start] === rightEdge);
    if (!left.length || !right.length) return rects;
    const requested = Math.round(delta);
    if (!requested) return rects;
    const shrinkingRight = requested > 0;
    const selectedShrinks = low ? shrinkingRight : !shrinkingRight;
    let bands = [];
    let band = shrinkingRight ? right : left;
    const seen = new Set();
    while (band.length) {
        bands.push(band);
        // Pressure crosses more bands only while the grabbed tile grows. When
        // it shrinks, stop at its minimum instead of translating its far edge.
        if (selectedShrinks) break;
        for (const {i} of band) seen.add(i);
        const boundary = shrinkingRight ? band[0].r[start] + band[0].r[size] : band[0].r[start];
        const next = entries.filter(({r, i}) => !seen.has(i) && touches(r, band) &&
            (shrinkingRight ? r[start] >= boundary : r[start] + r[size] <= boundary));
        if (!next.length) break;
        const closest = shrinkingRight ? Math.min(...next.map(({r}) => r[start])) :
            Math.max(...next.map(({r}) => r[start] + r[size]));
        const anchor = next.find(({r}) => (shrinkingRight ? r[start] : r[start] + r[size]) === closest).r;
        band = entries.filter(({r, i}) => !seen.has(i) && r[start] === anchor[start] &&
            r[size] === anchor[size] && touches(r, bands.at(-1)));
    }
    // A shrinking tile may cover more of the perpendicular axis than the tile
    // growing into its space after a previous, differently oriented resize.
    // Stop pressure before that band instead of leaving its uncovered strip empty.
    const opensGap = (shrinking, growing) => {
        const ends = [...new Set([...shrinking, ...growing].flatMap(({r}) =>
            [r[otherStart], r[otherStart] + r[otherSize]]))].sort((a, b) => a - b);
        let uncovered = 0;
        for (let i = 0; i < ends.length - 1; i++) {
            const midpoint = (ends[i] + ends[i + 1]) / 2;
            const covers = group => group.some(({r}) =>
                r[otherStart] <= midpoint && midpoint < r[otherStart] + r[otherSize]);
            uncovered = covers(shrinking) && !covers(growing)
                ? uncovered + ends[i + 1] - ends[i] : 0;
            if (uncovered > rightEdge - leftEdge) return true;
        }
        return false;
    };
    const usableBands = [];
    let growing = shrinkingRight ? left : right;
    for (const group of bands) {
        if (opensGap(group, growing)) {
            if (!usableBands.length && alignmentsLeft > 0) {
                const low = Math.min(...group.map(({r}) => r[otherStart]));
                const growLow = Math.min(...growing.map(({r}) => r[otherStart]));
                const high = Math.max(...group.map(({r}) => r[otherStart] + r[otherSize]));
                const growHigh = Math.max(...growing.map(({r}) => r[otherStart] + r[otherSize]));
                const missingLow = growLow - low, missingHigh = high - growHigh;
                const towardsLow = missingLow > rightEdge - leftEdge;
                const missing = towardsLow ? missingLow : missingHigh;
                if (missing > rightEdge - leftEdge) {
                    const member = growing.find(({r}) => towardsLow
                        ? r[otherStart] === growLow : r[otherStart] + r[otherSize] === growHigh);
                    const otherEdge = horizontal ? (towardsLow ? 'N' : 'S') : (towardsLow ? 'W' : 'E');
                    const step = Math.min(Math.abs(requested), missing);
                    const aligned = resizeDivider(rects, member.i, otherEdge,
                        towardsLow ? -step : step, minSize, 0);
                    const before = towardsLow ? member.r[otherStart] : member.r[otherStart] + member.r[otherSize];
                    const afterRect = aligned[member.i];
                    const after = towardsLow ? afterRect[otherStart] : afterRect[otherStart] + afterRect[otherSize];
                    const consumed = Math.abs(after - before);
                    if (consumed) return consumed >= Math.abs(requested) ? aligned :
                        resizeDivider(aligned, index, edge,
                            Math.sign(requested) * (Math.abs(requested) - consumed), minSize, alignmentsLeft - 1);
                }
            }
            break;
        }
        usableBands.push(group);
        growing = group;
    }
    bands = usableBands;
    const capacity = band => Math.max(0, Math.min(...band.map(({r}) =>
        r[size] - Math.min(minSize, r[size]))));
    const maxAmount = Math.min(Math.abs(requested), bands.reduce((sum, group) => sum + capacity(group), 0));
    if (!maxAmount) return rects;
    const move = amount => {
        const result = rects.map(r => ({...r}));
        if (shrinkingRight) for (const {i} of left) result[i][size] += amount;
        else for (const {i} of right) { result[i][start] -= amount; result[i][size] += amount; }
        let remaining = amount;
        for (const group of bands) {
            const consumed = Math.min(remaining, capacity(group));
            const carried = remaining - consumed;
            for (const {i} of group) {
                if (shrinkingRight) result[i][start] += remaining;
                else result[i][start] -= carried;
                result[i][size] -= consumed;
            }
            remaining = carried;
        }
        return result;
    };
    // Earlier local resizes can create T-junctions. A window beyond the nearest
    // aligned band may then block movement without sharing that band's edge.
    const bounds = {
        left: Math.min(...rects.map(r => r.x)), top: Math.min(...rects.map(r => r.y)),
        right: Math.max(...rects.map(r => r.x + r.width)),
        bottom: Math.max(...rects.map(r => r.y + r.height)),
    };
    const clear = result => result.every((r, i) => r.x >= bounds.left && r.y >= bounds.top &&
        r.x + r.width <= bounds.right && r.y + r.height <= bounds.bottom &&
        result.every((other, j) => i === j ||
            r.x >= other.x + other.width || other.x >= r.x + r.width ||
            r.y >= other.y + other.height || other.y >= r.y + r.height));
    let amount = maxAmount;
    if (!clear(move(amount))) {
        let lo = 0, hi = amount;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (clear(move(mid))) lo = mid;
            else hi = mid - 1;
        }
        amount = lo;
    }
    return amount ? move(amount) : rects;
}

export function resizedLayout(base, area, saved) {
    if (!Array.isArray(saved?.offsets) || saved.offsets.length !== base.length) return base;
    const result = base.map((r, i) => {
        const values = saved.offsets[i];
        if (!Array.isArray(values) || values.length !== 4 || values.some(v => !Number.isFinite(v))) return null;
        return {x: r.x + Math.round(values[0] * area.width), y: r.y + Math.round(values[1] * area.height),
            width: r.width + Math.round(values[2] * area.width),
            height: r.height + Math.round(values[3] * area.height)};
    });
    if (result.some((r, i) => !r || r.width < Math.min(80, base[i].width) ||
        r.height < Math.min(80, base[i].height) || r.x < area.x || r.y < area.y ||
        r.x + r.width > area.x + area.width || r.y + r.height > area.y + area.height)) return base;
    // Scaling each saved offset independently can make formerly separate tiles
    // overlap after the work area's aspect ratio changes.
    if (result.some((r, i) => result.some((other, j) => i < j &&
        r.x < other.x + other.width && other.x < r.x + r.width &&
        r.y < other.y + other.height && other.y < r.y + r.height))) return base;
    return result;
}

export function resizeOffsets(base, resized, area) {
    return base.map((r, i) => [(resized[i].x - r.x) / area.width,
        (resized[i].y - r.y) / area.height, (resized[i].width - r.width) / area.width,
        (resized[i].height - r.height) / area.height]);
}

export function nearestSlot(rects, x, y) {
    let best = -1, distance = Infinity;
    rects.forEach((r, i) => {
        const d = (r.x + r.width / 2 - x) ** 2 + (r.y + r.height / 2 - y) ** 2;
        if (d < distance) { distance = d; best = i; }
    });
    return best;
}

export function directionalSlot(rects, index, direction) {
    const origin = rects[index];
    if (!origin) return -1;
    const horizontal = direction === 'left' || direction === 'right';
    const sign = direction === 'left' || direction === 'up' ? -1 : 1;
    let best = -1, score = Infinity;
    rects.forEach((r, i) => {
        if (i === index) return;
        const dx = r.x + r.width / 2 - origin.x - origin.width / 2;
        const dy = r.y + r.height / 2 - origin.y - origin.height / 2;
        const forward = (horizontal ? dx : dy) * sign;
        if (forward <= 1) return;
        const cost = forward + Math.abs(horizontal ? dy : dx) * 2;
        if (cost < score) { score = cost; best = i; }
    });
    return best;
}

// Only advertise a keyboard swap when its destination really shares a side
// with the source. Empty slots between windows are not neighboring targets.
export function swapNeighbor(rects, index, direction) {
    const target = directionalSlot(rects, index, direction);
    if (target < 0) return -1;
    const source = rects[index], other = rects[target];
    const horizontal = direction === 'left' || direction === 'right';
    const overlap = horizontal
        ? Math.min(source.y + source.height, other.y + other.height) - Math.max(source.y, other.y)
        : Math.min(source.x + source.width, other.x + other.width) - Math.max(source.x, other.x);
    if (overlap <= 0) return -1;
    const distance = rect => {
        if (direction === 'right') return rect.x - source.x - source.width;
        if (direction === 'left') return source.x - rect.x - rect.width;
        if (direction === 'down') return rect.y - source.y - source.height;
        return source.y - rect.y - rect.height;
    };
    const gap = distance(other);
    if (gap < 0) return -1;
    const blocked = rects.some((rect, i) => i !== index && i !== target &&
        distance(rect) >= 0 && distance(rect) < gap && (horizontal
            ? Math.min(source.y + source.height, rect.y + rect.height) > Math.max(source.y, rect.y)
            : Math.min(source.x + source.width, rect.x + rect.width) > Math.max(source.x, rect.x)));
    return blocked ? -1 : target;
}

// Preserve holes when compaction is disabled; fill them before growing the grid.
export function reconcileSlots(previous, windows, compact = true) {
    const wanted = new Set(windows);
    const slots = previous.map(w => wanted.has(w) ? w : null);
    const assigned = new Set(slots.filter(Boolean));
    for (const window of windows) {
        if (assigned.has(window)) continue;
        const hole = slots.indexOf(null);
        if (hole < 0) slots.push(window); else slots[hole] = window;
        assigned.add(window);
    }
    return compact ? slots.filter(Boolean) : slots;
}

export function activePinnedSlots(previous, windows, pinned, appId) {
    if (!previous || !Array.isArray(pinned)) return pinned;
    const correctlyPlaced = new Map();
    for (let i = 0; i < pinned.length; i++) {
        const id = pinned[i], atSlot = previous[i];
        if (id && atSlot && windows.includes(atSlot) && appId(atSlot) === id)
            correctlyPlaced.set(id, (correctlyPlaced.get(id) ?? 0) + 1);
    }
    return pinned.map((id, index) => {
        if (!id) return null;
        const atSlot = previous[index];
        if (atSlot && windows.includes(atSlot) && appId(atSlot) === id) return id;
        const liveCount = windows.filter(w => appId(w) === id).length;
        return liveCount > (correctlyPlaced.get(id) ?? 0) ? null : id;
    });
}

// A pinned app keeps its slot even while no matching window is open.
export function reserveAppSlots(slots, pinned, appId, compact = true) {
    if (!Array.isArray(pinned) || !pinned.some(Boolean)) return slots;
    const result = Array(Math.max(slots.length, pinned.length)).fill(null);
    const available = slots.filter(Boolean), used = new Set();
    for (let i = 0; i < pinned.length; i++) {
        if (!pinned[i]) continue;
        const match = (slots[i] && !used.has(slots[i]) && appId(slots[i]) === pinned[i] ? slots[i] : null) ??
            available.find(w => !used.has(w) && appId(w) === pinned[i]);
        if (match) { result[i] = match; used.add(match); }
    }
    if (compact) {
        const remaining = available.filter(w => !used.has(w));
        let next = 0;
        for (let i = 0; i < result.length && next < remaining.length; i++)
            if (!pinned[i]) result[i] = remaining[next++];
        while (next < remaining.length) result.push(remaining[next++]);
    } else {
        for (let i = 0; i < slots.length; i++) {
            const w = slots[i];
            if (w && !used.has(w) && !pinned[i]) { result[i] = w; used.add(w); }
        }
        for (const w of available) {
            if (used.has(w)) continue;
            let i = result.findIndex((item, index) => !item && !pinned[index]);
            if (i < 0) i = result.length;
            result[i] = w; used.add(w);
        }
    }
    if (compact)
        while (result.length && !result.at(-1) && !pinned[result.length - 1]) result.pop();
    return result;
}
