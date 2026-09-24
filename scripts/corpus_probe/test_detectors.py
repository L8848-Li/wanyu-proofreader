#!/usr/bin/env python3
"""Tests for the corpus probe detectors and their input handling.

Every detector here is a gate someone will eventually trust to say "look at
this row", so each one is pinned from both sides: a value that must hit and the
neighbouring value that must not. The 533/453 pair and the keyboard repertoire
are the two places where an over-eager regex would bury proofreaders in noise.
"""
import contextlib
import importlib.util
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


detectors = _load("detectors")
input_source = _load("input_source")
probe_corpus = _load("probe_corpus")

FIXTURE = HERE / "fixtures" / "mini_corpus.csv"
KEYBOARD = HERE.parents[1] / "backend" / "keyboards" / "hinghwa-dialect.json"


class ToneRunTests(unittest.TestCase):
    def test_flags_long_run_that_is_not_a_legal_contour(self):
        hits = detectors.detect_illegal_tone_runs("sa1234", "拼音")
        self.assertEqual([detectors.READING_FORMAT_INVALID], [h.kind for h in hits])
        self.assertEqual(["1234"], hits[0].params["runs"])

    def test_legal_three_digit_contours_are_not_flagged(self):
        for value in ("to533", "to453"):
            self.assertEqual([], detectors.detect_illegal_tone_runs(value, "拼音"))

    def test_short_tone_digits_are_ignored(self):
        for value in ("ka55", "ŋa22", "ia1", "zua42"):
            self.assertEqual([], detectors.detect_illegal_tone_runs(value, "拼音"))

    def test_empty_value_is_safe(self):
        self.assertEqual([], detectors.detect_illegal_tone_runs("", "拼音"))

    def test_two_bad_runs_in_one_value_are_both_reported(self):
        hits = detectors.detect_illegal_tone_runs("a1234 b9999", "拼音")
        self.assertEqual(["1234", "9999"], hits[0].params["runs"])


class ToneCountTests(unittest.TestCase):
    def test_mismatch_between_pinyin_and_ipa(self):
        hits = detectors.detect_tone_count_mismatch("ka55 hi21", "ka55")
        self.assertEqual(1, len(hits))
        self.assertEqual({"pinyin_count": 2, "ipa_count": 1}, hits[0].params)

    def test_agreement_is_silent(self):
        self.assertEqual([], detectors.detect_tone_count_mismatch("ka55 hi21", "ka55 hi21"))

    def test_a_flattened_superscript_is_left_to_the_tone_run_detector(self):
        # "22" flattened into "222" is still one tone token, so this detector
        # stays quiet and detect_illegal_tone_runs is the one that fires.
        self.assertEqual([], detectors.detect_tone_count_mismatch("ŋã22", "ŋa222"))
        self.assertEqual(1, len(detectors.detect_illegal_tone_runs("ŋa222", "莆田IPA")))

    def test_missing_evidence_is_not_guessed(self):
        self.assertEqual([], detectors.detect_tone_count_mismatch("ka55", ""))
        self.assertEqual([], detectors.detect_tone_count_mismatch("", "ka55"))


class PlaceholderTests(unittest.TestCase):
    def test_hex_placeholder_is_reported_with_the_markers(self):
        hits = detectors.detect_missing_glyph_placeholders("@4E2D ia55", "拼音")
        self.assertEqual({"@4E2D"}, set(hits[0].params["marks"]))

    def test_at_sign_without_hex_is_not_a_placeholder(self):
        self.assertEqual([], detectors.detect_missing_glyph_placeholders("mail@example", "拼音"))


class ColumnCollapseTests(unittest.TestCase):
    def test_region_label_inside_a_reading_column(self):
        hits = detectors.detect_column_collapse("zua42 〔莆〕", "拼音")
        self.assertIn("region_label", hits[0].params["reasons"])

    def test_unbalanced_bracket(self):
        hits = detectors.detect_column_collapse("ka55］", "拼音")
        self.assertIn("unbalanced_bracket", hits[0].params["reasons"])

    def test_balanced_bracket_is_fine(self):
        self.assertEqual([], detectors.detect_column_collapse("ka55［1］", "拼音"))


class MeaningTests(unittest.TestCase):
    def test_meaning_that_is_only_a_phonetic_fragment_is_strong(self):
        hits = detectors.detect_phonetic_in_meaning("tsɔ33")
        self.assertEqual("meaning_is_phonetic_fragment", hits[0].message)
        self.assertEqual(detectors.STRONG, hits[0].severity)

    def test_phonetic_run_inside_prose_is_a_warning(self):
        hits = detectors.detect_phonetic_in_meaning("看看 ka33 东西")
        self.assertEqual(detectors.WARN, hits[0].severity)
        self.assertEqual("phonetic_run_inside_meaning", hits[0].message)

    def test_pure_meaning_is_clean(self):
        self.assertEqual([], detectors.detect_phonetic_in_meaning("第一"))

    def test_a_separated_sense_list_is_not_flagged(self):
        self.assertEqual([], detectors.detect_phonetic_in_meaning("甲：ka33；乙：lu21"))


class NormalizationFormTests(unittest.TestCase):
    def test_classifies_each_form(self):
        cases = {
            "": "empty",
            "ka55": "neutral",
            "kʰ\u00e355": "nfc",
            "k\u02b0a\u030355": "nfd",
        }
        for value, expected in cases.items():
            self.assertEqual(expected, detectors.normalization_form(value), repr(value))

    def test_mixed_column_flags_the_minority_form(self):
        hits = detectors.detect_inconsistent_forms(
            {"拼音": ["k\u00e355", "ka55", "a\u030355", "ki33"]})
        self.assertEqual([detectors.ENCODING_FORM_ANOMALY], [h.kind for h in hits])
        self.assertEqual("nfd", hits[0].params["minority"])

    def test_uniform_column_is_silent(self):
        self.assertEqual([], detectors.detect_inconsistent_forms(
            {"拼音": ["k\u00e355", "\u00e3", "ka55"]}))

    def test_combining_marks_are_reported_as_info(self):
        hits = detectors.detect_combining_marks("a\u0303", "莆田IPA")
        self.assertEqual(["0x303"], hits[0].params["marks"])
        self.assertEqual(detectors.INFO, hits[0].severity)
        self.assertEqual([], detectors.detect_combining_marks("ka55", "莆田IPA"))


class RepertoireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.repertoire = input_source.load_repertoire(str(KEYBOARD))

    def test_keyboard_declares_the_nasalised_and_ipa_characters_we_use(self):
        for char in ("\u00e3", "\u0254", "\u01fe", "\u02b0"):
            self.assertIn(ord(char), self.repertoire, char)

    def test_character_outside_the_keyboard_is_flagged(self):
        hits = detectors.detect_non_repertoire_chars("\u0254\u03a955", "莆田IPA",
                                                     self.repertoire)
        self.assertEqual(["0x3a9"], hits[0].params["codepoints"])

    def test_in_repertoire_characters_are_not_flagged(self):
        self.assertEqual([], detectors.detect_non_repertoire_chars(
            "\u01fe\u00e3\u0254\u02b055", "莆田IPA", self.repertoire))

    def test_cjk_extension_is_reported_separately(self):
        hits = detectors.detect_cjk_extension("\U00020000", "词条")
        self.assertEqual(["0x20000"], hits[0].params["codepoints"])
        self.assertEqual([], detectors.detect_cjk_extension("甲", "词条"))


class EntryIdentityTests(unittest.TestCase):
    """R-DEDUP: same-form headwords are never merged."""

    def test_headword_alone_is_not_an_identity(self):
        left = detectors.entry_identity("甲", "ka55")
        right = detectors.entry_identity("甲", "to533")
        self.assertNotEqual(left, right)

    def test_grouping_keeps_every_member(self):
        rows = [{"词条": "甲", "拼音": "ka55", "n": 1},
                {"词条": "甲", "拼音": "to533", "n": 2},
                {"词条": "甲", "拼音": "ka55", "n": 3}]
        groups = detectors.group_by_identity(rows)
        self.assertEqual(2, len(groups))
        self.assertEqual([1, 3], [row["n"] for row in groups[("甲", "ka55")]])


class RowLevelBehaviourTests(unittest.TestCase):
    """Two behaviours that only exist to keep the signal worth reading."""

    def test_placeholder_digits_are_not_counted_as_tones(self):
        row = {"词条": "壬", "拼音": "@4E2D ia55", "莆田IPA": "ia55", "仙游IPA": "ia55"}
        hits = detectors.analyze_row(row, allowed_repertoire=frozenset())
        self.assertNotIn("tone_token_count_differs", [h.message for h in hits])
        self.assertIn("missing_glyph_placeholder", [h.message for h in hits])

    def test_a_broken_cell_reports_once(self):
        row = {"词条": "庚", "拼音": "zua42 〔莆〕", "莆田IPA": "zua42"}
        hits = detectors.analyze_row(row, allowed_repertoire=frozenset())
        messages = [h.message for h in hits]
        self.assertIn("column_collapse", messages)
        self.assertNotIn("non_ipa_range_codepoints", messages)

    def test_a_clean_cell_still_reports_repertoire(self):
        row = {"词条": "特", "拼音": "\u0254\u03a955", "莆田IPA": "\u0254\u03a955"}
        hits = detectors.analyze_row(row, allowed_repertoire=frozenset())
        self.assertIn("non_ipa_range_codepoints", [h.message for h in hits])


class ProbeEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.headers, self.rows = input_source.read_rows(str(FIXTURE))
        self.findings = probe_corpus.analyze(
            self.headers, self.rows, input_source.load_repertoire(str(KEYBOARD)))

    def test_fixture_exercises_the_expected_kinds(self):
        found = {item["kind"] for item in self.findings}
        for expected in (detectors.READING_FORMAT_INVALID, detectors.MERGED_COLUMNS,
                         detectors.MISSING_GLYPH_PLACEHOLDER,
                         detectors.ENCODING_FORM_ANOMALY, detectors.CHAR_OUT_OF_REPERTOIRE,
                         detectors.OUTSIDE_UNICODE_SET):
            self.assertIn(expected, found)

    def test_illegal_run_row_is_attributable(self):
        lines = {item["line"] for item in self.findings
                 if item["message"] == "long_digit_run"}
        self.assertIn(4, lines)      # sa1234 sits on csv line 4
        self.assertNotIn(2, lines)   # to533 is legal

    def test_default_output_never_echoes_field_contents(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        argv_backup = list(os.sys.argv)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            os.sys.argv = ["probe_corpus.py"]
            try:
                self.assertEqual(0, probe_corpus.main(["--csv", str(FIXTURE)]))
            finally:
                os.sys.argv = argv_backup
        out = stdout.getvalue()
        # Column headers are structure, not corpus content; values are the leak.
        for leaked in ("第一", "第二", "tsɔ33", "看看", "kʰã55", str(FIXTURE)):
            self.assertNotIn(leaked, out)
        self.assertIn("findings:", out)

    def test_json_output_also_stays_content_free_without_show_samples(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            probe_corpus.main(["--csv", str(FIXTURE), "--json"])
        payload = json.loads(stdout.getvalue())
        self.assertNotIn("第一", json.dumps(payload, ensure_ascii=False))
        self.assertEqual(os.path.basename(str(FIXTURE)), payload["source"])

    def test_show_samples_warns_that_output_now_contains_corpus(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            probe_corpus.main(["--csv", str(FIXTURE), "--show-samples", "1"])
        self.assertIn("do not paste", stderr.getvalue())
        self.assertTrue(any(line.startswith("{")
                            for line in stdout.getvalue().splitlines()))


class InputSourceTests(unittest.TestCase):
    def test_flag_wins_over_environment(self):
        with tempfile.TemporaryDirectory() as work:
            chosen = Path(work) / "chosen.csv"
            chosen.write_text("PDF页码,词条\n1,甲\n", encoding="utf-8")
            other = Path(work) / "other.csv"
            other.write_text("PDF页码,词条\n1,乙\n", encoding="utf-8")
            resolved = input_source.resolve_corpus_path(
                ["--csv", str(chosen)], env={input_source.ENV_VAR: str(other)})
            self.assertEqual(str(chosen), resolved)

    def test_equals_form_of_the_flag_is_accepted(self):
        with tempfile.TemporaryDirectory() as work:
            chosen = Path(work) / "c.csv"
            chosen.write_text("PDF页码\n1\n", encoding="utf-8")
            self.assertEqual(str(chosen),
                             input_source.resolve_corpus_path([f"--csv={chosen}"], env={}))

    def test_no_default_is_selected_on_any_machine(self):
        with self.assertRaises(input_source.InputSourceError) as caught:
            input_source.resolve_corpus_path([], env={})
        self.assertIn("--csv", str(caught.exception))

    def test_missing_file_is_reported_not_crashed(self):
        with self.assertRaises(input_source.InputSourceError):
            input_source.resolve_corpus_path(["--csv", "/nonexistent/corpus.csv"], env={})

    def test_keyboard_defaults_to_the_repository_copy(self):
        self.assertEqual(str(KEYBOARD), input_source.resolve_keyboard_path([], env={}))

    def test_bom_is_tolerated(self):
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "bom.csv"
            path.write_bytes("PDF页码,词条\n1,甲\n".encode("utf-8-sig"))
            headers, rows = input_source.read_rows(str(path))
            self.assertEqual(["PDF页码", "词条"], headers)
            self.assertEqual([["1", "甲"]], rows)


if __name__ == "__main__":
    unittest.main()
