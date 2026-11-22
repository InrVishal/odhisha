"""Runs one fragment in a locked Docker container.

The container gets no network, a read-only root, a small noexec /tmp, an
unprivileged user, no capabilities, no privilege escalation, Docker's default
seccomp profile, a pids limit, memory and CPU limits and a hard time limit.
Input is mounted read-only. Output goes to a directory the container can
write into but not list. Everything is built as an argument list and run
without a shell.

Container contract (agent/workloads/*): read /in/input.json and
/in/params.json, write /out/result.json = {"items": [...]}.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess  # nosec B404 - argument lists only, never a shell
import sys
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from nightshift_agent.trust import WorkloadPin, is_digest_pinned

DOCKER = "docker"
#: Output size cap per fragment, matching the coordinator's upload limit.
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_FILES = 64
RESULT_FILE = "result.json"
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
WINDOWS_RESERVED = frozenset(
    {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
)
NOBODY = "65534:65534"


class SandboxError(Exception):
    def __init__(self, reason: str, detail: str = "") -> None:
        super().__init__(f"{reason}: {detail}" if detail else reason)
        #: One of the agent API's fail reasons.
        self.reason = reason


@dataclass(frozen=True)
class Limits:
    memory: str = "4g"
    cpus: str = "2"
    pids: int = 256
    tmpfs_size: str = "256m"
    #: Seconds Docker waits after SIGTERM before SIGKILL on stop.
    stop_timeout: int = 5


Runner = Callable[..., "subprocess.CompletedProcess[bytes]"]


def docker_args(
    *,
    name: str,
    image: str,
    in_dir: Path,
    out_dir: Path,
    limits: Limits,
    gpu: bool,
) -> list[str]:
    """The exact `docker run` command. Tested argument by argument."""
    if not is_digest_pinned(image):
        raise SandboxError("bad_input", "image must be pinned by digest")
    if not re.fullmatch(r"ns-[a-f0-9]{16}", name):
        raise SandboxError("bad_input", "bad container name")
    args = [
        DOCKER, "run",
        "--rm",
        "--name", name,
        "--network", "none",
        "--read-only",
        "--tmpfs", f"/tmp:rw,noexec,nosuid,nodev,size={limits.tmpfs_size}",  # noqa: S108  # nosec B108 - /tmp inside the container, not on the host
        "--user", NOBODY,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", str(limits.pids),
        "--memory", limits.memory,
        "--memory-swap", limits.memory,
        "--cpus", limits.cpus,
        "--stop-timeout", str(limits.stop_timeout),
        "--ipc", "none",
        "--log-driver", "none",
        "--pull", "never",
        "--mount", f"type=bind,source={in_dir},target=/in,readonly",
        "--mount", f"type=bind,source={out_dir},target=/out",
        "--env", "HF_HUB_OFFLINE=1",
        "--env", "TRANSFORMERS_OFFLINE=1",
    ]  # fmt: skip
    if gpu:
        args += ["--gpus", "all"]
    args.append(image)
    return args


def safe_output_name(name: str) -> str | None:
    """The name if it's a plain, safe file name; otherwise None (dropped)."""
    if name != os.path.basename(name) or "/" in name or "\\" in name or ".." in name:
        return None
    if not SAFE_NAME.fullmatch(name):
        return None
    if name.split(".", maxsplit=1)[0].lower() in WINDOWS_RESERVED:
        return None
    return name


def collect_output(out_dir: Path, *, max_bytes: int = MAX_OUTPUT_BYTES) -> bytes:
    """Reads result.json from the output dir, refusing anything unsafe."""
    total = 0
    result: bytes | None = None
    entries = list(os.scandir(out_dir))
    if len(entries) > MAX_OUTPUT_FILES:
        raise SandboxError("bad_output", "too many output files")
    for entry in entries:
        name = safe_output_name(entry.name)
        if name is None:
            raise SandboxError("bad_output", "unsafe output file name")
        st = os.lstat(entry.path)
        if not stat.S_ISREG(st.st_mode):
            raise SandboxError("bad_output", "outputs must be regular files (no links or folders)")
        total += st.st_size
        if total > max_bytes:
            raise SandboxError("bad_output", "output too large")
        if name == RESULT_FILE:
            with open(entry.path, "rb") as fh:
                result = fh.read(max_bytes + 1)
    if result is None:
        raise SandboxError("bad_output", "no result.json")
    if len(result) > max_bytes:
        raise SandboxError("bad_output", "output too large")
    try:
        doc = json.loads(result)
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise SandboxError("bad_output", "result.json isn't JSON") from err
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list) or set(doc) != {"items"}:
        raise SandboxError("bad_output", 'result.json must be {"items": [...]}')
    return result


def _prepare_dirs(root: Path, input_bytes: bytes, params: dict[str, Any]) -> tuple[Path, Path]:
    in_dir = root / "in"
    out_dir = root / "out"
    in_dir.mkdir(mode=0o755)
    out_dir.mkdir(mode=0o733)
    (in_dir / "input.json").write_bytes(input_bytes)
    (in_dir / "params.json").write_text(json.dumps(params), encoding="utf-8")
    for p in (in_dir / "input.json", in_dir / "params.json"):
        p.chmod(0o444)
    if sys.platform != "win32":
        # Others (the container's nobody user) may create files in /out but
        # not list it. Not enforceable on Windows bind mounts (see README).
        out_dir.chmod(0o733)
    return in_dir, out_dir


def run_fragment(
    *,
    pin: WorkloadPin,
    input_bytes: bytes,
    params: dict[str, Any],
    timeout_s: float,
    gpu: bool,
    limits: Limits | None = None,
    runner: Runner = subprocess.run,
    workdir: Path | None = None,
) -> bytes:
    """Runs the container and returns the validated result.json bytes."""
    limits = limits or Limits(memory=pin.memory, cpus=pin.cpus)
    name = f"ns-{secrets.token_hex(8)}"
    root = Path(tempfile.mkdtemp(prefix="nightshift-", dir=workdir))
    try:
        in_dir, out_dir = _prepare_dirs(root, input_bytes, params)
        args = docker_args(
            name=name, image=pin.image, in_dir=in_dir, out_dir=out_dir, limits=limits, gpu=gpu and pin.wants_gpu
        )
        try:
            proc = runner(args, capture_output=True, timeout=timeout_s, check=False, shell=False)
        except subprocess.TimeoutExpired as err:
            hard_kill(name, runner)
            raise SandboxError("timeout", f"killed after {timeout_s:.0f}s") from err
        if proc.returncode == 137:
            raise SandboxError("out_of_memory", "container was killed (memory)")
        if proc.returncode != 0:
            raise SandboxError("crashed", f"exit code {proc.returncode}")
        return collect_output(out_dir)
    finally:
        cleanup(name, root, runner)


def hard_kill(name: str, runner: Runner) -> None:
    """SIGKILL now; no grace period for a task over its time."""
    _quiet(runner, [DOCKER, "kill", "--signal", "KILL", name])


def cleanup(name: str, root: Path, runner: Runner) -> None:
    """Always: remove the container (if still there) and the temp files."""
    _quiet(runner, [DOCKER, "rm", "--force", name])
    remove_tree(root)


def remove_tree(root: Path) -> None:
    """rmtree that also removes read-only files (Windows refuses otherwise)."""
    for dirpath, dirnames, filenames in os.walk(root):
        for n in [*dirnames, *filenames]:
            with contextlib.suppress(OSError):
                os.chmod(os.path.join(dirpath, n), stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
    shutil.rmtree(root, ignore_errors=True)


def _quiet(runner: Runner, args: Sequence[str]) -> None:
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        runner(list(args), capture_output=True, timeout=30, check=False, shell=False)


def ensure_image(image: str, runner: Runner = subprocess.run, *, timeout_s: float = 1800) -> bool:
    """Pulls a digest-pinned image if it isn't here yet. Returns True if present.

    Run before taking work, so a first download never eats into a lease.
    Pulling by digest means Docker itself checks the content matches.
    """
    if not is_digest_pinned(image):
        raise SandboxError("bad_input", "image must be pinned by digest")
    have = runner(
        [DOCKER, "image", "inspect", "--format", "{{.Id}}", image],
        capture_output=True,
        timeout=30,
        check=False,
        shell=False,
    )
    if have.returncode == 0:
        return True
    pulled = runner(
        [DOCKER, "pull", "--quiet", image], capture_output=True, timeout=timeout_s, check=False, shell=False
    )
    return pulled.returncode == 0


def docker_available(runner: Runner = subprocess.run) -> bool:
    try:
        proc = runner(
            [DOCKER, "version", "--format", "{{.Server.Version}}"],
            capture_output=True,
            timeout=20,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0
