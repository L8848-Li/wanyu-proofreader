// Package reviewbundle checks a Review Bundle v0 directory or zip.
// It never opens a database and never writes an import.
package reviewbundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	SchemaInbound = "ReviewBundle/v0"
	SchemaResult  = "ReviewResultBundle/v0"

	maxZipFiles   = 32
	maxFileBytes  = 8 << 20
	maxTotalBytes = 20 << 20
)

// ErrNotZip means the upload is not a zip archive. Callers should reject it
// before treating the result as an import report.
var ErrNotZip = errors.New("reviewbundle: not a zip")

// Diagnostic is one reason the whole bundle was refused.
type Diagnostic struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Report is the validate-only import report. OK false means nothing may be imported.
type Report struct {
	OK            bool         `json:"ok"`
	SchemaVersion string       `json:"schema_version,omitempty"`
	BundleID      string       `json:"bundle_id,omitempty"`
	EntryCount    int          `json:"entry_count"`
	Errors        []Diagnostic `json:"errors"`
}

type manifestFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Lines  int    `json:"lines"`
	Bytes  int    `json:"bytes"`
}

type manifest struct {
	Bundle struct {
		BundleID      string `json:"bundle_id"`
		SchemaVersion string `json:"schema_version"`
		CreatedAt     string `json:"created_at"`
	} `json:"bundle"`
	SourceSystem    string   `json:"source_system"`
	SourceID        string   `json:"source_id"`
	SourceVersion   string   `json:"source_version"`
	RequestedFields []string `json:"requested_fields"`
	RightsRef       string   `json:"rights_ref"`
	Operator        string   `json:"operator"`
	ResultOf        *struct {
		BundleID string `json:"bundle_id"`
	} `json:"result_of"`
	Files []manifestFile `json:"files"`
}

type walkRefuse Report

func (r walkRefuse) Error() string {
	if len(r.Errors) == 0 {
		return "refused"
	}
	return r.Errors[0].Message
}

// ValidateDir checks a directory that contains manifest.json at its root.
// Nested paths are kept, so a directory and a zip of the same layout agree.
func ValidateDir(dir string) (Report, error) {
	files := map[string][]byte{}
	var total int
	err := filepath.WalkDir(dir, func(full string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if full == dir {
			return nil
		}
		rel, err := filepath.Rel(dir, full)
		if err != nil {
			return err
		}
		name, ok := cleanRel(filepath.ToSlash(rel))
		if !ok {
			return walkRefuse(refused("path_unsafe", fmt.Sprintf("路径「%s」不安全。", rel)))
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
			return walkRefuse(refused("path_unsafe", fmt.Sprintf("路径「%s」不是普通文件。", name)))
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() > maxFileBytes {
			return walkRefuse(refused("bundle_too_large", fmt.Sprintf("文件 %s 超过大小限制。", name)))
		}
		data, err := os.ReadFile(full)
		if err != nil {
			return err
		}
		total += len(data)
		if total > maxTotalBytes || len(files) >= maxZipFiles {
			return walkRefuse(refused("bundle_too_large", "包超过大小或文件数限制。"))
		}
		files[name] = data
		return nil
	})
	if err != nil {
		var refusedWalk walkRefuse
		if errors.As(err, &refusedWalk) {
			return Report(refusedWalk), nil
		}
		if os.IsNotExist(err) {
			return refused("manifest_missing", "缺少 manifest.json。"), nil
		}
		return Report{}, err
	}
	return validateLoaded(files), nil
}

// ValidateZip checks a zip whose manifest.json is at the archive root,
// or under a single top-level directory.
func ValidateZip(data []byte) (Report, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Report{}, ErrNotZip
	}
	files := map[string][]byte{}
	var total int
	for _, file := range reader.File {
		if file.FileInfo().IsDir() {
			continue
		}
		name, ok := cleanRel(file.Name)
		if !ok {
			return refused("path_unsafe", fmt.Sprintf("压缩包内路径「%s」不安全。", file.Name)), nil
		}
		if file.UncompressedSize64 > maxFileBytes {
			return refused("bundle_too_large", fmt.Sprintf("文件 %s 超过大小限制。", name)), nil
		}
		rc, err := file.Open()
		if err != nil {
			return Report{}, ErrNotZip
		}
		payload, err := io.ReadAll(io.LimitReader(rc, maxFileBytes+1))
		rc.Close()
		if err != nil {
			return Report{}, err
		}
		if len(payload) > maxFileBytes {
			return refused("bundle_too_large", fmt.Sprintf("文件 %s 超过大小限制。", name)), nil
		}
		total += len(payload)
		if total > maxTotalBytes || len(files) >= maxZipFiles {
			return refused("bundle_too_large", "包超过大小或文件数限制。"), nil
		}
		if _, exists := files[name]; exists {
			return refused("path_unsafe", fmt.Sprintf("压缩包内路径「%s」重复。", name)), nil
		}
		files[name] = payload
	}
	return validateLoaded(normalizeRoot(files)), nil
}

func validateLoaded(files map[string][]byte) Report {
	raw, ok := files["manifest.json"]
	if !ok {
		return refused("manifest_missing", "缺少 manifest.json。")
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil || root == nil {
		return refused("manifest_invalid", "manifest.json 不是有效的 JSON。")
	}
	var doc manifest
	if err := json.Unmarshal(raw, &doc); err != nil {
		return refused("manifest_invalid", "manifest.json 的字段类型不符合契约。")
	}
	version := doc.Bundle.SchemaVersion
	if version != SchemaInbound && version != SchemaResult {
		shown := version
		if shown == "" {
			shown = "空"
		}
		return Report{
			OK:            false,
			SchemaVersion: version,
			BundleID:      doc.Bundle.BundleID,
			Errors: []Diagnostic{{
				Code: "schema_version_unsupported",
				Message: refusedText(fmt.Sprintf(
					"不支持的 schema_version「%s」。当前只接受 %s 和 %s。",
					shown, SchemaInbound, SchemaResult)),
			}},
		}
	}

	var problems []Diagnostic
	add := func(code, detail string) {
		problems = append(problems, Diagnostic{Code: code, Message: refusedText(detail)})
	}
	checkEnvelope(&doc, root, add)

	seen := map[string]string{}
	seenPaths := map[string]bool{}
	entryCount := 0
	for _, file := range doc.Files {
		entryCount += checkPayload(doc, file, files, seenPaths, seen, add)
	}
	if problems == nil {
		problems = []Diagnostic{}
	}
	return Report{
		OK:            len(problems) == 0,
		SchemaVersion: version,
		BundleID:      doc.Bundle.BundleID,
		EntryCount:    entryCount,
		Errors:        problems,
	}
}

func checkEnvelope(doc *manifest, root map[string]json.RawMessage, add func(string, string)) {
	inbound := doc.Bundle.SchemaVersion == SchemaInbound
	if !validID(doc.Bundle.BundleID) {
		add("bundle_invalid", "bundle.bundle_id 不能为空，且须是来源侧的稳定编号。")
	}
	if _, err := time.Parse(time.RFC3339, doc.Bundle.CreatedAt); err != nil {
		add("bundle_invalid", "bundle.created_at 不是 RFC3339 时间。")
	}
	for _, item := range []struct{ name, value string }{
		{"source_system", doc.SourceSystem},
		{"source_id", doc.SourceID},
		{"source_version", doc.SourceVersion},
		{"operator", doc.Operator},
	} {
		if strings.TrimSpace(item.value) == "" || utf8.RuneCountInString(item.value) > 200 || strings.ContainsAny(item.value, "\r\n") {
			add("bundle_invalid", item.name+" 不能为空，且不能换行。")
		}
	}
	if !validID(doc.RightsRef) {
		add("bundle_invalid", "rights_ref 必须是来源登记里的 logical_id。")
	}
	rawResult, hasResult := root["result_of"]
	if inbound && hasResult && string(rawResult) != "null" {
		add("bundle_invalid", "进入包不能携带 result_of。")
	}
	if !inbound && (doc.ResultOf == nil || !validID(doc.ResultOf.BundleID)) {
		add("bundle_invalid", "结果包缺少 result_of.bundle_id。")
	}
	rawFields, hasFields := root["requested_fields"]
	if inbound && (!hasFields || string(rawFields) == "null") {
		add("bundle_invalid", "进入包缺少 requested_fields。")
	} else if hasFields && string(rawFields) != "null" {
		seen := map[string]bool{}
		if len(doc.RequestedFields) > 50 {
			add("bundle_invalid", "requested_fields 不能超过 50 项。")
		}
		for _, field := range doc.RequestedFields {
			if strings.TrimSpace(field) == "" || utf8.RuneCountInString(field) > 80 || strings.ContainsAny(field, "\r\n") || seen[field] {
				add("bundle_invalid", "requested_fields 里有空项或重复项。")
				break
			}
			seen[field] = true
		}
	}
	rawFiles, hasFiles := root["files"]
	if !hasFiles || string(rawFiles) == "null" || len(doc.Files) == 0 {
		add("bundle_invalid", "清单没有 files。")
	}
	if len(doc.Files) > maxZipFiles {
		add("bundle_too_large", "清单里的文件数超过限制。")
	}
}

func checkPayload(doc manifest, file manifestFile, files map[string][]byte, seenPaths map[string]bool, seenIDs map[string]string, add func(string, string)) int {
	name, ok := cleanRel(file.Path)
	if !ok || name == "manifest.json" {
		add("path_unsafe", fmt.Sprintf("清单路径「%s」不能使用。", file.Path))
		return 0
	}
	if seenPaths[name] {
		add("path_unsafe", fmt.Sprintf("清单路径「%s」重复。", name))
		return 0
	}
	seenPaths[name] = true
	data, exists := files[name]
	if !exists {
		add("file_missing", fmt.Sprintf("清单中的文件 %s 不存在。", name))
		return 0
	}
	if file.Bytes != len(data) {
		add("byte_count_mismatch", fmt.Sprintf("文件 %s 的字节数与清单不符：清单是 %d，实际是 %d。", name, file.Bytes, len(data)))
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	if !validSHA256(file.SHA256) || !strings.EqualFold(file.SHA256, actual) {
		add("checksum_mismatch", fmt.Sprintf("文件 %s 的 SHA-256 与清单不符：清单是 %s，实际是 %s。", name, file.SHA256, actual))
	}
	rows := splitLines(data)
	if file.Lines != len(rows) {
		add("line_count_mismatch", fmt.Sprintf("文件 %s 的行数与清单不符：清单是 %d，实际是 %d。", name, file.Lines, len(rows)))
	}
	count := 0
	inbound := doc.Bundle.SchemaVersion == SchemaInbound
	for index, row := range rows {
		if len(bytes.TrimSpace(row)) == 0 {
			continue
		}
		lineNo := index + 1
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(row, &obj); err != nil || obj == nil {
			add("entry_invalid", fmt.Sprintf("文件 %s 第 %d 行不是 JSON 对象。", name, lineNo))
			continue
		}
		id, ok := stringField(obj, "entry_id")
		if !ok || id == "" || utf8.RuneCountInString(id) > 200 || strings.ContainsAny(id, "\r\n") {
			add("entry_invalid", fmt.Sprintf("文件 %s 第 %d 行缺少可用的 entry_id。", name, lineNo))
			continue
		}
		where := fmt.Sprintf("%s 第 %d 行", name, lineNo)
		if prev, exists := seenIDs[id]; exists {
			add("duplicate_entry_id", fmt.Sprintf("entry_id「%s」重复，先出现在 %s，又出现在 %s。", id, prev, where))
		} else {
			seenIDs[id] = where
		}
		count++
		if inbound {
			checkInboundFields(name, lineNo, id, obj, doc.RequestedFields, add)
		} else {
			checkReviewedFields(name, lineNo, id, obj, add)
		}
	}
	return count
}

func checkInboundFields(file string, lineNo int, id string, obj map[string]json.RawMessage, requested []string, add func(string, string)) {
	raw, ok := obj["fields"]
	var fields map[string]json.RawMessage
	if !ok || json.Unmarshal(raw, &fields) != nil || fields == nil {
		add("entry_invalid", fmt.Sprintf("文件 %s 第 %d 行的条目 %s 缺少 fields。", file, lineNo, id))
		return
	}
	for _, name := range requested {
		if _, exists := fields[name]; !exists {
			add("entry_invalid", fmt.Sprintf("条目 %s 缺少请求字段 %s。", id, name))
		}
	}
}

func checkReviewedFields(file string, lineNo int, id string, obj map[string]json.RawMessage, add func(string, string)) {
	raw, ok := obj["reviewed_fields"]
	var items []map[string]json.RawMessage
	if !ok || json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		add("entry_invalid", fmt.Sprintf("文件 %s 第 %d 行的条目 %s 缺少 reviewed_fields。", file, lineNo, id))
		return
	}
	for _, item := range items {
		field, _ := stringField(item, "field")
		decision, _ := stringField(item, "decision")
		provenance, _ := stringField(item, "provenance")
		if _, exists := item["value"]; !exists || field == "" || decision == "" || provenance == "" || strings.ContainsAny(provenance, "\r\n") || utf8.RuneCountInString(provenance) > 200 {
			add("entry_invalid", fmt.Sprintf("条目 %s 的审校字段缺少最终值、decision 或 provenance。", id))
			return
		}
	}
}

func stringField(obj map[string]json.RawMessage, key string) (string, bool) {
	raw, ok := obj[key]
	if !ok {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

func refused(code, detail string) Report {
	return Report{OK: false, Errors: []Diagnostic{{Code: code, Message: refusedText(detail)}}}
}

func refusedText(detail string) string {
	detail = strings.TrimSpace(detail)
	if !strings.HasSuffix(detail, "。") {
		detail += "。"
	}
	return detail + "已拒绝整包，未写入任何数据。"
}

func validID(value string) bool {
	if value == "" || len(value) > 80 {
		return false
	}
	for i, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case i > 0 && (r == '.' || r == '_' || r == ':' || r == '-'):
		default:
			return false
		}
	}
	return true
}

func validSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func splitLines(data []byte) [][]byte {
	if len(data) == 0 {
		return nil
	}
	parts := bytes.Split(data, []byte("\n"))
	if len(parts) > 0 && len(parts[len(parts)-1]) == 0 {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func cleanRel(name string) (string, bool) {
	if name == "" || strings.ContainsAny(name, "\\:\x00") || strings.HasPrefix(name, "/") {
		return "", false
	}
	cleaned := path.Clean(name)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", false
	}
	return cleaned, true
}

func normalizeRoot(files map[string][]byte) map[string][]byte {
	if _, ok := files["manifest.json"]; ok {
		return files
	}
	prefix := ""
	for name := range files {
		slash := strings.IndexByte(name, '/')
		if slash <= 0 {
			return files
		}
		next := name[:slash+1]
		if prefix == "" {
			prefix = next
		} else if prefix != next {
			return files
		}
	}
	if prefix == "" {
		return files
	}
	out := make(map[string][]byte, len(files))
	for name, data := range files {
		out[strings.TrimPrefix(name, prefix)] = data
	}
	return out
}
