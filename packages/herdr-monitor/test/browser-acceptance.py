"""Visible Chrome DevTools MCP acceptance. Requires an explicitly granted browser slot.

Start a fresh synthetic monitor on loopback, then run with --bridge /path/to/mcp.py
--page-id N --url http://127.0.0.1:4319. The bridge must target foreground native
Chromium. Uses existing tabs only; publisher/view keys must be synthetic fixtures.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

parser = argparse.ArgumentParser()
parser.add_argument("--bridge", required=True)
parser.add_argument("--page-id", required=True, type=int)
parser.add_argument("--window-address", required=True)
parser.add_argument("--url", default="http://127.0.0.1:4319")
args = parser.parse_args()
package = Path(__file__).resolve().parents[1]


def call(name, **arguments):
    assert re.fullmatch(r"0x[0-9a-f]+", args.window_address), "Invalid compositor address"
    subprocess.run(["hyprctl", "dispatch", 'hl.dsp.focus({ window = "address:' + args.window_address + '" })'], check=True, capture_output=True)
    active = json.loads(subprocess.check_output(["hyprctl", "activewindow", "-j"], text=True))
    assert active.get("address") == args.window_address and active.get("visible") and "chrom" in active.get("class", "").lower(), "Foreground Chromium required"
    result = json.loads(subprocess.check_output(["python3", args.bridge, "call"], input=json.dumps({"name": name, "arguments": arguments}), text=True))
    assert not result.get("error"), result
    value = result["result"]
    assert not value.get("isError"), value
    return "\n".join(item.get("text", "") for item in value.get("content", []))


def evaluate(source):
    text = call("evaluate_script", function=source)
    return json.loads(re.search(r"```json\n(.*?)\n```", text, re.S).group(1))


def panel(message):
    evaluate("() => { const p=document.getElementById('validation') || document.body.appendChild(document.createElement('aside')); p.id='validation'; Object.assign(p.style,{position:'fixed',bottom:'8px',right:'8px',zIndex:'99999',background:'#fff',color:'#111',padding:'10px',border:'3px solid #075EBC',maxWidth:'300px',font:'14px system-ui'}); p.textContent=" + json.dumps(message) + "; return true; }")
    print(message, flush=True)


def uid(role, name):
    text = call("take_snapshot")
    return re.search(r'uid=(\S+) ' + role + ' "' + re.escape(name) + '"', text).group(1)


def login():
    call("fill_form", elements=[{"uid": uid("textbox", "Board"), "value": "main"}, {"uid": uid("textbox", "View key"), "value": "view_" + "v" * 43}])
    call("press_key", key="Enter")


try:
    call("select_page", pageId=args.page_id, bringToFront=True)
    call("navigate_page", type="url", url=args.url)
    call("emulate", viewport="820x1180x1,touch")
    panel("RUNNING: locked → keyboard login → empty board")
    assert evaluate("() => document.getElementById('connection').textContent") == "Locked"
    call("fill", uid=uid("textbox", "Board"), value="invalid/board")
    assert evaluate("() => !document.getElementById('board').checkValidity()")
    login()
    call("wait_for", text=["No published data"], timeout=15000)
    assert evaluate("() => !document.getElementById('lock').hidden && document.activeElement.id === 'lock'")
    now = int(time.time() * 1000)
    snapshot = {"version": 1, "boardId": "main", "sequence": now, "sourceAt": now, "title": "Synthetic acceptance", "agents": [{"id": "builder", "name": "<img src=x onerror=alert(1)>", "task": "Read-only status board", "state": "blocked", "status": "Published text only", "blocker": "Awaiting review", "jiraKey": "DEMO-42", "branch": "feat/example", "pullRequest": "Example #42", "clockify": {"source": "clockify", "seconds": 1800, "observedAt": now}, "elapsedSeconds": 2400}]}
    with tempfile.TemporaryDirectory(prefix="monitor-browser-") as folder:
        path = Path(folder) / "snapshot.json"
        path.write_text(json.dumps(snapshot))
        subprocess.run(["node", str(package / "dist/cli.js"), "publish", str(path)], env={**os.environ, "MONITOR_ORIGIN": args.url, "MONITOR_PUBLISH_TOKEN": "publish_" + "p" * 43}, check=True, capture_output=True)
    panel("RUNNING: explicit publication, text safety, Clockify vs elapsed")
    call("wait_for", text=["Synthetic acceptance"], timeout=15000)
    assert evaluate("() => document.querySelectorAll('#agents img, #agents a').length === 0 && document.getElementById('agents').textContent.includes('<img src=x onerror=alert(1)>') && document.getElementById('agents').textContent.includes('0h 30m') && document.getElementById('agents').textContent.includes('0h 40m')")
    for width, height in [(820, 1180), (390, 844), (1180, 820)]:
        call("emulate", viewport=f"{width}x{height}x1,touch")
        panel(f"RUNNING: responsive {width}×{height}, keyboard focus and contrast")
        assert evaluate("() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.agent')].every(n=>n.getBoundingClientRect().right <= innerWidth)")
    report = call("lighthouse_audit", mode="snapshot", device="desktop")
    assert "Accessibility: 100" in report, report
    panel("RUNNING: offline state keeps Lock reachable")
    call("emulate", networkConditions="Offline", viewport="1180x820x1,touch")
    call("wait_for", text=["Offline"], timeout=20000)
    assert evaluate("() => !document.getElementById('lock').hidden && document.getElementById('board-view').hidden")
    call("click", uid=uid("button", "Lock board"))
    assert evaluate("() => !document.querySelector('main').textContent.includes('Synthetic acceptance') && !document.querySelector('main').textContent.includes('DEMO-42') && document.activeElement.id === 'credential' && localStorage.length === 0 && sessionStorage.length === 0 && document.cookie === ''")
    call("emulate", viewport="1180x820x1,touch")
    panel("RUNNING: reconnect, receipt-time stale state, no secret persistence")
    login()
    call("wait_for", text=["Synthetic acceptance"], timeout=15000)
    # Two bounded waits keep the current check visible throughout natural ageing.
    for attempt in range(2):
        try:
            call("wait_for", text=["Stale"], timeout=45000)
            break
        except AssertionError:
            if attempt == 1:
                raise
            panel("RUNNING: waiting for server receipt-time stale threshold")
    assert evaluate("() => document.getElementById('connection').textContent.startsWith('Stale')")
    console = call("list_console_messages", types=["error", "warn"])
    # Offline network errors are induced deliberately. All other console errors fail.
    for line in console.splitlines():
        if "msgid=" in line:
            assert "ERR_INTERNET_DISCONNECTED" in line, line
    network = call("list_network_requests", resourceTypes=["fetch", "xhr", "websocket"])
    assert "websocket" not in network.lower()
    panel("PASS: empty/login/publish/text safety; 390×844, 820×1180, 1180×820; keyboard Lock/reconnect; stale/offline; a11y100; only expected offline network errors. Desktop Chromium, not iPad hardware.")
except Exception:
    panel("FAIL: visible monitor acceptance. See test output; no acceptance claimed.")
    raise
