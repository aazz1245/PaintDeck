//! 跟舊版 Python 行為對齊的小工具：真值判斷、`a or b`、json.dumps 的輸出格式、time.time()。
use serde::Serialize;
use serde_json::Value;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

/// Python 真值：None、False、0、""、[]、{} 為假
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0).unwrap_or(false),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

/// Python `a or b`：a 為真就是 a，不然就是 b（b 可能也是假值）
pub fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) {
        a
    } else {
        b
    }
}

/// json.dumps(v, ensure_ascii=False)：分隔符是 ", " 與 ": "，中文不跳脫
pub fn dumps(v: &Value) -> String {
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, PyFormatter);
    v.serialize(&mut ser).expect("寫進記憶體不會失敗");
    String::from_utf8(out).expect("serde_json 只會寫出 UTF-8")
}

struct PyFormatter;
impl serde_json::ser::Formatter for PyFormatter {
    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        w: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            w.write_all(b", ")
        }
    }
    fn begin_object_value<W: ?Sized + io::Write>(&mut self, w: &mut W) -> io::Result<()> {
        w.write_all(b": ")
    }
}

/// Python int(x)：整數、小數（捨去）、bool、整數寫法的字串；其他（None、"1.5"、清單…）回 None
pub fn int(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|x| x.is_finite())
                .map(|x| x.trunc() as i64)
        }),
        Value::Bool(b) => Some(*b as i64),
        Value::String(s) => s.trim().replace('_', "").parse().ok(),
        _ => None,
    }
}

/// Python float(x)
pub fn float(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::Bool(b) => Some(*b as i64 as f64),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// time.time()
pub fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// round(x, n)：照十進位取 n 位（跟 Python 一樣以實際的二進位值為準）
pub fn round(x: f64, n: usize) -> f64 {
    format!("{x:.n$}").parse().unwrap_or(x)
}

/// str.isspace()：比 Rust 的空白多了 \x1c～\x1f（檔案／群組／記錄／單元分隔字元）
pub fn is_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// str.strip()
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// " ".join(s.split())：連續空白縮成一個空格、去頭尾
pub fn squash(s: &str) -> String {
    s.split(is_space)
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// repr(float)：最短寫法；指數寫法跟 Python 一樣帶正負號、至少兩位（1e+16、1.5e-07）
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let a = x.abs();
    if a != 0.0 && !(1e-4..1e16).contains(&a) {
        let s = format!("{x:e}"); // 1e16、1.5e-7
        let (m, e) = s.split_once('e').unwrap_or((&s, "0"));
        let (sign, digits) = e.strip_prefix('-').map(|d| ("-", d)).unwrap_or(("+", e));
        return format!("{m}e{sign}{digits:0>2}");
    }
    let s = format!("{x}");
    if s.contains('.') {
        s
    } else {
        format!("{s}.0")
    }
}

fn str_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut out = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\x{:02x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// repr(x)：json.loads 讀出來的值在 Python 裡的樣子（字串用單引號、None、True…）
pub fn repr(v: &Value) -> String {
    match v {
        Value::String(s) => str_repr(s),
        Value::Array(a) => format!("[{}]", a.iter().map(repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!(
            "{{{}}}",
            o.iter()
                .map(|(k, v)| format!("{}: {}", str_repr(k), repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        other => str_of(other),
    }
}

/// str(x)：字串原樣，其他同 repr
pub fn str_of(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(b) => {
            if *b {
                "True".into()
            } else {
                "False".into()
            }
        }
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => float_repr(n.as_f64().unwrap_or(f64::NAN)),
        },
        Value::String(s) => s.clone(),
        other => repr(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn dumps_like_python() {
        // Python: json.dumps({"a": [1, 2.0, "中"], "b": None}, ensure_ascii=False)
        assert_eq!(
            dumps(&json!({"a": [1, 2.0, "中"], "b": null})),
            r#"{"a": [1, 2.0, "中"], "b": null}"#
        );
    }

    #[test]
    fn str_like_python() {
        // Python: str(2.0), str(1e16), str(1.5e-7), str(0.0001), str(True), repr(["a'", None, {"k": 1.5}])
        assert_eq!(str_of(&json!(2.0)), "2.0");
        assert_eq!(str_of(&json!(1e16)), "1e+16");
        assert_eq!(str_of(&json!(1.5e-7)), "1.5e-07");
        assert_eq!(str_of(&json!(0.0001)), "0.0001");
        assert_eq!(str_of(&json!(true)), "True");
        assert_eq!(
            str_of(&json!(["a'", null, {"k": 1.5}])),
            r#"["a'", None, {'k': 1.5}]"#
        );
        assert_eq!(squash(" a\t b\x1c c\u{3000}d \n"), "a b c d");
        assert_eq!(round(2.675, 2), 2.67); // 二進位其實是 2.67499…，Python 也是 2.67
    }

    #[test]
    fn or_like_python() {
        let (zero, s) = (json!(0), json!("x"));
        assert_eq!(or(Some(&zero), Some(&s)), Some(&s));
        assert_eq!(or(Some(&s), Some(&zero)), Some(&s));
        assert_eq!(or(None, Some(&zero)), Some(&zero));
    }
}
