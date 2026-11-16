package main

import "github.com/pocketbase/pocketbase/core"

// Project read models have no import queues or worker lifecycle. Their database
// access is scoped to a reader snapshot by each endpoint.
type projectQueryService struct {
	app      core.App
	hooksDir string
}

func newProjectQueryService(app core.App, hooksDir string) *projectQueryService {
	return &projectQueryService{app: app, hooksDir: hooksDir}
}

func (s *projectQueryService) requireProjectManager(c *core.RequestEvent, projectID string) (*core.Record, *core.Record, error) {
	return requireProjectManagerInApp(s.app, c, projectID)
}
