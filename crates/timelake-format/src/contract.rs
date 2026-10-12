//! The Timelake table contract (SPEC §7.1): which column is time, which columns identify a series,
//! and the layout/maintenance policy derived from them. Stored as `timelake.*` Iceberg table
//! properties, so the contract travels with the table and other engines simply ignore it.

use std::collections::HashMap;
use std::time::Duration;

use crate::{FormatError, Result};

fn invalid(msg: impl Into<String>) -> FormatError {
    FormatError(msg.into())
}

pub const P_TIME_COLUMN: &str = "timelake.time-column";
pub const P_SERIES_KEY: &str = "timelake.series-key";
pub const P_CHUNK: &str = "timelake.chunk-interval";
pub const P_DEDUP: &str = "timelake.dedup";
pub const P_RETENTION: &str = "timelake.retention";
pub const P_TARGET_FILE_SIZE: &str = "timelake.target-file-size-bytes";
pub const P_ROW_GROUP_ROWS: &str = "timelake.row-group-rows";
pub const P_AUTO_MAINTAIN: &str = "timelake.auto-maintain";
pub const P_SNAPSHOT_RETENTION: &str = "timelake.snapshot-retention";
pub const P_MIN_SNAPSHOTS: &str = "timelake.min-snapshots";
pub const P_MAX_SNAPSHOTS: &str = "timelake.max-snapshots";
pub const P_COMPACT_MIN_FILES: &str = "timelake.compact-min-files";

/// Time partition granularity, like TimescaleDB's `chunk_time_interval`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Chunk {
    Hour,
    Day,
    Month,
}

impl Chunk {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "hour" | "1h" | "1 hour" => Ok(Self::Hour),
            "day" | "1d" | "1 day" | "24h" => Ok(Self::Day),
            "month" | "1 month" => Ok(Self::Month),
            other => Err(invalid(format!("chunk interval must be hour, day or month, got {other:?}"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Month => "month",
        }
    }

    /// Iceberg transform value (hours/days/months since the epoch) of a timestamp in microseconds.
    pub fn value(self, micros: i64) -> i32 {
        const H: i64 = 3_600_000_000;
        match self {
            Self::Hour => micros.div_euclid(H) as i32,
            Self::Day => micros.div_euclid(24 * H) as i32,
            Self::Month => {
                let days = micros.div_euclid(24 * H);
                let d = chrono::DateTime::from_timestamp(days * 86_400, 0).unwrap().date_naive();
                use chrono::Datelike;
                (d.year() - 1970) * 12 + d.month0() as i32
            }
        }
    }

    /// Start of a partition, in microseconds since the epoch.
    pub fn start_micros(self, value: i32) -> i64 {
        const H: i64 = 3_600_000_000;
        match self {
            Self::Hour => value as i64 * H,
            Self::Day => value as i64 * 24 * H,
            Self::Month => {
                let (y, m) = (1970 + value.div_euclid(12), value.rem_euclid(12) as u32 + 1);
                chrono::NaiveDate::from_ymd_opt(y, m, 1).unwrap().and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_micros()
            }
        }
    }

    pub fn end_micros(self, value: i32) -> i64 {
        self.start_micros(value + 1)
    }

    /// Human-readable partition value, used in data file paths (`time_day=2026-01-01`).
    pub fn label(self, value: i32) -> String {
        let t = chrono::DateTime::from_timestamp_micros(self.start_micros(value)).unwrap();
        match self {
            Self::Hour => t.format("%Y-%m-%d-%H").to_string(),
            Self::Day => t.format("%Y-%m-%d").to_string(),
            Self::Month => t.format("%Y-%m").to_string(),
        }
    }
}

/// Options for creating a table. Only `time_column` is required for a time-series table; leave it
/// unset for a plain (dimension) table such as device metadata.
#[derive(Clone, Debug, Default)]
pub struct TableOptions {
    pub time_column: Option<String>,
    pub series_key: Vec<String>,
    pub chunk: Option<Chunk>,
    pub dedup: Option<bool>,
    pub retention: Option<String>,
    /// Extra Iceberg/Timelake table properties.
    pub properties: HashMap<String, String>,
}

/// The parsed contract of an existing table.
#[derive(Clone, Debug)]
pub struct Contract {
    pub time_column: Option<String>,
    pub series_key: Vec<String>,
    pub chunk: Option<Chunk>,
    /// Remove rows with the same `(series_key, time)` during compaction; the latest write wins.
    pub dedup: bool,
    pub retention: Option<Duration>,
    pub target_file_size: u64,
    pub row_group_rows: usize,
    pub auto_maintain: bool,
    pub snapshot_retention: Duration,
    pub min_snapshots: usize,
    /// Snapshots beyond the newest `max_snapshots` are expired even if younger than the retention.
    pub max_snapshots: usize,
    /// Inline auto-maintenance merges a size tier of a partition once it has this many files.
    pub compact_min_files: usize,
}

impl Contract {
    pub fn from_properties(p: &HashMap<String, String>) -> Result<Self> {
        let get = |k: &str| p.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let parse_u = |k: &str, d: u64| -> Result<u64> {
            get(k).map(|s| s.parse::<u64>().map_err(|_| invalid(format!("{k} must be an integer")))).unwrap_or(Ok(d))
        };
        let series_key = get(P_SERIES_KEY)
            .map(|s| s.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect())
            .unwrap_or_default();
        Ok(Self {
            time_column: get(P_TIME_COLUMN).map(str::to_string),
            dedup: get(P_DEDUP).map(|s| s == "true").unwrap_or(false),
            series_key,
            chunk: get(P_CHUNK).map(Chunk::parse).transpose()?,
            retention: get(P_RETENTION).map(parse_duration).transpose()?,
            target_file_size: parse_u(P_TARGET_FILE_SIZE, 256 << 20)?,
            row_group_rows: parse_u(P_ROW_GROUP_ROWS, 1024 * 1024)? as usize,
            auto_maintain: get(P_AUTO_MAINTAIN).map(|s| s != "false").unwrap_or(true),
            snapshot_retention: get(P_SNAPSHOT_RETENTION).map(parse_duration).transpose()?.unwrap_or(Duration::from_secs(3600)),
            min_snapshots: parse_u(P_MIN_SNAPSHOTS, 5)? as usize,
            max_snapshots: parse_u(P_MAX_SNAPSHOTS, 100)? as usize,
            compact_min_files: parse_u(P_COMPACT_MIN_FILES, 8)? as usize,
        })
    }

    pub fn is_time_series(&self) -> bool {
        self.time_column.is_some()
    }

    /// Sort key: series key columns, then time.
    pub fn sort_columns(&self) -> Vec<String> {
        let mut v = self.series_key.clone();
        v.extend(self.time_column.clone());
        v
    }
}

/// Parses durations like `90d`, `12h`, `30m`, `45s`, `2w`, `1y`.
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (n, unit) = s.split_at(split);
    let n: u64 = n.parse().map_err(|_| invalid(format!("bad duration {s:?}")))?;
    let secs = match unit.trim() {
        "s" | "sec" | "seconds" => 1,
        "m" | "min" | "minutes" => 60,
        "h" | "hours" => 3600,
        "d" | "days" => 86_400,
        "w" | "weeks" => 7 * 86_400,
        "y" | "years" => 365 * 86_400,
        _ => return Err(invalid(format!("bad duration unit in {s:?} (use s, m, h, d, w, y)"))),
    };
    Ok(Duration::from_secs(n * secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_values_round_trip() {
        let t = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z
        for c in [Chunk::Hour, Chunk::Day, Chunk::Month] {
            let v = c.value(t + 1);
            assert_eq!(c.start_micros(v), t, "{c:?}");
            assert!(c.end_micros(v) > t);
        }
        assert_eq!(Chunk::Day.label(Chunk::Day.value(t)), "2026-01-01");
        assert_eq!(Chunk::Month.value(t), (2026 - 1970) * 12);
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90d").unwrap().as_secs(), 90 * 86_400);
        assert_eq!(parse_duration("1h").unwrap().as_secs(), 3600);
        assert!(parse_duration("1 parsec").is_err());
    }
}
