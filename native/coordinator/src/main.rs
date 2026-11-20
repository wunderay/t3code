use serde_json::{Value, json};
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};
use t3_coordinator::{
    Error, Supervisor,
    model::{MAX_INPUT_BYTES, PROTOCOL_VERSION},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("coordinator: {}", error.message);
        std::process::exit(1);
    }
}

fn run() -> Result<(), Error> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--database")) {
        return Err(Error::invalid(
            "Usage: t3-coordinator --database <supervisor-owned.sqlite>",
        ));
    }
    let path = PathBuf::from(
        args.next()
            .ok_or_else(|| Error::invalid("Missing database path"))?,
    );
    if args.next().is_some() {
        return Err(Error::invalid("Unexpected argument"));
    }
    let mut supervisor = Supervisor::open(&path)?;
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut line = Vec::with_capacity(8192);
    loop {
        line.clear();
        let mut oversized = false;
        loop {
            let bytes = input.fill_buf().map_err(Error::internal)?;
            if bytes.is_empty() {
                break;
            }
            let length = bytes
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |i| i + 1);
            let finished = bytes[length - 1] == b'\n';
            if line.len() + length > MAX_INPUT_BYTES {
                oversized = true;
            }
            if !oversized {
                line.extend_from_slice(&bytes[..length]);
            }
            input.consume(length);
            if finished {
                break;
            }
        }
        if line.is_empty() && !oversized {
            break;
        }
        let request = if oversized {
            Err(Error::invalid("Request exceeds 1 MiB"))
        } else {
            serde_json::from_slice::<Value>(&line).map_err(|_| Error::parse("Invalid JSON request"))
        };
        let (id, response) = match request {
            Err(error) => (Value::Null, Err(error)),
            Ok(request) => {
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                let response = if request
                    .get("protocolVersion")
                    .is_some_and(|v| v.as_u64() != Some(u64::from(PROTOCOL_VERSION)))
                {
                    Err(Error::invalid("Unsupported protocolVersion"))
                } else if let Some(method) = request.get("method").and_then(Value::as_str) {
                    supervisor.call(
                        method,
                        request.get("params").cloned().unwrap_or_else(|| json!({})),
                    )
                } else {
                    Err(Error::invalid("Missing method"))
                };
                (id, response)
            }
        };
        let envelope = match response {
            Ok(result) => json!({"id":id,"result":result}),
            Err(error) => json!({"id":id,"error":error}),
        };
        serde_json::to_writer(&mut output, &envelope).map_err(Error::internal)?;
        output.write_all(b"\n").map_err(Error::internal)?;
        output.flush().map_err(Error::internal)?;
    }
    Ok(())
}
