package main

import (
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Fixed-size IN queries keep event reads bounded by batches instead of issuing
// one query per delivery. Each delivery retains its authoritative event order.
func deliveryEventIndex(reader recordReader, deliveries []*core.Record) (map[string][]*core.Record, error) {
	byDelivery := make(map[string][]*core.Record, len(deliveries))
	for start := 0; start < len(deliveries); start += 200 {
		end := min(start+200, len(deliveries))
		ids := make([]any, 0, end-start)
		for _, delivery := range deliveries[start:end] {
			ids = append(ids, delivery.Id)
		}
		events := []*core.Record{}
		if err := reader.RecordQuery("release_events").AndWhere(dbx.In("delivery", ids...)).OrderBy("sequence", "id").All(&events); err != nil {
			return nil, err
		}
		for _, event := range events {
			id := event.GetString("delivery")
			byDelivery[id] = append(byDelivery[id], event)
		}
	}
	return byDelivery, nil
}
