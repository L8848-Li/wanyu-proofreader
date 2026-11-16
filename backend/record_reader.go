package main

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/search"
)

// Read models accept only this interface, so their Go and JavaScript helpers
// cannot accidentally save through the application's separate writer.
type recordReader interface {
	DataDir() string
	DB() dbx.Builder
	RecordQuery(any) *dbx.SelectQuery
	FindCollectionByNameOrId(string) (*core.Collection, error)
	FindRecordById(any, string, ...func(*dbx.SelectQuery) error) (*core.Record, error)
	FindRecordsByFilter(any, string, string, int, int, ...dbx.Params) ([]*core.Record, error)
	FindFirstRecordByFilter(any, string, ...dbx.Params) (*core.Record, error)
	CountRecords(any, ...dbx.Expression) (int64, error)
}

type snapshotReader struct {
	schema core.App
	tx     *dbx.Tx
	ctx    context.Context
}

func withRecordReadSnapshot(ctx context.Context, app core.App, visit func(recordReader) error) error {
	return withReadSnapshot(ctx, app, func(tx *dbx.Tx) error {
		return visit(&snapshotReader{schema: app, tx: tx, ctx: ctx})
	})
}

func (r *snapshotReader) DataDir() string { return r.schema.DataDir() }
func (r *snapshotReader) DB() dbx.Builder { return r.tx }

// PocketBase's normal record queries also resolve schema from this cache.
// All business records, including relation/filter reads, use the pinned tx.
func (r *snapshotReader) FindCollectionByNameOrId(name string) (*core.Collection, error) {
	return r.schema.FindCachedCollectionByNameOrId(name)
}

func (r *snapshotReader) collection(value any) (*core.Collection, error) {
	switch value := value.(type) {
	case *core.Collection:
		return value, nil
	case core.Collection:
		return &value, nil
	case string:
		return r.FindCollectionByNameOrId(value)
	default:
		return nil, fmt.Errorf("invalid collection identifier")
	}
}

func (r *snapshotReader) RecordQuery(value any) *dbx.SelectQuery {
	collection, err := r.collection(value)
	if err != nil {
		ctx, cancel := context.WithCancelCause(r.ctx)
		cancel(err)
		return r.tx.Select("*").From("@@invalid_collection").WithContext(ctx)
	}
	return r.tx.Select(r.tx.QuoteSimpleColumnName(collection.Name) + ".*").From(collection.Name).
		WithContext(r.ctx).WithBuildHook(func(query *dbx.Query) {
		query.WithOneHook(func(_ *dbx.Query, target any, scan func(any) error) error {
			record, ok := target.(*core.Record)
			if !ok {
				return scan(target)
			}
			data := dbx.NullStringMap{}
			if err := scan(&data); err != nil {
				return err
			}
			decoded, err := decodeSnapshotRecord(collection, data)
			if err == nil {
				*record = *decoded
			}
			return err
		}).WithAllHook(func(_ *dbx.Query, target any, scan func(any) error) error {
			switch target.(type) {
			case *[]*core.Record, *[]core.Record:
			default:
				return scan(target)
			}
			data := []dbx.NullStringMap{}
			if err := scan(&data); err != nil {
				return err
			}
			records := make([]*core.Record, 0, len(data))
			for _, row := range data {
				record, err := decodeSnapshotRecord(collection, row)
				if err != nil {
					return err
				}
				records = append(records, record)
			}
			switch target := target.(type) {
			case *[]*core.Record:
				*target = records
			case *[]core.Record:
				*target = make([]core.Record, len(records))
				for i, record := range records {
					(*target)[i] = *record
				}
			}
			return nil
		})
	})
}

func (r *snapshotReader) FindRecordById(value any, id string, filters ...func(*dbx.SelectQuery) error) (*core.Record, error) {
	collection, err := r.collection(value)
	if err != nil {
		return nil, err
	}
	query := r.RecordQuery(collection).AndWhere(dbx.HashExp{collection.Name + ".id": id}).Limit(1)
	for _, filter := range filters {
		if filter != nil {
			if err := filter(query); err != nil {
				return nil, err
			}
		}
	}
	record := &core.Record{}
	err = query.One(record)
	return record, err
}

func (r *snapshotReader) FindRecordsByFilter(value any, filter, sort string, limit, offset int, params ...dbx.Params) ([]*core.Record, error) {
	collection, err := r.collection(value)
	if err != nil {
		return nil, err
	}
	query := r.RecordQuery(collection)
	resolver := core.NewRecordFieldResolver(r.schema, collection, nil, true)
	if filter != "" {
		expression, err := search.FilterData(filter).BuildExpr(resolver, params...)
		if err != nil {
			return nil, err
		}
		query.AndWhere(expression)
	}
	if sort != "" {
		for _, field := range search.ParseSortFromString(sort) {
			expression, err := field.BuildExpr(resolver)
			if err != nil {
				return nil, err
			}
			if expression != "" {
				query.AndOrderBy(expression)
			}
		}
	}
	if err = resolver.UpdateQuery(query); err != nil {
		return nil, err
	}
	if limit > 0 {
		query.Limit(int64(limit))
	}
	if offset > 0 {
		query.Offset(int64(offset))
	}
	records := []*core.Record{}
	err = query.All(&records)
	return records, err
}

func (r *snapshotReader) FindFirstRecordByFilter(collection any, filter string, params ...dbx.Params) (*core.Record, error) {
	records, err := r.FindRecordsByFilter(collection, filter, "", 1, 0, params...)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, sql.ErrNoRows
	}
	return records[0], nil
}

func (r *snapshotReader) CountRecords(collection any, expressions ...dbx.Expression) (int64, error) {
	query := r.RecordQuery(collection).Select("COUNT(*)")
	for _, expression := range expressions {
		if expression != nil {
			query.AndWhere(expression)
		}
	}
	var count int64
	err := query.Row(&count)
	return count, err
}
