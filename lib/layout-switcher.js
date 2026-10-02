import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {layout, PRESETS, capacity, sortedSavedLayouts} from './layout.js';

const PREVIEW = {width: 84, height: 54};

function summary(parts) {
    return parts.filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`).join('  ·  ') ||
        'No windows to open or hide';
}

export class LayoutSwitcher {
    constructor(extension, monitor, space) {
        this.extension = extension;
        this.monitor = monitor;
        this.space = space;
        this.rows = [];
        this.dialog = new ModalDialog.ModalDialog({styleClass: 'snaptess-layout-switcher'});
        const screen = Main.layoutManager.monitors[monitor];
        this.width = Math.min(560, Math.floor(screen.width * 0.9));
        this.dialog.contentLayout.set_width(this.width);
        const header = new St.BoxLayout({style_class: 'snaptess-quick-header'});
        const titles = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        titles.add_child(new St.Label({text: 'SNAPTESS', style_class: 'snaptess-quick-eyebrow'}));
        titles.add_child(new St.Label({text: 'Change layout', style_class: 'snaptess-quick-title'}));
        titles.add_child(new St.Label({text: `Display ${monitor + 1}  ·  Space ${space + 1}`,
            style_class: 'snaptess-quick-context'}));
        header.add_child(titles);
        header.add_child(new St.Icon({gicon: extension.icon, icon_size: 30,
            style_class: 'snaptess-quick-brand'}));
        this.dialog.contentLayout.add_child(header);

        this.autoRow = this.addPreset('auto', 'Arrange open windows', this.dialog.contentLayout);
        this.autoRow.add_style_class_name('snaptess-quick-primary');

        this.scroll = new St.ScrollView({style_class: 'snaptess-quick-scroll',
            reactive: true, hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC});
        this.list = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-quick-list'});
        this.scroll.set_child(this.list);
        this.dialog.contentLayout.add_child(this.scroll);

        this.savedSectionCount = 0;
        if (!extension.savedLayouts.length) {
            this.list.add_child(new St.Label({text: 'SAVED LAYOUTS', style_class: 'snaptess-quick-section'}));
            this.savedSectionCount = 1;
            this.list.add_child(new St.Label({text: 'Create a layout in Studio to see it here.',
                style_class: 'snaptess-quick-empty'}));
        }
        const savedLayouts = sortedSavedLayouts(extension.savedLayouts);
        for (const [title, custom] of [['CUSTOM LAYOUTS', true], ['PRESET LAYOUTS', false]]) {
            const items = savedLayouts.filter(saved => (saved.preset === 'custom') === custom);
            if (!items.length) continue;
            this.list.add_child(new St.Label({text: title, style_class: 'snaptess-quick-section'}));
            this.savedSectionCount++;
            for (const saved of items) this.addSaved(saved);
        }

        const compatible = PRESETS.filter(([id]) => id !== 'auto' &&
            extension.quickPresetPlan(monitor, space, id));
        const hidden = PRESETS.length - 1 - compatible.length;
        this.presetToggle = new St.Button({label: `Other compatible presets (${compatible.length})  ▾`,
            style_class: 'snaptess-quick-expand', reactive: true, can_focus: true});
        this.presetToggle.visible = compatible.length > 0;
        this.list.add_child(this.presetToggle);
        if (hidden) {
            const required = extension.quickPresetPlan(monitor, space, 'auto').windows.length;
            this.hiddenPresetNote = new St.Label({text: `${hidden} presets hidden · this space needs ${required} tiles`,
                style_class: 'snaptess-quick-hidden-note'});
            this.list.add_child(this.hiddenPresetNote);
        }
        this.presetList = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'snaptess-quick-presets', visible: false});
        this.list.add_child(this.presetList);
        for (const [id, name] of compatible) this.addPreset(id, name, this.presetList);
        this.presetToggle.connect('clicked', () => {
            this.presetList.visible = !this.presetList.visible;
            this.presetToggle.label = `Other compatible presets (${compatible.length})  ${
                this.presetList.visible ? '▴' : '▾'}`;
            this.resizeList();
        });
        this.presetToggle.connect('key-press-event', (_actor, event) => this.navigate(event, this.presetToggle));
        this.dialog.setButtons([{label: 'Cancel', key: Clutter.KEY_Escape,
            action: () => this.dialog.close()}]);
        this.resizeList();
    }

    resizeList() {
        const screen = Main.layoutManager.monitors[this.monitor];
        const contentHeight = 56 + (this.savedSectionCount - 1) * 30 + this.extension.savedLayouts.length * 78 +
            (this.extension.savedLayouts.length ? 0 : 30) + 40 +
            (this.hiddenPresetNote ? 28 : 0) +
            (this.presetList.visible ? this.presetList.get_n_children() * 78 : 0);
        this.scroll.set_height(Math.min(440, Math.floor(screen.height * 0.56), contentHeight));
    }

    preview(preset, count, apps = [], pinned = [], tiles) {
        const preview = new St.Widget({style_class: 'snaptess-quick-preview',
            layout_manager: new Clutter.FixedLayout(), ...PREVIEW});
        const rects = layout({x: 0, y: 0, ...PREVIEW}, Math.max(1, count),
            {preset, tiles, gap: 2, padding: 3, ratio: this.extension.settings.get_double('master-ratio')});
        rects.forEach((rect, index) => {
            const cell = new St.Widget({style_class: `snaptess-quick-cell${apps[index] ? ' filled' : ''}${
                pinned[index] ? ' pinned' : ''}`});
            cell.set_position(rect.x, rect.y); cell.set_size(rect.width, rect.height);
            preview.add_child(cell);
        });
        return preview;
    }

    addRow({name, meta, count = null, detail, preview, active = false, enabled = true, action}, parent = this.list) {
        const row = new St.Button({style_class: `snaptess-quick-row${active ? ' active' : ''}${
            enabled ? '' : ' unavailable'}`, reactive: enabled, can_focus: enabled});
        row.accessible_name = `${name}. ${count === null ? '' : `${count} tiles. `}${meta}. ${detail}${
            active ? '. Current layout' : ''}`;
        const content = new St.BoxLayout({style_class: 'snaptess-quick-row-content'});
        content.add_child(preview);
        const labels = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true,
            style_class: 'snaptess-quick-row-labels'});
        labels.set_width(Math.max(80, this.width - 222));
        const title = new St.Label({text: name, style_class: 'snaptess-quick-row-name'});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        title.clutter_text.single_line_mode = true;
        labels.add_child(title);
        const metadata = new St.BoxLayout({style_class: 'snaptess-quick-row-metadata'});
        if (count !== null) metadata.add_child(new St.Label({text: `${count} TILES`,
            style_class: 'snaptess-quick-count'}));
        metadata.add_child(new St.Label({text: meta, style_class: 'snaptess-quick-row-meta'}));
        labels.add_child(metadata);
        const effects = new St.Label({text: detail, style_class: 'snaptess-quick-row-effects'});
        effects.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        effects.clutter_text.single_line_mode = true;
        labels.add_child(effects);
        content.add_child(labels);
        if (active) content.add_child(new St.Label({text: 'ACTIVE', style_class: 'snaptess-quick-active'}));
        else if (enabled) content.add_child(new St.Icon({icon_name: 'go-next-symbolic', icon_size: 13,
            style_class: 'snaptess-quick-arrow'}));
        row.set_child(content);
        if (enabled) {
            row.connect('clicked', () => {
                if (this.monitor >= Main.layoutManager.monitors.length) return;
                this.dialog.close(); action();
            });
            row.connect('key-press-event', (_actor, event) => this.navigate(event, row));
        }
        parent.add_child(row);
        this.rows.push(row);
        return row;
    }

    addSaved(saved) {
        const plan = this.extension.savedLayoutPlan(saved, this.monitor, this.space);
        const appSystem = Shell.AppSystem.get_default();
        const unavailable = plan.missing.filter(id => !(
            appSystem.lookup_app(id) ?? appSystem.lookup_app(`${id}.desktop`))?.get_app_info?.()).length;
        const detail = summary([['reused', plan.slots.filter(Boolean).length],
            ['to open', plan.missing.length - unavailable],
            ['to hide', plan.extras.filter(w => !w.minimized).length],
            ['unavailable', unavailable]]);
        const presetName = PRESETS.find(([id]) => id === saved.preset)?.[1] ?? (saved.preset === 'custom' ? 'Custom' : saved.preset);
        this.addRow({name: saved.name, meta: presetName, count: saved.slotCount, detail,
            preview: this.preview(saved.preset, saved.slotCount, saved.apps ?? saved.pinned, saved.pinned, saved.tiles),
            active: this.extension.savedLayoutActive(saved, this.monitor, this.space),
            action: () => this.extension.restoreSavedLayout(saved.id, this.monitor, this.space)});
    }

    addPreset(id, name, parent = this.list) {
        const plan = this.extension.quickPresetPlan(this.monitor, this.space, id);
        const count = plan?.windows.length ?? this.extension.windows(this.monitor, this.space, true).length;
        const restored = plan?.windows.filter(w => w && this.extension.records.get(w)?.restoreParked).length ?? 0;
        return this.addRow({name, meta: id === 'auto' ?
            `Auto · ${count} open window${count === 1 ? '' : 's'}` : `${capacity(id)} tiles`,
            detail: plan ? (restored ? `${restored} hidden windows return  ·  No apps opened` :
                'Rearrange open windows  ·  No apps opened') : 'Too many windows for this preset',
            preview: this.preview(id, id === 'auto' ? Math.max(1, count) : capacity(id),
                Array.from({length: id === 'auto' ? Math.max(1, count) : capacity(id)}, () => true)),
            active: id === 'auto' && this.extension.running &&
                this.extension.options(this.monitor, this.space).preset === 'auto' && restored === 0,
            enabled: Boolean(plan), action: () => this.extension.applyQuickPreset(this.monitor, this.space, id)}, parent);
    }

    navigate(event, current) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            current.emit('clicked', 1);
            return Clutter.EVENT_STOP;
        }
        if (key !== Clutter.KEY_Up && key !== Clutter.KEY_Down) return Clutter.EVENT_PROPAGATE;
        const navigable = [this.autoRow,
            ...this.rows.filter(row => row.reactive && row.get_parent() === this.list),
            ...(this.presetToggle.visible ? [this.presetToggle] : []),
            ...(this.presetList.visible ? this.rows.filter(row => row.reactive &&
                row.get_parent() === this.presetList) : [])];
        const index = navigable.indexOf(current), direction = key === Clutter.KEY_Down ? 1 : -1;
        const target = navigable[(index + direction + navigable.length) % navigable.length];
        target?.grab_key_focus();
        this.ensureVisible(target);
        return Clutter.EVENT_STOP;
    }

    ensureVisible(row) {
        if (!row || row === this.autoRow) return;
        const adjustment = this.scroll.vadjustment;
        const [, rowY] = row.get_transformed_position();
        const [, scrollY] = this.scroll.get_transformed_position();
        const top = rowY - scrollY, bottom = top + row.height;
        if (top < 8) adjustment.set_value(adjustment.get_value() + top - 8);
        else if (bottom > this.scroll.height - 8)
            adjustment.set_value(adjustment.get_value() + bottom - this.scroll.height + 8);
    }

    open() {
        this.dialog.open();
        this.rows.find(row => row.reactive)?.grab_key_focus();
    }
}
