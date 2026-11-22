from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import pytest

from nightshift_agent import trust
from nightshift_agent.nonces import NonceStore
from nightshift_agent.trust import TaskRejected, WorkloadPin, is_digest_pinned, key_id, pinned_keys, verify_task

from .conftest import IMAGE, NODE, Coordinator


def check(
    coord: Coordinator,
    whitelist: dict[str, WorkloadPin],
    signed: object,
    inp: object,
    nonces: NonceStore | None = None,
    **kw: object,
):  # type: ignore[no-untyped-def]
    return verify_task(
        signed,
        inp,
        node_id=NODE,
        nonces=nonces if nonces is not None else NonceStore(),
        keys=coord.keys,
        whitelist=whitelist,
        **kw,
    )  # type: ignore[arg-type]


def reason(fn) -> str:  # type: ignore[no-untyped-def]
    with pytest.raises(TaskRejected) as info:
        fn()
    return info.value.reason


def test_accepts_a_genuine_task(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task()
    t = check(coord, whitelist, signed, inp)
    assert t.workload == "text_embeddings"
    assert t.input == b'{"texts":["hi"]}'
    assert t.pin.image == IMAGE


def test_tampered_task_text_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task()
    signed["task"] = signed["task"].replace('"attempt": 1', '"attempt": 2')
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "bad_signature"


def test_tampered_signature_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task()
    sig = bytearray(base64.b64decode(signed["signature"]))
    sig[0] ^= 1
    signed["signature"] = base64.b64encode(bytes(sig)).decode()
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "bad_signature"
    signed["signature"] = "!!not base64!!"
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "bad_signature"


def test_task_signed_by_another_key_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    other = Coordinator()
    signed, inp = other.task()
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "unknown_key"
    # Claiming our kid doesn't help: the signature still has to verify.
    signed["kid"] = coord.kid
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "bad_signature"


def test_expired_task_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task(exp=int(time.time()) - 1)
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "expired"


def test_task_from_the_future_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task(iat=int(time.time()) + 3600, exp=int(time.time()) + 7200)
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "issued_in_future"


def test_replayed_nonce_is_refused_even_after_a_restart(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], tmp_path: Path
) -> None:
    signed, inp = coord.task()
    store = NonceStore(tmp_path / "nonces.json")
    check(coord, whitelist, signed, inp, nonces=store)
    assert reason(lambda: check(coord, whitelist, signed, inp, nonces=store)) == "replayed_nonce"
    restarted = NonceStore(tmp_path / "nonces.json")
    assert reason(lambda: check(coord, whitelist, signed, inp, nonces=restarted)) == "replayed_nonce"


def test_a_rejected_task_does_not_burn_its_nonce(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    store = NonceStore()
    signed, _ = coord.task()
    assert (
        reason(lambda: check(coord, whitelist, signed, base64.b64encode(b"other").decode(), nonces=store))
        == "input_mismatch"
    )
    assert len(store) == 0


def test_task_for_another_node_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, inp = coord.task(nodeId="99999999-9999-4999-8999-999999999999")
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "wrong_node"


@pytest.mark.parametrize("workload", ["shell", "python_script", "text_embeddings ", "TEXT_EMBEDDINGS", "image_resize"])
def test_non_whitelisted_workload_is_refused(
    coord: Coordinator, whitelist: dict[str, WorkloadPin], workload: str
) -> None:
    signed, inp = coord.task(workload=workload)
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "workload_not_allowed"


@pytest.mark.parametrize(
    "image",
    [
        "ghcr.io/inrvishal/nightshift-text-embeddings:latest",
        "ghcr.io/inrvishal/nightshift-text-embeddings@sha256:" + "b" * 64,
        "evil.example/nightshift-text-embeddings@sha256:" + "a" * 64,
        IMAGE + " --privileged",
        None,
        "",
    ],
)
def test_wrong_image_digest_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin], image: object) -> None:
    signed, inp = coord.task(image=image)
    assert reason(lambda: check(coord, whitelist, signed, inp)) == "image_mismatch"


def test_a_whitelist_entry_with_a_tag_never_matches(coord: Coordinator) -> None:
    tagged = {"text_embeddings": WorkloadPin(image="ghcr.io/x/y:latest", wants_gpu=False)}
    signed, inp = coord.task(image="ghcr.io/x/y:latest")
    assert reason(lambda: check(coord, tagged, signed, inp)) == "image_mismatch"


def test_input_that_does_not_match_its_hash_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    signed, _ = coord.task()
    assert reason(lambda: check(coord, whitelist, signed, base64.b64encode(b"swapped").decode())) == "input_mismatch"
    assert reason(lambda: check(coord, whitelist, signed, "%%%")) == "input_mismatch"
    assert reason(lambda: check(coord, whitelist, signed, 42)) == "bad_format"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.update(v=2),
        lambda t: t.update(attempt="1"),
        lambda t: t.update(attempt=True),
        lambda t: t.update(params="rm -rf /"),
        lambda t: t.pop("nonce"),
        lambda t: t.update(taskId=7),
    ],
)
def test_malformed_tasks_are_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin], mutate) -> None:  # type: ignore[no-untyped-def]
    signed, inp = coord.task()
    task = json.loads(signed["task"])
    mutate(task)
    resigned = coord.sign_text(json.dumps(task))
    assert reason(lambda: check(coord, whitelist, resigned, inp)) in ("bad_format", "unsupported_version")


@pytest.mark.parametrize("signed", [None, "x", {}, {"task": 1, "signature": "x"}, {"task": "{}", "signature": None}])
def test_garbage_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin], signed: object) -> None:
    assert reason(lambda: check(coord, whitelist, signed, "")) in ("bad_format", "unknown_key")


def test_non_json_task_text_is_refused(coord: Coordinator, whitelist: dict[str, WorkloadPin]) -> None:
    assert reason(lambda: check(coord, whitelist, coord.sign_text("not json"), "")) == "bad_format"
    assert reason(lambda: check(coord, whitelist, coord.sign_text("[1,2]"), "")) == "bad_format"


def test_rejections_after_the_signature_carry_the_task_for_reporting(
    coord: Coordinator, whitelist: dict[str, WorkloadPin]
) -> None:
    signed, inp = coord.task(exp=int(time.time()) - 1)
    with pytest.raises(TaskRejected) as info:
        check(coord, whitelist, signed, inp)
    assert info.value.task is not None
    forged = Coordinator().task()[0]
    with pytest.raises(TaskRejected) as info2:
        check(coord, whitelist, forged, inp)
    assert info2.value.task is None


def test_key_id_matches_the_coordinator() -> None:
    # lib/security/signing.ts keyId(): sha256(SPKI DER)[:16]. The preview
    # deployment published this kid for the pinned key.
    assert key_id(trust.PREVIEW_KEY_PEM) == "052ed2bc229d420f"
    # And production published this one.
    assert trust.PRODUCTION_KEY_PEM is not None
    assert key_id(trust.PRODUCTION_KEY_PEM) == "a80990c7b502fa31"


def test_pinned_keys_and_dev_override(coord: Coordinator, monkeypatch: pytest.MonkeyPatch) -> None:
    keys = pinned_keys()
    assert "052ed2bc229d420f" in keys
    assert "a80990c7b502fa31" in keys
    monkeypatch.setenv("NIGHTSHIFT_DEV_PINNED_KEY", coord.pem)
    assert coord.kid not in pinned_keys()  # ignored outside dev mode
    monkeypatch.setenv("NIGHTSHIFT_DEV", "1")
    assert coord.kid in pinned_keys()


def test_digest_pinning_check() -> None:
    assert is_digest_pinned(IMAGE)
    assert not is_digest_pinned("x:latest")
    assert not is_digest_pinned("x@sha256:" + "A" * 64)
    assert not is_digest_pinned("@sha256:" + "a" * 64)
    assert not is_digest_pinned("x@sha256:" + "a" * 63)


def test_shipped_whitelist_is_digest_pinned() -> None:
    for name, pin in trust.WHITELIST.items():
        assert is_digest_pinned(pin.image), name


def test_nonce_store_prunes_expired_entries_and_survives_corruption(tmp_path: Path) -> None:
    store = NonceStore(tmp_path / "n.json")
    assert store.add("a", expires_at=100, now=0)
    assert not store.add("a", expires_at=100, now=50)
    assert store.add("b", expires_at=10_000, now=2000)  # "a" expired + grace → pruned
    assert "a" not in store
    (tmp_path / "n.json").write_text("{corrupt", encoding="utf-8")
    fresh = NonceStore(tmp_path / "n.json")
    assert len(fresh) == 0
    assert (tmp_path / "n.corrupt").exists()
