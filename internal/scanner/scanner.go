package scanner

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"skilldock/internal/models"
)

var frontmatterRe = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---`)

// parseFrontmatter extracts YAML frontmatter key: value pairs from markdown.
func parseFrontmatter(content string) (map[string]string, string) {
	match := frontmatterRe.FindStringSubmatch(content)
	if match == nil {
		return map[string]string{}, content
	}
	yaml := match[1]
	data := map[string]string{}
	for _, line := range strings.Split(yaml, "\n") {
		idx := strings.Index(line, ":")
		if idx > 0 {
			key := strings.TrimSpace(line[:idx])
			val := strings.TrimSpace(line[idx+1:])
			// strip surrounding quotes
			val = strings.Trim(val, "\"'")
			data[key] = val
		}
	}
	return data, content[len(match[0]):]
}

// getAllFiles recursively collects all file paths under dir.
func getAllFiles(dir string) []string {
	var results []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return results
	}
	for _, entry := range entries {
		full := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			results = append(results, getAllFiles(full)...)
		} else if entry.Type()&os.ModeSymlink != 0 {
			// follow symlinks — resolve to the actual file
			results = append(results, full)
		} else if !entry.IsDir() {
			results = append(results, full)
		}
	}
	return results
}

// ComputeSkillHash returns a content hash for a skill directory.
// All files (sorted by relative path) are individually hashed and combined.
func ComputeSkillHash(skillDir string) string {
	info, err := os.Lstat(skillDir)
	if err != nil {
		return ""
	}
	// If it's a symlink, resolve it
	realDir := skillDir
	if info.Mode()&os.ModeSymlink != 0 {
		target, err := filepath.EvalSymlinks(skillDir)
		if err == nil {
			realDir = target
		}
	}
	files := getAllFiles(realDir)
	if len(files) == 0 {
		return ""
	}
	sort.Strings(files)
	var hashes []string
	for _, f := range files {
		rel, err := filepath.Rel(realDir, f)
		if err != nil {
			continue
		}
		rel = strings.ReplaceAll(rel, "\\", "/")
		data, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		h := sha256.Sum256(data)
		hashes = append(hashes, fmt.Sprintf("%s:%s", rel, hex.EncodeToString(h[:])))
	}
	combined := strings.Join(hashes, "\n")
	final := sha256.Sum256([]byte(combined))
	return "sha256:" + hex.EncodeToString(final[:])[:12]
}

// ScanBase walks the Base directory and returns all valid skills.
// A valid skill is a subdirectory containing SKILL.md.
func ScanBase(basePath string) []models.Skill {
	if basePath == "" {
		return []models.Skill{}
	}
	expanded := basePath // caller should expand, but handle ~ as safety
	if info, err := os.Stat(expanded); err != nil || !info.IsDir() {
		return []models.Skill{}
	}
	entries, err := os.ReadDir(expanded)
	if err != nil {
		return []models.Skill{}
	}
	var skills []models.Skill
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		skillDir := filepath.Join(expanded, entry.Name())
		skillMdPath := filepath.Join(skillDir, "SKILL.md")
		content, err := os.ReadFile(skillMdPath)
		if err != nil {
			continue
		}
		fm, _ := parseFrontmatter(string(content))
		hash := ComputeSkillHash(skillDir)
		info, err := os.Stat(skillMdPath)
		updatedAt := ""
		if err == nil {
			updatedAt = info.ModTime().UTC().Format(time.RFC3339)
		}
		name := entry.Name()
		if v, ok := fm["name"]; ok && v != "" {
			name = v
		}
		desc := ""
		if v, ok := fm["description"]; ok && v != "" {
			desc = v
		} else if v, ok := fm["summary"]; ok && v != "" {
			desc = v
		}
		skills = append(skills, models.Skill{
			ID:          entry.Name(),
			Name:        name,
			Description: desc,
			ContentHash: hash,
			UpdatedAt:   updatedAt,
		})
	}
	return skills
}

// RelativeTime returns a human-readable relative time string (Chinese).
func RelativeTime(iso string) string {
	if iso == "" {
		return "未知"
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return "未知"
	}
	diff := time.Since(t)
	if diff < 0 {
		diff = -diff
	}
	sec := int(diff.Seconds())
	min := sec / 60
	hr := min / 60
	day := hr / 24
	if sec < 60 {
		return "刚刚"
	}
	if min < 60 {
		return fmt.Sprintf("%d 分钟前", min)
	}
	if hr < 24 {
		return fmt.Sprintf("%d 小时前", hr)
	}
	if day < 7 {
		return fmt.Sprintf("%d 天前", day)
	}
	if day < 30 {
		return fmt.Sprintf("%d 周前", day/7)
	}
	return t.Format("2006-01-02")
}
