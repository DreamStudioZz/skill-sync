//go:build !windows

package config

import "os/exec"

// HideConsoleWindow is a no-op on non-Windows platforms (no console window to
// hide). Kept as a no-op stub so callers compile unchanged across platforms.
func HideConsoleWindow(cmd *exec.Cmd) *exec.Cmd {
	return cmd
}
