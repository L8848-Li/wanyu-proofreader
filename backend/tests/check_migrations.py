#!/usr/bin/env python3
"""Verify every pb_migrations file up, down and up again on a disposable database.

This replaces two per-migration scripts that hard-coded one index name and one
file name each, so a new index migration silently went unverified. Walking the
migrations also exercises 1788941000_pagination_indexes.js, whose down() no
earlier check ever ran, and asserts that the initial schema refuses a rollback
instead of dropping a populated database.
"""
import json
from contextlib import closing
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import harness

# Assertions a migration must satisfy while it is applied.
SPECS = {
    '1794442300_ocr_source_regions.js': {
        'fields': ('pages', {'ocr_source_binding_json': {'max': 4096}}),
    },
    '1794442500_project_purpose.js': {
        'fields': ('projects', {'purpose': {'required': False, 'values_contains': 'practice'}}),
    },
    '1794442600_assist_tone_count_fields.js': {
        'fields': ('projects', {'assist_tone_count_fields_json': {'required': False, 'max': 4096}}),
    },
    '1794442200_csv_page_column.js': {
        'fields': ('import_jobs', {'csv_pdf_page_column': {'max': 524288}}),
        'indexes': ['idx_import_jobs_mapping_dedup'],
        'unique_indexes': [('import_jobs', 'idx_import_jobs_mapping_dedup', ('project', 'file_hash', 'mode', None, 'csv_pdf_page_column'))],
    },
    '1794204800_native_account_rate_limits.js': {'native_account_limits': True},
    '1794204600_import_inspection_budget.js': {
        'fields': ('import_jobs', {'inspection_json': {'max': 524288}}),
    },
    '1794204700_assist_publications.js': {
        'objects': [('table', name) for name in ['assist_publications', '_assist_finding_retirements', '_assist_page_derivations', '_assist_basis_epochs']] + [('trigger', '_assist_epoch_' + table + '_' + action) for table in ['projects', 'pages', 'project_files', 'import_jobs', 'verification_policies', 'project_keyboards', 'finding_dismissals', 'keyboards', 'sources', 'source_usages', 'findings', 'retirement'] for action in ['insert', 'update', 'delete']] + [('trigger', '_assist_epoch_publication')],
        'indexes': ['idx_assist_single_bulk', 'idx_assist_publications_project', 'idx_assist_publications_cleanup', 'idx_review_findings_publication', 'idx_verification_events_publication', '_assist_retirements_publication'],
        'collection_indexes': ('assist_publications', 'idx_assist_single_bulk'),
        'unique_indexes': [('assist_publications', 'idx_assist_single_bulk', ('state',))],
        'locked_rules': 'assist_publications',
        'fields': ('assist_publications', {
            'project': {'required': True, 'max': 15},
            'state': {'required': True, 'values_contains': 'staging'},
            'scope': {'required': True, 'values_contains': 'identity'},
            'basis_json': {'required': True, 'max': 4096},
            'expected_retirements': {'required': False},
        }),
        'plans': [('_assist_finding_retirements', 'SELECT publication FROM _assist_finding_retirements WHERE finding=?', ('f',), 'PRIMARY KEY'),
                  ('_assist_page_derivations', 'SELECT difficulty_tier FROM _assist_page_derivations WHERE publication=? AND page=?', ('p','e'), 'PRIMARY KEY')],
    },
    '1794204900_verification_read_epochs.js': {
        'objects': [('table', '_verification_read_epochs')] + [
            ('trigger', f'_verification_read_epoch_{table}_{action}')
            for table in ('pages', 'projects', 'project_files', 'verification_policies', 'project_keyboards',
                          'finding_dismissals', 'keyboards', 'assist_rule_gates', 'sources', 'source_usages',
                          'proofreading_attempts', 'proofreading_drafts', 'problem_reports', 'problem_issues',
                          'review_findings', 'verification_events', 'assist_publications', '_assist_finding_retirements')
            for action in ('insert', 'update', 'delete')
        ],
    },
    '1794204500_bootstrap_bindings.js': {
        'objects': [('table', 'bootstrap_bindings')],
        'indexes': ['idx_bootstrap_identity'],
        'collection_indexes': ('bootstrap_bindings', 'idx_bootstrap_identity'),
        'unique_indexes': [('bootstrap_bindings', 'idx_bootstrap_identity', ('auth_collection', 'email_sha256'))],
        'locked_rules': 'bootstrap_bindings',
        'fields': ('bootstrap_bindings', {
            'auth_collection': {'required': True, 'values_contains': '_superusers'},
            'email_sha256': {'required': True, 'max': 64},
            'record_id': {'required': True, 'max': 40},
        }),
        'plans': [('bootstrap_bindings', 'SELECT record_id FROM bootstrap_bindings WHERE auth_collection=? AND email_sha256=?', ('users', 'a' * 64), 'idx_bootstrap_identity')],
    },
    '1794204420_queue_projection_index.js': {
        'indexes': ['idx_pages_queue_projection'],
        'collection_indexes': ('pages', 'idx_pages_queue_projection'),
        'plans': [('pages', 'SELECT project,id,page_number,pdf_page,status,difficulty_tier,missing_glyph,proofreader,proofread_round FROM pages WHERE project=?', ('p',), 'COVERING INDEX idx_pages_queue_projection')],
    },
    '1794204410_claim_active_order.js': {
        'replacement_predecessor': '1794204200_claim_queue_indexes.js',
        'index_replacements': [('idx_pages_claim_active',
            ('project','proofreader','page_number','id','status','source_empty'),
            ('project','proofreader','status','page_number','id'))],
        'collection_indexes': ('pages', 'idx_pages_claim_active'),
        'plans': [('pages', "SELECT * FROM pages WHERE project=? AND source_empty IS NOT 1 AND proofreader=? AND (status='claimed' OR status='proofreading') ORDER BY page_number LIMIT 1", ('p','u'), 'idx_pages_claim_active'),
                  ('pages', "SELECT * FROM pages WHERE project=? AND proofreader=? AND (status='claimed' OR status='proofreading') ORDER BY page_number LIMIT 100000", ('p','u'), 'idx_pages_claim_active')],
    },
    '1794204400_claim_tier_filter_cover.js': {
        'replacement_predecessor': '1794204200_claim_queue_indexes.js',
        'index_replacements': [('idx_pages_claim_tier_order',
            ('project','difficulty_tier','page_number','id','status','source_empty'),
            ('project','difficulty_tier','page_number','id'))],
        'collection_indexes': ('pages', 'idx_pages_claim_tier_order'),
        'plans': [('pages', "SELECT * FROM pages WHERE project=? AND source_empty!=true AND (status='pending' OR status='proofread' OR status='claimed' OR status='proofreading') AND difficulty_tier=? ORDER BY page_number,id LIMIT 64", ('p','A'), 'idx_pages_claim_tier_order')],
    },
    '1794204200_claim_queue_indexes.js': {
        'indexes': ['idx_pages_claim_tier_order', 'idx_pages_claim_active'],
        'collection_indexes': ('pages', 'idx_pages_claim_tier_order'),
        'plans': [('pages', 'SELECT id FROM pages WHERE project=? AND difficulty_tier=? ORDER BY page_number,id LIMIT 64', ('p','A'), 'idx_pages_claim_tier_order'),
                  ('pages', 'SELECT id FROM pages WHERE project=? AND proofreader=? AND status=? ORDER BY page_number,id LIMIT 1', ('p','u','proofreading'), 'idx_pages_claim_active')],
    },
    '1794204300_own_review_cursor_index.js': {
        'indexes': ['idx_attempt_own_review_cursor'],
        'collection_indexes': ('proofreading_attempts', 'idx_attempt_own_review_cursor'),
        'plans': [('proofreading_attempts', "SELECT p.id,p.page_number,a.submitted_at FROM proofreading_attempts a JOIN pages p ON p.id=a.page AND p.project=a.project WHERE a.proofreader=? AND a.project=? AND a.kind='proofread' AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) ORDER BY p.page_number,p.id", ('u','p'), 'idx_attempt_own_review_cursor')],
    },
    '1794204100_field_summary_projection.js': {
        'objects': [('table', name) for name in ['_field_audit_contributions', '_field_audit_totals', '_field_audit_projection_meta']] + [('trigger', '_field_audit_' + name) for name in ['contribution_insert', 'contribution_delete', 'attempt_insert', 'attempt_update', 'attempt_delete', 'event_insert', 'event_update', 'event_delete']],
        'plans': [('_field_audit_totals', 'SELECT field_name,submitted_fields FROM _field_audit_totals WHERE project=?', ('p',), 'PRIMARY KEY')],
    },
    '1794204000_field_summary_judgment_index.js': {
        'indexes': ['idx_verification_judgment_latest'],
        'collection_indexes': ('verification_events', 'idx_verification_judgment_latest'),
        'plans': [('verification_events', "SELECT id FROM verification_events WHERE project=? AND kind='judgment' AND ref!='final' AND json_valid(payload_json) AND ref=? AND field_name=? ORDER BY created DESC, CAST(COALESCE(json_extract(payload_json, '$.revision'), 0) AS INTEGER) DESC, id DESC LIMIT 1", ('p','a','field'), 'idx_verification_judgment_latest')],
    },
    '1794203000_delivery_adoption.js': {
        'indexes': ['idx_delivery_job_version', 'idx_delivery_request'],
        'collection_indexes': ('release_deliveries', 'idx_delivery_job_version'),
        'fields': ('release_deliveries', {'request_id': {'required': False}, 'request_fingerprint': {'required': False}, 'reconciliation_json': {'required': False}}),
        'plans': [('release_deliveries', 'SELECT id FROM release_deliveries WHERE project=? AND recipient=? AND purpose=? AND import_job=? ORDER BY version DESC LIMIT 1', ('p','r','public_display','j'), 'idx_delivery_job_version')],
    },
    '1794201000_account_security.js': {
        'indexes': ['idx_security_created', 'idx_security_subject', 'idx_security_actor', 'idx_security_project'],
        'collection_indexes': ('security_events', 'idx_security_subject'),
        'fields': ('security_events', {'event_type': {'max': 80}, 'outcome': {'required': True, 'values_contains': 'failed'}, 'source': {'required': True}}),
        'plans': [('security_events', "SELECT id FROM security_events WHERE subject_user_id=? ORDER BY created DESC,id DESC LIMIT 25", ('u',), 'idx_security_subject')],
    },
    '1794201100_account_mail_pages.js': {'mail_links': True},
    '1794201200_security_retention_index.js': {
        'indexes': ['idx_security_outcome_created'],
        'collection_indexes': ('security_events', 'idx_security_outcome_created'),
        'plans': [('security_events', "SELECT id FROM security_events WHERE outcome=? AND created<? ORDER BY created,id LIMIT 500", ('failed', '2026-01-01'), 'idx_security_outcome_created')],
    },
    '1793926800_ocr_runtime.js': {
        'indexes': ['idx_import_jobs_ocr_request'],
        'collection_indexes': ('import_jobs', 'idx_import_jobs_ocr_request'),
        'plans': [('import_jobs', "SELECT id FROM import_jobs WHERE project=? AND created_by=? AND ocr_request_id=? AND ocr_request_id != ''", ('p','u','request'), 'idx_import_jobs_ocr_request')],
        'fields': ('pages', {'ocr_cells_json': {'required': False, 'max': 1048576}}),
    },
    '1793923200_member_lookup_limits.js': {
        'indexes': ['idx_member_lookup_actor'],
        'fields': ('member_lookup_limits', {'actor': {'required': True}, 'attempts': {'required': False}}),
        'plans': [('member_lookup_limits', 'SELECT id FROM member_lookup_limits WHERE actor=?', ('u',), 'idx_member_lookup_actor')],
    },
    '1792281600_release_deliveries.js': {
        'indexes': ['idx_delivery_package', 'idx_delivery_version', 'idx_delivery_source', 'idx_delivery_project', 'idx_release_events_delivery', 'idx_release_event_sequence'],
        'collection_indexes': ('release_deliveries', 'idx_delivery_version'),
        'fields': ('release_deliveries', {'archive': {'required': True}}),
        'plans': [('release_deliveries', 'SELECT id FROM release_deliveries WHERE project=? AND recipient=? AND purpose=? ORDER BY version DESC LIMIT 1',
                   ('p', 'r', 'public_display'), 'idx_delivery_version')],
    },
    '1792627200_source_fidelity.js': {
        'indexes': ['idx_verification_events_page', 'idx_verification_events_project',
                    'idx_problem_reports_mine', 'idx_problem_reports_issue',
                    'idx_problem_reports_page', 'idx_proofreading_drafts_user_page',
                    'idx_research_sessions_task', 'idx_research_sessions_project_user'],
        'collection_indexes': ('verification_events', 'idx_verification_events_page'),
        'plans': [
            ('verification_events', 'SELECT id FROM verification_events WHERE page=? ORDER BY created,id',
             ('p',), 'idx_verification_events_page'),
            ('proofreading_drafts', 'SELECT id FROM proofreading_drafts WHERE user=? AND page=?',
             ('u', 'p'), 'idx_proofreading_drafts_user_page'),
            ('problem_reports', 'SELECT id FROM problem_reports WHERE page=? AND blocking=1',
             ('p',), 'idx_problem_reports_page'),
        ],
        'fields': ('pages', {
            'verification_basis': {'required': False},
            'verification_context_json': {'required': False, 'max': 16 * 1024 * 1024},
            'verification_hold': {'required': False},
            'verification_needs_recheck': {'required': False},
            'verification_source_revision': {'required': False},
            'source_empty': {'required': False},
        }),
    },
    '1792713600_import_job_skipped_count.js': {
        'fields': ('import_jobs', {
            'skipped_count': {'required': False},
        }),
    },
    '1792800000_page_missing_glyph.js': {
        'fields': ('pages', {
            'missing_glyph': {'required': False},
        }),
    },
    '1792800100_page_rework_status.js': {
        'fields': ('pages', {
            'status': {'values_contains': 'rework'},
        }),
    },
    '1792800200_attempt_superseded_outcome.js': {
        'fields': ('proofreading_attempts', {
            'outcome': {'values_contains': 'superseded'},
        }),
    },
    '1791580800_unique_nickname_login.js': {
        'indexes': ['idx_users_nickname'],
        'collection_indexes': ('users', 'idx_users_nickname'),
        'fields': ('users', {'name': {'required': True}}),
        'plans': [('users', 'SELECT id FROM users WHERE name=? COLLATE NOCASE',
                   ('nickname',), 'idx_users_nickname')],
    },
    '1792166400_research_notice.js': {
        'indexes': ['idx_research_notice_latest'],
        'collection_indexes': ('research_notice_decisions', 'idx_research_notice_latest'),
        'plans': [('research_notice_decisions',
                   'SELECT id FROM research_notice_decisions WHERE user=? AND notice_version=? ORDER BY decided_at DESC',
                   ('u', '2026-10-17'), 'idx_research_notice_latest')],
    },
    '1788941000_pagination_indexes.js': {
        'indexes': ['idx_pages_project_status_order',
                    'idx_attempts_page_round_kind_user',
                    'idx_membership_user_role_project'],
        'plans': [('pages', "SELECT id FROM pages WHERE project=? AND status=? AND page_number>? ORDER BY page_number,id LIMIT 25",
                   ('p', 'pending', 1), 'idx_pages_project_status_order')],
    },
    '1788942000_join_attempt_retention.js': {
        'indexes': ['idx_project_join_attempt_window', 'idx_project_join_source_attempt_window'],
        'plans': [('project_join_attempts',
                   "SELECT id FROM project_join_attempts WHERE window_started != '' AND window_started <= ? AND blocked_until <= ? ORDER BY window_started,id LIMIT 250",
                   ('2026-01-01', '2026-01-01'), 'idx_project_join_attempt_window'),
                  ('project_join_source_attempts',
                   "SELECT id FROM project_join_source_attempts WHERE window_started != '' AND window_started <= ? AND blocked_until <= ? ORDER BY window_started,id LIMIT 250",
                   ('2026-01-01', '2026-01-01'), 'idx_project_join_source_attempt_window')],
    },
    '1789027200_pdf_task_affinity.js': {
        'indexes': ['idx_pages_pdf_affinity'],
        'plans': [('pages',
                   'SELECT id FROM pages WHERE project=? AND project_file=? AND pdf_page=? AND status=? ORDER BY page_number,id',
                   ('p', 'f', 2, 'pending'), 'idx_pages_pdf_affinity')],
        # PocketBase keeps declared index SQL in the collection record; a migration
        # that only touches sqlite_master disappears on the next schema sync.
        'collection_indexes': ('pages', 'idx_pages_pdf_affinity'),
    },
    '1789113600_review_findings.js': {
        'indexes': ['idx_findings_page_current', 'idx_findings_project_kind',
                    'idx_findings_rule_identity', 'idx_gate_rule_identity'],
        'plans': [
            # The read path #176 actually uses: current (not superseded) findings of one page.
            ('review_findings',
             "SELECT id FROM review_findings WHERE page=? AND superseded_at='' ORDER BY produced_at DESC",
             ('p',), 'idx_findings_page_current'),
            # Manager-side statistics grouping.
            ('review_findings',
             'SELECT id FROM review_findings WHERE project=? AND kind=?',
             ('p', 'merged_columns'), 'idx_findings_project_kind'),
            # Gate lookup by rule identity — one row per (producer, version, kind, message_key).
            ('assist_rule_gates',
             'SELECT id FROM assist_rule_gates WHERE producer=? AND producer_version=? AND kind=? AND message_key=?',
             ('rule', 'v1', 'merged_columns', 'bracket_unbalanced'), 'idx_gate_rule_identity'),
        ],
        'collection_indexes': ('review_findings', 'idx_findings_page_current'),
    },
    '1789113700_page_difficulty.js': {
        'indexes': ['idx_pages_project_tier'],
        # #162 的筛选谓词就是「某项目里 tier = ?」，不带排序；带排序时优化器会选
        # 已有的 (project, page_number) 唯一索引，那是正确选择，不是本索引的失败。
        'plans': [('pages',
                   'SELECT id FROM pages WHERE project=? AND difficulty_tier=?',
                   ('p', 'A'), ('idx_pages_project_tier', 'idx_pages_claim_tier_order'))],
        'collection_indexes': ('pages', 'idx_pages_project_tier'),
    },
    '1789113800_entry_identity.js': {
        'indexes': ['idx_pages_project_identity', 'idx_dismissal_group'],
        'plans': [
            ('pages', 'SELECT id FROM pages WHERE project=? AND entry_identity_key=?',
             ('p', 'k'), 'idx_pages_project_identity'),
            ('finding_dismissals', 'SELECT id FROM finding_dismissals WHERE project=? AND group_key=? AND kind=?',
             ('p', 'k', 'duplicate_identity'), 'idx_dismissal_group'),
        ],
        'collection_indexes': ('pages', 'idx_pages_project_identity'),
    },
    # OCR 的三条迁移只改字段元数据（mode 加值、source_file/file_hash/file_size 放开必填），
    # 不建索引。用 fields 断言验证 _collections 里的字段元数据，而非空填 indexes。
    '1789060000_ocr_import_mode.js': {
        'fields': ('import_jobs', {
            'mode': {'values_contains': 'ocr'},
        }),
    },
    '1789061000_ocr_source_file_optional.js': {
        'fields': ('import_jobs', {
            'source_file': {'required': False},
        }),
    },
    '1789062000_ocr_file_meta_optional.js': {
        'fields': ('import_jobs', {
            'file_hash': {'required': False},
            'file_size': {'required': False},
        }),
    },
    '1789200000_source_registry.js': {
        'indexes': ['idx_sources_logical_id', 'idx_source_usages_purpose'],
        'plans': [
            ('sources', 'SELECT id FROM sources WHERE logical_id=?',
             ('src-demo',), 'idx_sources_logical_id'),
            ('source_usages', 'SELECT id FROM source_usages WHERE source=? AND purpose=?',
             ('s', 'public_display'), 'idx_source_usages_purpose'),
        ],
        'collection_indexes': ('sources', 'idx_sources_logical_id'),
    },
    # Column roles are metadata on the project row. There is no new index;
    # the entry exists so a missing migration file still fails the coverage check.
    '1789200100_column_roles.js': {},
    # #228 gate 放行的审计列。断言 required=False：这些列全是可选项，
    # 一旦有人把 approved_by 改成必填，老登记行会立刻写不进去。
    '1789200200_gate_release_audit.js': {
        'fields': ('assist_rule_gates', {
            'approved_by': {'required': False},
            'approved_at': {'required': False},
            'changeset': {'required': False},
            'applied_by': {'required': False},
            'revoked_at': {'required': False},
            'revoked_by': {'required': False},
        }),
    },
    # #240 阻塞结论的审计列。断言 required=False：一旦有人把它们改成必填，
    # 存量条目会立刻写不进 blocked_reason（清除路径要写空串）。
    '1789200400_blocked_reason_audit.js': {
        'fields': ('pages', {
            'blocked_reason_by': {'required': False},
            'blocked_reason_at': {'required': False},
            'blocked_reason_note': {'required': False},
        }),
    },
    # #190 的两把查询：复核队列按 (project, normalization_status) 筛，
    # 作业侧按 project 找当前活跃的那个。fields 断言钉住 required=False——
    # 这些列在转换跑过之前都是空的，设成必填会让所有既有创建路径在校验期失败。
    #
    # 队列那条计划断言按**生产查询的形状**写：listNormalizations 是
    # FindRecordsByFilter("pages", filter, "page_number,id", size, offset, params)，
    # 带 ORDER BY 与 LIMIT/OFFSET。原来是「WHERE project=? AND normalization_status=?」
    # 这种不带排序的形状，而那种形状下 SQLite 根本不用这条索引——它选
    # idx_pages_project_page_number，再为 ORDER BY 现搭临时 B 树。断言写成不带排序的
    # 形状，等于给一条没人用的索引背书：两列版本在 CI 上是绿的，在生产上没生效。
    '1789200700_scheme_conversion.js': {
        'indexes': ['idx_pages_normalization_queue',
                    'idx_conversion_jobs_active', 'idx_conversion_jobs_project'],
        'plans': [
            ('pages',
             'SELECT id FROM pages WHERE project=? AND normalization_status=? '
             'ORDER BY page_number, id LIMIT 25 OFFSET 0',
             ('p', 'AMBIGUOUS'), 'idx_pages_normalization_queue'),
            ('conversion_jobs',
             "SELECT id FROM conversion_jobs WHERE project=? AND status IN ('queued','processing')",
             ('p',), 'idx_conversion_jobs_active'),
        ],
        'collection_indexes': ('pages', 'idx_pages_normalization_queue'),
        'fields': ('pages', {
            'normalization_status': {'required': False, 'values_contains': 'REVIEWED'},
            # max 与 backend/scheme_conversion.go 的 canonicalPronunciationMaxLength 必须相等：
            # 不等就会出现「界面拦得住、直接调接口存不进」这种只碰得到一半的差别。
            'canonical_pronunciation': {'required': False, 'max': 200},
            'normalization_basis': {'required': False},
            'normalization_source_column': {'required': False},
            # 转换时抄下的源值副本。刻意没有 max——它是源单元格的副本，源列本身无上限。
            'normalization_source_snapshot': {'required': False},
        }),
    },
    '1789200300_project_artifacts.js': {
        'indexes': ['idx_project_artifacts_project'],
        'plans': [
            ('project_artifacts',
             'SELECT id FROM project_artifacts WHERE project=? ORDER BY created DESC',
             ('p',), 'idx_project_artifacts_project'),
        ],
        'collection_indexes': ('project_artifacts', 'idx_project_artifacts_project'),
    },
    # #172 的筛选谓词就是「某项目里 quality_state = ?」（管理端筛待定/已确认/暂缓外发），
    # 不带排序——与 #162 的 tier 同形。fields 断言另外钉住 required=False：
    # 这条列一旦被改成必填，既有的导入与校对创建路径会在校验期集体失败。
    '1789200400_page_quality_state.js': {
        'indexes': ['idx_pages_project_quality'],
        'plans': [('pages',
                   'SELECT id FROM pages WHERE project=? AND quality_state=?',
                   ('p', 'candidate'), 'idx_pages_project_quality')],
        'collection_indexes': ('pages', 'idx_pages_project_quality'),
        'fields': ('pages', {
            'quality_state': {'required': False, 'values_contains': 'withheld'},
            'quality_state_basis': {'required': False},
        }),
    },
    # #183 的两把键：条目级自然键（部分唯一索引，空键的存量行不受约束）与
    # 作业级的 bundle 身份。查询计划断言用的就是导入路径真实发出的两个谓词。
    '1789200500_bundle_entry_keys.js': {
        'indexes': ['idx_pages_source_entry', 'idx_import_jobs_bundle'],
        'plans': [
            # 查询里必须**显式**写出 source_entry_id != ''，SQLite 才会考虑这个部分索引；
            # 不写就退化成按 project 扫，而 scan 依然"正确"，只是这条断言会先失败。
            ('pages',
             "SELECT id FROM pages WHERE project=? AND source_entry_id != '' AND source_system=? AND source_id=? AND source_version=? AND source_entry_id='e'",
             ('p', 's', 'a', 'v'), 'idx_pages_source_entry'),
            # 与 findJobByBundle 的谓词逐字一致（含 status != 'failed'）：部分索引只有
            # 在查询里写出这个谓词时才会被选中。
            ('import_jobs',
             "SELECT id FROM import_jobs WHERE project=? AND bundle_id != '' AND bundle_id=? AND status != 'failed'",
             ('p', 'b'), 'idx_import_jobs_bundle'),
        ],
        'collection_indexes': ('pages', 'idx_pages_source_entry'),
        'fields': ('import_jobs', {
            'bundle_id': {'required': False},
            'bundle_schema_version': {'required': False},
            'mode': {'values_contains': 'bundle'},
        }),
    },
    # #315 D 用途编选 v0。两条列表查询就是路由真正发出的形状：
    # listAdoptionBatches 是 project 过滤 + created 倒序，listAdoptionExceptions 是
    # batch 过滤 + created 升序；例外那条还必须能命中最左列，否则「这一批的例外」
    # 会退化成按 batch 扫全表。fields 断言钉住两处会静默改语义的契约：
    # status 必须允许 confirmed（否则确认动作存不进库），recipient 的 120 与
    # backend/adoption.go 的 adoptionRecipientMax 必须相等。
    '1792886400_adoption_batches.js': {
        'indexes': ['idx_adoption_batches_project', 'idx_adoption_batches_open',
                    'idx_adoption_exceptions_page', 'idx_adoption_exceptions_batch'],
        'plans': [
            ('adoption_batches',
             'SELECT id FROM adoption_batches WHERE project=? ORDER BY created DESC',
             ('p',), 'idx_adoption_batches_project'),
            ('adoption_exceptions',
             'SELECT id FROM adoption_exceptions WHERE batch=? ORDER BY created',
             ('b',), 'idx_adoption_exceptions_batch'),
        ],
        'collection_indexes': ('adoption_batches', 'idx_adoption_batches_open'),
        'fields': ('adoption_batches', {
            'status': {'required': True, 'values_contains': 'confirmed'},
            'recipient': {'required': True, 'max': 120},
        }),
    },
    # #315 D5.3/D9 的追加事件表。查询就是 listAdoptionEvents 的形状：batch 过滤 +
    # created 倒序。kind 的取值必须包含 rights_changed——少了它，权利变更就记不下来，
    # 而这件事在界面上只是「没有事件」，看起来和「没变过」一样。
    '1792972800_adoption_events.js': {
        'indexes': ['idx_adoption_events_batch', 'idx_adoption_events_kind'],
        'plans': [
            ('adoption_events',
             'SELECT id FROM adoption_events WHERE batch=? ORDER BY created DESC',
             ('b',), 'idx_adoption_events_batch'),
        ],
        'collection_indexes': ('adoption_events', 'idx_adoption_events_batch'),
        'fields': ('adoption_events', {
            'kind': {'required': True, 'values_contains': 'rights_changed'},
            'affected_count': {'required': False},
            'stored_selected': {'required': False},
            'current_selected': {'required': False},
        }),
    },
    # 确认范围的成员指纹：四个计数相同但成员互换时，确认/导出必须能发现漂移。
    '1793059200_adoption_scope_digest.js': {
        'fields': ('adoption_batches', {
            'scope_digest': {'required': False},
        }),
    },
    # #433 的报告产物是按项目与入站作业保留的快照；并发生成约束和历史查询
    # 都必须留在迁移里，JSON/CSV artifact kind 则由同一迁移追加并在回滚时移除。
    '1794441600_batch_report_exports.js': {
        'objects': [('table', 'batch_report_exports')],
        'indexes': ['idx_batch_report_history', 'idx_batch_report_active'],
        'collection_indexes': ('batch_report_exports', 'idx_batch_report_active'),
        'unique_indexes': [
            ('batch_report_exports', 'idx_batch_report_active', ('project', 'import_job', 'created_by')),
        ],
        'plans': [
            ('batch_report_exports',
             'SELECT id FROM batch_report_exports WHERE project=? AND import_job=? ORDER BY created DESC,id DESC',
             ('p', 'j'), 'idx_batch_report_history'),
        ],
        'fields': [
            ('batch_report_exports', {
                'import_job': {'required': True, 'max': 15},
                'status': {'required': True, 'values_contains': 'completed'},
                'error_code': {'required': False, 'max': 2000},
                'error_message': {'required': False, 'max': 2000},
                'json_artifact': {'required': False},
                'json_sha256': {'required': False, 'max': 64},
                'csv_artifact': {'required': False},
                'csv_sha256': {'required': False, 'max': 64},
                'generated_at': {'required': False},
            }),
            ('project_artifacts', {
                'kind': {'values_contains': ['batch_report_json', 'batch_report_csv']},
            }),
        ],
    },
}
FIRST = '1788940000_initial_schema.js'


def spec_coverage(migrations_dir=None, specs=None):
    """Reconcile SPECS against the migrations on disk, without booting anything.

    Deriving the migration list from a disk glob alone made this file weaker than
    the two hardcoded scripts it replaced: move a migration out and the run still
    reported PASS, because SPECS is only ever read by `SPECS.get(name)`. Both
    directions must fail — a migration without assertions, and an assertion for a
    migration that no longer exists.
    """
    root = Path(migrations_dir) if migrations_dir else harness.MIGRATIONS
    specs = SPECS if specs is None else specs
    on_disk = sorted(path.name for path in root.glob('*.js'))
    problems = []
    if FIRST not in on_disk:
        problems.append(f'{FIRST} is absent from {root}, so the verifier would pass vacuously')
    for name in on_disk:
        if name != FIRST and name not in specs:
            problems.append(f'{name} is walked but has no assertions in SPECS')
    for name in sorted(specs):
        if name not in on_disk:
            problems.append(f'SPECS covers {name} but that migration no longer exists')
    return on_disk, problems


def migrate(binary, data, *command, expect_success=True):
    env = {**os.environ, 'FANGJI_SKIP_ADMIN_BOOTSTRAP': '1'}
    result = subprocess.run([str(binary), 'migrate', *[str(part) for part in command],
                            f'--dir={data}', f'--migrationsDir={harness.MIGRATIONS}'],
                            env=env, input='y\n', text=True, encoding='utf-8', capture_output=True)
    joined = result.stdout + result.stderr
    if expect_success and result.returncode != 0:
        raise AssertionError(f'migrate {command} failed: {joined[-4000:]}')
    if not expect_success and result.returncode == 0:
        raise AssertionError(f'migrate {command} unexpectedly succeeded: {joined[-4000:]}')
    return joined


def applied(data):
    """Only this repository's JS migrations; PocketBase also records its own Go ones."""
    with closing(sqlite3.connect(data / 'data.db')) as db:
        return [row[0] for row in db.execute(
            "SELECT file FROM _migrations WHERE file LIKE '%.js' ORDER BY file")]


def index_names(data):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        return {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='index'")}


def assert_index_replacements(data, migration, problems, up):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        predecessor = SPECS.get(migration, {}).get('replacement_predecessor')
        if not up and predecessor and not db.execute('SELECT 1 FROM _migrations WHERE file=?', (predecessor,)).fetchone():
            return
        for name, new_columns, old_columns in SPECS.get(migration, {}).get('index_replacements', []):
            actual = tuple(row[2] for row in db.execute(f'PRAGMA index_info("{name}")'))
            expected = new_columns if up else old_columns
            if actual != expected:
                problems.append(f'{migration}: index {name} columns {actual} != {expected}')


def assert_applied(data, migration, problems):
    assert_index_replacements(data, migration, problems, up=True)
    spec = SPECS.get(migration, {})
    present = index_names(data)
    with closing(sqlite3.connect(data / 'data.db')) as db:
        objects = {(row[0], row[1]) for row in db.execute('SELECT type,name FROM sqlite_master')}
    for kind, name in spec.get('objects', []):
        if (kind, name) not in objects:
            problems.append(f'{migration}: {kind} {name} missing after up')
    if migration == '1792281600_release_deliveries.js' and 'idx_delivery_job_version' in present:
        spec = {**spec, 'indexes': [n for n in spec['indexes'] if n != 'idx_delivery_version'], 'collection_indexes': ('release_deliveries', 'idx_delivery_job_version'), 'plans': []}
    for name in spec.get('indexes', []):
        if name not in present:
            problems.append(f'{migration}: index {name} missing after up')
    collection = spec.get('collection_indexes')
    if collection:
        table, name = collection
        with closing(sqlite3.connect(data / 'data.db')) as db:
            declared = json.loads(db.execute('SELECT indexes FROM _collections WHERE name=?', (table,)).fetchone()[0])
        if not any(name in sql for sql in declared):
            problems.append(f'{migration}: {table} collection metadata lost index {name}')
    for table, query, parameters, name in spec.get('plans', []):
        with closing(sqlite3.connect(data / 'data.db')) as db:
            plan = str(db.execute(f'EXPLAIN QUERY PLAN {query}', parameters).fetchall())
        alternatives = (name,) if isinstance(name, str) else name
        if not any(index in plan for index in alternatives):
            problems.append(f'{migration}: {table} query plan does not use {name}: {plan}')
    if spec.get('mail_links'):
        _assert_mail_links(data, migration, problems, expect=True)
    if spec.get('native_account_limits'):
        _assert_native_account_limits(data, migration, problems, expect=True)
    field_spec = spec.get('fields')
    if field_spec:
        _assert_fields(data, migration, field_spec, problems, expect=True)
    if spec.get('locked_rules'):
        _assert_locked_rules(data, migration, spec['locked_rules'], problems)
    _assert_unique_indexes(data, migration, spec.get('unique_indexes', []), problems)


def _assert_locked_rules(data, migration, collection, problems):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        row = db.execute('SELECT listRule,viewRule,createRule,updateRule,deleteRule FROM _collections WHERE name=?', (collection,)).fetchone()
    if row is None or any(value is not None for value in row):
        problems.append(f'{migration}: {collection} native API rules must all be null')


def _assert_unique_indexes(data, migration, indexes, problems):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        for table, name, columns in indexes:
            metadata = next((row for row in db.execute(f'PRAGMA index_list("{table}")') if row[1] == name), None)
            actual = tuple(row[2] for row in db.execute(f'PRAGMA index_info("{name}")'))
            if metadata is None or metadata[2] != 1 or actual != columns:
                problems.append(f'{migration}: {name} must be unique on {columns}')


def assert_absent(data, migration, problems, context):
    assert_index_replacements(data, migration, problems, up=False)
    if SPECS.get(migration, {}).get('mail_links'):
        _assert_mail_links(data, migration, problems, expect=False)
    if SPECS.get(migration, {}).get('native_account_limits'):
        _assert_native_account_limits(data, migration, problems, expect=False)
    present = index_names(data)
    with closing(sqlite3.connect(data / 'data.db')) as db:
        objects = {(row[0], row[1]) for row in db.execute('SELECT type,name FROM sqlite_master')}
    for kind, name in SPECS.get(migration, {}).get('objects', []):
        if (kind, name) in objects:
            problems.append(f'{migration}: {kind} {name} survived {context}')
    for name in SPECS.get(migration, {}).get('indexes', []):
        if name in present:
            problems.append(f'{migration}: index {name} survived {context}')
    field_spec = SPECS.get(migration, {}).get('fields')
    if field_spec:
        _assert_fields(data, migration, field_spec, problems, expect=False)


def _assert_mail_links(data, migration, problems, expect):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        row = db.execute("SELECT options FROM _collections WHERE name='users'").fetchone()
    if not row:
        if expect:
            problems.append(f'{migration}: users collection missing')
        return
    options = json.loads(row[0])
    for key, path in [('verificationTemplate', '/account/verify-email#token={TOKEN}'),
                      ('resetPasswordTemplate', '/account/reset-password#token={TOKEN}'),
                      ('confirmEmailChangeTemplate', '/account/confirm-email#token={TOKEN}')]:
        contains = path in options.get(key, {}).get('body', '')
        if contains != expect:
            problems.append(f'{migration}: {key} link mismatch after {"up" if expect else "down"}')


def _account_limit_settings(data):
    with closing(sqlite3.connect(data / 'data.db')) as db:
        value = db.execute("SELECT value FROM _params WHERE id='settings'").fetchone()[0]
    settings = json.loads(value)
    return settings['rateLimits'], settings['trustedProxy']


def _assert_native_account_limits(data, migration, problems, expect):
    limits, proxy = _account_limit_settings(data)
    rules = [(rule['label'], rule['maxRequests'], rule['duration'], rule['audience']) for rule in limits['rules']]
    expected_rules = [
        ('*:authWithPassword', 240, 60, ''), ('*:authRefresh', 120, 60, ''),
        ('*:authWithOAuth2', 120, 60, ''), ('*:authWithOTP', 120, 60, ''), ('*:requestOTP', 120, 60, ''),
    ] if expect else [
        ('*:auth', 2, 3, ''), ('*:create', 20, 5, ''), ('/api/batch', 3, 1, ''), ('/api/', 300, 10, ''),
    ]
    if limits['enabled'] != expect or limits['excludedIPs'] or rules != expected_rules:
        problems.append(f'{migration}: native rules differ after migration (enabled expected: {expect})')
    if proxy['useLeftmostIP'] or (proxy['headers'] or []) != (['X-Fangji-Client-IP'] if expect else []):
        problems.append(f'{migration}: trusted proxy selection differs after migration (enabled expected: {expect})')


def _assert_operator_account_limits_preserved(binary, data, problems):
    def down_to_account_limits(expect_success=True):
        target = '1794204800_native_account_rate_limits.js'
        count = sum(name >= target for name in applied(data))
        return migrate(binary, data, 'down', count, expect_success=expect_success)

    # Keep a modified managed policy intact until its proxy header is reviewed.
    with closing(sqlite3.connect(data / 'data.db')) as db, db:
        db.execute("UPDATE _params SET value=json_set(value, '$.rateLimits.rules[0].maxRequests', 300) WHERE id='settings'")
    modified = _account_limit_settings(data)
    output = down_to_account_limits(expect_success=False)
    if 'X-Fangji-Client-IP' not in output or _account_limit_settings(data) != modified:
        problems.append('native account rate limit rollback did not preserve modified proxy policy')
    with closing(sqlite3.connect(data / 'data.db')) as db, db:
        db.execute("UPDATE _params SET value=json_set(value, '$.rateLimits.rules[0].maxRequests', 240) WHERE id='settings'")
    # Deliberate operator changes must survive reapplying this migration.
    down_to_account_limits()
    with closing(sqlite3.connect(data / 'data.db')) as db, db:
        db.execute("UPDATE _params SET value=json_set(value, '$.rateLimits.rules[0].maxRequests', 60) WHERE id='settings'")
    before = _account_limit_settings(data)
    migrate(binary, data, 'up')
    if _account_limit_settings(data) != before:
        problems.append('native account rate limit migration overwrote operator settings on up')
    down_to_account_limits()
    if _account_limit_settings(data) != before:
        problems.append('native account rate limit migration overwrote operator settings on down')


def _assert_fields(data, migration, field_spec, problems, expect):
    """验证 _collections 里字段元数据（required / values / max），供只改字段的迁移使用。

    field_spec 形如 (collection, {field_name: {'required': bool, 'values_contains': str, 'max': int}})。
    expect=True 表示应用迁移后应满足这些条件；expect=False 表示回滚后应不满足。

    回滚方向上「集合或字段根本不存在」是**通过**而不是失败：往 collections 上追加字段的迁移，
    它的 down 通常只删字段，而那个集合本身是由更早的迁移创建、会在回滚序列里被整个删掉
    （assist_rule_gates 就同时被 1789113600 的 down 删除）。把它判成缺失报错，等于要求
    「加字段」类迁移永远不能声明 fields 断言——而那正是这类迁移唯一能写的断言。
    """
    field_specs = [field_spec] if isinstance(field_spec[0], str) else field_spec
    for collection, fields in field_specs:
        with closing(sqlite3.connect(data / 'data.db')) as db:
            row = db.execute('SELECT fields FROM _collections WHERE name=?', (collection,)).fetchone()
        if row is None:
            if expect:
                problems.append(f'{migration}: collection {collection} missing')
            continue
        declared = json.loads(row[0])
        for field_name, conditions in fields.items():
            target = next((f for f in declared if f.get('name') == field_name), None)
            if target is None:
                if not expect:
                    continue
                problems.append(f'{migration}: field {collection}.{field_name} missing')
                continue
            if 'required' in conditions:
                actual = target.get('required')
                want = conditions['required']
                ok = (actual == want) if expect else (actual != want)
                if not ok:
                    state = 'applied' if expect else 'rolled back'
                    problems.append(
                        f'{migration}: {collection}.{field_name}.required should be {want} when {state}, got {actual}')
            if 'max' in conditions:
                # 长度上限也是契约的一部分：#190 的 canonical_pronunciation 上限在迁移与
                # handler 里各写了一份，对不上就是「界面拦得住、直接调接口存不进」。
                # 没写 max 的文本字段在 PocketBase 里存的不是 0 而是缺省，所以这里用 get。
                actual = target.get('max')
                want = conditions['max']
                ok = (actual == want) if expect else (actual != want)
                if not ok:
                    state = 'applied' if expect else 'rolled back'
                    problems.append(
                        f'{migration}: {collection}.{field_name}.max should be {want} when {state}, got {actual}')
            if 'values_contains' in conditions:
                actual_values = target.get('values', [])
                want = conditions['values_contains']
                wanted_values = want if isinstance(want, list) else [want]
                contains = all(value in actual_values for value in wanted_values)
                ok = contains if expect else all(value not in actual_values for value in wanted_values)
                if not ok:
                    problems.append(
                        f'{migration}: {collection}.{field_name}.values should {"contain" if expect else "exclude"} {wanted_values!r} when {"applied" if expect else "rolled back"}')


def assert_state(data, expected, through, problems, context):
    """`through` is the newest migration that must still be applied; newer ones gone."""
    for migration in expected:
        if migration <= through:
            assert_applied(data, migration, problems)
        else:
            assert_absent(data, migration, problems, context)


def main():
    expected, problems = spec_coverage()
    if problems:
        for problem in problems:
            print(f'migration coverage drift: {problem}', file=sys.stderr)
        return 1
    with harness.temporary_root() as root:
        binary = harness.build_binary(root / 'pocketbase')
        data = root / 'data'
        rollbackable = [name for name in expected if name != FIRST]

        migrate(binary, data, 'up')
        if applied(data) != expected:
            problems.append(f'applied set {applied(data)} != files {expected}')
        assert_state(data, expected, expected[-1], problems, 'initial up')

        # Round trip each migration: PocketBase reverts the newest applied files
        # first, so stepping down to a target also lifts everything after it.
        for target in reversed(rollbackable):
            newer = [name for name in applied(data) if name >= target]
            previous = expected[expected.index(target) - 1]
            migrate(binary, data, 'down', len(newer))
            assert_state(data, expected, previous, problems, f'down of {target}')
            migrate(binary, data, 'up')
            assert_state(data, expected, expected[-1], problems, f'reapply of {target}')

        # The oldest migration must refuse to revert rather than drop the schema.
        for target in reversed(rollbackable):
            migrate(binary, data, 'down', len([name for name in applied(data) if name >= target]))
        if applied(data) != [FIRST]:
            problems.append(f'walking down left {applied(data)} != [{FIRST}]')
        output = migrate(binary, data, 'down', 1, expect_success=False)
        if 'backup' not in output.lower():
            problems.append(f'initial schema down() did not refuse with a backup message: {output[-1500:]}')
        assert_state(data, expected, FIRST, problems, 'refused down')
        migrate(binary, data, 'up')
        if applied(data) != expected:
            problems.append(f'reapply left {applied(data)} != {expected}')
        assert_state(data, expected, expected[-1], problems, 'final up')
        _assert_operator_account_limits_preserved(binary, data, problems)

    if problems:
        print('migration verification failed:', file=sys.stderr)
        for problem in sorted(set(problems)):
            print(f'  - {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {len(expected)} migrations verified up, down, up and initial-schema refusal')
    return 0


if __name__ == '__main__':
    sys.exit(main())
