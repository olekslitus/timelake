//! Iceberg single-value serialization of column bounds (manifest `lower_bounds`/`upper_bounds`).
//! <https://iceberg.apache.org/spec/#binary-single-value-serialization>

/// A decoded bound. Timestamps and dates keep Iceberg's integer encoding (µs / days since epoch).
#[derive(Debug, Clone, PartialEq, PartialOrd)]
pub enum Bound {
    /// `boolean`.
    Bool(bool),
    /// `int`, `long`, `date`, `time` and timestamps.
    Int(i64),
    /// `float` and `double`.
    Float(f64),
    /// `string`.
    Str(String),
}

/// Decodes a bound for an Iceberg primitive type name (`int`, `long`, `timestamptz`, `double`, …).
/// Unsupported types return `None` (and are then simply not used for pruning).
pub fn decode(iceberg_type: &str, bytes: &[u8]) -> Option<Bound> {
    let le4 = || bytes.first_chunk::<4>().copied();
    let le8 = || bytes.first_chunk::<8>().copied();
    Some(match iceberg_type {
        "boolean" => Bound::Bool(*bytes.first()? != 0),
        "int" | "date" => Bound::Int(i32::from_le_bytes(le4()?).into()),
        "long" | "time" | "timestamp" | "timestamptz" | "timestamp_ns" | "timestamptz_ns" => {
            Bound::Int(i64::from_le_bytes(le8()?))
        }
        "float" => Bound::Float(f32::from_le_bytes(le4()?).into()),
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
        assert_eq!(decode("date", &(-1i32).to_le_bytes()), Some(Bound::Int(-1)));
        assert_eq!(
            decode("timestamptz", &1_700_000_000_000_000i64.to_le_bytes()),
            Some(Bound::Int(1_700_000_000_000_000))
        );
        assert_eq!(decode("double", &1.5f64.to_le_bytes()), Some(Bound::Float(1.5)));
        assert_eq!(decode("float", &0.5f32.to_le_bytes()), Some(Bound::Float(0.5)));
        assert_eq!(decode("boolean", &[1]), Some(Bound::Bool(true)));
        assert_eq!(decode("string", b"truck_1"), Some(Bound::Str("truck_1".into())));
        assert_eq!(decode("decimal(10,2)", &[0]), None);
    }

    #[test]
    fn short_input_is_none() {
        assert_eq!(decode("long", &[1, 2, 3]), None);
        assert_eq!(decode("int", &[]), None);
        assert_eq!(decode("boolean", &[]), None);
        assert_eq!(decode("string", &[0xff]), None);
    }
}
