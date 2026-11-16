package main

import (
	"log"
	"os"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/plugins/jsvm"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"
)

// Injected by -ldflags; docs/operations.md asks operators to record the build revision.
var (
	version   = "dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	log.SetOutput(os.Stdout)
	log.Printf("fangji backend %s (commit %s, built %s)", version, commit, buildDate)
	poolConfig, err := databasePoolConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	writeOperation("info", "database", "db_pool_config", map[string]any{
		"data_max_open": poolConfig.DataMaxOpenConns, "data_max_idle": poolConfig.DataMaxIdleConns,
		"aux_max_open": poolConfig.AuxMaxOpenConns, "aux_max_idle": poolConfig.AuxMaxIdleConns,
		"separate_writer_connections": 2,
	})
	// Temporary/go-run executables must retain the same log privacy as releases.
	poolConfig.DefaultDev = false
	app := pocketbase.NewWithConfig(poolConfig)
	registerBootstrapPrivacy(app)
	registerDataDirectoryOwnership(app)
	registerAssistPublicationRecovery(app)

	var hooksDir string
	app.RootCmd.PersistentFlags().StringVar(&hooksDir, "hooksDir", "", "the directory with the JS app hooks")

	var hooksWatch bool
	app.RootCmd.PersistentFlags().BoolVar(&hooksWatch, "hooksWatch", true, "auto restart on JS hook changes")

	var hooksPool int
	app.RootCmd.PersistentFlags().IntVar(&hooksPool, "hooksPool", 25, "the JS hook runtime pool size")

	var migrationsDir string
	app.RootCmd.PersistentFlags().StringVar(&migrationsDir, "migrationsDir", "", "the directory with migrations")

	var automigrate bool
	app.RootCmd.PersistentFlags().BoolVar(&automigrate, "automigrate", true, "enable automatic migrations")

	app.RootCmd.ParseFlags(os.Args[1:])

	jsvm.MustRegister(app, jsvm.Config{
		MigrationsDir: migrationsDir,
		HooksDir:      hooksDir,
		HooksWatch:    hooksWatch,
		HooksPoolSize: hooksPool,
	})
	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{
		TemplateLang: migratecmd.TemplateLangJS,
		Automigrate:  automigrate,
		Dir:          migrationsDir,
	})
	registerTrustedClientIP(app)
	registerAccountSecurity(app)
	registerAccountRecoveryCommand(app)
	registerNicknameLogin(app)
	registerProfile(app)
	registerBundleValidation(app)
	registerJoinAttemptCleanup(app)

	if err := registerKeyboardPresets(app); err != nil {
		log.Fatal(err)
	}

	importer := newImportService(app)
	registerObservability(app, importer)
	registerCapacityProbe(app)
	importer.register()
	importer.registerOCR()
	importer.registerPDFPreview()
	importer.registerPagination()
	importer.registerArtifacts()
	deliveries := newDeliveryService(app, hooksDir)
	deliveries.registerDeliveries()
	queries := newProjectQueryService(app, hooksDir)
	queries.registerManagerTodos()
	queries.registerProjectWorkflow()
	importer.registerProjectExport()
	importer.registerBatchReports()
	importer.registerQualityState()
	importer.registerImportLedger()
	importer.registerAdoption()
	importer.registerAdoptionEvents()
	importer.registerBundleImports()
	importer.registerPageContent()
	importer.registerToneBatch()

	if err := importer.registerSchemeConversion(); err != nil {
		// 规则文件坏掉就整实例起不来（#189：非法即启动报错，不要静默半生效）。
		// 目录未配置不是错误，是「本实例还没有可用方案」这个合法状态。
		log.Fatal(err)
	}

	identityProviders := make([]externalIdentityProvider, 0, 1)
	if hinghwaBaseURL := os.Getenv("HINGHWA_IDENTITY_BASE_URL"); hinghwaBaseURL != "" {
		hinghwaProvider, err := newHinghwaIdentityProvider(hinghwaBaseURL)
		if err != nil {
			log.Fatal(err)
		}
		identityProviders = append(identityProviders, hinghwaProvider)
	}
	externalIdentities := newExternalIdentityService(app, identityProviders...)
	externalIdentities.register()

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
