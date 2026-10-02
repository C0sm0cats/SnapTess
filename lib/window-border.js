import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

function rgb(hex) {
    const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '3584e4';
    return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
}

export const WindowBorder = GObject.registerClass({GTypeName: `SnapTessWindowBorder${GLib.get_monotonic_time()}`},
class WindowBorder extends St.DrawingArea {
    constructor() {
        super({style_class: 'snaptess-border', reactive: false, visible: false});
        this.strokeWidth = 2;
        this.bandWidth = 0;
        this.haloWidth = 0;
        this.topRadius = 0;
        this.bottomRadius = 0;
        this.topRightRadius = 0;
        this.bottomRightRadius = 0;
        this.strokeColor = '#3584e4';
    }

    setOutline(color, radius, scale = 1) {
        const top = Math.max(0, (radius?.top ?? 0) * scale);
        const bottom = Math.max(0, (radius?.bottom ?? 0) * scale);
        const topRight = Math.max(0, (radius?.topRight ?? radius?.top ?? 0) * scale);
        const bottomRight = Math.max(0, (radius?.bottomRight ?? radius?.bottom ?? 0) * scale);
        if (this.strokeColor === color && this.topRadius === top && this.bottomRadius === bottom &&
            this.topRightRadius === topRight && this.bottomRightRadius === bottomRight) return;
        this.strokeColor = color;
        this.topRadius = top;
        this.bottomRadius = bottom;
        this.topRightRadius = topRight;
        this.bottomRightRadius = bottomRight;
        this.queue_repaint();
    }

    setFrame(rect, monitorScale = 1, emphasized = false, {width: thickness = 2, style = 'outline'} = {}) {
        const scale = Math.max(1, monitorScale);
        const oldWidth = this.strokeWidth, oldBandWidth = this.bandWidth, oldHalo = this.haloWidth;
        thickness = Math.max(1, Math.min(6, thickness));
        this.strokeWidth = (emphasized ? Math.max(3, thickness + 1) : thickness) * scale;
        this.haloWidth = style === 'halo' ? 5 * scale : 0;
        this.bandWidth = emphasized ? 4 * scale : 0;
        const outset = this.strokeWidth + this.bandWidth + this.haloWidth;
        const x = Math.round(rect.x - outset), y = Math.round(rect.y - outset);
        const width = Math.max(1, Math.round(rect.width + 2 * outset));
        const height = Math.max(1, Math.round(rect.height + 2 * outset));
        if (this.x !== x || this.y !== y) this.set_position(x, y);
        const resized = this.width !== width || this.height !== height;
        if (resized) this.set_size(width, height);
        this.show();
        if (resized || oldWidth !== this.strokeWidth || oldBandWidth !== this.bandWidth || oldHalo !== this.haloWidth)
            this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        // A resize can repaint once with the previous surface at the new
        // position; avoid flashing a short stroke before allocation catches up.
        const surfaceScale = width / Math.max(1, this.width);
        const bw = this.strokeWidth * surfaceScale;
        const band = this.bandWidth * surfaceScale;
        const halo = this.haloWidth * surfaceScale;
        const outset = bw + band + halo;
        if (width <= outset || height <= outset || surfaceScale < 0.9 ||
            Math.abs(height / Math.max(1, this.height) - surfaceScale) > 0.05) {
            cr.$dispose?.();
            return;
        }
        const [red, green, blue] = rgb(this.strokeColor);
        const crispCenter = halo + band + bw / 2;
        const stroke = (center, lineWidth, alpha) => {
            const left = center, top = center;
            const right = width - center, bottom = height - center;
            const maxRadius = Math.max(0, Math.min((right - left) / 2, (bottom - top) / 2));
            const radius = value => Math.min(maxRadius, value * surfaceScale +
                (value ? bw + crispCenter - center : 0));
            const topLeft = radius(this.topRadius), bottomLeft = radius(this.bottomRadius);
            const topRight = radius(this.topRightRadius), bottomRight = radius(this.bottomRightRadius);
            cr.setSourceRGBA(red, green, blue, alpha);
            cr.setLineWidth(lineWidth);
            cr.newPath();
            cr.moveTo(left, top + topLeft);
            if (topLeft) cr.arc(left + topLeft, top + topLeft, topLeft, Math.PI, Math.PI * 1.5);
            else cr.lineTo(left, top);
            cr.lineTo(right - topRight, top);
            if (topRight) cr.arc(right - topRight, top + topRight, topRight, Math.PI * 1.5, 0);
            cr.lineTo(right, bottom - bottomRight);
            if (bottomRight) cr.arc(right - bottomRight, bottom - bottomRight, bottomRight, 0, Math.PI * 0.5);
            else cr.lineTo(right, bottom);
            cr.lineTo(left + bottomLeft, bottom);
            if (bottomLeft) cr.arc(left + bottomLeft, bottom - bottomLeft, bottomLeft, Math.PI * 0.5, Math.PI);
            cr.closePath();
            cr.stroke();
        };
        if (halo) {
            const step = halo / 5;
            for (let i = 0; i < 5; i++)
                stroke(halo - (i + 0.5) * step, step, 0.22 * (1 - i / 5) ** 2);
        }
        if (band) stroke(halo + band / 2, band, 0.3);
        stroke(crispCenter, bw, 1);
        cr.$dispose?.();
    }
});
