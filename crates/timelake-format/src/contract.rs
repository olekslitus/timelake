//! The Timelake table contract (SPEC §7.1): which column is time, which columns identify a series,
//! and the layout/maintenance policy derived from them. Stored as `timelake.*` Iceberg table
//! properties, so the contract travels with the table and other engines simply ignore it.

use std::collections::HashMap;
use std::time::Duration;

use chrono::Datelike;

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
    pub fn value(self, micros: i64) -> Result<i32> {
        let out_of_range = || invalid(format!("timestamp {micros}µs is out of range for {} partitions", self.as_str()));
        let t = chrono::DateTime::from_timestamp_micros(micros).ok_or_else(out_of_range)?;
        let v = match self {
            Self::Hour => micros.div_euclid(HOUR_MICROS),
            Self::Day => micros.div_euclid(DAY_MICROS),
            Self::Month => (i64::from(t.year()) - 1970) * 12 + i64::from(t.month0()),
        };
        i32::try_from(v).map_err(|_| out_of_range())
    }

    /// Start of a partition, in microseconds since the epoch.
    pub fn start_micros(self, value: i32) -> Result<i64> {
        let start = match self {
            Self::Hour => Some(i64::from(value) * HOUR_MICROS),
            Self::Day => i64::from(value).checked_mul(DAY_MICROS),
            Self::Month => {
                let (year, month0) = (1970 + value.div_euclid(12), value.rem_euclid(12).unsigned_abs());
                chrono::NaiveDate::from_ymd_opt(year, month0 + 1, 1)
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|t| t.and_utc().timestamp_micros())
            }
        };
        start.ok_or_else(|| invalid(format!("{} partition {value} is out of range", self.as_str())))
    }

    /// End (exclusive) of a partition, in microseconds since the epoch.
    pub fn end_micros(self, value: i32) -> Result<i64> {
        let next = value
            .checked_add(1)
            .ok_or_else(|| invalid(format!("{} partition {value} is out of range", self.as_str())))?;
        self.start_micros(next)
    }

    /// Human-readable partition value, used in data file paths (`time_day=2026-01-01`). Values
    /// outside the supported time range fall back to the plain number.
    pub fn label(self, value: i32) -> String {
        let Some(t) = self.start_micros(value).ok().and_then(chrono::DateTime::from_timestamp_micros) else {
            return value.to_string();
        };
        match self {
            Self::Hour => t.format("%Y-%m-%d-%H").to_string(),
            Self::Day => t.format("%Y-%m-%d").to_string(),
            Self::Month => t.format("%Y-%m").to_string(),
        }
    }
}

const HOUR_MICROS: i64 = 3_600_000_000;
const DAY_MICROS: i64 = 24 * HOUR_MICROS;

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
        let parse_bool = |k: &str, d: bool| -> Result<bool> {
            get(k)
                .map(|s| {
                    s.to_ascii_lowercase().parse().map_err(|_| invalid(format!("{k} must be true or false, got {s:?}")))
                })
                .unwrap_or(Ok(d))
        };
        let series_key = get(P_SERIES_KEY)
            .map(|s| s.split(',').map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect())
            .unwrap_or_default();
        Ok(Self {
            time_column: get(P_TIME_COLUMN).map(str::to_string),
            dedup: parse_bool(P_DEDUP, false)?,
            series_key,
            chunk: get(P_CHUNK).map(Chunk::parse).transpose()?,
            retention: get(P_RETENTION).map(parse_duration).transpose()?,
            target_file_size: parse_u(P_TARGET_FILE_SIZE, 256 << 20)?,
            row_group_rows: parse_u(P_ROW_GROUP_ROWS, 1024 * 1024)? as usize,
            auto_maintain: parse_bool(P_AUTO_MAINTAIN, true)?,
            snapshot_retention: get(P_SNAPSHOT_RETENTION)
                .map(parse_duration)
                .transpose()?
                .unwrap_or(Duration::from_secs(3600)),
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

/// Parses durations like `90d`, `12h`, `30m`, `45s`, `2w`, `1y`, or spelled out (`1 day`, `3 hours`).
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (n, unit) = s.split_at(split);
    let n: u64 = n.parse().map_err(|_| invalid(format!("bad duration {s:?}")))?;
    let unit_secs = match unit.trim().to_ascii_lowercase().as_str() {
        "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => 86_400,
        "w" | "week" | "weeks" => 7 * 86_400,
        "y" | "year" | "years" => 365 * 86_400,
        _ => return Err(invalid(format!("bad duration unit in {s:?} (use s, m, h, d, w, y)"))),
    };
    let secs = n.checked_mul(unit_secs).ok_or_else(|| invalid(format!("duration {s:?} is too long")))?;
    Ok(Duration::from_secs(secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z

    #[test]
    fn chunk_values_round_trip() {
        for c in [Chunk::Hour, Chunk::Day, Chunk::Month] {
            let v = c.value(T + 1).unwrap();
            assert_eq!(c.start_micros(v).unwrap(), T, "{c:?}");
            assert!(c.end_micros(v).unwrap() > T);
        }
        assert_eq!(Chunk::Day.label(Chunk::Day.value(T).unwrap()), "2026-01-01");
        assert_eq!(Chunk::Month.value(T).unwrap(), (2026 - 1970) * 12);
        // Before the epoch, values are negative and still round down.
        assert_eq!(Chunk::Day.value(-1).unwrap(), -1);
        assert_eq!(Chunk::Month.value(-1).unwrap(), -1);
        assert_eq!(Chunk::Month.start_micros(-1).unwrap(), -31 * DAY_MICROS);
    }

    #[test]
    fn out_of_range_times_are_errors() {
        for c in [Chunk::Hour, Chunk::Day, Chunk::Month] {
            assert!(c.value(i64::MAX).is_err(), "{c:?}");
            assert!(c.value(i64::MIN).is_err(), "{c:?}");
        }
        assert!(Chunk::Day.start_micros(i32::MAX).is_err());
        assert!(Chunk::Month.start_micros(i32::MAX).is_err());
        assert!(Chunk::Hour.end_micros(i32::MAX).is_err());
        assert_eq!(Chunk::Month.label(i32::MAX), i32::MAX.to_string());
    }

    #[test]
    fn durations() {
        assert_eq!(parse_duration("90d").unwrap().as_secs(), 90 * 86_400);
        assert_eq!(parse_duration("1h").unwrap().as_secs(), 3600);
        assert_eq!(parse_duration(" 0s ").unwrap(), Duration::ZERO);
        assert!(parse_duration("1 parsec").is_err());
        assert!(parse_duration("d").is_err());
        assert!(parse_duration("-1d").is_err());
    }

    #[test]
    fn durations_accept_singular_and_plural_units() {
        assert_eq!(parse_duration("1 day").unwrap().as_secs(), 86_400);
        assert_eq!(parse_duration("1 hour").unwrap().as_secs(), 3600);
        assert_eq!(parse_duration("1 week").unwrap().as_secs(), 7 * 86_400);
        assert_eq!(parse_duration("2 Weeks").unwrap().as_secs(), 14 * 86_400);
        assert_eq!(parse_duration("1 minute").unwrap().as_secs(), 60);
        assert_eq!(parse_duration("1 year").unwrap().as_secs(), 365 * 86_400);
    }

    #[test]
    fn duration_overflow_is_an_error() {
        assert!(parse_duration("99999999999999999y").is_err());
        assert!(parse_duration("99999999999999999999s").is_err());
    }

    fn props(kv: &[(&str, &str)]) -> HashMap<String, String> {
        kv.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
    }

    #[test]
    fn contract_defaults() {
        let c = Contract::from_properties(&HashMap::new()).unwrap();
        assert!(!c.is_time_series() && !c.dedup && c.auto_maintain);
        assert_eq!(c.retention, None);
        assert_eq!(c.snapshot_retention, Duration::from_secs(3600));
        assert!(c.sort_columns().is_empty());
    }

    #[test]
    fn contract_parses_properties() {
        let c = Contract::from_properties(&props(&[
            (P_TIME_COLUMN, "time"),
            (P_SERIES_KEY, "site, device,"),
            (P_CHUNK, "hour"),
            (P_DEDUP, "True"),
            (P_AUTO_MAINTAIN, "FALSE"),
            (P_RETENTION, "1 day"),
            (P_MIN_SNAPSHOTS, "3"),
        ]))
        .unwrap();
        assert_eq!(c.sort_columns(), ["site", "device", "time"]);
        assert_eq!(c.chunk, Some(Chunk::Hour));
        assert!(c.dedup && !c.auto_maintain);
        assert_eq!(c.retention, Some(Duration::from_secs(86_400)));
        assert_eq!(c.min_snapshots, 3);
    }

    #[test]
    fn contract_rejects_bad_values() {
        for kv in [
            (P_DEDUP, "yes"),
            (P_AUTO_MAINTAIN, "0"),
            (P_CHUNK, "week"),
            (P_RETENTION, "forever"),
            (P_MAX_SNAPSHOTS, "-1"),
        ] {
            assert!(Contract::from_properties(&props(&[kv])).is_err(), "{kv:?}");
        }
    }
}
