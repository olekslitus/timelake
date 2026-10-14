//! The table format version, `timelake.format-version`: a semantic version of its own, separate
//! from the software's.

use std::fmt;
use std::str::FromStr;

use crate::{FormatError, Result};

/// A table format version, `MAJOR.MINOR.PATCH`. What a bump means for an older Timelake:
///
/// | Bump | Reads the table | Writes the table |
/// | --- | --- | --- |
/// | patch (0.2.0 → 0.2.1, 1.2.0 → 1.2.1) | yes | yes |
/// | minor from 1.0 (1.2 → 1.3) | yes | no |
/// | major from 1.0, minor before (0.2 → 0.3, 1.x → 2.0) | no | no |
///
/// Before 1.0 the minor version is the breaking one, as Cargo treats `0.y` crates.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FormatVersion {
    /// A newer major (from 1.0) breaks older readers.
    pub major: u32,
    /// A newer minor breaks older writers (from 1.0), or older readers and writers (before 1.0).
    pub minor: u32,
    /// A newer patch is compatible both ways.
    pub patch: u32,
}

impl FormatVersion {
    /// Tables written by Timelake 0.1 and 0.2, which recorded no version.
    pub const UNVERSIONED: Self = Self::new(0, 1, 0);

    /// `MAJOR.MINOR.PATCH`.
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    /// Whether a Timelake that knows format `known` reads a table of this format correctly.
    pub fn readable_by(self, known: Self) -> bool {
        self.breaking() <= known.breaking()
    }

    /// Whether a Timelake that knows format `known` may write to a table of this format without
    /// breaking what it relies on.
    pub fn writable_by(self, known: Self) -> bool {
        (self.major, self.minor) <= (known.major, known.minor)
    }

    /// The part of the version whose increase breaks older readers.
    fn breaking(self) -> (u32, u32) {
        if self.major == 0 { (0, self.minor) } else { (self.major, 0) }
    }
}

impl fmt::Display for FormatVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl FromStr for FormatVersion {
    type Err = FormatError;

    /// `MAJOR.MINOR.PATCH`, or the plain integer `N` that Timelake 0.3.0 wrote, read as `0.N.0`.
    fn from_str(s: &str) -> Result<Self> {
        let bad = || FormatError::new(format!("a format version is MAJOR.MINOR.PATCH, got {s:?}"));
        let parts = s.trim().split('.').map(str::parse).collect::<std::result::Result<Vec<u32>, _>>();
        match parts.map_err(|_| bad())?[..] {
            [major, minor, patch] => Ok(Self::new(major, minor, patch)),
            [legacy] => Ok(Self::new(0, legacy, 0)),
            _ => Err(bad()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> FormatVersion {
        s.parse().unwrap()
    }

    #[test]
    fn parses_semver_and_the_legacy_integer() {
        assert_eq!(v("0.2.0"), FormatVersion::new(0, 2, 0));
        assert_eq!(v(" 1.12.3 ").to_string(), "1.12.3");
        assert_eq!(v("2"), v("0.2.0"));
        assert_eq!(v("1"), FormatVersion::UNVERSIONED);
        for bad in ["", "1.2", "1.2.3.4", "v1.2.3", "1.-2.3"] {
            assert!(bad.parse::<FormatVersion>().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn compatibility_follows_the_bump() {
        let known = v("0.2.0");
        assert!(v("0.1.0").readable_by(known) && v("0.1.0").writable_by(known));
        assert!(v("0.2.5").readable_by(known) && v("0.2.5").writable_by(known));
        assert!(!v("0.3.0").readable_by(known) && !v("0.3.0").writable_by(known));
        assert!(!v("1.0.0").readable_by(known));

        let known = v("1.2.0");
        assert!(v("0.9.0").readable_by(known) && v("0.9.0").writable_by(known));
        assert!(v("1.2.7").writable_by(known));
        assert!(v("1.3.0").readable_by(known) && !v("1.3.0").writable_by(known));
        assert!(!v("2.0.0").readable_by(known) && !v("2.0.0").writable_by(known));
    }
}
