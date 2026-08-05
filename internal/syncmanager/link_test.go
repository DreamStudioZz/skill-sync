package syncmanager

import (
	"os"
	"path/filepath"
	"testing"

	"skilldock/internal/config"
	"skilldock/internal/models"
	"skilldock/internal/scanner"
)

// setupTestEnv creates a temp base with one skill and a temp agent dir.
func setupTestEnv(t *testing.T) (baseDir, agentDir string, cleanup func()) {
	t.Helper()
	baseDir = t.TempDir()
	agentDir = t.TempDir()

	skillDir := filepath.Join(baseDir, "demo-skill")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	md := `---
name: Demo Skill
description: 测试用
---

# Demo
`
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(md), 0644); err != nil {
		t.Fatal(err)
	}

	return baseDir, agentDir, func() {
		// TempDir cleans up automatically
	}
}

func makeConfig(t *testing.T, baseDir, agentDir string) models.Config {
	t.Helper()
	skills := scanSkills(t, baseDir)
	return models.Config{
		Base: models.Base{
			Path:   baseDir,
			Skills: skills,
		},
		Agents: []models.Agent{
			{
				ID:          "agent-1",
				Name:        "TestAgent",
				DisplayName: "TestAgent",
				Path:        agentDir,
				Color:       "#8B5CF6",
				DefaultMode: "copy",
				Links:       []models.Link{},
			},
		},
		History: []models.HistoryEntry{},
	}
}

// scanSkills uses the scanner to build the skill list for the base dir.
func scanSkills(t *testing.T, baseDir string) []models.Skill {
	t.Helper()
	skills := scanner.ScanBase(baseDir)
	if len(skills) == 0 {
		t.Fatalf("scanner.ScanBase returned no skills for %s", baseDir)
	}
	return skills
}

// TestSyncSkillCopyModeCreatesCopy verifies that sync copies the skill into
// the agent directory (a real, independent directory) rather than linking it.
// This is a regression test for the removal of link (junction/symlink) mode:
// editing the Base must NOT be reflected in the agent copy.
func TestSyncSkillCopyModeCreatesCopy(t *testing.T) {
	baseDir, agentDir, cleanup := setupTestEnv(t)
	defer cleanup()

	cfg := makeConfig(t, baseDir, agentDir)
	result, err := SyncSkill(&cfg, "demo-skill", "agent-1", "copy")
	if err != nil {
		t.Fatalf("SyncSkill failed: %v", err)
	}

	// 1. The recorded link must be copy mode.
	agent := findAgent(result.Config.Agents, "agent-1")
	link := findLink(agent.Links, "demo-skill")
	if link == nil {
		t.Fatal("link record missing after sync")
	}
	if link.Mode != "copy" {
		t.Fatalf("link.Mode = %q, want %q", link.Mode, "copy")
	}

	agentSkillDir := config.GetAgentSkillPath(*agent, "demo-skill")

	// 2. The agent skill dir must be a real directory, NOT a symlink/junction.
	info, err := os.Lstat(agentSkillDir)
	if err != nil {
		t.Fatalf("Lstat agent skill dir failed: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("agent skill dir is a symlink — it should be a copied directory")
	}

	// 3. Independence check: editing the Base must NOT be reflected in the copy.
	md := "---\nname: Demo Skill\n---\n\n# Changed\n"
	if err := os.WriteFile(filepath.Join(baseDir, "demo-skill", "SKILL.md"), []byte(md), 0644); err != nil {
		t.Fatal(err)
	}
	copied, err := os.ReadFile(filepath.Join(agentSkillDir, "SKILL.md"))
	if err != nil {
		t.Fatalf("read copied SKILL.md failed: %v", err)
	}
	if string(copied) == md {
		t.Fatalf("agent copy reflects Base edits — it is linked, not copied")
	}
}
