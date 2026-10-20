use crate::protocol::{Button, InputEvent};
use ironrdp_pdu::input::fast_path::{FastPathInputEvent, KeyboardFlags};
use ironrdp_pdu::input::mouse::{MousePdu, PointerFlags};
use ironrdp_pdu::input::mouse_x::{MouseXPdu, PointerXFlags};
use std::collections::BTreeSet;

#[derive(Default, Clone)]
pub struct InputState {
    keys: BTreeSet<(u8, bool)>,
    unicode: BTreeSet<u32>,
    buttons: BTreeSet<Button>,
    position: (u16, u16),
}
impl InputState {
    pub fn translate(
        &mut self,
        event: InputEvent,
        dimensions: (u16, u16),
    ) -> Result<Vec<FastPathInputEvent>, &'static str> {
        Ok(match event {
            InputEvent::Key {
                scan_code,
                extended,
                down,
            } => {
                if scan_code == 0 {
                    return Err("invalid-key");
                }
                if down {
                    self.keys.insert((scan_code, extended));
                } else {
                    self.keys.remove(&(scan_code, extended));
                }
                let mut flags = KeyboardFlags::empty();
                if extended {
                    flags |= KeyboardFlags::EXTENDED;
                }
                if !down {
                    flags |= KeyboardFlags::RELEASE;
                }
                vec![FastPathInputEvent::KeyboardEvent(flags, scan_code)]
            }
            InputEvent::Unicode { code_point, down } => {
                let character = char::from_u32(code_point).ok_or("invalid-unicode")?;
                if down {
                    self.unicode.insert(code_point);
                } else {
                    self.unicode.remove(&code_point);
                }
                let mut units = [0; 2];
                let text = character.encode_utf16(&mut units);
                let flags = if down {
                    KeyboardFlags::empty()
                } else {
                    KeyboardFlags::RELEASE
                };
                text.iter()
                    .map(|unit| FastPathInputEvent::UnicodeKeyboardEvent(flags, *unit))
                    .collect()
            }
            InputEvent::Mouse {
                x,
                y,
                button,
                down,
                wheel,
                horizontal,
            } => {
                if dimensions.0 == 0 || dimensions.1 == 0 || x >= dimensions.0 || y >= dimensions.1
                {
                    return Err("invalid-pointer");
                }
                self.position = (x, y);
                if let Some(button) = button {
                    let down = down.ok_or("missing-button-state")?;
                    if down {
                        self.buttons.insert(button);
                    } else {
                        self.buttons.remove(&button);
                    }
                    if matches!(button, Button::Back | Button::Forward) {
                        let mut flags = if button == Button::Back {
                            PointerXFlags::BUTTON1
                        } else {
                            PointerXFlags::BUTTON2
                        };
                        if down {
                            flags |= PointerXFlags::DOWN;
                        }
                        vec![FastPathInputEvent::MouseEventEx(MouseXPdu {
                            flags,
                            x_position: x,
                            y_position: y,
                        })]
                    } else {
                        let mut flags = match button {
                            Button::Left => PointerFlags::LEFT_BUTTON,
                            Button::Right => PointerFlags::RIGHT_BUTTON,
                            _ => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
                        };
                        if down {
                            flags |= PointerFlags::DOWN;
                        }
                        vec![FastPathInputEvent::MouseEvent(MousePdu {
                            flags,
                            number_of_wheel_rotation_units: 0,
                            x_position: x,
                            y_position: y,
                        })]
                    }
                } else {
                    let flags = if wheel.is_some() {
                        if horizontal.unwrap_or(false) {
                            PointerFlags::HORIZONTAL_WHEEL
                        } else {
                            PointerFlags::VERTICAL_WHEEL
                        }
                    } else {
                        PointerFlags::MOVE
                    };
                    vec![FastPathInputEvent::MouseEvent(MousePdu {
                        flags,
                        number_of_wheel_rotation_units: wheel.unwrap_or(0).clamp(-256, 255),
                        x_position: x,
                        y_position: y,
                    })]
                }
            }
        })
    }
    pub fn release_all(&mut self, dimensions: (u16, u16)) -> Vec<FastPathInputEvent> {
        let mut events = Vec::new();
        for (scan_code, extended) in self.keys.clone() {
            events.extend(
                self.translate(
                    InputEvent::Key {
                        scan_code,
                        extended,
                        down: false,
                    },
                    dimensions,
                )
                .unwrap_or_default(),
            );
        }
        for code_point in self.unicode.clone() {
            events.extend(
                self.translate(
                    InputEvent::Unicode {
                        code_point,
                        down: false,
                    },
                    dimensions,
                )
                .unwrap_or_default(),
            );
        }
        for button in self.buttons.clone() {
            events.extend(
                self.translate(
                    InputEvent::Mouse {
                        x: self.position.0.min(dimensions.0.saturating_sub(1)),
                        y: self.position.1.min(dimensions.1.saturating_sub(1)),
                        button: Some(button),
                        down: Some(false),
                        wheel: None,
                        horizontal: None,
                    },
                    dimensions,
                )
                .unwrap_or_default(),
            );
        }
        self.keys.clear();
        self.unicode.clear();
        self.buttons.clear();
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_loss_releases_pressed_keys_and_buttons_once() {
        let mut state = InputState::default();
        state
            .translate(
                InputEvent::Key {
                    scan_code: 30,
                    extended: false,
                    down: true,
                },
                (100, 100),
            )
            .unwrap();
        state
            .translate(
                InputEvent::Mouse {
                    x: 9,
                    y: 8,
                    button: Some(Button::Left),
                    down: Some(true),
                    wheel: None,
                    horizontal: None,
                },
                (100, 100),
            )
            .unwrap();
        assert_eq!(state.release_all((100, 100)).len(), 2);
        assert!(state.release_all((100, 100)).is_empty());
    }
    #[test]
    fn unicode_scalar_validation_and_surrogates() {
        let mut state = InputState::default();
        assert!(
            state
                .translate(
                    InputEvent::Unicode {
                        code_point: 0xd800,
                        down: true
                    },
                    (1, 1)
                )
                .is_err()
        );
        assert_eq!(
            state
                .translate(
                    InputEvent::Unicode {
                        code_point: 0x1f600,
                        down: true
                    },
                    (1, 1)
                )
                .unwrap()
                .len(),
            2
        );
    }
}
