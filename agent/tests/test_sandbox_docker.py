"""Sandbox escape tests: real containers with the agent's exact flags.

Each test starts a container from a pinned Alpine image using docker_args()
(the same argument list real fragments use) plus a probe command, and proves
the container can't do the thing. Skipped when Docker isn't running; CI runs
them on Linux.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

import pytest

from nightshift_agent import sandbox
from nightshift_agent.sandbox import Limits, docker_args

from .conftest import ALPINE

pytestmark = pytest.mark.docker


@pytest.fixture(scope="module", autouse=True)
def _docker() -> None:
    if not sandbox.docker_available():
        pytest.skip("Docker isn't running")
    subprocess.run(["docker", "pull", "-q", ALPINE], capture_output=True, check=True, timeout=300, shell=False)


def box(
    tmp_path: Path, script: str, *, timeout: float = 60, limits: Limits | None = None
) -> subprocess.CompletedProcess[str]:
    in_dir, out_dir = tmp_path / "in", tmp_path / "out"
    in_dir.mkdir(exist_ok=True)
    out_dir.mkdir(exist_ok=True)
    (in_dir / "input.json").write_text("{}", encoding="utf-8")
    if sys.platform != "win32":
        out_dir.chmod(0o733)
    name = f"ns-{int(time.time() * 1e6) % 16**16:016x}"
    args = docker_args(
        name=name,
        image=ALPINE,
        in_dir=in_dir,
        out_dir=out_dir,
        limits=limits or Limits(memory="256m", cpus="1"),
        gpu=False,
    )
    try:
        return subprocess.run(
            [*args, "sh", "-c", script], capture_output=True, text=True, timeout=timeout, check=False, shell=False
        )
    finally:
        subprocess.run(["docker", "rm", "--force", name], capture_output=True, check=False, shell=False)


def test_no_network(tmp_path: Path) -> None:
    r = box(
        tmp_path,
        "ls /sys/class/net; "
        "wget -q -T 3 -O- http://1.1.1.1 >/dev/null 2>&1 && echo REACHED || echo BLOCKED; "
        "nslookup example.com >/dev/null 2>&1 && echo DNS || echo NODNS",
    )
    lines = r.stdout.split()
    assert lines[0] == "lo" and "eth0" not in lines
    assert "BLOCKED" in lines and "REACHED" not in lines
    assert "NODNS" in lines


def test_not_root_no_capabilities_no_new_privileges_seccomp_on(tmp_path: Path) -> None:
    r = box(tmp_path, "id -u; id -g; grep -E '^(CapEff|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status")
    out = r.stdout.split("\n")
    assert out[0] == "65534" and out[1] == "65534"
    status = dict(line.split(":\t") for line in out[2:] if ":\t" in line)
    assert status["CapEff"].strip() == "0000000000000000"
    assert status["CapBnd"].strip() == "0000000000000000"
    assert status["NoNewPrivs"].strip() == "1"
    assert status["Seccomp"].strip() == "2"  # filter mode: Docker's default profile


def test_cannot_write_outside_tmp_and_out(tmp_path: Path) -> None:
    script = "; ".join(
        f"(echo x > {p}) 2>/dev/null && echo WROTE:{p} || echo DENIED:{p}"
        for p in ("/etc/x", "/x", "/root/x", "/usr/bin/x", "/in/x", "/in/input.json", "/tmp/ok", "/out/result.json")
    )
    r = box(tmp_path, script)
    for p in ("/etc/x", "/x", "/root/x", "/usr/bin/x", "/in/x", "/in/input.json"):
        assert f"DENIED:{p}" in r.stdout, r.stdout
    assert "WROTE:/tmp/ok" in r.stdout
    assert "WROTE:/out/result.json" in r.stdout
    assert (tmp_path / "out" / "result.json").read_text(encoding="utf-8").strip() == "x"
    assert (tmp_path / "in" / "input.json").read_text(encoding="utf-8") == "{}"


def test_tmp_is_noexec(tmp_path: Path) -> None:
    r = box(tmp_path, "cp /bin/busybox /tmp/bb && chmod +x /tmp/bb && (/tmp/bb true && echo RAN || echo NOEXEC)")
    assert "NOEXEC" in r.stdout and "RAN" not in r.stdout


@pytest.mark.skipif(sys.platform == "win32", reason="Docker Desktop bind mounts ignore Linux modes")
def test_cannot_list_the_output_folder(tmp_path: Path) -> None:
    r = box(tmp_path, "echo hi > /out/a; ls /out >/dev/null 2>&1 && echo LISTED || echo NOLIST")
    assert "NOLIST" in r.stdout


def test_fork_bomb_stops_at_the_pids_limit(tmp_path: Path) -> None:
    # Try to start 600 processes, printing a count (echo is a shell built-in)
    # after each one that started. At the pids limit the shell can't fork
    # any more and gives up: it must stop well short of 600.
    script = "n=0; while [ $n -lt 600 ]; do sleep 30 & n=$((n+1)); echo $n; done"
    r = box(tmp_path, script, timeout=120)
    started = int(r.stdout.split()[-1])
    assert started < 256
    assert "can't fork" in r.stderr


def test_memory_limit_kills_a_hog(tmp_path: Path) -> None:
    # `tail` holds the whole 400 MB line in memory; with a 64 MB limit the
    # kernel kills it (exit 137 = SIGKILL) while the shell lives to report.
    r = box(
        tmp_path,
        "head -c 400m /dev/zero | tail > /dev/null; echo exit=$?",
        limits=Limits(memory="64m", cpus="1"),
        timeout=120,
    )
    # Docker Desktop's kernel kills just the hog (the shell reports exit=137);
    # a Linux host may kill the whole container (docker run exits 137). Either
    # way the process over the limit never gets its memory.
    assert "exit=137" in r.stdout or r.returncode == 137


def test_timeout_hard_kills_and_removes_the_container(tmp_path: Path) -> None:
    in_dir, out_dir = tmp_path / "in", tmp_path / "out"
    in_dir.mkdir()
    out_dir.mkdir()
    name = "ns-00000000deadbeef"
    args = docker_args(
        name=name, image=ALPINE, in_dir=in_dir, out_dir=out_dir, limits=Limits(memory="64m", cpus="1"), gpu=False
    )
    with pytest.raises(subprocess.TimeoutExpired):
        subprocess.run([*args, "sleep", "300"], capture_output=True, timeout=5, check=False, shell=False)
    sandbox.hard_kill(name, subprocess.run)
    sandbox.cleanup(name, tmp_path, subprocess.run)
    left = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"name={name}", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
        shell=False,
    )
    assert left.stdout.strip() == ""
    assert not tmp_path.exists()
