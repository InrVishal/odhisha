"""Power telemetry from nvidia-smi, or a declared estimate in CPU mode."""

from __future__ import annotations

import shutil
import subprocess  # nosec B404 - argument lists only, never a shell
from collections.abc import Callable
from dataclasses import dataclass

#: Draw of the rest of the PC (CPU, board, fans) while a GPU job runs. Added
#: to the GPU's own measured draw so we report whole-PC watts.
DEFAULT_SYSTEM_WATTS = 90

Runner = Callable[..., "subprocess.CompletedProcess[str]"]


@dataclass(frozen=True)
class GpuInfo:
    name: str
    vram_mb: int
    power_w: float


@dataclass(frozen=True)
class PowerReading:
    watts: int
    #: "nvidia-smi" (GPU measured + declared rest of system) or "estimated".
    source: str
    gpu: GpuInfo | None


def parse_nvidia_smi(output: str) -> GpuInfo | None:
    """Parses `--query-gpu=name,memory.total,power.draw --format=csv,noheader,nounits`."""
    for line in output.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        name, mem, power = parts
        try:
            vram = int(float(mem))
            watts = float(power)
        except ValueError:
            continue  # "[N/A]" on some laptops
        if watts <= 0 or watts > 2000:
            continue
        return GpuInfo(name=name[:128], vram_mb=vram, power_w=watts)
    return None


def read_gpu(runner: Runner = subprocess.run) -> GpuInfo | None:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        proc = runner(
            [exe, "--query-gpu=name,memory.total,power.draw", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            shell=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_nvidia_smi(proc.stdout) if proc.returncode == 0 else None


def read_power(
    *, cpu_watts: int, system_watts: int = DEFAULT_SYSTEM_WATTS, gpu_reader: Callable[[], GpuInfo | None] = read_gpu
) -> PowerReading:
    gpu = gpu_reader()
    if gpu is None:
        return PowerReading(watts=max(1, cpu_watts), source="estimated", gpu=None)
    return PowerReading(watts=max(1, round(gpu.power_w + system_watts)), source="nvidia-smi", gpu=gpu)
