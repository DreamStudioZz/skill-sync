// SkillDock entry point: starts a local HTTP server that serves the
// server-side rendered UI. There is no WebView2 / Wails dependency — the
// user opens the app in any browser. A single instance is enforced by
// holding the HTTP listen port; a second launch simply opens the browser
// to the already-running instance.
package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"skilldock/internal/app"
	"skilldock/internal/config"
	"skilldock/internal/server"
)

func main() {
	port := os.Getenv("SKILLDOCK_PORT")
	if port == "" {
		port = "38291"
	}
	host := os.Getenv("SKILLDOCK_HOST")
	if host == "" {
		host = "127.0.0.1"
	}

	// Single-instance: grabbing the listen port is the lock.
	ln, err := net.Listen("tcp", net.JoinHostPort(host, port))
	if err != nil {
		openBrowser("http://127.0.0.1:" + port)
		fmt.Println("SkillDock 已在运行，已为你打开浏览器。")
		return
	}

	application := app.New()
	srv, err := server.New(application)
	if err != nil {
		log.Fatalf("初始化失败: %v", err)
	}

	url := "http://127.0.0.1:" + port
	if os.Getenv("SKILLDOCK_NO_BROWSER") == "" {
		go func() {
			time.Sleep(400 * time.Millisecond)
			openBrowser(url)
		}()
	}
	fmt.Printf("SkillDock 已启动：%s\n", url)

	httpSrv := &http.Server{Handler: srv.Handler()}
	go func() {
		if e := httpSrv.Serve(ln); e != nil && e != http.ErrServerClosed {
			log.Printf("server error: %v", e)
		}
	}()

	waitForExit()
	application.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
}

// openBrowser opens the given URL in the system default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = config.HideConsoleWindow(exec.Command("cmd", "/c", "start", "", url))
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

// waitForExit blocks until the process receives an interrupt/terminate signal.
func waitForExit() {
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
}
