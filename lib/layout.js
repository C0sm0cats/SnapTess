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

// The gutter belongs to the shared boundary. Include it when finding contacts:
// using only client rectangles misses neighbors at staggered T-junctions.
function resizeGap(rects) {
    let gap = Infinity;
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        for (const [start, size, other, extent] of [
            ['x', 'width', 'y', 'height'], ['y', 'height', 'x', 'width'],
        ]) {
            if (Math.min(a[other] + a[extent], b[other] + b[extent]) <= Math.max(a[other], b[other])) continue;
            const distance = Math.max(a[start], b[start]) - Math.min(a[start] + a[size], b[start] + b[size]);
            if (distance >= 0) gap = Math.min(gap, distance);
        }
    }
    return Number.isFinite(gap) ? gap : 0;
}

// One node per connected shared border, with minimum-width/height constraints
// between nodes. Pressure follows these constraints through every affected tile;
// neither the perpendicular axis nor the grabbed tile's opposite edge moves.
function resizePlan(rects, index, edge, minSize = 80, gap = resizeGap(rects)) {
    const horizontal = edge === 'E' || edge === 'W', low = edge === 'W' || edge === 'N';
    const start = horizontal ? 'x' : 'y', size = horizontal ? 'width' : 'height';
    const other = horizontal ? 'y' : 'x', extent = horizontal ? 'height' : 'width';
    const parents = Array.from({length: rects.length * 2}, (_, i) => i);
    const root = i => parents[i] === i ? i : (parents[i] = root(parents[i]));
    const overlaps = (a, b) => Math.min(a[other] + a[extent] + gap, b[other] + b[extent] + gap) >
        Math.max(a[other], b[other]);
    for (let i = 0; i < rects.length; i++) for (let j = 0; j < rects.length; j++) {
        if (i !== j && rects[i][start] + rects[i][size] + gap === rects[j][start] &&
            overlaps(rects[i], rects[j])) parents[root(i * 2 + 1)] = root(j * 2);
    }
    const nodes = new Map();
    for (let i = 0; i < parents.length; i++) {
        const id = root(i), side = i % 2, r = rects[Math.floor(i / 2)];
        if (!nodes.has(id)) nodes.set(id, {id, sides: 0, forward: [], backward: [],
            position: r[start] + (side ? r[size] + gap : 0)});
        nodes.get(id).sides |= side ? 2 : 1;
    }
    const borders = rects.map((_, i) => [nodes.get(root(i * 2)), nodes.get(root(i * 2 + 1))]);
    const link = (left, right, capacity) => {
        if (left === right) return;
        left.forward.push({to: right, capacity});
        right.backward.push({to: left, capacity});
    };
    borders.forEach(([left, right], i) => link(left, right, Math.max(0, rects[i][size] - minSize)));
    // Also preserve clearance around pre-existing vacant areas or incomplete rows.
    for (let i = 0; i < rects.length; i++) for (let j = 0; j < rects.length; j++) {
        const distance = rects[j][start] - rects[i][start] - rects[i][size] - gap;
        if (i !== j && distance >= 0 && overlaps(rects[i], rects[j]))
            link(borders[i][1], borders[j][0], distance);
    }
    const ordered = [...nodes.values()].sort((a, b) => a.position - b.position);
    const target = borders[index][low ? 0 : 1], opposite = borders[index][low ? 1 : 0];
    return delta => {
        if (!Number.isFinite(delta) || !Math.round(delta)) return rects;
        const sign = Math.sign(delta), requested = Math.abs(Math.round(delta));
        const downstream = sign > 0 ? ordered : [...ordered].reverse();
        const links = sign > 0 ? 'forward' : 'backward';
        for (let i = downstream.length - 1; i >= 0; i--) {
            const node = downstream[i];
            node.move = 0;
            node.limit = node.sides !== 3 || node === opposite ? 0 : Infinity;
            for (const {to, capacity} of node[links]) node.limit = Math.min(node.limit, capacity + to.limit);
        }
        target.move = Math.min(requested, target.limit);
        if (!target.move) return rects;
        for (const node of downstream) for (const {to, capacity} of node[links])
            to.move = Math.max(to.move, node.move - capacity);
        return rects.map((r, i) => {
            const a = sign * borders[i][0].move, b = sign * borders[i][1].move;
            return {...r, [start]: r[start] + a, [size]: r[size] + b - a};
        });
    };
}

export function resizeDivider(rects, index, edge, delta, minSize = 80) {
    if (!rects[index] || !['E', 'W', 'N', 'S'].includes(edge)) return rects;
    return resizePlan(rects, index, edge, minSize)(delta);
}

function cornerStep(rects, grab, horizontal, vertical, dx, dy, limit) {
    const move = values => resizePlan(resizePlan(values, grab.index, horizontal, 80, grab.gap)(dx),
        grab.index, vertical, 80, grab.gap)(dy);
    const first = move(rects);
    const keys = ['x', 'y', 'width', 'height'];
    const velocity = first.map((r, i) => Object.fromEntries(keys.map(key => [key, r[key] - rects[i][key]])));
    if (limit === 1) return {rects: first, amount: 1};
    const second = move(first);
    if (second.some((r, i) => keys.some(key => r[key] - first[i][key] !== velocity[i][key])))
        return {rects: first, amount: 1};
    let amount = limit;
    // Stop at a minimum or just before a border crossing. Between these events
    // the contact graph is unchanged and every border has a constant velocity.
    for (const [start, size] of [['x', 'width'], ['y', 'height']]) {
        const borders = [];
        rects.forEach((r, i) => {
            const v = velocity[i];
            if (v[size] < 0) amount = Math.min(amount, Math.floor((r[size] - Math.min(80, r[size])) / -v[size]));
            borders.push({p: r[start], v: v[start]},
                {p: r[start] + r[size] + grab.gap, v: v[start] + v[size]});
        });
        for (const a of borders) for (const b of borders) {
            if (a.p < b.p && a.v > b.v) amount = Math.min(amount, Math.ceil((b.p - a.p) / (a.v - b.v)) - 1);
        }
    }
    amount = Math.max(1, amount);
    return {amount, rects: rects.map((r, i) => Object.fromEntries(keys.map(key =>
        [key, r[key] + velocity[i][key] * amount])))};
}

export function advanceLinkedResize(grab, pointer) {
    const horizontal = grab.edges.find(edge => edge === 'E' || edge === 'W');
    const vertical = grab.edges.find(edge => edge === 'N' || edge === 'S');
    grab.gap ??= resizeGap(grab.rects);
    if (!horizontal || !vertical) {
        const axis = horizontal ? 0 : 1;
        grab.plan ??= resizePlan(grab.rects, grab.index, horizontal ?? vertical, 80, grab.gap);
        return grab.plan(pointer[axis] - grab.pointer[axis]);
    }
    const [targetX, targetY] = pointer.map(Math.round);
    grab.steps ??= [{x: Math.round(grab.pointer[0]), y: Math.round(grab.pointer[1]), rects: grab.rects}];
    while (grab.steps.at(-1).x !== targetX || grab.steps.at(-1).y !== targetY) {
        const current = grab.steps.at(-1), previous = grab.steps.at(-2);
        if (previous) {
            const axes = ['x', 'y'].filter(axis => current[axis] !== previous[axis]);
            const target = {x: targetX, y: targetY};
            if (axes.every(axis => (previous[axis] - current[axis]) * (target[axis] - current[axis]) > 0)) {
                const length = Math.max(...axes.map(axis => Math.abs(current[axis] - previous[axis])));
                const undo = Math.min(length, ...axes.map(axis => Math.abs(target[axis] - current[axis])));
                if (undo === length) { grab.steps.pop(); continue; }
                if (axes.length === 2) {
                    current.rects = current.rects.map((r, i) => Object.fromEntries(
                        ['x', 'y', 'width', 'height'].map(key =>
                            [key, Math.round(previous.rects[i][key] + (r[key] - previous.rects[i][key]) * (length - undo) / length)])));
                } else {
                    const axis = axes[0], edge = axis === 'x' ? horizontal : vertical;
                    current.rects = resizePlan(previous.rects, grab.index, edge, 80, grab.gap)(
                        Math.sign(current[axis] - previous[axis]) * (length - undo));
                }
                for (const axis of axes) current[axis] += Math.sign(previous[axis] - current[axis]) * undo;
                continue;
            }
        }
        const dx = targetX - current.x, dy = targetY - current.y;
        let x, y, rects;
        if (Math.abs(dx) === Math.abs(dy)) {
            const step = cornerStep(current.rects, grab, horizontal, vertical, Math.sign(dx), Math.sign(dy), Math.abs(dx));
            x = current.x + Math.sign(dx) * step.amount;
            y = current.y + Math.sign(dy) * step.amount;
            rects = step.rects;
        } else {
            const moveX = Math.abs(dx) > Math.abs(dy);
            const amount = Math.abs(Math.abs(dx) - Math.abs(dy));
            x = current.x + (moveX ? Math.sign(dx) * amount : 0);
            y = current.y + (moveX ? 0 : Math.sign(dy) * amount);
            rects = resizePlan(current.rects, grab.index, moveX ? horizontal : vertical, 80, grab.gap)(
                moveX ? x - current.x : y - current.y);
        }
        const linear = Math.abs(dx) === Math.abs(dy);
        const length = x - current.x, oldLength = previous ? current.x - previous.x : 0;
        const sameRun = linear && current.linear && length * oldLength > 0 &&
            (y - current.y) * (current.y - previous.y) > 0 &&
            rects.every((r, i) => ['x', 'y', 'width', 'height'].every(key =>
                (r[key] - current.rects[i][key]) * oldLength ===
                (current.rects[i][key] - previous.rects[i][key]) * length));
        if (sameRun) grab.steps.pop();
        grab.steps.push({x, y, rects, linear});
    }
    return grab.steps.at(-1).rects;
}

export function resizedLayout(base, area, saved) {
    if (!Array.isArray(saved?.offsets) || saved.offsets.length !== base.length) return base;
    const result = base.map((r, i) => {
        const values = saved.offsets[i];
        if (!Array.isArray(values) || values.length !== 4 || values.some(v => !Number.isFinite(v))) return null;
        const x = r.x + Math.round(values[0] * area.width);
        const y = r.y + Math.round(values[1] * area.height);
        return {x, y,
            width: r.x + r.width + Math.round((values[0] + values[2]) * area.width) - x,
            height: r.y + r.height + Math.round((values[1] + values[3]) * area.height) - y};
    });
    if (result.some((r, i) => !r || r.width < Math.min(80, base[i].width) ||
        r.height < Math.min(80, base[i].height) || r.x < area.x || r.y < area.y ||
        r.x + r.width > area.x + area.width || r.y + r.height > area.y + area.height)) return base;
    const gap = resizeGap(base);
    // Shared edges are rounded once, not as independent position/size values.
    // Reject old corrupted layouts too: no overlaps alone does not exclude holes.
    if (result.some((r, i) => result.some((other, j) => i < j &&
        r.x < other.x + other.width + gap && other.x < r.x + r.width + gap &&
        r.y < other.y + other.height + gap && other.y < r.y + r.height + gap))) return base;
    const covered = rects => rects.reduce((sum, r) => sum + (r.width + gap) * (r.height + gap), 0);
    if (covered(result) !== covered(base)) return base;
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
