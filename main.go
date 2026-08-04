package main

import (
	"context"
	"embed"
	"fmt"
	"net"
	"sync/atomic"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// singleInstancePort is used to detect if another instance is already running.
const singleInstancePort = "127.0.0.1:38291"

// shouldQuit is set to true when the user explicitly quits via the tray menu.
// When false, closing the window hides it to the tray instead of exiting.
var shouldQuit atomic.Bool

func main() {
	// --- Single instance check ---
	ln, err := net.Listen("tcp", singleInstancePort)
	if err != nil {
		fmt.Println("SkillDock is already running.")
		return
	}
	defer ln.Close()

	// Create the app
	app := NewApp()

	// Start the system tray (runs in a goroutine on Windows)
	startTray(app, func() {
		// Quit function: flag true so OnBeforeClose allows the close,
		// then tell Wails to quit.
		shouldQuit.Store(true)
		if app.ctx != nil {
			wailsRuntime.Quit(app.ctx)
		}
	})

	// Run the Wails application
	err = wails.Run(&options.App{
		Title:     "SkillDock 技能货站",
		Width:     1280,
		Height:    860,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 251, G: 243, B: 228, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose: func(ctx context.Context) (prevent bool) {
			if shouldQuit.Load() {
				// User explicitly chose to quit — allow the window to close
				return false
			}
			// Minimize to tray instead of closing
			wailsRuntime.WindowHide(ctx)
			return true
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

// Ensure wailsRuntime is referenced (used in app.go for EventsEmit)
var _ = wailsRuntime.EventsEmit
