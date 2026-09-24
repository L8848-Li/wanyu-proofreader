"""Locate the corpus CSV without baking any one machine's path into the code.

The W2 probes defaulted to an absolute path under the author's own synced
conversation directory, so they could not run anywhere else. Resolution is now
explicit: --csv PATH, then $WANYU_CORPUS_CSV, then a hard error.
"""
import csv
import hashlib
import io
import json
import os
import sys

ENV_VAR = "WANYU_CORPUS_CSV"
KEYBOARD_ENV_VAR = "WANYU_KEYBOARD_JSON"
FLAG = "--csv"
ENCODINGS = ("utf-8-sig", "utf-8")
DEFAULT_KEYBOARD = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "backend", "keyboards", "hinghwa-dialect.json")


class InputSourceError(RuntimeError):
    pass


def resolve_corpus_path(argv=None, env=None):
    """Return the corpus path, or raise with the two accepted ways to set it."""
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    for index, token in enumerate(argv):
        if token == FLAG:
            if index + 1 >= len(argv):
                raise InputSourceError(f"{FLAG} needs a path")
            return _checked(argv[index + 1])
        if token.startswith(FLAG + "="):
            return _checked(token.split("=", 1)[1])
    from_env = env.get(ENV_VAR, "").strip()
    if from_env:
        return _checked(from_env)
    raise InputSourceError(
        f"no corpus selected: pass {FLAG} PATH or set {ENV_VAR}")


def _checked(path):
    if not os.path.isfile(path):
        raise InputSourceError(f"corpus file not found: {path}")
    return os.path.abspath(path)


def checksum(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_rows(path):
    """Return (headers, rows) with BOM tolerance, matching the 正本's encoding."""
    raw = None
    for encoding in ENCODINGS:
        try:
            with open(path, "r", encoding=encoding, newline="") as handle:
                raw = handle.read()
            break
        except UnicodeDecodeError:
            continue
    if raw is None:
        raise InputSourceError(f"unsupported encoding: {path}")
    rows = list(csv.reader(io.StringIO(raw)))
    if not rows:
        raise InputSourceError(f"empty csv: {path}")
    return rows[0], rows[1:]


def resolve_keyboard_path(argv=None, env=None):
    """A --keyboard path wins over $WANYU_KEYBOARD_JSON, which wins over the repo preset."""
    argv = list(sys.argv[1:] if argv is None else argv)
    env = os.environ if env is None else env
    for index, token in enumerate(argv):
        if token == "--keyboard" and index + 1 < len(argv):
            return _checked(argv[index + 1])
    from_env = env.get(KEYBOARD_ENV_VAR, "").strip()
    if from_env:
        return _checked(from_env)
    return DEFAULT_KEYBOARD


def load_repertoire(path):
    """Codepoints the project's own keyboard declares as typeable.

    #177 R1 judges a reading value against exactly this set: anything a
    proofreader cannot reach from the enabled keyboards is worth a look.
    """
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    chars = set()
    for section in data.get("sections", []):
        for key in section.get("keys", []):
            value = key.get("value")
            if isinstance(value, str):
                chars.update(value)
    return frozenset(ord(char) for char in chars)
