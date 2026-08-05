package syncmanager

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"skilldock/internal/config"
	"skilldock/internal/models"
	"skilldock/internal/scanner"
)

// strPtr returns a pointer to s, or nil if s is empty.
func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// strPtrAlways returns a pointer to s (never nil).
func strPtrAlways(s string) *string { return &s }

// ComputeStatusMatrix builds the agent×skill status map.
func ComputeStatusMatrix(cfg models.Config) models.StatusMatrix {
	matrix := models.StatusMatrix{}

	for _, agent := range cfg.Agents {
		matrix[agent.ID] = map[string]string{}
		for _, skill := range cfg.Base.Skills {
			link := findLink(agent.Links, skill.ID)
			if link == nil {
				matrix[agent.ID][skill.ID] = "not_synced"
				continue
			}
			agentSkillDir := config.GetAgentSkillPath(agent, skill.ID)
			if _, err := os.Lstat(agentSkillDir); err != nil {
				matrix[agent.ID][skill.ID] = "not_synced"
				continue
			}

			matrix[agent.ID][skill.ID] = checkCopyStatus(cfg, agent, skill, link, agentSkillDir)
		}
	}
	return matrix
}

func findLink(links []models.Link, skillID string) *models.Link {
	for i := range links {
		if links[i].SkillID == skillID {
			return &links[i]
		}
	}
	return nil
}

func checkCopyStatus(cfg models.Config, agent models.Agent, skill models.Skill, link *models.Link, agentSkillDir string) string {
	currentAgentHash := scanner.ComputeSkillHash(agentSkillDir)
	baseHash := skill.ContentHash
	lastHash := link.LastSyncedHash

	if currentAgentHash == "" {
		return "not_synced"
	}
	if currentAgentHash != lastHash && baseHash != lastHash {
		return "drifted"
	}
	if currentAgentHash != lastHash {
		return "drifted"
	}
	if baseHash != lastHash {
		return "stale"
	}
	return "synced"
}

// SyncSkill copies a skill from the Base directory into the agent's skills
// directory. Link mode was removed; copy is the only sync mode.
func SyncSkill(cfg *models.Config, skillID, agentID, modeOverride string) (*models.SyncResult, error) {
	agent := findAgent(cfg.Agents, agentID)
	if agent == nil {
		return nil, fmt.Errorf("Agent 不存在")
	}
	skill := findSkill(cfg.Base.Skills, skillID)
	if skill == nil {
		return nil, fmt.Errorf("Skill 不存在")
	}
	baseSkillDir := filepath.Join(cfg.Base.Path, skillID)
	if _, err := os.Lstat(baseSkillDir); err != nil {
		return nil, fmt.Errorf("Base skill 目录不存在")
	}
	agentSkillDir := config.GetAgentSkillPath(*agent, skillID)

	config.EnsureAgentDir(*agent)

	var beforeHash *string

	if _, err := os.Lstat(agentSkillDir); err == nil {
		h := scanner.ComputeSkillHash(agentSkillDir)
		if h != "" {
			beforeHash = strPtrAlways(h)
		}
		config.SafeRm(agentSkillDir)
	}

	if err := config.CopyDir(baseSkillDir, agentSkillDir); err != nil {
		return nil, fmt.Errorf("复制 skill 失败: %v", err)
	}

	afterHash := skill.ContentHash

	// Update or create link record
	link := findLink(agent.Links, skillID)
	if link == nil {
		agent.Links = append(agent.Links, models.Link{
			SkillID:        skillID,
			Mode:           "copy",
			LastSyncedHash: afterHash,
			LastSyncedAt:   time.Now().UTC().Format(time.RFC3339),
		})
	} else {
		link.Mode = "copy"
		link.LastSyncedHash = afterHash
		link.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
	}

	entry := models.HistoryEntry{
		ID:         config.GenerateID("hist"),
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
		Action:     "sync",
		SkillID:    skillID,
		SkillName:  skill.Name,
		AgentID:    agentID,
		AgentName:  agent.Name,
		Mode:       "copy",
		BeforeHash: beforeHash,
		AfterHash:  strPtrAlways(afterHash),
	}
	cfg.History = append(cfg.History, entry)

	matrix := ComputeStatusMatrix(*cfg)
	return &models.SyncResult{
		Config:       *cfg,
		StatusMatrix: matrix,
		HistoryEntry: &entry,
	}, nil
}

// UnsyncSkill removes a skill sync from an agent. Base is never affected.
func UnsyncSkill(cfg *models.Config, skillID, agentID string) (*models.SyncResult, error) {
	agent := findAgent(cfg.Agents, agentID)
	if agent == nil {
		return nil, fmt.Errorf("Agent 不存在")
	}
	agentSkillDir := config.GetAgentSkillPath(*agent, skillID)
	var beforeHash *string
	var backupPath *string
	syncMode := "copy"

	if _, err := os.Lstat(agentSkillDir); err == nil {
		h := scanner.ComputeSkillHash(agentSkillDir)
		if h != "" {
			beforeHash = strPtrAlways(h)
		}
		link := findLink(agent.Links, skillID)
		if link != nil {
			syncMode = link.Mode
			bp, _ := config.BackupAgentSkill(agent.ID, skillID, agentSkillDir)
			if bp != "" {
				backupPath = strPtrAlways(bp)
			}
		}
		config.SafeRm(agentSkillDir)
	}

	// Remove link from config
	var newLinks []models.Link
	for _, l := range agent.Links {
		if l.SkillID != skillID {
			newLinks = append(newLinks, l)
		}
	}
	agent.Links = newLinks

	skill := findSkill(cfg.Base.Skills, skillID)
	skillName := skillID
	if skill != nil {
		skillName = skill.Name
	}
	entry := models.HistoryEntry{
		ID:         config.GenerateID("hist"),
		Timestamp:  time.Now().UTC().Format(time.RFC3339),
		Action:     "unsync",
		SkillID:    skillID,
		SkillName:  skillName,
		AgentID:    agentID,
		AgentName:  agent.Name,
		Mode:       syncMode,
		BeforeHash: beforeHash,
		AfterHash:  nil,
		BackupPath: backupPath,
	}
	cfg.History = append(cfg.History, entry)

	matrix := ComputeStatusMatrix(*cfg)
	return &models.SyncResult{
		Config:       *cfg,
		StatusMatrix: matrix,
		HistoryEntry: &entry,
	}, nil
}

// PushChanges overwrites agent-side content with a fresh copy of the Base
// version, refreshing the link record and history.
func PushChanges(cfg *models.Config, skillID, agentID string) (*models.SyncResult, error) {
	return SyncSkill(cfg, skillID, agentID, "copy")
}

// ResolveDrift handles drift resolution: keep, overwrite, or save_as_new.
func ResolveDrift(cfg *models.Config, skillID, agentID, action, newSkillName string) (*models.DriftResult, error) {
	agent := findAgent(cfg.Agents, agentID)
	if agent == nil {
		return nil, fmt.Errorf("Agent 不存在")
	}

	switch action {
	case "keep":
		agentSkillDir := config.GetAgentSkillPath(*agent, skillID)
		currentHash := scanner.ComputeSkillHash(agentSkillDir)
		link := findLink(agent.Links, skillID)
		var oldHash *string
		if link != nil {
			oldHash = strPtrAlways(link.LastSyncedHash)
			link.LastSyncedHash = currentHash
			link.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
		}
		skill := findSkill(cfg.Base.Skills, skillID)
		skillName := skillID
		if skill != nil {
			skillName = skill.Name
		}
		cfg.History = append(cfg.History, models.HistoryEntry{
			ID:         config.GenerateID("hist"),
			Timestamp:  time.Now().UTC().Format(time.RFC3339),
			Action:     "drift_keep",
			SkillID:    skillID,
			SkillName:  skillName,
			AgentID:    agentID,
			AgentName:  agent.Name,
			Mode:       "copy",
			BeforeHash: oldHash,
			AfterHash:  strPtrAlways(currentHash),
		})
		matrix := ComputeStatusMatrix(*cfg)
		return &models.DriftResult{Config: *cfg, StatusMatrix: matrix}, nil

	case "overwrite":
		_, err := PushChanges(cfg, skillID, agentID)
		if err != nil {
			return nil, err
		}
		matrix := ComputeStatusMatrix(*cfg)
		return &models.DriftResult{Config: *cfg, StatusMatrix: matrix}, nil

	case "save_as_new":
		agentSkillDir := config.GetAgentSkillPath(*agent, skillID)
		newID := newSkillName
		if newID == "" {
			newID = skillID + "-variant-" + fmt.Sprintf("%x", time.Now().Unix())
		}
		newSkillDir := filepath.Join(cfg.Base.Path, newID)
		if _, err := os.Lstat(newSkillDir); err == nil {
			return nil, fmt.Errorf("目录 %s 已存在于 Base 中", newID)
		}
		config.CopyDir(agentSkillDir, newSkillDir)
		currentHash := scanner.ComputeSkillHash(agentSkillDir)
		link := findLink(agent.Links, skillID)
		if link != nil {
			link.LastSyncedHash = currentHash
			link.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
		}
		note := fmt.Sprintf("从 %s 的漂移版本另存为新 skill", agent.Name)
		cfg.History = append(cfg.History, models.HistoryEntry{
			ID:        config.GenerateID("hist"),
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Action:    "drift_save_new",
			SkillID:   skillID,
			SkillName: newID,
			AgentID:   agentID,
			AgentName: agent.Name,
			Mode:      "copy",
			Note:      &note,
		})
		matrix := ComputeStatusMatrix(*cfg)
		return &models.DriftResult{Config: *cfg, StatusMatrix: matrix, NewSkillID: newID}, nil
	}

	return nil, fmt.Errorf("未知的漂移处理动作: %s", action)
}

// Rollback reverses a history entry: sync→unsync, unsync→resync, push→restore backup.
func Rollback(cfg *models.Config, historyID string) (*models.ConfigResponse, error) {
	idx := -1
	for i, h := range cfg.History {
		if h.ID == historyID {
			idx = i
			break
		}
	}
	if idx == -1 {
		return nil, fmt.Errorf("历史记录不存在")
	}
	entry := cfg.History[idx]
	agent := findAgent(cfg.Agents, entry.AgentID)

	if entry.Action == "sync" || entry.Action == "push" {
		if entry.BackupPath != nil {
			bp := *entry.BackupPath
			if _, err := os.Lstat(bp); err == nil {
				agentSkillDir := config.GetAgentSkillPath(*agent, entry.SkillID)
				config.RestoreFromBackup(bp, agentSkillDir)
				restoredHash := scanner.ComputeSkillHash(agentSkillDir)
				link := findLink(agent.Links, entry.SkillID)
				if link != nil {
					link.LastSyncedHash = restoredHash
					link.LastSyncedAt = time.Now().UTC().Format(time.RFC3339)
				}
			}
		} else if agent != nil {
			agentSkillDir := config.GetAgentSkillPath(*agent, entry.SkillID)
			if _, err := os.Lstat(agentSkillDir); err == nil {
				config.SafeRm(agentSkillDir)
			}
			var newLinks []models.Link
			for _, l := range agent.Links {
				if l.SkillID != entry.SkillID {
					newLinks = append(newLinks, l)
				}
			}
			agent.Links = newLinks
		}
	} else if entry.Action == "unsync" {
		_, err := SyncSkill(cfg, entry.SkillID, entry.AgentID, entry.Mode)
		if err != nil {
			return nil, fmt.Errorf("回滚失败: %v", err)
		}
	}

	note := fmt.Sprintf("回滚操作: %s", entry.Action)
	cfg.History = append(cfg.History, models.HistoryEntry{
		ID:        config.GenerateID("hist"),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Action:    "rollback",
		SkillID:   entry.SkillID,
		SkillName: entry.SkillName,
		AgentID:   entry.AgentID,
		AgentName: entry.AgentName,
		Mode:      entry.Mode,
		Note:      &note,
	})

	matrix := ComputeStatusMatrix(*cfg)
	return &models.ConfigResponse{Config: *cfg, StatusMatrix: matrix}, nil
}

// GetChanges returns skills that are stale or drifted in any agent.
func GetChanges(cfg models.Config, matrix models.StatusMatrix) []models.ChangeItem {
	var changes []models.ChangeItem
	for _, skill := range cfg.Base.Skills {
		var affected []models.ChangeAffectedAgent
		for _, agent := range cfg.Agents {
			status, ok := matrix[agent.ID][skill.ID]
			if ok && (status == "stale" || status == "drifted") {
				affected = append(affected, models.ChangeAffectedAgent{
					AgentID:   agent.ID,
					AgentName: agent.Name,
					Status:    status,
				})
			}
		}
		if len(affected) > 0 {
			changes = append(changes, models.ChangeItem{Skill: skill, Agents: affected})
		}
	}
	return changes
}

func findAgent(agents []models.Agent, id string) *models.Agent {
	for i := range agents {
		if agents[i].ID == id {
			return &agents[i]
		}
	}
	return nil
}

func findSkill(skills []models.Skill, id string) *models.Skill {
	for i := range skills {
		if skills[i].ID == id {
			return &skills[i]
		}
	}
	return nil
}
