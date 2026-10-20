use crate::protocol::{MAX_PAYLOAD, Packet, valid_dimensions};
use serde_json::json;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug)]
struct Rect {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
}

pub struct Batch {
    pub frame_id: u64,
    pub geometry: u64,
    pub width: u16,
    pub height: u16,
    rect: Rect,
    pixels: Vec<u8>,
    pub full: bool,
    next_row: u16,
}

impl Batch {
    pub fn next_packet(&mut self, seq: u64) -> Option<Packet> {
        if self.next_row >= self.rect.height {
            return None;
        }
        let stride = usize::from(self.rect.width) * 4;
        let rows = (MAX_PAYLOAD / stride).min(usize::from(self.rect.height - self.next_row)) as u16;
        let first = self.next_row == 0;
        let y = self.rect.y + self.next_row;
        let offset = usize::from(self.next_row) * stride;
        let len = usize::from(rows) * stride;
        self.next_row += rows;
        Some(Packet {
            header: json!({"type":"frame", "seq":seq, "frameId":self.frame_id,
                "geometry":self.geometry,"width":self.width,"height":self.height,
                "x":self.rect.x,"y":y,"tileWidth":self.rect.width,"tileHeight":rows,
                "full":self.full,"first":first,"last":self.next_row == self.rect.height}),
            payload: self.pixels[offset..offset + len].to_vec(),
        })
    }
}

#[derive(Default)]
pub struct Display {
    width: u16,
    height: u16,
    geometry: u64,
    frame_id: u64,
    pixels: Vec<u8>,
    dirty: Option<Rect>,
    full: bool,
    pub snapshot_serial: u64,
    pub cursor: Option<(serde_json::Value, Vec<u8>)>,
    pub cursor_position: Option<(u16, u16)>,
}

impl Display {
    pub fn apply(
        &mut self,
        width: u16,
        height: u16,
        x: u16,
        y: u16,
        rect_width: u16,
        rect_height: u16,
        pixels: &[u32],
    ) -> Result<(), &'static str> {
        if !valid_dimensions(width, height)
            || rect_width == 0
            || rect_height == 0
            || u32::from(x) + u32::from(rect_width) > u32::from(width)
            || u32::from(y) + u32::from(rect_height) > u32::from(height)
            || pixels.len() != usize::from(rect_width) * usize::from(rect_height)
        {
            return Err("invalid-frame");
        }
        if self.width != width || self.height != height {
            if x != 0 || y != 0 || rect_width != width || rect_height != height {
                return Err("missing-initial-frame");
            }
            self.width = width;
            self.height = height;
            self.geometry += 1;
            self.pixels = vec![0; usize::from(width) * usize::from(height) * 4];
            self.full = true;
            self.dirty = None;
            self.snapshot_serial += 1;
        }
        for row in 0..usize::from(rect_height) {
            let dst = (usize::from(y) + row) * usize::from(width) * 4 + usize::from(x) * 4;
            for (col, pixel) in pixels
                [row * usize::from(rect_width)..(row + 1) * usize::from(rect_width)]
                .iter()
                .enumerate()
            {
                let index = dst + col * 4;
                self.pixels[index..index + 4].copy_from_slice(&[
                    ((pixel >> 16) & 255) as u8,
                    ((pixel >> 8) & 255) as u8,
                    (pixel & 255) as u8,
                    255,
                ]);
            }
        }
        let mut rect = Rect {
            x,
            y,
            width: rect_width,
            height: rect_height,
        };
        if let Some(old) = self.dirty {
            let right = (old.x + old.width).max(rect.x + rect.width);
            let bottom = (old.y + old.height).max(rect.y + rect.height);
            rect.x = old.x.min(rect.x);
            rect.y = old.y.min(rect.y);
            rect.width = right - rect.x;
            rect.height = bottom - rect.y;
        }
        self.dirty = Some(rect);
        Ok(())
    }
    pub fn request_snapshot(&mut self) {
        self.full = true;
        self.snapshot_serial += 1;
    }
    pub fn take_batch(&mut self) -> Option<Batch> {
        if self.pixels.is_empty() {
            return None;
        }
        let rect = if self.full {
            Rect {
                x: 0,
                y: 0,
                width: self.width,
                height: self.height,
            }
        } else {
            self.dirty?
        };
        let mut pixels = Vec::with_capacity(usize::from(rect.width) * usize::from(rect.height) * 4);
        for row in rect.y..rect.y + rect.height {
            let offset = (usize::from(row) * usize::from(self.width) + usize::from(rect.x)) * 4;
            pixels.extend_from_slice(&self.pixels[offset..offset + usize::from(rect.width) * 4]);
        }
        self.frame_id += 1;
        let batch = Batch {
            frame_id: self.frame_id,
            geometry: self.geometry,
            width: self.width,
            height: self.height,
            rect,
            pixels,
            full: self.full,
            next_row: 0,
        };
        self.full = false;
        self.dirty = None;
        Some(batch)
    }
    pub fn dimensions(&self) -> (u16, u16) {
        (self.width, self.height)
    }
}

#[derive(Default)]
pub struct Credits {
    next: u64,
    bytes: usize,
    outstanding: BTreeMap<u64, usize>,
}
impl Credits {
    pub fn reserve(&mut self, bytes: usize) -> Option<u64> {
        if bytes > MAX_PAYLOAD
            || self.bytes + bytes > 8 * 1024 * 1024
            || self.outstanding.len() >= 128
        {
            return None;
        }
        self.next += 1;
        self.bytes += bytes;
        self.outstanding.insert(self.next, bytes);
        Some(self.next)
    }
    pub fn ack(&mut self, seq: u64) -> bool {
        if let Some(bytes) = self.outstanding.remove(&seq) {
            self.bytes -= bytes;
            true
        } else {
            false
        }
    }
}

pub fn self_test() -> Result<(), &'static str> {
    let mut display = Display::default();
    display.apply(2, 2, 0, 0, 2, 2, &[0xff0000, 0x00ff00, 0x0000ff, 0xffffff])?;
    let packet = display
        .take_batch()
        .ok_or("no-frame")?
        .next_packet(1)
        .ok_or("no-tile")?;
    if packet.payload[..4] != [255, 0, 0, 255] || packet.payload.len() != 16 {
        return Err("pixel-conversion");
    }
    display.apply(2, 2, 1, 1, 1, 1, &[0])?;
    display.request_snapshot();
    let packet = display
        .take_batch()
        .ok_or("no-snapshot")?
        .next_packet(2)
        .ok_or("no-tile")?;
    if packet.payload[12..] != [0, 0, 0, 255] {
        return Err("snapshot-coalescing");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dirty_pixels_survive_snapshot_coalescing() {
        self_test().unwrap();
    }
    #[test]
    fn credits_cannot_be_forged_or_exceeded() {
        let mut credits = Credits::default();
        let mut ids = Vec::new();
        for _ in 0..32 {
            ids.push(credits.reserve(MAX_PAYLOAD).unwrap());
        }
        assert!(credits.reserve(1).is_none());
        assert!(!credits.ack(999));
        assert!(credits.ack(ids[0]));
        assert!(!credits.ack(ids[0]));
        assert!(credits.reserve(MAX_PAYLOAD).is_some());
    }
    #[test]
    fn tiling_obeys_packet_limit_and_commit_barrier() {
        let mut display = Display::default();
        display
            .apply(1920, 1080, 0, 0, 1920, 1080, &vec![0; 1920 * 1080])
            .unwrap();
        let mut batch = display.take_batch().unwrap();
        let mut total = 0;
        let mut seq = 0;
        let mut last = false;
        while let Some(packet) = batch.next_packet(seq + 1) {
            seq += 1;
            total += packet.payload.len();
            assert!(packet.payload.len() <= MAX_PAYLOAD);
            assert_eq!(packet.header["first"], seq == 1);
            last = packet.header["last"].as_bool().unwrap();
        }
        assert!(last);
        assert_eq!(total, 1920 * 1080 * 4);
    }
}
