// ─── MCP bridge (backend side) ───────────────────────────────────────────────
// A command queue that connects the external stdio MCP server (apps/mcp/server.mjs)
// to the running editor webview. It replaces the old Vite dev-server middleware, so
// the app is fully self-contained — no dev server required.
//
//   stdio MCP server ──HTTP POST /mcp/cmd──▶ [ Bridge queue ] ◀──invoke mcp_poll──── webview
//                     ◀──── result ─────────                  ────invoke mcp_result─▶
//
// The HTTP endpoint (default 127.0.0.1:5174, override with SLOPWARS_BRIDGE_PORT)
// holds each request open until the webview executes the command and posts the
// result back, mirroring the original long-poll semantics.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

pub struct PendingCmd {
    pub id: String,
    pub cmd: Value,
}

/// Shared queue between the HTTP endpoint and the webview commands.
pub struct Bridge {
    pending: Mutex<Vec<PendingCmd>>,
    results: Mutex<HashMap<String, Value>>,
    seq: AtomicU64,
}

impl Bridge {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            results: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }

    /// Enqueue a command and return its generated id.
    fn enqueue(&self, cmd: Value) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let id = format!("c{n}_{ts:x}");
        self.pending.lock().unwrap().push(PendingCmd {
            id: id.clone(),
            cmd,
        });
        id
    }

    fn drop_pending(&self, id: &str) {
        self.pending.lock().unwrap().retain(|p| p.id != id);
    }

    fn take_result(&self, id: &str) -> Option<Value> {
        self.results.lock().unwrap().remove(id)
    }
}

// ── webview-facing Tauri commands ────────────────────────────────────────────

#[tauri::command]
pub fn mcp_poll(bridge: State<'_, Arc<Bridge>>) -> Vec<Value> {
    let mut pending = bridge.pending.lock().unwrap();
    let drained: Vec<PendingCmd> = std::mem::take(&mut *pending);
    drained
        .into_iter()
        .map(|p| json!({ "id": p.id, "cmd": p.cmd }))
        .collect()
}

#[tauri::command]
pub fn mcp_result(bridge: State<'_, Arc<Bridge>>, id: String, result: Value) {
    bridge.results.lock().unwrap().insert(id, result);
}

// ── HTTP endpoint for the external stdio MCP server ──────────────────────────

/// Spawn the bridge HTTP server on a background thread.
pub fn start_http(bridge: Arc<Bridge>) {
    let port: u16 = std::env::var("SLOPWARS_BRIDGE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5174);
    let addr = format!("127.0.0.1:{port}");

    std::thread::spawn(move || {
        let server = match tiny_http::Server::http(&addr) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[mcp] could not bind {addr}: {e} (is another editor running?)");
                return;
            }
        };
        eprintln!("[mcp] bridge listening on http://{addr}");
        for mut request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().split('?').next().unwrap_or("").to_string();

            if method == tiny_http::Method::Post && url == "/mcp/cmd" {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    respond(request, 400, &json!({ "error": "bad body" }));
                    continue;
                }
                let cmd: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
                let id = bridge.enqueue(cmd);
                let started = Instant::now();
                loop {
                    if let Some(result) = bridge.take_result(&id) {
                        respond(request, 200, &json!({ "ok": true, "result": result }));
                        break;
                    }
                    if started.elapsed() > Duration::from_secs(15) {
                        bridge.drop_pending(&id);
                        respond(
                            request,
                            504,
                            &json!({ "error": "editor did not respond — is the editor window open?" }),
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
            } else if method == tiny_http::Method::Get && url == "/mcp/health" {
                respond(request, 200, &json!({ "ok": true }));
            } else {
                respond(request, 404, &json!({ "error": "not found" }));
            }
        }
    });
}

fn respond(request: tiny_http::Request, code: u16, body: &Value) {
    let data = body.to_string();
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..])
        .expect("valid header");
    let response = tiny_http::Response::from_string(data)
        .with_status_code(code)
        .with_header(header);
    let _ = request.respond(response);
}
