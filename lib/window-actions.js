// Per-application placement and color of the window action handle and palette.

export const ACTION_POSITIONS = Object.freeze(['left', 'right', 'top', 'bottom']);
export const REMOTE_HANDLE_COLOR = '#ed5b00';

const VERTICAL_HANDLE = Object.freeze({width: 28, height: 40});
const VERTICAL_PALETTE = Object.freeze({width: 44, height: 176});

export const normalizeAppId = value => typeof value === 'string'
    ? value.trim().replace(/\.desktop$/i, '').toLowerCase() : '';

// The value configured for the first matching identifier, or null.
export function appRuleValue(map, identifiers) {
    if (!map || typeof map !== 'object') return null;
    const wanted = new Set(identifiers.map(normalizeAppId).filter(Boolean));
    for (const [id, value] of Object.entries(map))
        if (wanted.has(normalizeAppId(id))) return value;
    return null;
}

export function validColor(value) {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

export function actionStyle(identifiers, positions, colors) {
    const position = appRuleValue(positions, identifiers);
    return {
        position: ACTION_POSITIONS.includes(position) ? position : 'left',
        color: validColor(appRuleValue(colors, identifiers)),
    };
}

export const horizontalActions = position => position === 'top' || position === 'bottom';

export function actionHandleSize(position) {
    return horizontalActions(position)
        ? {width: VERTICAL_HANDLE.height, height: VERTICAL_HANDLE.width} : {...VERTICAL_HANDLE};
}

export function actionPaletteSize(position) {
    return horizontalActions(position)
        ? {width: VERTICAL_PALETTE.height, height: VERTICAL_PALETTE.width} : {...VERTICAL_PALETTE};
}

export const actionHandleIcon = position => ({
    left: 'go-next-symbolic', right: 'go-previous-symbolic',
    top: 'go-down-symbolic', bottom: 'go-up-symbolic',
})[position] ?? 'go-next-symbolic';

// Offset the palette slides in from: toward the edge it is attached to.
export function actionSlide(position, distance = 8) {
    return {
        x: position === 'left' ? -distance : position === 'right' ? distance : 0,
        y: position === 'top' ? -distance : position === 'bottom' ? distance : 0,
    };
}

// Attach a control of `size` inside `rect` against the chosen edge, centered
// along it and kept within the monitor work `area`.
export function actionPlacement(position, rect, area, size) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    const centeredX = rect.x + (rect.width - size.width) / 2;
    const centeredY = rect.y + (rect.height - size.height) / 2;
    const x = position === 'right' ? rect.x + rect.width - size.width - 4
        : position === 'left' ? rect.x + 4 : centeredX;
    const y = position === 'bottom' ? rect.y + rect.height - size.height - 4
        : position === 'top' ? rect.y + 4 : centeredY;
    return {
        x: Math.round(clamp(x, area.x + 6, area.x + area.width - size.width - 6)),
        y: Math.round(clamp(y, area.y + 8, area.y + area.height - size.height - 8)),
    };
}

// Tooltip beside an action button, on the side away from the window edge.
export function actionTooltipPlacement(position, button, tooltip, area) {
    const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
    let x, y;
    if (horizontalActions(position)) {
        x = button.x + (button.width - tooltip.width) / 2;
        const below = button.y + button.height + 8, above = button.y - tooltip.height - 8;
        y = position === 'top'
            ? below + tooltip.height <= area.y + area.height - 6 ? below : above
            : above >= area.y + 6 ? above : below;
    } else {
        y = button.y + (button.height - tooltip.height) / 2;
        const right = button.x + button.width + 8, left = button.x - tooltip.width - 8;
        x = position === 'right'
            ? left >= area.x + 6 ? left : right
            : right + tooltip.width <= area.x + area.width - 6 ? right : left;
    }
    return {
        x: Math.round(clamp(x, area.x + 6, area.x + area.width - tooltip.width - 6)),
        y: Math.round(clamp(y, area.y + 6, area.y + area.height - tooltip.height - 6)),
    };
}

export function rgba(hex, alpha) {
    const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${rgb.join(',')},${alpha})`;
}

// Lighten toward white for a border that stays visible on dark colors.
export function lighten(hex, amount = 0.45) {
    return `#${[1, 3, 5].map(i => {
        const channel = parseInt(hex.slice(i, i + 2), 16);
        return Math.round(channel + (255 - channel) * amount).toString(16).padStart(2, '0');
    }).join('')}`;
}

export function actionHandleStyle(color) {
    return color ? `background-color: ${rgba(color, 0.96)}; border-color: ${lighten(color)};` : null;
}

export function actionPaletteStyle(color) {
    return color ? `border-color: ${color};` : null;
}
