use eframe::egui::{self, Color32, Frame, Margin, Rounding, Stroke, Ui};

// Modern Dark Theme Palette (Base Slate)
pub const BG_DARK: Color32 = Color32::from_rgb(14, 16, 22);
pub const BG_SURFACE: Color32 = Color32::from_rgb(22, 26, 35);
pub const BG_PANEL: Color32 = Color32::from_rgb(18, 21, 28);
pub const BG_CARD: Color32 = Color32::from_rgb(25, 30, 41);
pub const BG_CARD_HOVER: Color32 = Color32::from_rgb(33, 40, 54);

pub const BORDER_COLOR: Color32 = Color32::from_rgb(38, 44, 58);
pub const BORDER_LIGHT: Color32 = Color32::from_rgb(52, 60, 78);

pub const ACCENT_BLUE: Color32 = Color32::from_rgb(59, 130, 246);
pub const ACCENT_CYAN: Color32 = Color32::from_rgb(14, 165, 233);
pub const ACCENT_GREEN: Color32 = Color32::from_rgb(34, 197, 94);
pub const ACCENT_AMBER: Color32 = Color32::from_rgb(245, 158, 11);
pub const ACCENT_RED: Color32 = Color32::from_rgb(239, 68, 68);
pub const ACCENT_PURPLE: Color32 = Color32::from_rgb(168, 85, 247);

pub const TEXT_PRIMARY: Color32 = Color32::from_rgb(241, 245, 249);
pub const TEXT_SECONDARY: Color32 = Color32::from_rgb(203, 213, 225);
pub const TEXT_MUTED: Color32 = Color32::from_rgb(148, 163, 184);
pub const TEXT_DIM: Color32 = Color32::from_rgb(100, 116, 139);

/// Configures egui context visuals with the Oxide modern dark theme.
pub fn configure_visuals(ctx: &egui::Context) {
    let mut visuals = egui::Visuals::dark();

    visuals.override_text_color = Some(TEXT_PRIMARY);
    visuals.panel_fill = BG_PANEL;
    visuals.window_fill = BG_SURFACE;
    visuals.faint_bg_color = BG_DARK;
    visuals.extreme_bg_color = BG_DARK;

    visuals.widgets.noninteractive.bg_fill = BG_SURFACE;
    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER_COLOR);
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT_MUTED);
    visuals.widgets.noninteractive.rounding = Rounding::same(4.0_f32);

    visuals.widgets.inactive.bg_fill = BG_SURFACE;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER_COLOR);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT_SECONDARY);
    visuals.widgets.inactive.rounding = Rounding::same(4.0_f32);

    visuals.widgets.hovered.bg_fill = BG_CARD_HOVER;
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, ACCENT_BLUE);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);
    visuals.widgets.hovered.rounding = Rounding::same(4.0_f32);

    visuals.widgets.active.bg_fill = ACCENT_BLUE;
    visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, ACCENT_CYAN);
    visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, Color32::WHITE);
    visuals.widgets.active.rounding = Rounding::same(4.0_f32);

    visuals.widgets.open.bg_fill = BG_CARD;
    visuals.widgets.open.bg_stroke = Stroke::new(1.0_f32, ACCENT_BLUE);
    visuals.widgets.open.fg_stroke = Stroke::new(1.0_f32, TEXT_PRIMARY);
    visuals.widgets.open.rounding = Rounding::same(4.0_f32);

    visuals.selection.bg_fill = Color32::from_rgba_premultiplied(59, 130, 246, 70);
    visuals.selection.stroke = Stroke::new(1.0_f32, ACCENT_BLUE);

    ctx.set_visuals(visuals);
}

/// Standard surface card frame
pub fn card_frame() -> Frame {
    Frame::none()
        .fill(BG_SURFACE)
        .stroke(Stroke::new(1.0_f32, BORDER_COLOR))
        .rounding(Rounding::same(6.0_f32))
        .inner_margin(Margin::same(10.0_f32))
}

/// Selected or highlighted card frame
pub fn highlighted_card_frame() -> Frame {
    Frame::none()
        .fill(BG_CARD)
        .stroke(Stroke::new(1.0_f32, ACCENT_BLUE))
        .rounding(Rounding::same(6.0_f32))
        .inner_margin(Margin::same(10.0_f32))
}

/// Dark nested panel frame
pub fn nested_panel_frame() -> Frame {
    Frame::none()
        .fill(BG_DARK)
        .stroke(Stroke::new(1.0_f32, BORDER_COLOR))
        .rounding(Rounding::same(4.0_f32))
        .inner_margin(Margin::same(8.0_f32))
}

/// Top header bar frame
pub fn header_frame() -> Frame {
    Frame::none()
        .fill(BG_PANEL)
        .stroke(Stroke::new(1.0_f32, BORDER_COLOR))
        .inner_margin(Margin::symmetric(12.0_f32, 8.0_f32))
}

/// Render a clean ASCII badge
pub fn ascii_badge(ui: &mut Ui, label: &str, color: Color32) {
    ui.scope(|ui| {
        let frame = Frame::none()
            .fill(Color32::from_rgba_premultiplied(color.r(), color.g(), color.b(), 35))
            .stroke(Stroke::new(1.0_f32, color))
            .rounding(Rounding::same(3.0_f32))
            .inner_margin(Margin::symmetric(5.0_f32, 2.0_f32));
        frame.show(ui, |ui| {
            ui.colored_label(color, label);
        });
    });
}

/// Render an ASCII status pill [ONLINE] / [STANDBY]
pub fn ascii_status_pill(ui: &mut Ui, is_online: bool, online_label: &str, offline_label: &str) {
    if is_online {
        ascii_badge(ui, &format!("[{}]", online_label), ACCENT_GREEN);
    } else {
        ascii_badge(ui, &format!("[{}]", offline_label), TEXT_MUTED);
    }
}
