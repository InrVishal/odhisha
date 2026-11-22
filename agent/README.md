# nightshift-agent

The program that runs on an owner's PC. It asks the NightShift coordinator for work and runs each piece in a locked Docker container. It reports the power draw with each result.

- **It only asks for work.** It never opens a port, and nothing on the internet can connect to it.
- **It only runs signed work.** Every task must be signed with a key pinned in this program. It must also not be expired, not be a replay, and be meant for this PC. Its workload and exact container image must both be on the built-in whitelist.
- **Each piece runs in a locked container:**
  - no internet, and a read-only filesystem apart from a small `/tmp`;
  - an unprivileged user with no Linux capabilities;
  - a process limit, memory and CPU limits, and a hard time limit.

  The container is deleted after every piece.

## Install

You need Python 3.11+, [pipx](https://pipx.pypa.io/) and Docker.

```sh
pipx install nightshift-agent            # from a signed release wheel, see "Updates"
nightshift-agent login nsn_...           # the token from your NightShift dashboard (shown once)
nightshift-agent start
```

Dependencies are pinned with hashes. To install them exactly: `pip install --require-hashes -r requirements.lock`.

### Windows 11

1. Install **Docker Desktop**, and let it set up **WSL 2** when it asks. Start Docker Desktop before you start the agent.
2. Install Python 3.11+ and pipx:
   ```powershell
   winget install Python.Python.3.11
   py -m pip install --user pipx
   py -m pipx ensurepath
   ```
3. Use the NVIDIA GPU, if the PC has one:
   1. Install the current **NVIDIA Game Ready or Studio driver for Windows**. Don't install a driver inside WSL, because the Windows driver already provides one there.
   2. In Docker Desktop, check **Settings → Resources → WSL integration** is on.
   3. Check it works:
      ```powershell
      docker run --rm --gpus all nvidia/cuda:12.6.3-base-ubuntu24.04 nvidia-smi
      ```
      It should print your GPU.
   4. Make sure `nvidia-smi` works in PowerShell too, so the agent can read real power draw.

   No NVIDIA GPU, or the check fails? The agent runs in **CPU mode** (see below).

### Linux

Install Docker Engine and add yourself to the `docker` group. For the GPU, install the NVIDIA driver and the NVIDIA Container Toolkit, then run `sudo nvidia-ctk runtime configure --runtime=docker`.

## Commands

| Command | What it does |
| --- | --- |
| `login <token> [--api URL]` | Checks the token with the coordinator, then stores it in the OS keyring (Windows Credential Manager, macOS Keychain, Secret Service). With no keyring, it goes in a file only you can read (`0600`). The token is never logged. |
| `start [--window 23:00-07:00] [--cpu-watts 65] [--no-gpu] [--once]` | Starts taking work. `--window` is an extra local window, on top of the one you set on the dashboard. `--once` runs one piece and exits. |
| `status` | Shows the coordinator, node, whether a token is stored (never the token itself), paused or not, the window, and the last state. |
| `pause` / `resume` | Stops or restarts taking new work. A piece that's already running finishes first. |
| `logs [-n 50]` | Shows recent log lines. Tokens are removed before anything is written. |
| `update <wheel> --manifest m.json --signature m.sig` | Installs a new version, but only if the signature verifies against the pinned release key and the wheel's sha256 matches the signed manifest. |
| `logout` | Removes the token from this PC. |

The agent stores its state in `%LOCALAPPDATA%\NightShift` on Windows and `~/.local/state/nightshift` on Linux. That's the config, the nonce store, the pause flag and the logs.

## CPU mode

With no NVIDIA GPU, or when `nvidia-smi` can't be read, the agent runs on the CPU. It reports `--cpu-watts` (default 65 W) as the PC's draw, marked **estimated**. The coordinator stores the "estimated" flag with the node, and the owner's dashboard shows it. Use CPU mode for laptops and for demos.

## Power telemetry

With a GPU, the agent reads `nvidia-smi` power draw every 30 seconds. It adds 90 W for the rest of the PC (CPU, board, fans), then sends the result with each heartbeat and each finished piece (`X-Power-Watts`, `X-Power-Source`). The coordinator keeps a rolling average and pays electricity from it.

## The sandbox

Every piece runs as one `docker run` command. It's built as a list of arguments and run without a shell:

```
docker run --rm --name ns-<random>
  --network none --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=256m
  --user 65534:65534 --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory 4g --memory-swap 4g --cpus 2 --stop-timeout 5
  --ipc none --log-driver none --pull never
  --mount type=bind,source=<in>,target=/in,readonly
  --mount type=bind,source=<out>,target=/out
  [--gpus all]   # only with an NVIDIA GPU, and only for workloads that use it
  <image>@sha256:<pinned digest>
```

- **Seccomp:** Docker's default profile applies, because the agent never passes `seccomp=unconfined`.
- **Output folder:** on Linux it's mode `0733`, so the container can create files but can't list the folder.
- **Output checks:** names must be plain, no paths or `..`; only regular files are accepted, no links or folders; output is capped at 4 MB; and it must be `{"items": [...]}`. The agent hashes it with SHA-256 before uploading.
- **Time limit:** a piece that runs past its lease is force-stopped.
- **Cleanup:** the container and its temp files are always removed.

Limits on Windows:
- Docker Desktop bind mounts don't enforce Linux file modes, so the output folder can't be made unlistable there. Every other flag applies as normal.
- The container still sees the plaintext of the piece it computes. That's inherent to running the work, and it's why jobs are split into small pieces.

## Updates

Releases are signed. The release workflow signs `manifest.json`, which holds the version, wheel name and sha256, with an Ed25519 key that exists only as a GitHub Actions secret. The matching public key is pinned in `updates.py`. `nightshift-agent update` refuses any wheel whose signature or hash doesn't match.

## Development

```sh
cd agent
uv venv --python 3.11 && uv pip install -e ".[dev]"
pytest --cov                      # unit tests; the docker-marked tests need Docker running
ruff check . && ruff format --check . && mypy && bandit -r src -c pyproject.toml && pip-audit -r requirements.lock
```

To work against a local coordinator, set `NIGHTSHIFT_DEV=1`. Plain HTTP is then allowed, to localhost only. To trust the dev server's random signing key, also set `NIGHTSHIFT_DEV_PINNED_KEY` to the PEM from `/api/agent/signing-key`.

## Live demo: three laptops

This runs against production (https://nightshift-ten-iota.vercel.app) once Phase 4 is merged. Until then, use a preview URL, as noted below.

**You need, once:** a NightShift account. Sign in on the site with Google, or with the email link. Without a verified domain, the email link only reaches the Resend account owner's address. One account can be both the owner and the buyer.

1. **Get your session cookie.** Sign in, open the browser dev tools (**Application → Cookies**), and copy the value of `__Secure-authjs.session-token`. On the machine with the repo:
   ```powershell
   $env:NIGHTSHIFT_SESSION = "<that value>"
   ```
2. **Register the three laptops.** Each command prints the laptop's token once, so keep each one for its laptop:
   ```powershell
   npm run ns -- node add "Laptop 1" cpu
   npm run ns -- node add "Laptop 2" cpu
   npm run ns -- node add "Laptop 3" cpu
   npm run ns -- node list
   ```
   For a daytime demo, open the night window to all day:
   ```powershell
   npm run ns -- node window <nodeId> all-day
   ```
3. **On each laptop** (Windows 11), install Docker Desktop with WSL 2 and start it. Then install Python 3.11 and pipx, and run:
   ```powershell
   pipx install "git+https://github.com/InrVishal/odhisha.git#subdirectory=agent"
   nightshift-agent login -          # paste that laptop's token, then press Enter
   nightshift-agent start --no-gpu   # CPU mode: reports 65 W, marked as estimated
   ```
   - **First start:** the agent pulls the pinned images (about 2 GB for text embeddings) and runs the benchmark. It then shows `heartbeat: ... canWork=True`.
   - **Laptop with an NVIDIA GPU:** drop `--no-gpu` and the agent reports real `nvidia-smi` watts. The images are CPU builds for now, so the GPU won't make the work faster yet.
4. **Submit a job** from any machine, using a text file with one sentence per line:
   ```powershell
   npm run ns -- quote reviews.txt cpu   # price breakdown and "done by" time
   npm run ns -- confirm <jobId>         # simulated charge (demo mode)
   npm run ns -- status <jobId>          # run it again to watch the pieces finish
   npm run ns -- results <jobId> out.json
   npm run ns -- earnings                # compute and electricity, shown separately
   ```
   A job of 600 or more lines splits into 3 or more pieces, so all three laptops get work. To show a retry, run `nightshift-agent pause` on one laptop mid-job, or close its lid: its piece goes to another laptop once the lease runs out.

**Against a preview instead of production:**
- On every agent command, set `NIGHTSHIFT_VERCEL_BYPASS` to the Vercel automation bypass secret.
- Use `nightshift-agent login - --api https://<preview>.vercel.app` to point the agent at the preview.
- Set `NIGHTSHIFT_API` to the preview URL for `npm run ns`.
- Previews use the Vercel Preview signing key, which is pinned too.
