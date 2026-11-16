package main

import (
	"errors"
	"io"
	"path"

	"github.com/pocketbase/pocketbase/core"
)

func openRecordFile(app core.App, record *core.Record, field string) (io.ReadSeeker, func(), error) {
	filename := record.GetString(field)
	if filename == "" {
		return nil, func() {}, errors.New("missing file field")
	}
	fs, err := app.NewFilesystem()
	if err != nil {
		return nil, func() {}, err
	}
	reader, err := fs.GetFile(path.Join(record.BaseFilesPath(), filename))
	if err != nil {
		fs.Close()
		return nil, func() {}, err
	}
	closeFn := func() {
		reader.Close()
		fs.Close()
	}
	return reader, closeFn, nil
}
