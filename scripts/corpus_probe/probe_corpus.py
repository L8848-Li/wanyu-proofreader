#!/usr/bin/env python3
"""Report suspicious values in a corpus CSV, counts only.

  python3 scripts/corpus_probe/probe_corpus.py --csv /path/to/正本.csv
  python3 scripts/corpus_probe/probe_corpus.py --csv ... --json
  python3 scripts/corpus_probe/probe_corpus.py --csv ... --show-samples 5

Default output carries row numbers and counts, never field contents: a
diagnostic that dumps dictionary text cannot be pasted into an issue without
leaving unlicensed corpus behind (CONTRIBUTING.md). --show-samples opts into
content and says so on stderr.
"""
import argparse
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import detectors  # noqa: E402
import input_source  # noqa: E402

READING_FIELDS = ("拼音", "莆田IPA", "仙游IPA")
MEANING_FIELDS = ("释义",)


def analyze(headers, rows, repertoire=frozenset()):
    """Return (findings, per-row map) for every parsed row of the corpus."""
    findings = []
    for offset, values in enumerate(rows):
        row = {header: (values[index] if index < len(values) else "")
               for index, header in enumerate(headers)}
        for hit in detectors.analyze_row(row, READING_FIELDS, MEANING_FIELDS,
                                         allowed_repertoire=repertoire):
            findings.append({"line": offset + 2, **hit._asdict()})
    by_field = {header: [values[index] for values in rows if index < len(values)]
                for index, header in enumerate(headers)}
    for hit in detectors.detect_inconsistent_forms(by_field):
        findings.append({"line": None, **hit._asdict()})
    return findings


def tally(findings):
    kinds = collections.Counter((f["kind"], f["severity"]) for f in findings)
    fields = collections.Counter(f["field"] for f in findings)
    return kinds, fields


def main(argv=None):
    parser = argparse.ArgumentParser(description="probe a dialect corpus CSV")
    parser.add_argument("--csv", help="corpus CSV path (or set WANYU_CORPUS_CSV)")
    parser.add_argument("--keyboard", help="keyboard JSON whose characters are "
                        "considered typeable (defaults to the repo's 莆仙方言键盘)")
    parser.add_argument("--json", action="store_true", help="emit findings as json")
    parser.add_argument("--show-samples", type=int, default=0, metavar="N",
                        help="also print N findings with their field contents")
    args = parser.parse_args(argv)

    try:
        path = input_source.resolve_corpus_path(
            ["--csv", args.csv] if args.csv else [])
        keyboard = input_source.resolve_keyboard_path(
            ["--keyboard", args.keyboard] if args.keyboard else [])
        repertoire = input_source.load_repertoire(keyboard)
    except (input_source.InputSourceError, OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    headers, rows = input_source.read_rows(path)
    findings = analyze(headers, rows, repertoire)
    kinds, fields = tally(findings)

    if args.json:
        json.dump({"source": os.path.basename(path), "sha256": input_source.checksum(path),
                   "rows": len(rows), "findings": findings},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(f"source: {os.path.basename(path)}  sha256: {input_source.checksum(path)[:16]}…")
        print(f"rows: {len(rows)}  findings: {len(findings)}")
        for (kind, severity), count in sorted(kinds.items(), key=lambda kv: -kv[1]):
            print(f"  {count:>6}  {kind} [{severity}]")
        print("by field: " + ", ".join(f"{f}={c}" for f, c in sorted(fields.items())))
        lines = sorted({f["line"] for f in findings if f["line"]})
        print(f"affected rows: {len(lines)}")

    if args.show_samples:
        print("warning: output below contains corpus field contents; do not paste "
              "it into issues, commits, or any non-private channel.", file=sys.stderr)
        for item in findings[:args.show_samples]:
            print(json.dumps(item, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
