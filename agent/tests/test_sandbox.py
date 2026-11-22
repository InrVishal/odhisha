from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from nightshift_agent import sandbox
from nightshift_agent.sandbox import Limits, SandboxError, collect_output, docker_args, run_fragment, safe_output_name
from nightshift_agent.trust import WorkloadPin

from .conftest import IMAGE

IN = Path("/work/in")
OUT = Path("/work/out")


def test_exact_docker_argument_list() -> None:
    args = docker_args(name="ns-0123456789abcdef", image=IMAGE, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=False)
    assert args == [
        "docker", "run",
        "--rm",
        "--name", "ns-0123456789abcdef",
        "--network", "none",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=256m",
        "--user", "65534:65534",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "256",
        "--memory", "4g",
        "--memory-swap", "4g",
        "--cpus", "2",
        "--stop-timeout", "5",
        "--ipc", "none",
        "--log-driver", "none",
        "--pull", "never",
        "--mount", f"type=bind,source={IN},target=/in,readonly",
        "--mount", f"type=bind,source={OUT},target=/out",
        "--env", "HF_HUB_OFFLINE=1",
        "--env", "TRANSFORMERS_OFFLINE=1",
        IMAGE,
    ]  # fmt: skip


def test_gpus_only_when_asked() -> None:
    with_gpu = docker_args(name="ns-0123456789abcdef", image=IMAGE, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=True)
    assert with_gpu[-3:] == ["--gpus", "all", IMAGE]
    without = docker_args(name="ns-0123456789abcdef", image=IMAGE, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=False)
    assert "--gpus" not in without


def test_never_weakens_isolation() -> None:
    args = docker_args(name="ns-0123456789abcdef", image=IMAGE, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=True)
    joined = " ".join(args)
    for banned in (
        "--privileged",
        "unconfined",
        "--cap-add",
        "--network host",
        "--pid host",
        "/var/run/docker.sock",
        "--device",
    ):
        assert banned not in joined


@pytest.mark.parametrize("image", ["x:latest", "ghcr.io/a/b", IMAGE.replace("@sha256:", ":")])
def test_refuses_images_not_pinned_by_digest(image: str) -> None:
    with pytest.raises(SandboxError):
        docker_args(name="ns-0123456789abcdef", image=image, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=False)


@pytest.mark.parametrize("name", ["x", "ns-0123; rm -rf /", "ns-ABCDEF0123456789", "--privileged"])
def test_refuses_odd_container_names(name: str) -> None:
    with pytest.raises(SandboxError):
        docker_args(name=name, image=IMAGE, in_dir=IN, out_dir=OUT, limits=Limits(), gpu=False)


@pytest.mark.parametrize(
    ("name", "ok"),
    [
        ("result.json", True),
        ("image-01.webp", True),
        ("../etc/passwd", False),
        ("..", False),
        ("..\\..\\x", False),
        ("a/b", False),
        ("/abs", False),
        (".hidden", False),
        ("a..b", False),
        ("CON", False),
        ("con.txt", False),
        ("lpt1.png", False),
        ("ünïcode.json", False),
        ("x" * 101, False),
        ("new\nline", False),
        ("", False),
    ],
)
def test_output_names_are_sanitised(name: str, ok: bool) -> None:
    assert (safe_output_name(name) == name) is ok


def write(out: Path, files: dict[str, bytes]) -> None:
    for k, v in files.items():
        (out / k).write_bytes(v)


def test_collects_a_valid_result(tmp_path: Path) -> None:
    write(tmp_path, {"result.json": b'{"items": [[1,2]]}'})
    assert json.loads(collect_output(tmp_path)) == {"items": [[1, 2]]}


@pytest.mark.parametrize(
    ("files", "why"),
    [
        ({}, "no result.json"),
        ({"result.json": b"not json"}, "isn't JSON"),
        ({"result.json": b'{"items": 1}'}, "must be"),
        ({"result.json": b'{"items": [], "extra": 1}'}, "must be"),
        ({"result.json": b"[1]"}, "must be"),
        ({"result.json": b'{"items":[]}', ".evil": b"x"}, "unsafe output file name"),
    ],
)
def test_refuses_bad_outputs(tmp_path: Path, files: dict[str, bytes], why: str) -> None:
    write(tmp_path, files)
    with pytest.raises(SandboxError, match=why) as info:
        collect_output(tmp_path)
    assert info.value.reason == "bad_output"


def test_refuses_oversized_output(tmp_path: Path) -> None:
    write(tmp_path, {"result.json": b'{"items":[' + b"1," * 600 + b"1]}"})
    with pytest.raises(SandboxError, match="too large"):
        collect_output(tmp_path, max_bytes=1000)
    write(tmp_path, {"padding.bin": b"x" * 900, "result.json": b'{"items":[1]}'})
    with pytest.raises(SandboxError, match="too large"):
        collect_output(tmp_path, max_bytes=905)


def test_refuses_too_many_files(tmp_path: Path) -> None:
    write(tmp_path, {f"f{i}.txt": b"" for i in range(sandbox.MAX_OUTPUT_FILES + 1)})
    with pytest.raises(SandboxError, match="too many"):
        collect_output(tmp_path)


def test_refuses_folders(tmp_path: Path) -> None:
    write(tmp_path, {"result.json": b'{"items":[]}'})
    (tmp_path / "sub").mkdir()
    with pytest.raises(SandboxError, match="regular files"):
        collect_output(tmp_path)


@pytest.mark.skipif(sys.platform == "win32", reason="symlinks need admin on Windows")
def test_refuses_symlinks_out_of_the_folder(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("owner's private file", encoding="utf-8")
    out = tmp_path / "out"
    out.mkdir()
    os.symlink(secret, out / "result.json")
    with pytest.raises(SandboxError, match="regular files"):
        collect_output(out)


class FakeDocker:
    """Records every command; `docker run` writes the given output into /out."""

    def __init__(self, output: bytes | None = b'{"items": [[0.5]]}', returncode: int = 0, hang: bool = False) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.output = output
        self.returncode = returncode
        self.hang = hang
        self.seen_input: bytes | None = None

    def __call__(self, args: list[str], **kw: Any) -> subprocess.CompletedProcess[bytes]:
        self.calls.append((args, kw))
        assert kw.get("shell") is False
        if args[:2] == ["docker", "run"]:
            mounts = [a for a in args if a.startswith("type=bind")]
            src_in = Path(mounts[0].split(",")[1].removeprefix("source="))
            src_out = Path(mounts[1].split(",")[1].removeprefix("source="))
            self.seen_input = (src_in / "input.json").read_bytes()
            if self.hang:
                raise subprocess.TimeoutExpired(args, kw["timeout"])
            if self.output is not None:
                (src_out / "result.json").write_bytes(self.output)
        return subprocess.CompletedProcess(args, self.returncode, b"", b"")


PIN = WorkloadPin(image=IMAGE, wants_gpu=True)


def test_runs_a_fragment_and_cleans_up(tmp_path: Path) -> None:
    fake = FakeDocker()
    out = run_fragment(
        pin=PIN, input_bytes=b'{"texts":["a"]}', params={}, timeout_s=60, gpu=False, runner=fake, workdir=tmp_path
    )
    assert json.loads(out) == {"items": [[0.5]]}
    assert fake.seen_input == b'{"texts":["a"]}'
    _run_args, run_kw = fake.calls[0]
    assert run_kw["timeout"] == 60
    assert fake.calls[-1][0][:3] == ["docker", "rm", "--force"]
    assert list(tmp_path.iterdir()) == []  # temp files gone


def test_kills_on_timeout_and_still_cleans_up(tmp_path: Path) -> None:
    fake = FakeDocker(hang=True)
    with pytest.raises(SandboxError) as info:
        run_fragment(pin=PIN, input_bytes=b"{}", params={}, timeout_s=5, gpu=False, runner=fake, workdir=tmp_path)
    assert info.value.reason == "timeout"
    cmds = [c[0][:4] for c in fake.calls]
    name = fake.calls[0][0][fake.calls[0][0].index("--name") + 1]
    assert ["docker", "kill", "--signal", "KILL"] in cmds
    assert fake.calls[-1][0] == ["docker", "rm", "--force", name]
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(("code", "why"), [(137, "out_of_memory"), (1, "crashed")])
def test_maps_container_failures(tmp_path: Path, code: int, why: str) -> None:
    with pytest.raises(SandboxError) as info:
        run_fragment(
            pin=PIN,
            input_bytes=b"{}",
            params={},
            timeout_s=5,
            gpu=False,
            runner=FakeDocker(returncode=code),
            workdir=tmp_path,
        )
    assert info.value.reason == why
    assert list(tmp_path.iterdir()) == []


def test_uses_the_gpu_only_if_the_node_has_one_and_the_workload_wants_it(tmp_path: Path) -> None:
    for pin, gpu, expected in (
        (PIN, True, True),
        (PIN, False, False),
        (WorkloadPin(image=IMAGE, wants_gpu=False), True, False),
    ):
        fake = FakeDocker()
        run_fragment(pin=pin, input_bytes=b"{}", params={}, timeout_s=5, gpu=gpu, runner=fake, workdir=tmp_path)
        assert ("--gpus" in fake.calls[0][0]) is expected


def test_quiet_commands_never_raise() -> None:
    def broken(*_a: Any, **_k: Any) -> subprocess.CompletedProcess[bytes]:
        raise OSError("docker missing")

    sandbox.hard_kill("ns-0123456789abcdef", broken)
    assert sandbox.docker_available(broken) is False
    assert sandbox.docker_available(lambda *a, **k: subprocess.CompletedProcess(a, 0, b"29.0", b"")) is True
