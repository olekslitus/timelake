//! Iceberg single-value serialization of column bounds (manifest `lower_bounds`/`upper_bounds`).
//! <https://iceberg.apache.org/spec/#binary-single-value-serialization>

/// A decoded bound. Timestamps and dates keep Iceberg's integer encoding (µs / days since epoch).
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum Bound {
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
}

/// Decodes a bound for an Iceberg primitive type name (`int`, `long`, `timestamptz`, `double`, …).
/// Unsupported types return `None` (and are then simply not used for pruning).
pub fn decode(iceberg_type: &str, bytes: &[u8]) -> Option<Bound> {
    let le4 = || bytes.get(..4).map(|b| [b[0], b[1], b[2], b[3]]);
    let le8 = || bytes.get(..8).map(|b| [b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]);
    Some(match iceberg_type {
        "boolean" => Bound::Bool(*bytes.first()? != 0),
        "int" | "date" => Bound::Int(i32::from_le_bytes(le4()?) as i64),
        "long" | "time" | "timestamp" | "timestamptz" | "timestamp_ns" | "timestamptz_ns" => {
            Bound::Int(i64::from_le_bytes(le8()?))
        }
        "float" => Bound::Float(f32::from_le_bytes(le4()?) as f64),
        "double" => Bound::Float(f64::from_le_bytes(le8()?)),
        "string" => Bound::Str(String::from_utf8(bytes.to_vec()).ok()?),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_primitives() {
        assert_eq!(decode("int", &7i32.to_le_bytes()), Some(Bound::Int(7)));
        assert_eq!(
            decode("timestamptz", &1_700_000_000_000_000i64.to_le_bytes()),
            Some(Bound::Int(1_700_000_000_000_000))
        );
        assert_eq!(decode("double", &1.5f64.to_le_bytes()), Some(Bound::Float(1.5)));
        assert_eq!(decode("string", b"truck_1"), Some(Bound::Str("truck_1".into())));
        assert_eq!(decode("decimal(10,2)", &[0]), None);
    }
}
