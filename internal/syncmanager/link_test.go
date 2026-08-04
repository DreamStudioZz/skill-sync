package syncmanager

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/sys/windows"

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
				DefaultMode: "link",
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

// isReparsePoint reports whether path carries the NTFS reparse point
// attribute (junctions, symlinks, mount points) using GetFileAttributes.
func isReparsePoint(t *testing.T, path string) bool {
	t.Helper()
	pathp, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("UTF16PtrFromString: %v", err)
	}
	attrs, err := windows.GetFileAttributes(pathp)
	if err != nil {
		t.Fatalf("GetFileAttributes(%s): %v", path, err)
	}
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0
}

// TestSyncSkillLinkModeCreatesJunction verifies that link mode creates a real
// directory link (junction on Windows), NOT a copy. This is a regression test
// for the bug where os.Symlink required admin privileges on Windows and the
// sync silently degraded to copy mode.
func TestSyncSkillLinkModeCreatesJunction(t *testing.T) {
	baseDir, agentDir, cleanup := setupTestEnv(t)
	defer cleanup()

	cfg := makeConfig(t, baseDir, agentDir)
	result, err := SyncSkill(&cfg, "demo-skill", "agent-1", "link")
	if err != nil {
		t.Fatalf("SyncSkill failed: %v", err)
	}

	// 1. Must NOT have degraded to copy
	if result.Degraded {
		t.Fatalf("link mode degraded to copy — junction creation failed. actualMode=%s note=%v",
			result.ActualMode, result.HistoryEntry != nil && result.HistoryEntry.Note != nil)
	}
	if result.ActualMode != "link" {
		t.Fatalf("actualMode = %q, want %q", result.ActualMode, "link")
	}

	// 2. The recorded link must be link mode
	agent := findAgent(result.Config.Agents, "agent-1")
	link := findLink(agent.Links, "demo-skill")
	if link == nil {
		t.Fatal("link record missing after sync")
	}
	if link.Mode != "link" {
		t.Fatalf("link.Mode = %q, want %q", link.Mode, "link")
	}

	// 3. The agent skill dir must be a live directory link, NOT a copied
	//    directory. On Windows a junction is not reported as ModeSymlink by
	//    os.Lstat, so we detect it via the FILE_ATTRIBUTE_REPARSE_POINT flag.
	agentSkillDir := config.GetAgentSkillPath(*agent, "demo-skill")
	if runtime.GOOS == "windows" {
		if !isReparsePoint(t, agentSkillDir) {
			t.Fatalf("agent skill dir is NOT a reparse point — it was copied, not linked")
		}
	} else {
		info, err := os.Lstat(agentSkillDir)
		if err != nil {
			t.Fatalf("Lstat agent skill dir failed: %v", err)
		}
		if info.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("agent skill dir is NOT a symlink (mode=%v)", info.Mode())
		}
	}

	// 4. Live link check: editing the base must be visible through the link
	md := "---\nname: Demo Skill\n---\n\n# Changed\n"
	if err := os.WriteFile(filepath.Join(baseDir, "demo-skill", "SKILL.md"), []byte(md), 0644); err != nil {
		t.Fatal(err)
	}
	linked, err := os.ReadFile(filepath.Join(agentSkillDir, "SKILL.md"))
	if err != nil {
		t.Fatalf("read through link failed: %v", err)
	}
	if string(linked) != md {
		t.Fatalf("content through link = %q, want %q — link is not live", string(linked), md)
	}
}
