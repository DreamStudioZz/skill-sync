package config

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"

	"skilldock/internal/models"
)

var (
	configDir  string
	configFile string
	backupDir  string
)

func init() {
	home, _ := os.UserHomeDir()
	configDir = filepath.Join(home, ".skilldock")
	configFile = filepath.Join(configDir, "config.json")
	backupDir = filepath.Join(configDir, "backups")
}

// ExpandPath replaces ~ with the user's home directory.
func ExpandPath(p string) string {
	if p == "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	if p == "~" {
		return home
	}
	if len(p) >= 2 && p[0] == '~' && (p[1] == '/' || p[1] == '\\') {
		return filepath.Join(home, p[2:])
	}
	return p
}

// GetConfigFile returns the path to the config file (for debugging).
func GetConfigFile() string { return configFile }

// GetBackupDir returns the backup directory path.
func GetBackupDir() string { return backupDir }

// DefaultConfig returns an empty configuration.
func DefaultConfig() models.Config {
	return models.Config{
		Base:    models.Base{Skills: []models.Skill{}},
		Agents:  []models.Agent{},
		History: []models.HistoryEntry{},
	}
}

// LoadConfig reads the config from disk, returning a default if missing/invalid.
func LoadConfig() models.Config {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return DefaultConfig()
	}
	var cfg models.Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return DefaultConfig()
	}
	if cfg.Base.Skills == nil {
		cfg.Base.Skills = []models.Skill{}
	}
	if cfg.Agents == nil {
		cfg.Agents = []models.Agent{}
	}
	if cfg.History == nil {
		cfg.History = []models.HistoryEntry{}
	}

	// Migrate legacy "link" mode to "copy": link (junction/symlink) sync was
	// removed, so copy is now the only sync mode. Persist the migrated config.
	migrated := false
	for i := range cfg.Agents {
		if cfg.Agents[i].DefaultMode == "link" {
			cfg.Agents[i].DefaultMode = "copy"
			migrated = true
		}
		for j := range cfg.Agents[i].Links {
			if cfg.Agents[i].Links[j].Mode == "link" {
				cfg.Agents[i].Links[j].Mode = "copy"
				migrated = true
			}
		}
	}
	if migrated {
		_ = SaveConfig(cfg)
	}

	return cfg
}

// SaveConfig writes the config to disk as pretty-printed JSON.
func SaveConfig(cfg models.Config) error {
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(configFile, data, 0644)
}

// GetAgentSkillPath returns the agent-side path for a skill.
func GetAgentSkillPath(agent models.Agent, skillID string) string {
	return filepath.Join(ExpandPath(agent.Path), skillID)
}

// EnsureAgentDir creates the agent directory if it doesn't exist.
func EnsureAgentDir(agent models.Agent) (string, error) {
	agentPath := ExpandPath(agent.Path)
	if err := os.MkdirAll(agentPath, 0755); err != nil {
		return "", err
	}
	return agentPath, nil
}

// CopyDir recursively copies a directory. Symlinks are preserved as symlinks.
func CopyDir(src, dest string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	// Preserve symlinks
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(src)
		if err != nil {
			return err
		}
		return os.Symlink(target, dest)
	}
	if !info.IsDir() {
		return copyFile(src, dest, info)
	}
	if err := os.MkdirAll(dest, 0755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		s := filepath.Join(src, entry.Name())
		d := filepath.Join(dest, entry.Name())
		if entry.IsDir() {
			if err := CopyDir(s, d); err != nil {
				return err
			}
		} else if entry.Type()&os.ModeSymlink != 0 {
			target, err := os.Readlink(s)
			if err != nil {
				return err
			}
			if err := os.Symlink(target, d); err != nil {
				return err
			}
		} else {
			if err := copyFile(s, d, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFile(src, dest string, info os.FileInfo) error {
	if info == nil {
		var err error
		info, err = os.Lstat(src)
		if err != nil {
			return err
		}
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dest, data, info.Mode().Perm())
}

// BackupAgentSkill copies agent-side files to the backup directory for rollback.
func BackupAgentSkill(agentID, skillID, agentSkillDir string) (string, error) {
	if _, err := os.Lstat(agentSkillDir); err != nil {
		return "", nil // doesn't exist
	}
	backupPath := filepath.Join(backupDir, agentID, skillID, strconv.FormatInt(time.Now().UnixMilli(), 10))
	if err := CopyDir(agentSkillDir, backupPath); err != nil {
		return "", err
	}
	return backupPath, nil
}

// RestoreFromBackup replaces agentSkillDir with the contents of backupPath.
func RestoreFromBackup(backupPath, agentSkillDir string) error {
	if _, err := os.Lstat(agentSkillDir); err == nil {
		SafeRm(agentSkillDir)
	}
	return CopyDir(backupPath, agentSkillDir)
}

// HideConsoleWindow configures an exec.Cmd to run without flashing a console
// window on Windows (CREATE_NO_WINDOW). On other platforms it is a no-op.
// Use this for every subprocess spawned by the app (PowerShell junction
// creation, file explorer open, delete fallback) so the UI never flickers
// a CLI window.
func HideConsoleWindow(cmd *exec.Cmd) *exec.Cmd {
	if runtime.GOOS == "windows" {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	}
	return cmd
}

// SafeRm robustly deletes a file or directory, trying multiple strategies.
// Returns true if the path is gone (or was never there), false if all strategies failed.
func SafeRm(targetPath string) bool {
	// Check existence (Lstat catches broken symlinks too)
	if _, err := os.Lstat(targetPath); err != nil {
		return true // already gone
	}

	// Strategy 1: os.RemoveAll (Go's built-in recursive removal)
	_ = os.RemoveAll(targetPath)
	if _, err := os.Lstat(targetPath); err != nil {
		return true
	}

	// Strategy 2: Check if it's a symlink/junction and remove the link only
	if info, err := os.Lstat(targetPath); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			_ = os.Remove(targetPath)
			if _, err := os.Lstat(targetPath); err != nil {
				return true
			}
		}
	}

	// Strategy 3: Platform-native command
	if runtime.GOOS == "windows" {
		cmd := HideConsoleWindow(exec.Command("powershell", "-NoProfile", "-Command",
			"Remove-Item -Path \""+targetPath+"\" -Recurse -Force -ErrorAction SilentlyContinue"))
		cmd.Run()
	} else {
		exec.Command("rm", "-rf", targetPath).Run()
	}
	if _, err := os.Lstat(targetPath); err != nil {
		return true
	}

	return false
}

// GenerateID creates a unique agent/history ID using timestamp + atomic counter.
var idCounter int64

func GenerateID(prefix string) string {
	count := atomic.AddInt64(&idCounter, 1)
	return fmt.Sprintf("%s-%s-%04d", prefix,
		strconv.FormatInt(time.Now().UnixMilli(), 36),
		count)
}
