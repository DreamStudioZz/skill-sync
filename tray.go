package main

import (
	_ "embed"

	"github.com/getlantern/systray"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed build/windows/icon.ico
var trayIconBytes []byte

// TrayManager manages the system tray lifecycle.
type TrayManager struct {
	app    *App
	quitFn func()
}

var trayMgr *TrayManager

// startTray launches the system tray in a goroutine (Windows supports this).
func startTray(app *App, quitFn func()) {
	trayMgr = &TrayManager{
		app:    app,
		quitFn: quitFn,
	}
	go systray.Run(onTrayReady, onTrayExit)
}

// onTrayReady sets up the tray icon and menu.
func onTrayReady() {
	systray.SetIcon(trayIconBytes)
	systray.SetTitle("SkillDock")
	systray.SetTooltip("SkillDock 技能货站 — 点击显示主窗口")

	mShow := systray.AddMenuItem("显示主窗口", "显示 SkillDock 主窗口")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("退出 SkillDock", "退出应用程序")

	// Handle clicks
	go func() {
		for {
			select {
			case <-mShow.ClickedCh:
				showMainWindow()
			case <-mQuit.ClickedCh:
				if trayMgr != nil && trayMgr.quitFn != nil {
					trayMgr.quitFn()
				}
				systray.Quit()
				return
			}
		}
	}()
}

// onTrayExit cleans up when the tray is exiting.
func onTrayExit() {
	// Nothing to clean up — the app quit is handled by quitFn
}

// showMainWindow brings the Wails window to the front.
func showMainWindow() {
	if trayMgr == nil || trayMgr.app == nil || trayMgr.app.ctx == nil {
		return
	}
	wailsRuntime.WindowShow(trayMgr.app.ctx)
	wailsRuntime.WindowSetAlwaysOnTop(trayMgr.app.ctx, true)
	wailsRuntime.WindowSetAlwaysOnTop(trayMgr.app.ctx, false)
}
