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

// blockScalarIndicators are the YAML block scalar markers (folded `>` and
// literal `|`, with optional chomping/clip indicators like `>-`, `|+`).
var blockScalarIndicators = map[string]bool{
	">": true, "|": true,
	">-": true, ">+": true,
	"|-": true, "|+": true,
}

// parseFrontmatter extracts YAML frontmatter key: value pairs from markdown.
// It supports plain scalars, quoted scalars, and YAML block scalars
// (`>` folded, `|` literal, with optional chomping indicators).
func parseFrontmatter(content string) (map[string]string, string) {
	match := frontmatterRe.FindStringSubmatch(content)
	if match == nil {
		return map[string]string{}, content
	}
	yaml := match[1]
	data := map[string]string{}
	lines := strings.Split(yaml, "\n")
	for i := 0; i < len(lines); {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			i++
			continue
		}
		idx := strings.Index(line, ":")
		if idx <= 0 {
			i++
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])

		// Block sequence: a key with empty value followed by "- item" lines.
		if val == "" && i+1 < len(lines) {
			nxt := strings.TrimSpace(lines[i+1])
			if strings.HasPrefix(nxt, "- ") {
				keyIndent := len(line) - len(strings.TrimLeft(line, " \t"))
				i++
				var items []string
				for i < len(lines) {
					bl := lines[i]
					if strings.TrimSpace(bl) == "" {
						i++
						continue
					}
					if len(bl)-len(strings.TrimLeft(bl, " \t")) <= keyIndent {
						break
					}
					t := strings.TrimSpace(bl)
					if strings.HasPrefix(t, "- ") {
						items = append(items, strings.TrimSpace(t[2:]))
						i++
						continue
					}
					break // not a list item
				}
				data[key] = strings.Join(items, ", ")
				continue
			}
		}

		// Block scalar: collect following indented lines.
		if blockScalarIndicators[val] {
			keyIndent := len(line) - len(strings.TrimLeft(line, " \t"))
			keepTrailing := strings.Contains(val, "+")
			i++
			var block []string
			for i < len(lines) {
				bl := lines[i]
				if strings.TrimSpace(bl) == "" {
					block = append(block, "") // paragraph break
					i++
					continue
				}
				if len(bl)-len(strings.TrimLeft(bl, " \t")) <= keyIndent {
					break // same-or-less indent => next key
				}
				block = append(block, strings.TrimSpace(bl))
				i++
			}
			// strip trailing blank lines unless chomping is "keep" (+)
			if !keepTrailing {
				for len(block) > 0 && block[len(block)-1] == "" {
					block = block[:len(block)-1]
				}
			}
			if strings.HasPrefix(val, "|") {
				data[key] = strings.Join(block, "\n")
			} else {
				// folded: join consecutive non-empty lines with a space,
				// blank lines become newlines.
				var sb strings.Builder
				for j, b := range block {
					if b == "" {
						if sb.Len() > 0 {
							sb.WriteByte('\n')
						}
						continue
					}
					if j > 0 && block[j-1] != "" {
						sb.WriteByte(' ')
					}
					sb.WriteString(b)
				}
				data[key] = sb.String()
			}
			continue
		}

		// strip surrounding quotes
		val = strings.Trim(val, "\"'")
		data[key] = val
		i++
	}
	return data, content[len(match[0]):]
}

// parseTagList normalizes a tags value (comma string, inline "[a, b]", or an
// already comma-joined YAML block sequence) into a clean, de-duplicated list.
func parseTagList(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "[") && strings.HasSuffix(raw, "]") {
		raw = strings.TrimSpace(raw[1 : len(raw)-1])
	}
	parts := strings.Split(raw, ",")
	var out []string
	seen := map[string]bool{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
	}
	return out
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
			Tags:        parseTagList(fm["tags"]),
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
