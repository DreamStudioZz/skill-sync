//go:build windows

package config

import (
	"os/exec"
	"syscall"
)

// HideConsoleWindow configures an exec.Cmd to run without flashing a console
// window on Windows (CREATE_NO_WINDOW). This is platform-specific because the
// HideWindow field only exists on Windows' syscall.SysProcAttr.
func HideConsoleWindow(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}
