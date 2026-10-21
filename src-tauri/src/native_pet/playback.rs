use super::model::{frame_interval_ms, is_looping, one_shot_next};
use std::time::{Duration, Instant};

/// One clock for both native renderers. Elapsed fractions survive timer ticks.
pub struct Playback {
    pub frame_index: usize,
    action: String,
    revision: u64,
    last_tick: Instant,
    elapsed: Duration,
    paused: bool,
    finished: bool,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            frame_index: 0,
            action: String::new(),
            revision: 0,
            last_tick: Instant::now(),
            elapsed: Duration::ZERO,
            paused: false,
            finished: false,
        }
    }
}

impl Playback {
    pub fn tick(
        &mut self,
        action: &str,
        revision: u64,
        count: usize,
        paused: bool,
        now: Instant,
    ) -> Option<&'static str> {
        if self.action != action || self.revision != revision {
            self.action = action.to_string();
            self.revision = revision;
            self.frame_index = 0;
            self.elapsed = Duration::ZERO;
            self.finished = false;
            self.last_tick = now;
        }
        let delta = now.saturating_duration_since(self.last_tick);
        self.last_tick = now;
        let was_paused = self.paused;
        self.paused = paused;
        if paused || was_paused || count == 0 || self.finished {
            return None;
        }
        self.elapsed += delta;
        let interval = Duration::from_millis(frame_interval_ms(action));
        let steps =
            (self.elapsed.as_nanos() / interval.as_nanos()).min(usize::MAX as u128) as usize;
        self.elapsed = Duration::from_nanos((self.elapsed.as_nanos() % interval.as_nanos()) as u64);
        if is_looping(action) {
            self.frame_index = (self.frame_index + steps % count) % count;
        } else if steps >= count.saturating_sub(self.frame_index) {
            self.frame_index = count - 1;
            self.finished = true;
            return one_shot_next(action);
        } else {
            self.frame_index = (self.frame_index + steps).min(count - 1);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_shot_consumes_last_frame_and_finishes_once() {
        for action in ["jump", "happy"] {
            let start = Instant::now();
            let mut p = Playback::default();
            p.tick(action, 1, 5, false, start);
            let frame = frame_interval_ms(action);
            assert_eq!(
                p.tick(
                    action,
                    1,
                    5,
                    false,
                    start + Duration::from_millis(frame * 4)
                ),
                None
            );
            assert_eq!(p.frame_index, 4);
            assert_eq!(
                p.tick(
                    action,
                    1,
                    5,
                    false,
                    start + Duration::from_millis(frame * 5)
                ),
                Some("idle")
            );
            assert_eq!(
                p.tick(action, 1, 5, false, start + Duration::from_secs(3)),
                None
            );
        }
    }
    #[test]
    fn irregular_ticks_keep_elapsed_fractions() {
        let start = Instant::now();
        let mut p = Playback::default();
        p.tick("jump", 1, 5, false, start);
        for ms in [100, 200, 300, 400, 500] {
            p.tick("jump", 1, 5, false, start + Duration::from_millis(ms));
        }
        assert_eq!(p.frame_index, 4);
        assert_eq!(
            p.tick("jump", 1, 5, false, start + Duration::from_millis(600)),
            Some("idle")
        );
    }
    #[test]
    fn pause_never_finishes_or_consumes_paused_time() {
        let start = Instant::now();
        let mut p = Playback::default();
        p.tick("jump", 1, 5, false, start);
        p.tick("jump", 1, 5, false, start + Duration::from_millis(440));
        assert_eq!(
            p.tick("jump", 1, 5, true, start + Duration::from_secs(3)),
            None
        );
        assert_eq!(
            p.tick("jump", 1, 5, false, start + Duration::from_secs(4)),
            None
        );
        assert_eq!(
            p.tick("jump", 1, 5, false, start + Duration::from_millis(4110)),
            Some("idle")
        );
    }
    #[test]
    fn repeated_action_replays_but_resting_actions_hold() {
        let start = Instant::now();
        let mut p = Playback::default();
        p.tick("sit", 1, 5, false, start);
        assert_eq!(
            p.tick("sit", 1, 5, false, start + Duration::from_secs(5)),
            None
        );
        assert_eq!(p.frame_index, 4);
        p.tick("sit", 2, 5, false, start + Duration::from_secs(6));
        assert_eq!(p.frame_index, 0);
    }
}
