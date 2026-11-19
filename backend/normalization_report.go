package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"fangji/backend/scheme"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// A report uses stored conversion evidence only. Old rows without a snapshot
// have an empty source_snapshot; substituting a later edit would change the evidence.
const normalizationReportSQL = `
SELECT p.id, p.page_number, p.pdf_page, p.normalization_source_column,
       p.normalization_source_snapshot, p.normalization_status, p.source_scheme_id,
       p.canonical_scheme_id, p.normalization_rule_version, p.normalization_basis,
       p.normalization_trace_json, p.normalization_candidates_json, COALESCE(s.logical_id, ''),
       (COALESCE(s.status,'')='confirmed' AND COALESCE(u.decision,'')='allow' AND
        p.status!='importing' AND p.quality_state!='withheld')
FROM pages p
JOIN projects pr ON pr.id=p.project
LEFT JOIN import_jobs j ON j.id=p.import_job AND j.project=p.project
LEFT JOIN sources s ON s.id=CASE WHEN p.import_job='' THEN pr.source ELSE j.source END
LEFT JOIN source_usages u ON u.source=s.id AND u.purpose='internal_research'
WHERE p.project={:project} AND p.normalization_status IN ('AMBIGUOUS','UNSUPPORTED')
  AND ({:both} OR p.normalization_status={:status})
ORDER BY p.page_number,p.id`

type normalizationReportEntry struct {
	ID           string   `json:"id"`
	Number       int      `json:"page_number"`
	PDFPage      int      `json:"pdf_page"`
	Column       string   `json:"normalization_source_column"`
	Snapshot     string   `json:"normalization_source_snapshot"`
	Status       string   `json:"normalization_status"`
	SourceScheme string   `json:"source_scheme_id"`
	TargetScheme string   `json:"canonical_scheme_id"`
	Version      string   `json:"normalization_rule_version"`
	Basis        string   `json:"normalization_basis"`
	Trace        []string `json:"normalization_trace"`
	Candidates   []string `json:"candidates"`
	Source       string   `json:"source_ref"`
}

func (s *importService) exportNormalizationReport(c *core.RequestEvent) error {
	projectID := c.Request.PathValue("projectId")
	if _, _, err := requireProjectManagerInApp(s.app, c, projectID); err != nil {
		return err
	}
	query := c.Request.URL.Query()
	raw := query.Get("status")
	if len(query) > 1 || (len(query) > 0 && len(query["status"]) != 1) {
		return apis.NewBadRequestError("请仅指定复核状态。", nil)
	}
	if raw == "" {
		raw = "AMBIGUOUS,UNSUPPORTED"
	}
	statuses, problem := parseNormalizationStatuses(raw)
	if problem != "" {
		return apis.NewBadRequestError(problem, nil)
	}
	for _, status := range statuses {
		if !reviewableNormalizationStatus(status) {
			return apis.NewBadRequestError("异常清单只支持需人工确认和暂未支持两种状态。", nil)
		}
	}

	// Finish and validate the complete snapshot before sending any source text.
	file, err := os.CreateTemp("", "wanyu-normalizations-*")
	if err != nil {
		return err
	}
	// On systems that support unlinking an open file, even a server crash
	// cannot leave a named report containing source text on disk.
	if err := os.Remove(file.Name()); err != nil {
		defer os.Remove(file.Name())
	}
	defer file.Close()
	sources := map[string]bool{}
	count := 0
	err = withRecordReadSnapshot(c.Request.Context(), s.app, func(reader recordReader) error {
		if _, _, err := requireProjectManagerInApp(reader, c, projectID); err != nil {
			return err
		}
		rows, err := reader.DB().NewQuery(normalizationReportSQL).WithContext(c.Request.Context()).Bind(dbx.Params{"project": projectID, "both": len(statuses) == 2, "status": string(statuses[0])}).Rows()
		if err != nil {
			return err
		}
		defer rows.Close()
		w := bufio.NewWriter(file)
		// Only bound enum values and a server-validated project ID enter the header.
		scope, err := json.Marshal(struct {
			Project  string          `json:"project_id"`
			Statuses []scheme.Status `json:"statuses"`
		}{projectID, statuses})
		if err != nil {
			return err
		}
		fmt.Fprintf(w, `{"scope":%s,"items":[`, scope)
		encoder := json.NewEncoder(w)
		for rows.Next() {
			var item normalizationReportEntry
			var trace, candidates string
			var allowed bool
			if err := rows.Scan(
				&item.ID, &item.Number, &item.PDFPage, &item.Column, &item.Snapshot, &item.Status,
				&item.SourceScheme, &item.TargetScheme, &item.Version, &item.Basis,
				&trace, &candidates, &item.Source, &allowed,
			); err != nil {
				return err
			}
			if !allowed {
				return apis.NewForbiddenError("筛选范围含未获内部研究许可、暂缓外发或导入中的条目。请核对来源登记与条目状态。", nil)
			}
			sources[item.Source] = true

			if trace != "" {
				if err := json.Unmarshal([]byte(trace), &item.Trace); err != nil {
					return err
				}
			}
			if candidates != "" {
				if err := json.Unmarshal([]byte(candidates), &item.Candidates); err != nil {
					return err
				}
			}
			if item.Trace == nil {
				item.Trace = []string{}
			}
			if item.Candidates == nil {
				item.Candidates = []string{}
			}
			if count > 0 {
				w.WriteByte(',')
			}
			if err := encoder.Encode(item); err != nil {
				return err
			}
			count++
		}
		if err := rows.Err(); err != nil {
			return err
		}
		fmt.Fprintf(w, `],"count":%d}`, count)
		return w.Flush()
	})
	if err != nil {
		return err
	}
	length, err := file.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err = s.app.RunInTransaction(func(tx core.App) error {
		auth, _, err := requireProjectManagerInApp(tx, c, projectID)
		if err != nil {
			return err
		}
		for ref := range sources {
			if err := deliveryRights(tx, ref, "internal_research"); err != nil {
				return apis.NewForbiddenError("来源内部研究许可已变化，请重新核对。", err)
			}
		}
		return appendSecurityEvent(tx, c, "export.authorized", "success", auth.Id, "", projectID, map[string]any{"count": count, "resource_type": "normalization_report", "resource_id": projectID})
	}); err != nil {
		return err
	}
	h := c.Response.Header()
	h.Set("Cache-Control", "private, no-store")
	h.Set("Content-Disposition", `attachment; filename="normalization-report.json"`)
	h.Set("Content-Length", strconv.FormatInt(length, 10))
	return c.Stream(http.StatusOK, "application/json; charset=utf-8", file)
}
