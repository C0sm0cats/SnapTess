import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';

function rgb(hex) {
    const value = /^#([0-9a-f]{6})$/i.exec(hex)?.[1] ?? '8ce8c3';
    return [0, 2, 4].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
}

export const WindowBorder = GObject.registerClass({GTypeName: `SnapTessWindowBorder${GLib.get_monotonic_time()}`},
class WindowBorder extends St.DrawingArea {
    constructor() {
        super({style_class: 'snaptess-border', reactive: false, visible: false});
        this.strokeWidth = 2;
        this.topRadius = 12;
        this.bottomRadius = 12;
        this.strokeColor = '#8ce8c3';
    }

    setOutline(color, radius, scale = 1) {
        const top = Math.max(0, (radius?.top ?? 12) * scale);
        const bottom = Math.max(0, (radius?.bottom ?? 12) * scale);
        if (this.strokeColor === color && this.topRadius === top && this.bottomRadius === bottom) return;
        this.strokeColor = color;
        this.topRadius = top;
        this.bottomRadius = bottom;
        this.queue_repaint();
    }

    setFrame(rect, monitorScale = 1) {
        const scale = Math.max(1, monitorScale);
        const oldWidth = this.strokeWidth;
        this.strokeWidth = 2 * scale;
        const bw = this.strokeWidth;
        const x = Math.round(rect.x - bw), y = Math.round(rect.y - bw);
        const width = Math.max(1, Math.round(rect.width + 2 * bw));
        const height = Math.max(1, Math.round(rect.height + 2 * bw));
        if (this.x !== x || this.y !== y) this.set_position(x, y);
        const resized = this.width !== width || this.height !== height;
        if (resized) this.set_size(width, height);
        this.show();
        if (resized || oldWidth !== bw) this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        // A resize can repaint once with the previous surface at the new
        // position; avoid flashing a short stroke before allocation catches up.
        const surfaceScale = width / Math.max(1, this.width);
        const bw = this.strokeWidth * surfaceScale;
        if (width <= bw || height <= bw || surfaceScale < 0.9 ||
            Math.abs(height / Math.max(1, this.height) - surfaceScale) > 0.05) {
            cr.$dispose?.();
            return;
        }
        const left = bw / 2, top = bw / 2;
        const right = width - bw / 2, bottom = height - bw / 2;
        const maxRadius = Math.max(0, Math.min((right - left) / 2, (bottom - top) / 2));
        const rt = Math.min(maxRadius, this.topRadius * surfaceScale + (this.topRadius ? bw : 0));
        const rb = Math.min(maxRadius, this.bottomRadius * surfaceScale + (this.bottomRadius ? bw : 0));
        const [red, green, blue] = rgb(this.strokeColor);
        cr.setSourceRGBA(red, green, blue, 1);
        cr.setLineWidth(bw);
        cr.newPath();
        cr.moveTo(left, top + rt);
        if (rt) cr.arc(left + rt, top + rt, rt, Math.PI, Math.PI * 1.5);
        else cr.lineTo(left, top);
        cr.lineTo(right - rt, top);
        if (rt) cr.arc(right - rt, top + rt, rt, Math.PI * 1.5, 0);
        cr.lineTo(right, bottom - rb);
        if (rb) cr.arc(right - rb, bottom - rb, rb, 0, Math.PI * 0.5);
        else cr.lineTo(right, bottom);
        cr.lineTo(left + rb, bottom);
        if (rb) cr.arc(left + rb, bottom - rb, rb, Math.PI * 0.5, Math.PI);
        cr.closePath();
        cr.stroke();
        cr.$dispose?.();
    }
});
