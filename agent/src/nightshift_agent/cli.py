"""nightshift-agent: login, start, status, pause, resume, logs, benchmark, update, logout."""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path

from nightshift_agent import __version__, benchmark, logs, secrets_store, updates
from nightshift_agent.api import ApiError, Client
from nightshift_agent.config import AgentConfig, ConfigError, state_dir, validate_api_url
from nightshift_agent.runner import Agent, is_paused, set_paused
from nightshift_agent.sandbox import docker_available, ensure_image
from nightshift_agent.trust import WHITELIST
from nightshift_agent.window import Window


def _say(msg: str) -> None:
    print(logs.redact(msg))


def cmd_login(args: argparse.Namespace, d: Path) -> int:
    try:
        raw = sys.stdin.readline() if args.token == "-" else args.token  # noqa: S105  # nosec B105 - "-" means read stdin
        token = secrets_store.check_token(raw)
        api = validate_api_url(args.api) if args.api else AgentConfig.load(d).api
    except (secrets_store.TokenError, ConfigError) as err:
        _say(f"error: {err}")
        return 2
    try:
        reply = Client(api, token).post_json("/api/agent/heartbeat", {"agentVersion": __version__}).body
    except ApiError as err:
        _say(f"error: the coordinator refused this token ({err.code})" if err.status == 401 else f"error: {err.code}")
        return 1
    node_id = reply.get("nodeId")
    if not isinstance(node_id, str):
        _say("error: the coordinator didn't return a node id")
        return 1
    where = secrets_store.save_token(token, d)
    cfg = AgentConfig.load(d)
    cfg.api, cfg.node_id = api, node_id
    cfg.save(d)
    place = "the OS keyring" if where == "keyring" else f"a private file ({d / 'token'})"
    _say(f"Logged in as node {node_id[:8]}. Token stored in {place}.")
    return 0


def cmd_start(args: argparse.Namespace, d: Path) -> int:
    cfg = AgentConfig.load(d)
    if args.window:
        cfg.window = str(Window.parse(args.window))
    if args.cpu_watts:
        cfg.cpu_watts = args.cpu_watts
    if args.no_gpu:
        cfg.use_gpu = False
    cfg.save(d)
    token = secrets_store.load_token(d)
    if not token or not cfg.node_id:
        _say("error: not logged in. Run `nightshift-agent login <token>` first.")
        return 2
    if not docker_available():
        _say("error: Docker isn't running. Start Docker Desktop (Windows) or the docker service (Linux).")
        return 2
    logger = logs.setup(d, verbose=args.verbose)
    for workload, pin in WHITELIST.items():
        if not ensure_image(pin.image):
            logger.warning("couldn't pull the %s image; that work will be refused until it can be pulled", workload)
    logger.info("nightshift-agent %s starting for node %s against %s", __version__, cfg.node_id[:8], cfg.api)
    if cfg.benchmark_score is None and "text_embeddings" in WHITELIST:
        logger.info("first start: benchmarking this PC (takes about a minute)")
        try:
            cfg.benchmark_score = benchmark.run_benchmark(WHITELIST["text_embeddings"], gpu=cfg.use_gpu)
            cfg.save(d)
            logger.info("benchmark score %s (RTX 3060 = 1000)", cfg.benchmark_score)
        except Exception as err:  # noqa: BLE001 - a failed benchmark must not stop the agent
            logger.warning("benchmark failed (%s); the coordinator will use the class default", err)
    agent = Agent(
        client=Client(cfg.api, token), config=cfg, node_id=cfg.node_id, directory=d, benchmark_score=cfg.benchmark_score
    )
    try:
        agent.run_forever(once=args.once)
    except KeyboardInterrupt:
        logger.info("stopped by owner")
    except ApiError as err:
        return 1 if err.status == 401 else 3
    return 0


def cmd_status(_: argparse.Namespace, d: Path) -> int:
    cfg = AgentConfig.load(d)
    status_file = d / "status.json"
    status = json.loads(status_file.read_text(encoding="utf-8")) if status_file.exists() else {}
    try:
        has_token = secrets_store.load_token(d) is not None
    except secrets_store.TokenError as err:
        has_token = False
        _say(f"warning: {err}")
    _say(f"nightshift-agent {__version__}")
    _say(f"  coordinator: {cfg.api}")
    _say(f"  node:        {cfg.node_id or '(not logged in)'}")
    _say(f"  token:       {'stored' if has_token else 'missing'}")
    _say(f"  paused:      {'yes' if is_paused(d) else 'no'}")
    _say(f"  window:      {cfg.window or 'from the dashboard only'}")
    _say(f"  last state:  {status.get('state', 'never ran')} {status.get('reason', '')}".rstrip())
    return 0


def cmd_pause(_: argparse.Namespace, d: Path) -> int:
    set_paused(True, d)
    _say("Paused. A fragment already running will finish; no new work will start.")
    return 0


def cmd_resume(_: argparse.Namespace, d: Path) -> int:
    set_paused(False, d)
    _say("Resumed.")
    return 0


def cmd_logs(args: argparse.Namespace, d: Path) -> int:
    for line in logs.tail(args.lines, d):
        _say(line)
    return 0


def cmd_logout(_: argparse.Namespace, d: Path) -> int:
    secrets_store.delete_token(d)
    _say("Token removed from this machine.")
    return 0


def cmd_update(args: argparse.Namespace, _d: Path) -> int:
    try:
        rel = updates.verify_release(
            Path(args.manifest).read_bytes(), Path(args.signature).read_bytes(), Path(args.wheel)
        )
    except (updates.ReleaseError, OSError) as err:
        _say(f"refusing to update: {err}")
        return 2
    _say(f"Release {rel.version} verified. Installing with pipx...")
    return updates.install(Path(args.wheel))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="nightshift-agent", description="Run NightShift jobs on this PC while it's idle.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("login", help="store this PC's node token (from the dashboard)")
    s.add_argument("token", help='the token, or "-" to read it from stdin (keeps it out of the process list)')
    s.add_argument("--api", help="coordinator URL (https only)")
    s.set_defaults(fn=cmd_login)

    s = sub.add_parser("start", help="start taking work")
    s.add_argument("--once", action="store_true", help="run one fragment, then exit")
    s.add_argument("--window", help='local night window, e.g. "23:00-07:00"')
    s.add_argument("--cpu-watts", type=int, help="declared draw in CPU mode (no NVIDIA GPU), in watts")
    s.add_argument("--no-gpu", action="store_true", help="never use the GPU")
    s.add_argument("--verbose", action="store_true")
    s.set_defaults(fn=cmd_start)

    for name, fn, text in (
        ("status", cmd_status, "show what the agent is doing"),
        ("pause", cmd_pause, "stop taking new work (the current fragment finishes)"),
        ("resume", cmd_resume, "take work again"),
        ("logout", cmd_logout, "remove the token from this machine"),
    ):
        sub.add_parser(name, help=text).set_defaults(fn=fn)

    s = sub.add_parser("logs", help="show recent log lines (tokens are never logged)")
    s.add_argument("-n", "--lines", type=int, default=50)
    s.set_defaults(fn=cmd_logs)

    s = sub.add_parser("update", help="install a signed release")
    s.add_argument("wheel")
    s.add_argument("--manifest", required=True)
    s.add_argument("--signature", required=True)
    s.set_defaults(fn=cmd_update)
    return p


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    d = state_dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        return int(args.fn(args, d))
    except ConfigError as err:
        _say(f"error: {err}")
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
