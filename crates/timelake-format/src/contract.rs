//! The Timelake table contract (SPEC §7.1): which column is time, which columns identify a series,
//! and the layout/maintenance policy derived from them. Stored as `timelake.*` Iceberg table
//! properties (see [`property`]), so the contract travels with the table and other
//! engines simply ignore it.

use std::collections::HashMap;
use std::fmt;
use std::str::FromStr;
use std::time::Duration;

use chrono::Datelike;

use crate::{FormatError, Result, property};

const HOUR_MICROS: i64 = 3_600_000_000;
const DAY_MICROS: i64 = 24 * HOUR_MICROS;
const DAY_SECS: u64 = 86_400;

/// Time partition granularity, like TimescaleDB's `chunk_time_interval`.
///
/// Parses from `hour`, `day` or `month` (and spellings such as `1h`, `1 day`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Chunk {
    /// One partition per hour.
    Hour,
    /// One partition per day (the default).
    Day,
    /// One partition per calendar month.
    Month,
}

impl Chunk {
    /// The canonical name, as stored in the table properties.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
            Self::Month => "month",
        }
    }

    /// Iceberg transform value (hours/days/months since the epoch) of a timestamp in microseconds.
    pub fn value(self, micros: i64) -> Result<i32> {
        let out_of_range = || FormatError::new(format!("timestamp {micros}µs is out of range for {self} partitions"));
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
        start.ok_or_else(|| self.out_of_range(value))
    }

    /// End (exclusive) of a partition, in microseconds since the epoch.
    pub fn end_micros(self, value: i32) -> Result<i64> {
        self.start_micros(value.checked_add(1).ok_or_else(|| self.out_of_range(value))?)
    }

    /// Human-readable partition value, used in data file paths (`time_day=2026-01-01`). Values
    /// outside the supported time range fall back to the plain number.
    pub fn label(self, value: i32) -> String {
        let Some(t) = self.start_micros(value).ok().and_then(chrono::DateTime::from_timestamp_micros) else {
            return value.to_string();
        };
        let format = match self {
            Self::Hour => "%Y-%m-%d-%H",
            Self::Day => "%Y-%m-%d",
            Self::Month => "%Y-%m",
        };
        t.format(format).to_string()
    }

    fn out_of_range(self, value: i32) -> FormatError {
        FormatError::new(format!("{self} partition {value} is out of range"))
    }
}

impl FromStr for Chunk {
    type Err = FormatError;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "hour" | "1h" | "1 hour" => Ok(Self::Hour),
            "day" | "1d" | "1 day" | "24h" => Ok(Self::Day),
            "month" | "1 month" => Ok(Self::Month),
            other => Err(FormatError::new(format!("chunk interval must be hour, day or month, got {other:?}"))),
        }
    }
}

impl fmt::Display for Chunk {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Options for creating a table. Only `time_column` is required for a time-series table; leave it
/// unset for a plain (dimension) table such as device metadata.
#[derive(Clone, Debug, Default)]
pub struct TableOptions {
    /// The timestamp column; makes the table a time-series table.
    pub time_column: Option<String>,
    /// Columns that identify a series (e.g. `device_id`); requires a time column.
    pub series_key: Vec<String>,
    /// Time partition size (default: [`Chunk::Day`]).
    pub chunk: Option<Chunk>,
    /// Remove duplicate `(series_key, time)` rows during compaction (default: on with a series key).
    pub dedup: Option<bool>,
    /// Drop partitions entirely older than this.
    pub retention: Option<Duration>,
    /// Extra Iceberg/Timelake table properties.
    pub properties: HashMap<String, String>,
}

/// The parsed contract of an existing table.
#[derive(Clone, Debug)]
pub struct Contract {
    /// The timestamp column, if this is a time-series table.
    pub time_column: Option<String>,
    /// Columns that identify a series.
    pub series_key: Vec<String>,
    /// Time partition size.
    pub chunk: Option<Chunk>,
    /// Remove rows with the same `(series_key, time)` during compaction; the latest write wins.
    pub dedup: bool,
    /// Partitions entirely older than this are dropped by maintenance.
    pub retention: Option<Duration>,
    /// Compaction writes files of about this size.
    pub target_file_size: u64,
    /// Rows per Parquet row group.
    pub row_group_rows: usize,
    /// Appends run inline maintenance when thresholds are crossed.
    pub auto_maintain: bool,
    /// Snapshots younger than this are kept.
    pub snapshot_retention: Duration,
    /// The newest snapshots kept regardless of age.
    pub min_snapshots: usize,
    /// Snapshots beyond the newest `max_snapshots` are expired even if younger than the retention.
    pub max_snapshots: usize,
    /// Inline auto-maintenance merges a size tier of a partition once it has this many files.
    pub compact_min_files: usize,
}

impl Contract {
    /// Defaults for properties a table doesn't set.
    const DEFAULT_TARGET_FILE_SIZE: u64 = 256 << 20;
    const DEFAULT_ROW_GROUP_ROWS: usize = 1 << 20;
    const DEFAULT_SNAPSHOT_RETENTION: Duration = Duration::from_secs(3600);
    const DEFAULT_MIN_SNAPSHOTS: usize = 5;
    const DEFAULT_MAX_SNAPSHOTS: usize = 100;
    const DEFAULT_COMPACT_MIN_FILES: usize = 8;

    /// Reads the contract from Iceberg table properties, with defaults for what isn't set.
    pub fn from_properties(properties: &HashMap<String, String>) -> Result<Self> {
        let p = Properties(properties);
        Ok(Self {
            time_column: p.get(property::TIME_COLUMN).map(str::to_string),
            series_key: p
                .get(property::SERIES_KEY)
                .map(|s| s.split(',').map(str::trim).filter(|c| !c.is_empty()).map(str::to_string).collect())
                .unwrap_or_default(),
            chunk: p.get(property::CHUNK).map(str::parse).transpose()?,
            dedup: p.flag(property::DEDUP, false)?,
            retention: p.duration(property::RETENTION)?,
            target_file_size: p.number(property::TARGET_FILE_SIZE, Self::DEFAULT_TARGET_FILE_SIZE)?,
            row_group_rows: p.number(property::ROW_GROUP_ROWS, Self::DEFAULT_ROW_GROUP_ROWS)?,
            auto_maintain: p.flag(property::AUTO_MAINTAIN, true)?,
            snapshot_retention: p.duration(property::SNAPSHOT_RETENTION)?.unwrap_or(Self::DEFAULT_SNAPSHOT_RETENTION),
            min_snapshots: p.number(property::MIN_SNAPSHOTS, Self::DEFAULT_MIN_SNAPSHOTS)?,
            max_snapshots: p.number(property::MAX_SNAPSHOTS, Self::DEFAULT_MAX_SNAPSHOTS)?,
            compact_min_files: p.number(property::COMPACT_MIN_FILES, Self::DEFAULT_COMPACT_MIN_FILES)?,
        })
    }

    /// Whether the table has a time column.
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

/// Typed access to table properties; blank values count as unset.
struct Properties<'a>(&'a HashMap<String, String>);

impl Properties<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).map(|s| s.trim()).filter(|s| !s.is_empty())
    }

    fn number<T: FromStr>(&self, key: &str, default: T) -> Result<T> {
        self.get(key).map_or(Ok(default), |s| {
            s.parse().map_err(|_| FormatError::new(format!("{key} must be a non-negative integer, got {s:?}")))
        })
    }

    fn flag(&self, key: &str, default: bool) -> Result<bool> {
        self.get(key).map_or(Ok(default), |s| {
            s.to_ascii_lowercase()
                .parse()
                .map_err(|_| FormatError::new(format!("{key} must be true or false, got {s:?}")))
        })
    }

    fn duration(&self, key: &str) -> Result<Option<Duration>> {
        self.get(key).map(parse_duration).transpose()
    }
}

/// Parses durations like `90d`, `12h`, `30m`, `45s`, `2w`, `1y`, or spelled out (`1 day`, `3 hours`).
pub fn parse_duration(s: &str) -> Result<Duration> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
    let (n, unit) = s.split_at(split);
    let n: u64 = n.parse().map_err(|_| FormatError::new(format!("bad duration {s:?}")))?;
    let unit_secs = match unit.trim().to_ascii_lowercase().as_str() {
        "s" | "sec" | "secs" | "second" | "seconds" => 1,
        "m" | "min" | "mins" | "minute" | "minutes" => 60,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3600,
        "d" | "day" | "days" => DAY_SECS,
        "w" | "week" | "weeks" => 7 * DAY_SECS,
        "y" | "year" | "years" => 365 * DAY_SECS,
        _ => return Err(FormatError::new(format!("bad duration unit in {s:?} (use s, m, h, d, w, y)"))),
    };
    let secs = n.checked_mul(unit_secs).ok_or_else(|| FormatError::new(format!("duration {s:?} is too long")))?;
    Ok(Duration::from_secs(secs))
}

/// Formats whole seconds of a duration in the largest exact unit (`90d`, `36h`, `45s`), the
/// inverse of [`parse_duration`].
pub fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    match [(DAY_SECS, 'd'), (3600, 'h'), (60, 'm')]
        .into_iter()
        .find(|(unit, _)| secs != 0 && secs.is_multiple_of(*unit))
    {
        Some((unit, suffix)) => format!("{}{suffix}", secs / unit),
        None => format!("{secs}s"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::property::*;

    const T: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z

    #[test]
    fn chunk_values_round_trip() {
        for c in [Chunk::Hour, Chunk::Day, Chunk::Month] {
            let v = c.value(T + 1).unwrap();
            assert_eq!(c.start_micros(v).unwrap(), T, "{c:?}");
            assert!(c.end_micros(v).unwrap() > T);
        }
        assert_eq!(Chunk::Day.label(Chunk::Day.value(T).unwrap()), "2026-01-01");
        assert_eq!(Chunk::Hour.label(Chunk::Hour.value(T).unwrap()), "2026-01-01-00");
        assert_eq!(Chunk::Month.label(Chunk::Month.value(T).unwrap()), "2026-01");
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
    fn chunk_parses_and_displays() {
        for (s, c) in [("hour", Chunk::Hour), (" 1 Day ", Chunk::Day), ("24h", Chunk::Day), ("month", Chunk::Month)] {
            assert_eq!(s.parse::<Chunk>().unwrap(), c, "{s}");
        }
        assert!("week".parse::<Chunk>().is_err());
        for c in [Chunk::Hour, Chunk::Day, Chunk::Month] {
            assert_eq!(c.to_string().parse::<Chunk>().unwrap(), c);
        }
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

    #[test]
    fn durations_format_in_the_largest_exact_unit() {
        for (secs, s) in [(90 * 86_400, "90d"), (36 * 3600, "36h"), (90, "90s"), (120, "2m"), (0, "0s")] {
            assert_eq!(format_duration(Duration::from_secs(secs)), s);
            assert_eq!(parse_duration(s).unwrap().as_secs(), secs);
        }
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
        assert_eq!((c.min_snapshots, c.max_snapshots, c.compact_min_files), (5, 100, 8));
        assert!(c.sort_columns().is_empty());
    }

    #[test]
    fn contract_parses_properties() {
        let c = Contract::from_properties(&props(&[
            (TIME_COLUMN, "time"),
            (SERIES_KEY, "site, device,"),
            (CHUNK, "hour"),
            (DEDUP, "True"),
            (AUTO_MAINTAIN, "FALSE"),
            (RETENTION, "1 day"),
            (MIN_SNAPSHOTS, "3"),
            (TARGET_FILE_SIZE, " 1024 "),
        ]))
        .unwrap();
        assert_eq!(c.sort_columns(), ["site", "device", "time"]);
        assert_eq!(c.chunk, Some(Chunk::Hour));
        assert!(c.dedup && !c.auto_maintain);
        assert_eq!(c.retention, Some(Duration::from_secs(86_400)));
        assert_eq!((c.min_snapshots, c.target_file_size), (3, 1024));
    }

    #[test]
    fn contract_rejects_bad_values() {
        for kv in [(DEDUP, "yes"), (AUTO_MAINTAIN, "0"), (CHUNK, "week"), (RETENTION, "forever"), (MAX_SNAPSHOTS, "-1")]
        {
            assert!(Contract::from_properties(&props(&[kv])).is_err(), "{kv:?}");
        }
    }
}
