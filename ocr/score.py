#!/usr/bin/env python3
"""
score.py — 万语校坊 OCR 验收打分脚本（#120）

对比「参考真值 CSV（标准答案）」与「待测 CSV（OCR 结果）」，输出验收指标。

用法：
    python score.py --gold 标准答案.csv --test 待测结果.csv [--key 页码/行号列]

对齐约定：
    - 默认按 CSV 行顺序对齐；
    - 若指定 --key，按该列值对齐（gold 有 test 无 / test 有 gold 无 分开计数）。

指标（与 #120 验收表对应，语义见各函数注释）：
    字级准确率 / 字级错误率 CER
    列归属准确率
    行对齐率
    生僻字覆盖
    静默替换率
    集外字可表示性
    合并未分离检出率
    弃权质量
"""

import argparse
import csv
import sys
from pathlib import Path

from charset import (
    is_abstain_char,
    is_hard_char,
    is_placeholder_char,
)


def read_csv(path):
    """读取 CSV，返回 (表头列表, 行列表[dict])。"""
    with open(path, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows = [dict(row) for row in reader]
    return fieldnames, rows


def levenshtein(a, b):
    """标准 Levenshtein 编辑距离。"""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            insert = curr[-1] + 1
            delete = prev[j] + 1
            replace = prev[j - 1] + (ca != cb)
            curr.append(min(insert, delete, replace))
        prev = curr
    return prev[-1]


def align_positions(gold, test):
    """用 Levenshtein 回溯，返回 [(gold_idx, test_idx_or_None)] 的对齐结果。

    对 gold 的每个字符，给出它在 test 中对齐到的位置：
    - 相同字符或「替换」：对齐到对应 test 位置；
    - 「删除」（gold 有、test 无）：对齐到 None。

    调用方据此判断难字是认对 / 弃权 / 静默替换 / 被丢弃。
    """
    a, b = gold, test
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)

    # 回溯，构建 gold 每个位置 → test 位置（或 None）的映射
    mapping = [None] * m
    i, j = m, n
    while i > 0 or j > 0:
        if i > 0 and j > 0 and a[i - 1] == b[j - 1]:
            mapping[i - 1] = j - 1
            i -= 1
            j -= 1
        elif i > 0 and j > 0 and dp[i][j] == dp[i - 1][j - 1] + 1:
            # 替换
            mapping[i - 1] = j - 1
            i -= 1
            j -= 1
        elif i > 0 and (j == 0 or dp[i - 1][j] <= dp[i][j - 1]):
            # 删除：gold 有、test 无
            mapping[i - 1] = None
            i -= 1
        else:
            # 插入：test 有、gold 无（跳过 test 字符）
            j -= 1
    return mapping


def merge_case(gold_a, gold_b, test_val):
    """判定「左格吞并右列」的未分离合并，及是否被弃权标记。

    规则（口径见 README「合并未分离检出率」）：
    - 合并案例：gold 相邻两字段 A、B 均非空，test 对应 A 列的格子去掉
      弃权标记字符（空格/PUA/IDS）后恰好等于 A、B 各去掉弃权标记后的拼接。
    - 被标记：合并格在 A 段结束、B 段开始的边界处出现了弃权标记字符
      （即引擎承认这两块内容之间有分界）。贪心按 A→B 顺序对齐，
      边界取 A 内容消耗完毕处。
    - 返回 None 表示不构成合并案例；False 为静默合并；True 为合并但被标记。
    """
    if not gold_a or not gold_b or not test_val:
        return None
    qa = [c for c in gold_a if not is_abstain_char(c)]
    qb = [c for c in gold_b if not is_abstain_char(c)]
    qt = [c for c in test_val if not is_abstain_char(c)]
    if not qa or not qb or qt != qa + qb:
        return None
    ia = 0
    ib = 0
    boundary_marked = False
    for ch in test_val:
        if is_abstain_char(ch):
            if ia == len(qa) and ib == 0:
                # 弃权标记恰好落在 A/B 边界（B 内容尚未开始）
                boundary_marked = True
            continue
        if ia < len(qa):
            ia += 1
        else:
            ib += 1
    return boundary_marked


def score(gold_rows, test_rows, fields, key=None):
    """对两份数据逐字段打分。

    fields：按标准答案的字段表（待测缺列按空值计错，不从分母剔除）。
    key：若给定，按键列对齐；否则按行序对齐。

    若 key 列存在空值，抛 ValueError（避免静默退化成按行序对齐）。
    """
    if key:
        def key_value(row):
            # csv.DictReader 对列数少于表头的行，把缺失键填成 None；
            # 这里 None 与空串都视为"无键值"，避免 str(None) 变成字面量 "None"。
            value = row.get(key, "")
            if value is None:
                return ""
            return str(value).strip()

        empty_gold = sum(1 for r in gold_rows if not key_value(r))
        empty_test = sum(1 for r in test_rows if not key_value(r))
        if empty_gold or empty_test:
            raise ValueError(
                f"--key 列 {key} 存在空值（标准答案 {empty_gold} 行、待测 {empty_test} 行），"
                f"无法按键值对齐。请换一个无空值的列，或去掉 --key 按行序对齐。"
            )

    n_gold = len(gold_rows)
    n_test = len(test_rows)

    # ── 行对齐 ──
    if key:
        # 按键列分组（列表，支持同键多行，避免字典覆盖丢行）
        gold_by_key = {}
        for r in gold_rows:
            gold_by_key.setdefault(key_value(r), []).append(r)
        test_by_key = {}
        for r in test_rows:
            test_by_key.setdefault(key_value(r), []).append(r)
        common = set(gold_by_key) & set(test_by_key)
        only_gold = set(gold_by_key) - set(test_by_key)
        only_test = set(test_by_key) - set(gold_by_key)
        # 同键多行时，按行序逐一配对（多退少补）
        pairs = []
        for k in common:
            g_rows = gold_by_key[k]
            t_rows = test_by_key[k]
            for i in range(max(len(g_rows), len(t_rows))):
                g = g_rows[i] if i < len(g_rows) else {}
                t = t_rows[i] if i < len(t_rows) else {}
                pairs.append((g, t))
        matched_rows = sum(
            min(len(gold_by_key[k]), len(test_by_key[k])) for k in common
        )
    else:
        n = max(n_gold, n_test)
        pairs = [
            (gold_rows[i] if i < n_gold else {}, test_rows[i] if i < n_test else {})
            for i in range(n)
        ]
        matched_rows = min(n_gold, n_test)
        only_gold = n_gold - n_test if n_gold > n_test else 0
        only_test = n_test - n_gold if n_test > n_gold else 0

    total_cells = 0
    matched_cells = 0
    total_chars = 0
    total_char_errors = 0

    hard_total = 0
    hard_correct = 0
    hard_abstained = 0
    hard_missing = 0
    silent_replace = 0

    merge_total = 0
    merge_marked = 0
    abstain_total = 0
    abstain_needed = 0

    for gold_row, test_row in pairs:
        for fi, field in enumerate(fields):
            gold_val = str(gold_row.get(field, "") or "")
            test_val = str(test_row.get(field, "") or "")
            total_cells += 1
            if gold_val == test_val:
                matched_cells += 1

            # CER 累加（clamp 在最终计算处）
            total_chars += max(1, len(gold_val))
            total_char_errors += levenshtein(gold_val, test_val)

            # 难字比对：用回溯对齐，gold 每个难字对齐到 test 字符或 None
            mapping = align_positions(gold_val, test_val)
            for gi, ti in enumerate(mapping):
                gch = gold_val[gi]
                if not is_hard_char(gch):
                    continue
                hard_total += 1
                if ti is None:
                    # gold 的难字被删除（test 无对应）→ 丢弃
                    hard_missing += 1
                else:
                    tch = test_val[ti]
                    if tch == gch:
                        hard_correct += 1
                    elif is_abstain_char(tch):
                        hard_abstained += 1
                    elif is_hard_char(tch):
                        # 难字认成别的难字：未覆盖，但不是静默替换
                        pass
                    else:
                        # 难字被换成常见字 → 静默替换
                        silent_replace += 1

            # 弃权质量：含 PUA/IDS 占位符的 test 格视为「标为低置信」；
            # 与 gold 不完全一致 → 确实需要人工。空格不算低置信标记。
            if any(is_placeholder_char(c) for c in test_val):
                abstain_total += 1
                if test_val != gold_val:
                    abstain_needed += 1

            # 合并未分离检出率：本列 test 格吞并了右侧相邻 gold 列
            if fi + 1 < len(fields):
                next_gold = str(gold_row.get(fields[fi + 1], "") or "")
                mc = merge_case(gold_val, next_gold, test_val)
                if mc is not None:
                    merge_total += 1
                    if mc:
                        merge_marked += 1

    # 没有任何可比对单元格/字符时，指标标记为「无数据」，不得报满分（0/1）。
    no_data = total_cells == 0

    if no_data:
        cell_accuracy = None
        cer = None
        hard_coverage = None
        silent_replace_rate = None
        representability = None
    else:
        cell_accuracy = matched_cells / total_cells
        cer = min(1.0, total_char_errors / total_chars) if total_chars else 0.0
        hard_covered = hard_correct + hard_abstained
        hard_coverage = hard_covered / hard_total if hard_total else 0.0
        silent_replace_rate = silent_replace / hard_total if hard_total else 0.0
        representability = 1 - (hard_missing / hard_total) if hard_total else 0.0

    # 合并未分离检出率 / 弃权质量：分母为 0 时输出 None（无数据），不冒充 0 或 1。
    merge_recall = merge_marked / merge_total if merge_total else None
    abstain_quality = abstain_needed / abstain_total if abstain_total else None

    # 行对齐率 = 按键值/行序实际匹配上的行数比例
    row_alignment = matched_rows / n_gold if n_gold else 0.0

    def fmt(v):
        return None if v is None else round(v, 4)

    return {
        "标准行数": n_gold,
        "待测行数": n_test,
        "匹配行数": matched_rows,
        "行对齐率": round(row_alignment, 4),
        "列归属准确率": fmt(cell_accuracy),
        "字级错误率 CER": fmt(cer),
        "字级准确率": None if cer is None else round(1 - cer, 4),
        "难字总数": hard_total,
        "生僻字覆盖": fmt(hard_coverage),
        "静默替换率": fmt(silent_replace_rate),
        "集外字可表示性": fmt(representability),
        "合并案例数": merge_total,
        "合并未分离检出率": fmt(merge_recall),
        "弃权格数": abstain_total,
        "弃权质量": fmt(abstain_quality),
        "仅标准答案有": only_gold if isinstance(only_gold, int) else len(only_gold),
        "仅待测结果有": only_test if isinstance(only_test, int) else len(only_test),
    }


def main():
    parser = argparse.ArgumentParser(description="万语校坊 OCR 验收打分脚本")
    parser.add_argument("--gold", required=True, help="参考真值 CSV（标准答案）")
    parser.add_argument("--test", required=True, help="待测 CSV（OCR 结果）")
    parser.add_argument("--key", default="", help="按该列值对齐（留空则按行顺序）")
    args = parser.parse_args()

    gold_path = Path(args.gold)
    test_path = Path(args.test)
    if not gold_path.is_file():
        print(f"错误：标准答案文件不存在 {gold_path}", file=sys.stderr)
        sys.exit(1)
    if not test_path.is_file():
        print(f"错误：待测文件不存在 {test_path}", file=sys.stderr)
        sys.exit(1)

    gold_fields, gold_rows = read_csv(gold_path)
    test_fields, test_rows = read_csv(test_path)

    # 按标准答案的字段表打分：待测缺列按空值计错，不从分母剔除
    fields = list(gold_fields)
    missing = [f for f in gold_fields if f not in test_fields]
    if missing:
        print(f"警告：待测 CSV 缺少字段 {missing}，这些字段按全错计。", file=sys.stderr)
    extra = [f for f in test_fields if f not in gold_fields]
    if extra:
        print(f"提示：待测 CSV 多出字段 {extra}，不参与打分。", file=sys.stderr)

    key = args.key.strip() if args.key else None
    if key and key not in gold_fields:
        print(f"错误：--key 指定的列 {key} 不在标准答案的字段中。", file=sys.stderr)
        sys.exit(1)

    try:
        result = score(gold_rows, test_rows, fields, key=key)
    except ValueError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        sys.exit(1)

    print("=" * 50)
    print("万语校坊 OCR 打分结果")
    print("=" * 50)
    print(f"标准答案: {gold_path.name} ({len(gold_rows)} 行)")
    print(f"待测结果: {test_path.name} ({len(test_rows)} 行)")
    print(f"比较字段: {', '.join(fields)}")
    if key:
        print(f"对齐方式: 按键列 {key}")
    print("-" * 50)
    for k, v in result.items():
        print(f"  {k}: {v}")
    print("=" * 50)


if __name__ == "__main__":
    main()
