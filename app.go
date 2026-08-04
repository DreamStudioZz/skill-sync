package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"skilldock/internal/config"
	"skilldock/internal/models"
	"skilldock/internal/scanner"
	"skilldock/internal/syncmanager"
	"skilldock/internal/watcher"
)

// App is the Wails binding struct. All exported methods are callable from the frontend.
type App struct {
	ctx     context.Context
	cfg     models.Config
	watcher *watcher.Watcher
	mu      sync.Mutex
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{}
}

// startup is called by Wails when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.cfg = config.LoadConfig()

	// Start the file watcher if base is set
	if a.cfg.Base.Path != "" {
		a.ensureWatcher()
	}
}

// shutdown is called when the app is closing.
func (a *App) shutdown(ctx context.Context) {
	if a.watcher != nil {
		a.watcher.Stop()
	}
}

// ensureWatcher stops any existing watcher and starts a new one for the current base path.
func (a *App) ensureWatcher() {
	if a.watcher != nil {
		a.watcher.Stop()
		a.watcher = nil
	}
	if a.cfg.Base.Path == "" {
		return
	}
	basePath := config.ExpandPath(a.cfg.Base.Path)
	w, err := watcher.Start(basePath, func(newSkills []models.Skill) {
		a.mu.Lock()
		defer a.mu.Unlock()

		// Compare to detect actual changes
		oldHashes := map[string]string{}
		for _, s := range a.cfg.Base.Skills {
			oldHashes[s.ID] = s.ContentHash
		}
		a.cfg.Base.Skills = newSkills

		var changedIDs []string
		for _, s := range newSkills {
			if old, ok := oldHashes[s.ID]; !ok || old != s.ContentHash {
				changedIDs = append(changedIDs, s.ID)
			}
		}

		config.SaveConfig(a.cfg)
		matrix := syncmanager.ComputeStatusMatrix(a.cfg)

		wailsRuntime.EventsEmit(a.ctx, "config_updated", models.ConfigResponse{
			Config:       a.cfg,
			StatusMatrix: matrix,
		})

		if len(changedIDs) > 0 {
			wailsRuntime.EventsEmit(a.ctx, "change_detected", map[string]interface{}{
				"skills":  changedIDs,
				"message": "检测到 " + strconv.Itoa(len(changedIDs)) + " 个 skill 有更新",
			})
		}
	})
	if err == nil {
		a.watcher = w
	}
}

// --- Binding methods (callable from frontend via window.go.main.App.*) ---

// GetConfig returns the current config and status matrix.
func (a *App) GetConfig() models.ConfigResponse {
	a.mu.Lock()
	defer a.mu.Unlock()
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}
}

// SetBase sets the Base warehouse path and scans it.
func (a *App) SetBase(basePath string) (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	expanded := config.ExpandPath(basePath)
	if expanded == "" {
		return models.ConfigResponse{}, &appError{"请提供 Base 路径"}
	}
	if _, err := filepath.Glob(expanded); err != nil {
		return models.ConfigResponse{}, &appError{"路径无效: " + expanded}
	}
	// Check the directory exists
	dir, err := filepath.Abs(expanded)
	if err != nil {
		return models.ConfigResponse{}, &appError{"路径无效: " + expanded}
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return models.ConfigResponse{}, &appError{"路径不存在: " + expanded}
	}

	a.cfg.Base.Path = dir
	a.cfg.Base.Skills = scanner.ScanBase(dir)
	config.SaveConfig(a.cfg)

	// Restart watcher (outside the lock — but we're holding it; that's OK since
	// the watcher's callback uses its own lock acquisition via the closure)
	// We unlock temporarily for the watcher start
	a.mu.Unlock()
	a.ensureWatcher()
	a.mu.Lock()

	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}, nil
}

// ScanBase rescans the Base directory.
func (a *App) ScanBase() (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cfg.Base.Path == "" {
		return models.ConfigResponse{}, &appError{"未设置 Base 路径"}
	}
	a.cfg.Base.Skills = scanner.ScanBase(a.cfg.Base.Path)
	config.SaveConfig(a.cfg)
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}, nil
}

// Browse lists subdirectories of a path (for the path picker UI).
func (a *App) Browse(p string) (models.BrowseResult, error) {
	if p == "" {
		p, _ = os.UserHomeDir()
	}
	expanded := config.ExpandPath(p)
	entries, err := os.ReadDir(expanded)
	if err != nil {
		return models.BrowseResult{}, &appError{err.Error()}
	}
	var browseEntries []models.BrowseEntry
	for _, e := range entries {
		if e.IsDir() && e.Name()[0] != '.' {
			browseEntries = append(browseEntries, models.BrowseEntry{Name: e.Name(), IsDir: true})
		}
	}
	parent := filepath.Dir(expanded)
	if parent == expanded {
		parent = ""
	}
	return models.BrowseResult{
		Path:    expanded,
		Parent:  parent,
		Entries: browseEntries,
	}, nil
}

// GetAgents returns the list of agents.
func (a *App) GetAgents() []models.Agent {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.cfg.Agents
}

// AddAgent creates a new agent.
func (a *App) AddAgent(name, agentPath, color, defaultMode string) (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if name == "" || agentPath == "" {
		return models.ConfigResponse{}, &appError{"请提供名称和路径"}
	}
	if color == "" {
		color = "#8B5CF6"
	}
	if defaultMode == "" {
		defaultMode = "link"
	}
	agent := models.Agent{
		ID:          config.GenerateID("agent"),
		Name:        name,
		DisplayName: name,
		Path:        agentPath,
		Color:       color,
		DefaultMode: defaultMode,
		Links:       []models.Link{},
	}
	expanded := config.ExpandPath(agentPath)
	if err := os.MkdirAll(expanded, 0755); err != nil {
		return models.ConfigResponse{}, &appError{"无法创建目录: " + err.Error()}
	}
	a.cfg.Agents = append(a.cfg.Agents, agent)
	config.SaveConfig(a.cfg)
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}, nil
}

// UpdateAgent updates an agent's properties. Empty strings mean "don't change".
func (a *App) UpdateAgent(id, name, agentPath, color, defaultMode string) (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	agent := findAgentByID(a.cfg.Agents, id)
	if agent == nil {
		return models.ConfigResponse{}, &appError{"Agent 不存在"}
	}
	if name != "" {
		agent.Name = name
		agent.DisplayName = name
	}
	if agentPath != "" {
		agent.Path = agentPath
	}
	if color != "" {
		agent.Color = color
	}
	if defaultMode != "" {
		agent.DefaultMode = defaultMode
	}
	config.SaveConfig(a.cfg)
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}, nil
}

// DeleteAgent removes an agent. If cleanup is true, synced files are deleted.
func (a *App) DeleteAgent(id string, cleanup bool) (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	idx := -1
	for i, ag := range a.cfg.Agents {
		if ag.ID == id {
			idx = i
			break
		}
	}
	if idx == -1 {
		return models.ConfigResponse{}, &appError{"Agent 不存在"}
	}
	agent := a.cfg.Agents[idx]
	if cleanup {
		for _, link := range agent.Links {
			agentSkillDir := filepath.Join(config.ExpandPath(agent.Path), link.SkillID)
			config.SafeRm(agentSkillDir)
		}
	}
	a.cfg.Agents = append(a.cfg.Agents[:idx], a.cfg.Agents[idx+1:]...)
	config.SaveConfig(a.cfg)
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.ConfigResponse{Config: a.cfg, StatusMatrix: matrix}, nil
}

// SyncSkill syncs a skill to an agent.
func (a *App) SyncSkill(skillID, agentID, mode string) (models.SyncResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := syncmanager.SyncSkill(&a.cfg, skillID, agentID, mode)
	if err != nil {
		return models.SyncResult{}, err
	}
	a.cfg = result.Config
	config.SaveConfig(a.cfg)
	return *result, nil
}

// SyncBatch syncs multiple skills to multiple agents.
func (a *App) SyncBatch(skillIDs, agentIDs []string, mode string) models.BatchSyncResult {
	a.mu.Lock()
	defer a.mu.Unlock()
	var errs []models.BatchSyncError
	degradedCount := 0
	for _, skillID := range skillIDs {
		for _, agentID := range agentIDs {
			result, err := syncmanager.SyncSkill(&a.cfg, skillID, agentID, mode)
			if err != nil {
				errs = append(errs, models.BatchSyncError{SkillID: skillID, AgentID: agentID, Error: err.Error()})
			} else {
				a.cfg = result.Config
				if result.Degraded {
					degradedCount++
				}
			}
		}
	}
	config.SaveConfig(a.cfg)
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return models.BatchSyncResult{Config: a.cfg, StatusMatrix: matrix, Errors: errs, DegradedCount: degradedCount}
}

// UnsyncSkill removes a skill sync from an agent.
func (a *App) UnsyncSkill(skillID, agentID string) (models.SyncResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := syncmanager.UnsyncSkill(&a.cfg, skillID, agentID)
	if err != nil {
		return models.SyncResult{}, err
	}
	a.cfg = result.Config
	config.SaveConfig(a.cfg)
	return *result, nil
}

// PushChanges pushes updated Base content to a synced agent.
func (a *App) PushChanges(skillID, agentID string) (models.SyncResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := syncmanager.PushChanges(&a.cfg, skillID, agentID)
	if err != nil {
		return models.SyncResult{}, err
	}
	a.cfg = result.Config
	config.SaveConfig(a.cfg)
	return *result, nil
}

// ResolveDrift handles drift resolution: keep, overwrite, or save_as_new.
func (a *App) ResolveDrift(skillID, agentID, action, newSkillName string) (models.DriftResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := syncmanager.ResolveDrift(&a.cfg, skillID, agentID, action, newSkillName)
	if err != nil {
		return models.DriftResult{}, err
	}
	a.cfg = result.Config
	if action == "save_as_new" {
		a.cfg.Base.Skills = scanner.ScanBase(a.cfg.Base.Path)
	}
	config.SaveConfig(a.cfg)
	return *result, nil
}

// GetHistory returns the most recent history entries.
func (a *App) GetHistory(limit int) []models.HistoryEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	if limit <= 0 {
		limit = 50
	}
	hist := a.cfg.History
	start := len(hist) - limit
	if start < 0 {
		start = 0
	}
	sub := hist[start:]
	// Reverse
	result := make([]models.HistoryEntry, len(sub))
	for i, h := range sub {
		result[len(sub)-1-i] = h
	}
	return result
}

// Rollback reverses a history entry.
func (a *App) Rollback(historyID string) (models.ConfigResponse, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	result, err := syncmanager.Rollback(&a.cfg, historyID)
	if err != nil {
		return models.ConfigResponse{}, err
	}
	a.cfg = result.Config
	config.SaveConfig(a.cfg)
	return *result, nil
}

// GetChanges returns skills that are stale or drifted.
func (a *App) GetChanges() []models.ChangeItem {
	a.mu.Lock()
	defer a.mu.Unlock()
	matrix := syncmanager.ComputeStatusMatrix(a.cfg)
	return syncmanager.GetChanges(a.cfg, matrix)
}

// OpenPath opens a path in the system file explorer.
func (a *App) OpenPath(targetPath string) error {
	expanded := config.ExpandPath(targetPath)
	if expanded == "" {
		return &appError{"请提供路径"}
	}
	if _, err := os.Stat(expanded); err != nil {
		return &appError{"路径不存在: " + expanded}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// Hide the console window so no cmd CLI window flashes before
		// Explorer opens.
		cmd = config.HideConsoleWindow(exec.Command("cmd", "/c", "start", "", expanded))
	case "darwin":
		cmd = exec.Command("open", expanded)
	default:
		cmd = exec.Command("xdg-open", expanded)
	}
	return cmd.Start()
}

// --- helpers ---

func findAgentByID(agents []models.Agent, id string) *models.Agent {
	for i := range agents {
		if agents[i].ID == id {
			return &agents[i]
		}
	}
	return nil
}

// appError implements the error interface with a user-friendly message.
type appError struct{ msg string }

func (e *appError) Error() string { return e.msg }
