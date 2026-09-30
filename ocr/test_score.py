#!/usr/bin/env python3
"""score.py 的回归测试（覆盖 #120 审查意见的 6 个构造用例，
以及「合并未分离检出率」「弃权质量」两项指标的 happy/edge 用例）。

只使用标准库 unittest，无需安装额外依赖。
运行：python -m unittest ocr.test_score 或 python ocr/test_score.py
"""

import csv
import io
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from score import score, align_positions  # noqa: E402


def make_csv(rows, fields):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=fields)
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


FIELDS = ["词头", "音读", "释义"]


class TestHardCharAlignment(unittest.TestCase):
    def test_insert_does_not_destroy_hard_chars(self):
        # 审查用例1：待测只多一个首字符，难字全部认对 → 生僻字覆盖应接近1，静默替换≈0
        gold = [{"词头": "㨄ɛʔ", "音读": "a", "释义": "x"}]
        test = [{"词头": "X㨄ɛʔ", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreaterEqual(r["生僻字覆盖"], 0.9)
        self.assertLessEqual(r["静默替换率"], 0.01)

    def test_silent_replace_detected(self):
        # 难字被换成常用字 → 静默替换率 > 0
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "本", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreater(r["静默替换率"], 0.0)


class TestAbstain(unittest.TestCase):
    def test_abstain_counts_as_covered(self):
        # 审查用例2：诚实弃权（空格/PUA/IDS）应记为合法弃权，生僻字覆盖=(认对+弃权)/总数
        gold = [{"词头": "㨄㧟", "音读": "a", "释义": "x"}]
        test = [{"词头": "  ", "音读": "a", "释义": "x"}]  # 两个难字各弃权成空格
        r = score(gold, test, FIELDS)
        # 弃权应计入覆盖，静默替换应为0
        self.assertGreaterEqual(r["生僻字覆盖"], 0.9)
        self.assertEqual(r["静默替换率"], 0.0)

    def test_pua_is_abstain_not_silent(self):
        # PUA 占位应算弃权，不算静默替换
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "", "音读": "a", "释义": "x"}]  # PUA
        r = score(gold, test, FIELDS)
        self.assertEqual(r["静默替换率"], 0.0)


class TestHardCharSet(unittest.TestCase):
    def test_compat_and_ext_g_are_hard(self):
        # 审查用例3：U+F900（兼容表意）、U+30000（Ext G）必须是难字
        hard = chr(0xF900) + chr(0x30000)
        gold = [{"词头": hard, "音读": "a", "释义": "x"}]
        test = [{"词头": "本本", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreater(r["难字总数"], 0)
        self.assertGreater(r["静默替换率"], 0.0)


class TestMissingColumn(unittest.TestCase):
    def test_missing_column_is_not_full_score(self):
        # 审查用例4：待测缺「释义」列 → 不能满分
        gold = [{"词头": "a", "音读": "b", "释义": "c"}]
        test = [{"词头": "a", "音读": "b"}]  # 缺释义列
        r = score(gold, test, FIELDS)
        self.assertLess(r["列归属准确率"], 1.0)


class TestKeyAlignment(unittest.TestCase):
    def test_key_alignment_matches_rows(self):
        # 审查用例5：--key 应该按键值对齐，行序换了不该全错
        gold = [
            {"页码": "1", "词头": "a", "音读": "b", "释义": "c"},
            {"页码": "2", "词头": "d", "音读": "e", "释义": "f"},
        ]
        test = [
            {"页码": "2", "词头": "d", "音读": "e", "释义": "f"},
            {"页码": "1", "词头": "a", "音读": "b", "释义": "c"},
        ]
        r = score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")
        self.assertEqual(r["列归属准确率"], 1.0)

    def test_empty_key_raises(self):
        # 阻断2：键列存在但值为空时，必须报错，不能静默退化成按行序对齐
        gold = [{"页码": "", "词头": "a", "音读": "b", "释义": "c"}]
        test = [{"页码": "", "词头": "a", "音读": "b", "释义": "c"}]
        with self.assertRaises(ValueError):
            score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")

    def test_none_key_raises(self):
        # 阻断（AI 新提）：csv.DictReader 对列数少于表头的行，缺失键填 None；
        # None 也必须视为空值，不能变成字面量 "None" 躲过空值保护。
        gold = [{"页码": None, "词头": "a", "音读": "b", "释义": "c"}]
        test = [{"页码": None, "词头": "a", "音读": "b", "释义": "c"}]
        with self.assertRaises(ValueError):
            score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")


class TestCerbounded(unittest.TestCase):
    def test_cer_is_bounded(self):
        # 审查用例6：空gold里吐出超长字符，CER/准确率必须 clamp 在 [0,1]
        gold = [{"词头": "", "音读": "", "释义": ""}]
        test = [{"词头": "x" * 61, "音读": "", "释义": ""}]
        r = score(gold, test, FIELDS)
        self.assertGreaterEqual(r["字级错误率 CER"], 0.0)
        self.assertLessEqual(r["字级错误率 CER"], 1.0)
        self.assertGreaterEqual(r["字级准确率"], 0.0)
        self.assertLessEqual(r["字级准确率"], 1.0)


class TestNoData(unittest.TestCase):
    def test_no_match_is_not_full_score(self):
        # 阻断1：一个都没比对时，不能报字级准确率 1.0
        gold = [{"页码": "1", "词头": "a", "音读": "b", "释义": "c"}]
        test = [{"页码": "999", "词头": "x", "音读": "y", "释义": "z"}]
        r = score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")
        # 没有共同键 → 匹配行数 0，字级准确率应为 None（无数据），不是 1.0
        self.assertEqual(r["匹配行数"], 0)
        self.assertIsNone(r["字级准确率"])


class TestDuplicateKey(unittest.TestCase):
    def test_duplicate_key_not_dropped(self):
        # 阻断2：--key 遇到重复键不能静默丢行
        gold = [
            {"页码": "1", "词头": "㨄", "音读": "b", "释义": "c"},
            {"页码": "1", "词头": "㧟", "音读": "e", "释义": "f"},
            {"页码": "1", "词头": "㨄", "音读": "h", "释义": "i"},
            {"页码": "1", "词头": "㧟", "音读": "k", "释义": "l"},
        ]
        test = [dict(r) for r in gold]  # 完全一致
        r_key = score(gold, test, ["页码", "词头", "音读", "释义"], key="页码")
        r_row = score(gold, test, ["页码", "词头", "音读", "释义"])
        # 难字总数应与行序模式一致（不能因重复键丢 3/4 数据）
        self.assertEqual(r_key["难字总数"], r_row["难字总数"])
        self.assertEqual(r_key["列归属准确率"], 1.0)


class TestIpaCharset(unittest.TestCase):
    def test_eng_is_hard(self):
        # 阻断3：ŋ（软颚鼻音）必须被判为难字（之前漏判导致难字总数=0）。
        # ASCII 短路之后，n 是普通字、ŋ 是难字，ŋ→n 正确落入静默替换，
        # 因此这里既断言难字被识别，也断言静默替换率非 0（防止把 ASCII 放宽回去）。
        gold = [{"词头": "ɛŋʔ", "音读": "a", "释义": "x"}]
        test = [{"词头": "ɛnʔ", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["难字总数"], 3)  # ɛ、ŋ、ʔ 三个都是 IPA 难字
        self.assertGreater(r["静默替换率"], 0.0)  # ŋ→n 是难字→普通字

    def test_hard_char_to_common_char_is_silent_replace(self):
        # 难字被认成真正的常见字（非音标）时，才应记静默替换
        gold = [{"词头": "ɛŋ", "音读": "a", "释义": "x"}]
        test = [{"词头": "本本", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertGreater(r["静默替换率"], 0.0)


class TestMergeRecall(unittest.TestCase):
    def test_merge_marked_by_space(self):
        # AC-1：相邻两列并入左格、边界有空格弃权 → 计为合并且被标记
        gold = [{"词头": "山", "音读": "san", "释义": "x"}]
        test = [{"词头": "山 san", "音读": "", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 1)
        self.assertEqual(r["合并未分离检出率"], 1.0)

    def test_merge_marked_by_pua(self):
        # PUA 占位在 A/B 边界同样算「被标记」
        gold = [{"词头": "山", "音读": "san", "释义": "x"}]
        test = [{"词头": "山\ue000san", "音读": "", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 1)
        self.assertEqual(r["合并未分离检出率"], 1.0)

    def test_silent_merge_not_marked(self):
        # AC-2：静默合并（边界无任何标记）→ 计入分母、不计分子
        gold = [{"词头": "山", "音读": "san", "释义": "x"}]
        test = [{"词头": "山san", "音读": "", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 1)
        self.assertEqual(r["合并未分离检出率"], 0.0)

    def test_space_inside_right_field_is_not_boundary(self):
        # 右列内部的空格不得误判为分界标记
        gold = [{"词头": "山", "音读": "s n", "释义": "x"}]
        test = [{"词头": "山s n", "音读": "", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 1)
        self.assertEqual(r["合并未分离检出率"], 0.0)

    def test_no_merge_case_is_none(self):
        # AC-3：完全正确的输出没有合并案例 → None（无数据），不得报 1.0 冒充结论
        gold = [{"词头": "山", "音读": "san", "释义": "x"}]
        test = [dict(row) for row in gold]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 0)
        self.assertIsNone(r["合并未分离检出率"])

    def test_three_column_run_on_is_out_of_scope(self):
        # 口径限制（README 已写明）：三列连续合并不在合并检出率口径内，
        # 由列归属准确率计错；此处锁定该行为不被悄悄改变
        gold = [{"词头": "a", "音读": "b", "释义": "c"}]
        test = [{"词头": "abc", "音读": "", "释义": ""}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["合并案例数"], 0)
        self.assertLess(r["列归属准确率"], 1.0)


class TestAbstainQuality(unittest.TestCase):
    def test_pua_abstain_needs_human(self):
        # AC-4：PUA 弃权且与 gold 不一致 → 确需人工，质量 = 1.0
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "\ue000", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["弃权格数"], 1)
        self.assertEqual(r["弃权质量"], 1.0)

    def test_ids_abstain_counts(self):
        # IDS 运算符（U+2FF0–U+2FFF）也是格级低置信标记
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "⿻木木", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["弃权格数"], 1)
        self.assertEqual(r["弃权质量"], 1.0)

    def test_space_cells_not_abstained(self):
        # AC-5：空格不构成低置信格 → 分母 0，弃权质量 = None
        gold = [{"词头": "㨄", "音读": "a", "释义": "x"}]
        test = [{"词头": "  ", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["弃权格数"], 0)
        self.assertIsNone(r["弃权质量"])

    def test_abstain_on_already_correct_cell_is_wasted(self):
        # gold 本就含 PUA 且被精确复制 → 弃权了但不需要人工，计入 wasted
        gold = [{"词头": "\ue001", "音读": "a", "释义": "x"}]
        test = [{"词头": "\ue001", "音读": "a", "释义": "x"}]
        r = score(gold, test, FIELDS)
        self.assertEqual(r["弃权格数"], 1)
        self.assertEqual(r["弃权质量"], 0.0)


if __name__ == "__main__":
    unittest.main()
