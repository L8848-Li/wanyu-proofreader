package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// withReadSnapshot pins one WAL snapshot on a concurrent reader. PocketBase's
// RunInTransaction uses its sole writer, even for SELECT-only callbacks.
// query_only enforces read-only behavior: the SQLite driver's ReadOnly option
// selects deferred BEGIN but alone does not reject writes. Restore the setting
// before returning the connection to the pool, or discard an unusable one.
func withReadSnapshot(ctx context.Context, app core.App, visit func(*dbx.Tx) error) (err error) {
	db, ok := app.ConcurrentDB().(*dbx.DB)
	if !ok {
		return errors.New("independent snapshot reader unavailable")
	}
	conn, err := db.DB().Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var previousQueryOnly int
	if err = conn.QueryRowContext(ctx, "PRAGMA query_only").Scan(&previousQueryOnly); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if _, resetErr := conn.ExecContext(cleanup, fmt.Sprintf("PRAGMA query_only=%d", previousQueryOnly)); resetErr != nil {
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			err = errors.Join(err, fmt.Errorf("restore snapshot connection: %w", resetErr))
		}
	}()
	// Install cleanup before changing the pragma: cancellation may be observed
	// after SQLite applied it but before ExecContext returns success.
	if _, err = conn.ExecContext(ctx, "PRAGMA query_only=ON"); err != nil {
		return err
	}
	raw, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	tx := db.Wrap(raw)
	defer tx.Rollback()
	if err = visit(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func snapshotQuery(ctx context.Context, tx *dbx.Tx, built *dbx.Query) *dbx.Query {
	return tx.NewQuery(built.SQL()).Bind(built.Params()).WithContext(ctx)
}

// Preserve PocketBase's field decoding and public JSON behavior while reading
// record bytes through the same snapshot as the count and relation expansion.
// Calling an embedded App's FindRecords methods would use its original DB.
func snapshotRecords(ctx context.Context, tx *dbx.Tx, collection *core.Collection, built *dbx.Query) ([]*core.Record, error) {
	rows, err := snapshotQuery(ctx, tx, built).Rows()
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*core.Record{}
	for rows.Next() {
		values := dbx.NullStringMap{}
		if err = rows.ScanMap(values); err != nil {
			return nil, err
		}
		record, err := decodeSnapshotRecord(collection, values)
		if err != nil {
			return nil, err
		}
		result = append(result, record)
	}
	return result, rows.Err()
}

func decodeSnapshotRecord(collection *core.Collection, values dbx.NullStringMap) (*core.Record, error) {
	record := core.NewRecord(collection)
	for _, field := range collection.Fields {
		var raw any
		if value, ok := values[field.GetName()]; ok && value.Valid {
			raw = value.String
		}
		value, err := field.PrepareValue(record, raw)
		if err != nil {
			return nil, err
		}
		record.SetRaw(field.GetName(), value)
	}
	return record, record.PostScan()
}

func toAnyStrings(values []string) []any {
	result := make([]any, len(values))
	for i, value := range values {
		result[i] = value
	}
	return result
}
