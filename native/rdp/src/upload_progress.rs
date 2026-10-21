use crate::protocol::Packet;
use serde_json::json;
use std::time::{Duration, Instant};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const MAX_SPARSE_RANGES: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestShape {
    pub index: u32,
    pub offset: u64,
    pub length: u32,
    pub size: bool,
}

/// Exact coverage stays compact for sequential reads. Highly fragmented reads
/// switch to one bit per byte, bounded to 32 MiB by the 256 MiB collection cap.
struct Coverage {
    size: u64,
    covered: u64,
    ranges: Vec<(u64, u64)>,
    bitmap: Option<Vec<u64>>,
}
impl Coverage {
    fn new(size: u64) -> Self {
        Self {
            size,
            covered: 0,
            ranges: Vec::new(),
            bitmap: None,
        }
    }
    fn record(&mut self, offset: u64, length: u64) {
        if length == 0 || offset >= self.size {
            return;
        }
        let end = offset.saturating_add(length).min(self.size);
        if let Some(bitmap) = &mut self.bitmap {
            self.covered += record_bits(bitmap, offset, end);
            return;
        }
        let mut start = offset;
        let mut finish = end;
        let first = self.ranges.partition_point(|range| range.1 < start);
        let mut last = first;
        while let Some(&(range_start, range_end)) = self.ranges.get(last) {
            if range_start > finish {
                break;
            }
            start = start.min(range_start);
            finish = finish.max(range_end);
            self.covered -= range_end - range_start;
            last += 1;
        }
        self.covered += finish - start;
        self.ranges.splice(first..last, [(start, finish)]);
        if self.ranges.len() > MAX_SPARSE_RANGES {
            let mut bitmap = vec![0; self.size.div_ceil(64) as usize];
            for (start, end) in self.ranges.drain(..) {
                record_bits(&mut bitmap, start, end);
            }
            self.ranges.shrink_to_fit();
            self.bitmap = Some(bitmap);
        }
    }
}
fn record_bits(bitmap: &mut [u64], start: u64, end: u64) -> u64 {
    let mut newly_covered = 0;
    let mut position = start;
    while position < end {
        let word = (position / 64) as usize;
        let low = (position % 64) as u32;
        let count = (end - position).min(u64::from(64 - low)) as u32;
        let mask = (u64::MAX >> (64 - count)) << low;
        newly_covered += u64::from((mask & !bitmap[word]).count_ones());
        bitmap[word] |= mask;
        position += u64::from(count);
    }
    newly_covered
}

pub struct UploadProgress {
    pub offer_id: String,
    pub transfer_id: String,
    files: Vec<Coverage>,
    phase: &'static str,
    last_emit: Instant,
    terminal_at: Option<Instant>,
    last_response: Option<RequestShape>,
}
impl UploadProgress {
    pub fn new(
        offer_id: String,
        transfer_id: String,
        sizes: impl Iterator<Item = u64>,
        now: Instant,
    ) -> Self {
        Self {
            offer_id,
            transfer_id,
            files: sizes.map(Coverage::new).collect(),
            phase: "transferring",
            last_emit: now,
            terminal_at: None,
            last_response: None,
        }
    }
    pub fn active(&self) -> bool {
        self.phase == "transferring"
    }
    pub fn restart_for(&self, request: RequestShape, now: Instant) -> bool {
        // CLIPRDR has no paste-operation ID. A new request after completion is
        // a new cycle only when it requests actual file bytes. SIZE and EOF
        // probes commonly finish the preceding copy; neither starts a cycle.
        self.phase == "completed"
            && !request.size
            && request.length > 0
            && self
                .files
                .get(request.index as usize)
                .is_some_and(|file| request.offset < file.size)
            && !(self.last_response == Some(request)
                && self
                    .terminal_at
                    .is_some_and(|ended| now.saturating_duration_since(ended) < PROGRESS_INTERVAL))
    }
    pub fn packet(&self) -> Packet {
        Packet::control(
            json!({"type":"clipboardFileUploadProgress","offerId":self.offer_id,
            "transferId":self.transfer_id,"phase":self.phase,
            "transferredBytes":self.files.iter().map(|file| file.covered).sum::<u64>(),
            "totalBytes":self.files.iter().map(|file| file.size).sum::<u64>(),
            "completedFiles":self.files.iter().filter(|file| file.covered == file.size).count(),
            "totalFiles":self.files.len()}),
        )
    }
    pub fn queued(&mut self, request: RequestShape, length: u64, now: Instant) -> Option<Packet> {
        if !self.active() {
            return None;
        }
        self.files
            .get_mut(request.index as usize)?
            .record(request.offset, length);
        self.last_response = Some(request);
        if self.files.iter().all(|file| file.covered == file.size) {
            self.phase = "completed";
            self.terminal_at = Some(now);
        } else if now.saturating_duration_since(self.last_emit) < PROGRESS_INTERVAL {
            return None;
        }
        self.last_emit = now;
        Some(self.packet())
    }
    pub fn terminate(&mut self, phase: &'static str, now: Instant) -> Option<Packet> {
        if !self.active() {
            return None;
        }
        self.phase = phase;
        self.terminal_at = Some(now);
        Some(self.packet())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overlapping_and_fragmented_ranges_count_each_byte_once() {
        let mut coverage = Coverage::new(1024);
        coverage.record(4, 12);
        coverage.record(0, 10);
        coverage.record(12, 8);
        coverage.record(4, 12);
        assert_eq!(coverage.covered, 20);
        for position in (30..200).step_by(2) {
            coverage.record(position, 1);
        }
        assert!(coverage.bitmap.is_some());
        assert_eq!(coverage.bitmap.as_ref().unwrap().len(), 16);
        assert_eq!(coverage.covered, 105);
        coverage.record(0, 1024);
        coverage.record(0, 1024);
        assert_eq!(coverage.covered, 1024);
    }
    #[test]
    fn progress_is_throttled_and_zero_files_complete_without_data() {
        let now = Instant::now();
        let mut progress =
            UploadProgress::new("offer".into(), "upload-1".into(), [0, 6].into_iter(), now);
        assert_eq!(progress.packet().header["completedFiles"], 1);
        let request = RequestShape {
            index: 1,
            offset: 0,
            length: 3,
            size: false,
        };
        assert!(progress.queued(request, 3, now).is_none());
        assert!(
            progress
                .queued(request, 3, now + PROGRESS_INTERVAL)
                .is_some()
        );
        let last = RequestShape {
            offset: 3,
            ..request
        };
        let complete = progress.queued(last, 3, now + PROGRESS_INTERVAL).unwrap();
        assert_eq!(complete.header["phase"], "completed");
        assert_eq!(complete.header["transferredBytes"], 6);
        assert_eq!(complete.header["completedFiles"], 2);
        assert!(!progress.restart_for(last, now + PROGRESS_INTERVAL));
        assert!(progress.restart_for(last, now + PROGRESS_INTERVAL * 2));
        assert!(progress.terminate("canceled", now).is_none());
    }
    #[test]
    fn failure_and_cancellation_are_terminal_once() {
        let now = Instant::now();
        let mut progress =
            UploadProgress::new("offer".into(), "upload-1".into(), [5].into_iter(), now);
        assert_eq!(
            progress.terminate("failed", now).unwrap().header["phase"],
            "failed"
        );
        assert!(progress.terminate("canceled", now).is_none());
    }
}
