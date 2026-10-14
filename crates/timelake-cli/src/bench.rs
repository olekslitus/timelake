//! Benchmark mode of `timelake sql` (used by the benchmark scripts).

use std::io::{Read, Write};
use std::time::Instant;

use anyhow::{Context, Result};
use timelake::Session;
use timelake::arrow::array::RecordBatch;

/// Runs `sql` 1 + `runs` times and prints `{"times": [...], "rows": n, "setup_s": s}` as JSON,
/// with request and byte counts per run when an s3proxy admin address is given.
pub(crate) async fn run(session: &Session, sql: &str, runs: usize, setup_s: f64, proxy: Option<&str>) -> Result<()> {
    let (mut times, mut requests, mut bytes, mut rows) = (vec![], vec![], vec![], 0usize);
    for _ in 0..=runs {
        let before = proxy.map(proxy_stats).transpose()?;
        let started = Instant::now();
        let batches = session.sql(sql).await?.collect().await?;
        times.push(started.elapsed().as_secs_f64());
        rows = batches.iter().map(RecordBatch::num_rows).sum();
        if let (Some((r0, b0)), Some(p)) = (before, proxy) {
            let (r1, b1) = proxy_stats(p)?;
            requests.push(r1 - r0);
            bytes.push(b1 - b0);
        }
    }
    let mut out = serde_json::json!({ "times": times, "rows": rows, "setup_s": setup_s });
    if proxy.is_some() {
        out["requests"] = requests.into();
        out["bytes"] = bytes.into();
    }
    println!("{out}");
    Ok(())
}

/// `(requests, bytes)` counters from tools/s3proxy's admin endpoint.
fn proxy_stats(addr: &str) -> Result<(u64, u64)> {
    let mut s = std::net::TcpStream::connect(addr)?;
    write!(s, "GET /stats HTTP/1.0\r\nHost: {addr}\r\n\r\n")?;
    let mut resp = String::new();
    s.read_to_string(&mut resp)?;
    let body = resp.split("\r\n\r\n").nth(1).context("bad proxy response")?;
    let v: serde_json::Value = serde_json::from_str(body.trim())?;
    Ok((v["requests"].as_u64().unwrap_or(0), v["bytes"].as_u64().unwrap_or(0)))
}
