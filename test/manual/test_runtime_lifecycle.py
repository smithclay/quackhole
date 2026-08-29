#!/usr/bin/env python3
"""Runtime lifecycle checks for quackhole: database close, and fork after LOAD.

A tokio runtime and a bound iroh endpoint live inside the DuckDB process, and
the host process is entitled to close the database or fork underneath them. The
failure mode we care about is a hang, so every scenario runs in a child process
and is judged on whether that process *exits* within a deadline. Measuring
`con.close()` in-process is not enough: it does not necessarily destroy the
DatabaseInstance, so a hang could be deferred to interpreter shutdown and go
unnoticed.

Needs the Python bindings at the DuckDB version the extension was built against,
so this is not part of `make test`. Run by hand:

    python3 -m venv /tmp/qhvenv && /tmp/qhvenv/bin/pip install duckdb==1.5.4
    /tmp/qhvenv/bin/python test/manual/test_runtime_lifecycle.py
"""

import pathlib
import subprocess
import sys
import time

REPO = pathlib.Path(__file__).resolve().parents[2]
EXTENSION = REPO / "build" / "release" / "extension" / "quackhole" / "quackhole.duckdb_extension"
#! qh_core_free is bounded by a 5s internal deadline, so anything near this is a
#! genuine stall rather than slow teardown.
DEADLINE_SECONDS = 30

PRELUDE = f"""
import duckdb, os, signal, sys, time
con = duckdb.connect(config={{"allow_unsigned_extensions": True}})
con.execute("LOAD '{EXTENSION}'")
con.execute("SET GLOBAL quackhole_ephemeral = true")   # never touch ~/.quackhole/key
"""

SCENARIOS = {
    "close with a bound endpoint": PRELUDE
    + """
con.execute("CALL quackhole_serve(auto_serve := false, target := '127.0.0.1:9494')")
assert con.execute("SELECT serving FROM quackhole_status()").fetchone()[0], "not serving"
con.close()
""",
    "exit while still serving": PRELUDE
    + """
# No explicit close: the process just ends. The QuackholeState destructor has to
# stop the accept loop and join the tokio runtime on its own.
con.execute("CALL quackhole_serve(auto_serve := false, target := '127.0.0.1:9494')")
assert con.execute("SELECT serving FROM quackhole_status()").fetchone()[0], "not serving"
""",
    "exit with a cached outbound connection": PRELUDE
    + """
# The dial path binds an endpoint implicitly and caches a QUIC connection keyed
# by endpoint id; teardown has to cope with that too.
con.execute("INSTALL quack"); con.execute("LOAD quack")
con.execute("CREATE SECRET (TYPE quack, TOKEN 'close-test-token')")
try:
    con.execute("ATTACH 'quack:not-a-real-endpoint-id.iroh:9494' AS peer")
except duckdb.Error:
    pass   # expected: no such peer. Our endpoint is bound regardless.
assert con.execute("SELECT endpoint_id IS NOT NULL FROM quackhole_status()").fetchone()[0]
""",
    "fork after serve": PRELUDE
    + """
# Only the forking thread survives into the child, so the child inherits a tokio
# runtime with no workers. The contract is that the child must not touch
# quackhole; what we check is that the PARENT is undamaged.
con.execute("CALL quackhole_serve(auto_serve := false, target := '127.0.0.1:9494')")
before = con.execute("SELECT endpoint_id FROM quackhole_status()").fetchone()[0]

pid = os.fork()
if pid == 0:
    os._exit(0)   # skips atexit + interpreter teardown, neither fork-safe here

deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
    time.sleep(0.05)
else:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
    sys.exit("child hung after fork")

assert os.waitstatus_to_exitcode(status) == 0, "child exited non-zero"
assert con.execute("SELECT serving FROM quackhole_status()").fetchone()[0], "parent stopped serving"
assert con.execute("SELECT endpoint_id FROM quackhole_status()").fetchone()[0] == before, "identity changed"
""",
}


def run(name, script):
    start = time.monotonic()
    try:
        result = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            timeout=DEADLINE_SECONDS,
        )
    except subprocess.TimeoutExpired:
        print(f"[FAIL] {name} -- process did not exit within {DEADLINE_SECONDS}s (hang)")
        return False

    elapsed = time.monotonic() - start
    if result.returncode != 0:
        print(f"[FAIL] {name} -- exit {result.returncode} after {elapsed:.2f}s")
        for line in (result.stdout + result.stderr).strip().splitlines()[-6:]:
            print(f"        {line}")
        return False

    print(f"[PASS] {name} -- exited cleanly in {elapsed:.2f}s")
    return True


def main():
    if not EXTENSION.exists():
        sys.exit(f"missing {EXTENSION} -- run 'make release' first")

    results = [run(name, script) for name, script in SCENARIOS.items()]
    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
