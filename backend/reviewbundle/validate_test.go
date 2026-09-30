package reviewbundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSyntheticFixturesPass(t *testing.T) {
	for _, name := range []string{"inbound", "result"} {
		report, err := ValidateDir(filepath.Join("testdata", "review-bundle-v0", name))
		if err != nil {
			t.Fatal(err)
		}
		if !report.OK || report.EntryCount != 2 || len(report.Errors) != 0 {
			t.Fatalf("%s: %#v", name, report)
		}
		again, err := ValidateDir(filepath.Join("testdata", "review-bundle-v0", name))
		if err != nil {
			t.Fatal(err)
		}
		if again.OK != report.OK || again.EntryCount != report.EntryCount || again.BundleID != report.BundleID {
			t.Fatalf("repeat validation changed the report: %#v %#v", report, again)
		}
	}
}

func TestRejectsMissingManifest(t *testing.T) {
	report, err := ValidateZip(zipBytes(t, map[string]string{"entries.jsonl": "{}\n"}))
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, report, "manifest_missing", "缺少 manifest.json")
}

func TestRejectsChecksumMismatch(t *testing.T) {
	files := validInbound(t)
	var manifest map[string]any
	if err := json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil {
		t.Fatal(err)
	}
	listed := manifest["files"].([]any)[0].(map[string]any)
	listed["sha256"] = strings.Repeat("ab", 32)
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files["manifest.json"] = string(raw)
	report, err := ValidateZip(zipBytes(t, files))
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, report, "checksum_mismatch", "SHA-256")
}

func TestRejectsLineCountMismatch(t *testing.T) {
	files := validInbound(t)
	var manifest map[string]any
	if err := json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["files"].([]any)[0].(map[string]any)["lines"] = 1
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files["manifest.json"] = string(raw)
	report, err := ValidateZip(zipBytes(t, files))
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, report, "line_count_mismatch", "行数")
}

func TestRejectsUnsupportedSchemaVersion(t *testing.T) {
	files := validInbound(t)
	files["entries.jsonl"] = strings.ReplaceAll(files["entries.jsonl"], "entry-002", "entry-001")
	var manifest map[string]any
	if err := json.Unmarshal([]byte(files["manifest.json"]), &manifest); err != nil {
		t.Fatal(err)
	}
	manifest["bundle"].(map[string]any)["schema_version"] = "ReviewBundle/v9"
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	files["manifest.json"] = string(raw)
	report, err := ValidateZip(zipBytes(t, files))
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, report, "schema_version_unsupported", "不支持的 schema_version「ReviewBundle/v9」")
	if len(report.Errors) != 1 {
		t.Fatalf("version mismatch must refuse before entry checks, got %#v", report.Errors)
	}
	if report.EntryCount != 0 {
		t.Fatalf("version mismatch must not accept entries, got %d", report.EntryCount)
	}
}

func TestRejectsDuplicateEntryID(t *testing.T) {
	payload := "{\"entry_id\":\"entry-001\",\"fields\":{\"headword\":\"样例甲\",\"reading\":\"sia3-li6\"}}\n" +
		"{\"entry_id\":\"entry-001\",\"fields\":{\"headword\":\"样例乙\",\"reading\":\"sia3-li7\"}}\n"
	files := manifestAround(t, SchemaInbound, "entries.jsonl", payload, false)
	report, err := ValidateZip(zipBytes(t, files))
	if err != nil {
		t.Fatal(err)
	}
	assertCode(t, report, "duplicate_entry_id", "entry_id「entry-001」重复")
}

func TestResultBundleAndNestedZip(t *testing.T) {
	payload := "{\"entry_id\":\"entry-001\",\"reviewed_fields\":[{\"field\":\"reading\",\"value\":\"sia3-li6\",\"decision\":\"confirmed\",\"provenance\":\"proofread_round:1\"}]}\n"
	files := manifestAround(t, SchemaResult, "results.jsonl", payload, true)
	nested := map[string]string{}
	for name, body := range files {
		nested["batch/"+name] = body
	}
	report, err := ValidateZip(zipBytes(t, nested))
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK || report.SchemaVersion != SchemaResult || report.EntryCount != 1 {
		t.Fatalf("%#v", report)
	}
}

func TestNotZip(t *testing.T) {
	_, err := ValidateZip([]byte("this is not a zip"))
	if err != ErrNotZip {
		t.Fatalf("got %v", err)
	}
}

func assertCode(t *testing.T, report Report, code, text string) {
	t.Helper()
	if report.OK {
		t.Fatalf("expected refusal, got %#v", report)
	}
	for _, item := range report.Errors {
		if item.Code == code && strings.Contains(item.Message, text) && strings.Contains(item.Message, "未写入任何数据") {
			return
		}
	}
	t.Fatalf("missing %s in %#v", code, report.Errors)
}

func validInbound(t *testing.T) map[string]string {
	t.Helper()
	payload := "{\"entry_id\":\"entry-001\",\"fields\":{\"headword\":\"样例甲\",\"reading\":\"sia3-li6\"}}\n" +
		"{\"entry_id\":\"entry-002\",\"fields\":{\"headword\":\"样例乙\",\"reading\":\"sia3-li7\"}}\n"
	return manifestAround(t, SchemaInbound, "entries.jsonl", payload, false)
}

func manifestAround(t *testing.T, version, name, payload string, result bool) map[string]string {
	t.Helper()
	sum := sha256.Sum256([]byte(payload))
	file := map[string]any{
		"path": name, "sha256": hex.EncodeToString(sum[:]), "lines": 0, "bytes": len(payload),
	}
	file["lines"] = strings.Count(payload, "\n")
	if !strings.HasSuffix(payload, "\n") && payload != "" {
		file["lines"] = file["lines"].(int) + 1
	}
	doc := map[string]any{
		"bundle": map[string]any{
			"bundle_id": "rb-synthetic-0001", "schema_version": version, "created_at": "2026-09-29T00:00:00Z",
		},
		"source_system": "xiangsheng-jihe", "source_id": "synthetic-lexicon", "source_version": "2026-09-29",
		"requested_fields": []string{"headword", "reading"}, "rights_ref": "src-synthetic-0001",
		"operator": "synthetic-operator",
		"files":    []any{file},
	}
	if result {
		doc["bundle"].(map[string]any)["bundle_id"] = "rrb-synthetic-0001"
		doc["result_of"] = map[string]any{"bundle_id": "rb-synthetic-0001"}
		doc["source_system"] = "wanyu-proofreader"
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"manifest.json": string(raw), name: payload}
}

func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, body := range files {
		entry, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(entry, body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestDirectoryAndZipAcceptTheSameNestedLayout(t *testing.T) {
	files := validInbound(t)
	var doc map[string]any
	if err := json.Unmarshal([]byte(files["manifest.json"]), &doc); err != nil {
		t.Fatal(err)
	}
	doc["files"].([]any)[0].(map[string]any)["path"] = "parts/entries.jsonl"
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	nested := map[string]string{
		"manifest.json":       string(raw),
		"parts/entries.jsonl": files["entries.jsonl"],
	}
	dir := t.TempDir()
	for name, body := range nested {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	dirReport, err := ValidateDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	zipReport, err := ValidateZip(zipBytes(t, nested))
	if err != nil {
		t.Fatal(err)
	}
	if !dirReport.OK || !zipReport.OK || dirReport.EntryCount != zipReport.EntryCount {
		t.Fatalf("dir %#v zip %#v", dirReport, zipReport)
	}
}

func TestFixtureZipMatchesDirectory(t *testing.T) {
	for _, name := range []string{"inbound", "result"} {
		root := filepath.Join("testdata", "review-bundle-v0", name)
		data, err := os.ReadFile(filepath.Join("testdata", "review-bundle-v0", name+".zip"))
		if err != nil {
			t.Fatal(err)
		}
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, file := range reader.File {
			if file.FileInfo().IsDir() {
				continue
			}
			rc, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(rc)
			rc.Close()
			if err != nil {
				t.Fatal(err)
			}
			disk, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(file.Name)))
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, disk) {
				t.Fatalf("%s 里的 %s 和目录文件不一致", name, file.Name)
			}
			seen[file.Name] = true
		}
		err = filepath.WalkDir(root, func(full string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() {
				return nil
			}
			rel, err := filepath.Rel(root, full)
			if err != nil {
				return err
			}
			key := filepath.ToSlash(rel)
			if !seen[key] {
				t.Fatalf("%s.zip 缺少 %s", name, key)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		report, err := ValidateZip(data)
		if err != nil || !report.OK {
			t.Fatalf("%s %#v %v", name, report, err)
		}
	}
}
