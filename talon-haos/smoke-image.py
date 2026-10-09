#!/usr/bin/env python3
"""Exercise the built HA image in disposable Docker fixtures, never a live HA.

Usage: python3 talon-haos/smoke-image.py talon-haos:ha-check
Requires a Linux Docker engine and Python 3. No host ports or existing volumes.
"""
import ast
import enum
import json
from pathlib import Path
import re
import subprocess
import sys
import time
import textwrap
from types import SimpleNamespace
from urllib.request import urlopen
import uuid

IMAGE = sys.argv[1]
ADDON_CONFIG = Path(__file__).resolve().with_name("config.yaml")
version_matches = re.findall(r'(?m)^version:\s*"?([0-9]+\.[0-9]+\.[0-9]+)"?\s*
PREFIX = "talon-smoke-" + uuid.uuid4().hex[:10]
NETWORK, VOLUME, ADDON = (PREFIX + suffix for suffix in ("-net", "-data", "-addon"))
SUPERVISOR_REV = "01b32d6d31125425260638f768980d35659c4874"
CONFIG = "/data/talon/workspaces/default/talond.yaml"
DB = "/data/talon/workspaces/default/state/talond.sqlite"
created_containers = []
created_network = created_volume = created_repro_image = False


def docker(*args, stdin=None):
    return subprocess.check_output(
        ["docker", *args], input=stdin, text=True, stderr=subprocess.STDOUT,
        timeout=180,
    ).strip()


def inspect(name):
    return json.loads(docker("inspect", name))[0]


def wait_for(predicate, description):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(1)
    raise AssertionError("Timed out: " + description)


def supervisor_state(healthcheck):
    # Execute the actual pinned upstream state method, without installing or
    # pretending to run Supervisor. Only the surrounding model is stubbed.
    url = (f"https://raw.githubusercontent.com/home-assistant/supervisor/"
           f"{SUPERVISOR_REV}/supervisor/apps/app.py")
    with urlopen(url, timeout=30) as response:
        source = response.read().decode("utf-8")
    # The rest of upstream uses Python 3.14 syntax; this method works on 3.10+.
    # Extract its indented block before parsing on the runner's Python 3.12.
    matches = re.findall(r"(?m)^    def _derive_state\([^\n]*\n(?:[ \t]*\n| {8}[^\n]*\n)*", source)
    assert len(matches) == 1, "Expected exactly one pinned Supervisor state method"
    method = ast.parse(textwrap.dedent(matches[0])).body[0]
    method.decorator_list = []
    module = ast.Module(body=[method], type_ignores=[])
    states = enum.Enum("ContainerState", "RUNNING HEALTHY UNHEALTHY STOPPED FAILED UNKNOWN")
    app_states = enum.Enum("AppState", "STARTUP STARTED STOPPED ERROR UNKNOWN")
    namespace = {"ContainerState": states, "AppState": app_states}
    exec(compile(module, url, "exec"), namespace)
    fixture = SimpleNamespace(_container_state=states.RUNNING,
                              instance=SimpleNamespace(healthcheck=healthcheck))
    return namespace["_derive_state"](fixture, operation_error=False).name


CLIENT = r"""
const assert = require('node:assert/strict');
const WebSocket = require('/opt/talond/node_modules/ws');
const url = 'http://172.30.32.10:7681/';
const headers = {'X-Ingress-Path': '/api/hassio_ingress/test-session'};
(async () => {
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(10000)});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html/i);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + 'ws', 'tty', {
      headers: {...headers, Origin: 'https://homeassistant.test'}
    });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('terminal timeout')); }, 15000);
    let output = '';
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(JSON.stringify({columns: 100, rows: 30}));
      // The marker is assembled by the shell, so terminal echo cannot pass.
      socket.send('0printf "TALON_%s\n" INGRESS_OK; printf "USER_%s\n" "$(id -un)"\r');
    });
    socket.on('message', data => {
      if (data[0] !== 48) return;
      output += data.subarray(1).toString();
      if (output.includes('TALON_INGRESS_OK') && output.includes('USER_talond')) {
        clearTimeout(timer); socket.close(); resolve();
      }
    });
  });
  console.log('PASS gateway HTTP + interactive tty WebSocket as talond');
})().catch(error => { console.error(error); process.exit(1); });
"""

DENIED = r"""
const assert = require('node:assert/strict');
(async () => {
  for (const port of [7681, 7682]) {
    await assert.rejects(fetch(`http://172.30.32.10:${port}/`, {
      headers: {'X-Forwarded-For': '172.30.32.2', 'X-Real-IP': '172.30.32.2'},
      signal: AbortSignal.timeout(5000)
    }));
  }
  console.log('PASS untrusted peer denied on proxy and loopback ttyd');
})().catch(error => { console.error(error); process.exit(1); });
"""


def client(ip, script):
    name = PREFIX + "-client-" + uuid.uuid4().hex[:5]
    created_containers.append(name)
    print(docker("run", "--rm", "--name", name, "--network", NETWORK, "--ip", ip,
                 "--entrypoint", "node", IMAGE, "-e", script), flush=True)


try:
    metadata = inspect(IMAGE)
    assert metadata["Config"]["Labels"]["io.hass.version"] == EXPECTED_VERSION
    assert not metadata["Config"].get("Healthcheck"), metadata["Config"].get("Healthcheck")
    assert supervisor_state(metadata["Config"].get("Healthcheck")) == "STARTED"
    print("PASS fixed image has no healthcheck; upstream state method returns STARTED", flush=True)

    # Reproduce the old image's real Docker metadata and lack of health events.
    docker("build", "-t", PREFIX + "-none", "-", stdin=f"FROM {IMAGE}\nHEALTHCHECK NONE\n")
    created_repro_image = True
    disabled = inspect(PREFIX + "-none")["Config"]["Healthcheck"]
    assert disabled["Test"] == ["NONE"]
    assert supervisor_state(disabled) == "STARTUP"
    repro = PREFIX + "-repro"
    created_containers.append(repro)
    docker("run", "-d", "--name", repro, "--entrypoint", "sleep", PREFIX + "-none", "120")
    state = inspect(repro)["State"]
    assert state["Status"] == "running" and "Health" not in state, state
    print("PASS reproduced NONE -> STARTUP with running container and no Docker Health", flush=True)

    docker("network", "create", "--subnet", "172.30.32.0/24", NETWORK)
    created_network = True
    docker("volume", "create", VOLUME)
    created_volume = True
    init = PREFIX + "-init"
    created_containers.append(init)
    docker("run", "--rm", "--name", init, "-v", VOLUME + ":/data", "--entrypoint",
           "sh", IMAGE, "-c", 'printf "{}" > /data/options.json')
    created_containers.append(ADDON)
    docker("run", "-d", "--name", ADDON, "--network", NETWORK, "--ip", "172.30.32.10",
           "-v", VOLUME + ":/data", IMAGE)
    wait_for(lambda: "talond started" in docker("logs", ADDON), "keyless daemon startup")
    config = docker("exec", ADDON, "cat", CONFIG)
    assert "codex-cli" in config and "api_key" not in config
    state = inspect(ADDON)["State"]
    assert state["Status"] == "running" and "Health" not in state
    client("172.30.32.2", CLIENT)
    client("172.30.32.11", DENIED)

    # Write a sentinel only into this test's fresh database. No user volumes.
    sqlite = "const db=require('better-sqlite3')(process.argv[1]);"
    docker("exec", "-w", "/opt/talond", ADDON, "node", "-e", sqlite +
           "db.exec(\"CREATE TABLE smoke_sentinel(value TEXT); INSERT INTO smoke_sentinel VALUES ('preserved')\"); db.close();", DB)
    docker("restart", "-t", "60", ADDON)
    wait_for(lambda: docker("logs", ADDON).count("talond started") >= 2, "restart")
    assert docker("exec", ADDON, "cat", CONFIG) == config
    assert docker("exec", "-w", "/opt/talond", ADDON, "node", "-e", sqlite +
                  "console.log(db.prepare('SELECT value FROM smoke_sentinel').get().value); db.close();", DB) == "preserved"
    client("172.30.32.2", CLIENT)
    print("PASS keyless daemon boot and YAML/SQLite preservation on restart", flush=True)

    # Break only the disposable fixture's config and verify recovery access.
    docker("stop", "-t", "60", ADDON)
    stopped_state = inspect(ADDON)["State"]
    assert stopped_state["Status"] == "exited", stopped_state
    assert stopped_state["ExitCode"] == 0, stopped_state
    stop_logs = docker("logs", ADDON)
    assert "daemon: stopped" in stop_logs, "Talon did not complete shutdown"
    assert "Session terminated, killing shell" not in stop_logs, "runuser shell termination persists"
    print("PASS normal Docker stop exits 0 after daemon shutdown; no runuser kill", flush=True)
    repair = PREFIX + "-repair"
    created_containers.append(repair)
    docker("run", "--rm", "--name", repair, "-v", VOLUME + ":/data", "--entrypoint", "node", IMAGE,
           "-e", "const fs=require('fs'); const p=process.argv[1];"
           "fs.appendFileSync(p, '\\ninvalid: [\\n');", CONFIG)
    docker("start", ADDON)
    wait_for(lambda: "Recovery terminal available" in docker("logs", ADDON), "recovery terminal")
    client("172.30.32.2", CLIENT)
    print("PASS recovery terminal with invalid daemon config", flush=True)
finally:
    if ADDON in created_containers:
        subprocess.run(["docker", "logs", ADDON], check=False)
    for name in reversed(created_containers):
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if created_network:
        subprocess.run(["docker", "network", "rm", NETWORK], check=False)
    if created_volume:
        subprocess.run(["docker", "volume", "rm", VOLUME], check=False)
    if created_repro_image:
        subprocess.run(["docker", "image", "rm", PREFIX + "-none"], check=False)
, ADDON_CONFIG.read_text())
assert len(version_matches) == 1, "Expected exactly one add-on version in config.yaml"
EXPECTED_VERSION = version_matches[0]
PREFIX = "talon-smoke-" + uuid.uuid4().hex[:10]
NETWORK, VOLUME, ADDON = (PREFIX + suffix for suffix in ("-net", "-data", "-addon"))
SUPERVISOR_REV = "01b32d6d31125425260638f768980d35659c4874"
CONFIG = "/data/talon/workspaces/default/talond.yaml"
DB = "/data/talon/workspaces/default/state/talond.sqlite"
created_containers = []
created_network = created_volume = created_repro_image = False


def docker(*args, stdin=None):
    return subprocess.check_output(
        ["docker", *args], input=stdin, text=True, stderr=subprocess.STDOUT,
        timeout=180,
    ).strip()


def inspect(name):
    return json.loads(docker("inspect", name))[0]


def wait_for(predicate, description):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(1)
    raise AssertionError("Timed out: " + description)


def supervisor_state(healthcheck):
    # Execute the actual pinned upstream state method, without installing or
    # pretending to run Supervisor. Only the surrounding model is stubbed.
    url = (f"https://raw.githubusercontent.com/home-assistant/supervisor/"
           f"{SUPERVISOR_REV}/supervisor/apps/app.py")
    with urlopen(url, timeout=30) as response:
        source = response.read().decode("utf-8")
    # The rest of upstream uses Python 3.14 syntax; this method works on 3.10+.
    # Extract its indented block before parsing on the runner's Python 3.12.
    matches = re.findall(r"(?m)^    def _derive_state\([^\n]*\n(?:[ \t]*\n| {8}[^\n]*\n)*", source)
    assert len(matches) == 1, "Expected exactly one pinned Supervisor state method"
    method = ast.parse(textwrap.dedent(matches[0])).body[0]
    method.decorator_list = []
    module = ast.Module(body=[method], type_ignores=[])
    states = enum.Enum("ContainerState", "RUNNING HEALTHY UNHEALTHY STOPPED FAILED UNKNOWN")
    app_states = enum.Enum("AppState", "STARTUP STARTED STOPPED ERROR UNKNOWN")
    namespace = {"ContainerState": states, "AppState": app_states}
    exec(compile(module, url, "exec"), namespace)
    fixture = SimpleNamespace(_container_state=states.RUNNING,
                              instance=SimpleNamespace(healthcheck=healthcheck))
    return namespace["_derive_state"](fixture, operation_error=False).name


CLIENT = r"""
const assert = require('node:assert/strict');
const WebSocket = require('/opt/talond/node_modules/ws');
const url = 'http://172.30.32.10:7681/';
const headers = {'X-Ingress-Path': '/api/hassio_ingress/test-session'};
(async () => {
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(10000)});
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html/i);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(url.replace('http:', 'ws:') + 'ws', 'tty', {
      headers: {...headers, Origin: 'https://homeassistant.test'}
    });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('terminal timeout')); }, 15000);
    let output = '';
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(JSON.stringify({columns: 100, rows: 30}));
      // The marker is assembled by the shell, so terminal echo cannot pass.
      socket.send('0printf "TALON_%s\n" INGRESS_OK; printf "USER_%s\n" "$(id -un)"\r');
    });
    socket.on('message', data => {
      if (data[0] !== 48) return;
      output += data.subarray(1).toString();
      if (output.includes('TALON_INGRESS_OK') && output.includes('USER_talond')) {
        clearTimeout(timer); socket.close(); resolve();
      }
    });
  });
  console.log('PASS gateway HTTP + interactive tty WebSocket as talond');
})().catch(error => { console.error(error); process.exit(1); });
"""

DENIED = r"""
const assert = require('node:assert/strict');
(async () => {
  for (const port of [7681, 7682]) {
    await assert.rejects(fetch(`http://172.30.32.10:${port}/`, {
      headers: {'X-Forwarded-For': '172.30.32.2', 'X-Real-IP': '172.30.32.2'},
      signal: AbortSignal.timeout(5000)
    }));
  }
  console.log('PASS untrusted peer denied on proxy and loopback ttyd');
})().catch(error => { console.error(error); process.exit(1); });
"""


def client(ip, script):
    name = PREFIX + "-client-" + uuid.uuid4().hex[:5]
    created_containers.append(name)
    print(docker("run", "--rm", "--name", name, "--network", NETWORK, "--ip", ip,
                 "--entrypoint", "node", IMAGE, "-e", script), flush=True)


try:
    metadata = inspect(IMAGE)
    assert metadata["Config"]["Labels"]["io.hass.version"] == "1.0.10"
    assert not metadata["Config"].get("Healthcheck"), metadata["Config"].get("Healthcheck")
    assert supervisor_state(metadata["Config"].get("Healthcheck")) == "STARTED"
    print("PASS fixed image has no healthcheck; upstream state method returns STARTED", flush=True)

    # Reproduce the old image's real Docker metadata and lack of health events.
    docker("build", "-t", PREFIX + "-none", "-", stdin=f"FROM {IMAGE}\nHEALTHCHECK NONE\n")
    created_repro_image = True
    disabled = inspect(PREFIX + "-none")["Config"]["Healthcheck"]
    assert disabled["Test"] == ["NONE"]
    assert supervisor_state(disabled) == "STARTUP"
    repro = PREFIX + "-repro"
    created_containers.append(repro)
    docker("run", "-d", "--name", repro, "--entrypoint", "sleep", PREFIX + "-none", "120")
    state = inspect(repro)["State"]
    assert state["Status"] == "running" and "Health" not in state, state
    print("PASS reproduced NONE -> STARTUP with running container and no Docker Health", flush=True)

    docker("network", "create", "--subnet", "172.30.32.0/24", NETWORK)
    created_network = True
    docker("volume", "create", VOLUME)
    created_volume = True
    init = PREFIX + "-init"
    created_containers.append(init)
    docker("run", "--rm", "--name", init, "-v", VOLUME + ":/data", "--entrypoint",
           "sh", IMAGE, "-c", 'printf "{}" > /data/options.json')
    created_containers.append(ADDON)
    docker("run", "-d", "--name", ADDON, "--network", NETWORK, "--ip", "172.30.32.10",
           "-v", VOLUME + ":/data", IMAGE)
    wait_for(lambda: "talond started" in docker("logs", ADDON), "keyless daemon startup")
    config = docker("exec", ADDON, "cat", CONFIG)
    assert "codex-cli" in config and "api_key" not in config
    state = inspect(ADDON)["State"]
    assert state["Status"] == "running" and "Health" not in state
    client("172.30.32.2", CLIENT)
    client("172.30.32.11", DENIED)

    # Write a sentinel only into this test's fresh database. No user volumes.
    sqlite = "const db=require('better-sqlite3')(process.argv[1]);"
    docker("exec", "-w", "/opt/talond", ADDON, "node", "-e", sqlite +
           "db.exec(\"CREATE TABLE smoke_sentinel(value TEXT); INSERT INTO smoke_sentinel VALUES ('preserved')\"); db.close();", DB)
    docker("restart", "-t", "60", ADDON)
    wait_for(lambda: docker("logs", ADDON).count("talond started") >= 2, "restart")
    assert docker("exec", ADDON, "cat", CONFIG) == config
    assert docker("exec", "-w", "/opt/talond", ADDON, "node", "-e", sqlite +
                  "console.log(db.prepare('SELECT value FROM smoke_sentinel').get().value); db.close();", DB) == "preserved"
    client("172.30.32.2", CLIENT)
    print("PASS keyless daemon boot and YAML/SQLite preservation on restart", flush=True)

    # Break only the disposable fixture's config and verify recovery access.
    docker("stop", "-t", "60", ADDON)
    stopped_state = inspect(ADDON)["State"]
    assert stopped_state["Status"] == "exited", stopped_state
    assert stopped_state["ExitCode"] == 0, stopped_state
    stop_logs = docker("logs", ADDON)
    assert "daemon: stopped" in stop_logs, "Talon did not complete shutdown"
    assert "Session terminated, killing shell" not in stop_logs, "runuser shell termination persists"
    print("PASS normal Docker stop exits 0 after daemon shutdown; no runuser kill", flush=True)
    repair = PREFIX + "-repair"
    created_containers.append(repair)
    docker("run", "--rm", "--name", repair, "-v", VOLUME + ":/data", "--entrypoint", "node", IMAGE,
           "-e", "const fs=require('fs'); const p=process.argv[1];"
           "fs.appendFileSync(p, '\\ninvalid: [\\n');", CONFIG)
    docker("start", ADDON)
    wait_for(lambda: "Recovery terminal available" in docker("logs", ADDON), "recovery terminal")
    client("172.30.32.2", CLIENT)
    print("PASS recovery terminal with invalid daemon config", flush=True)
finally:
    if ADDON in created_containers:
        subprocess.run(["docker", "logs", ADDON], check=False)
    for name in reversed(created_containers):
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if created_network:
        subprocess.run(["docker", "network", "rm", NETWORK], check=False)
    if created_volume:
        subprocess.run(["docker", "volume", "rm", VOLUME], check=False)
    if created_repro_image:
        subprocess.run(["docker", "image", "rm", PREFIX + "-none"], check=False)
