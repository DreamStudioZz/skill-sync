import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Parse YAML frontmatter from markdown content.
 * Simple parser for key: value pairs.
 */
export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { data: {}, content };

  const yaml = match[1];
  const data = {};
  yaml.split(/\r?\n/).forEach(line => {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      data[key] = val;
    }
  });
  return { data, content: content.slice(match[0].length) };
}

/** Recursively collect all file paths in a directory */
function getAllFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFiles(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Compute a content hash for a skill directory.
 * Hashes all files (sorted by relative path) and combines into a single hash.
 */
export function computeSkillHash(skillDir) {
  if (!fs.existsSync(skillDir)) return null;

  const files = getAllFiles(skillDir).sort();
  if (files.length === 0) return null;

  const hashes = [];
  for (const f of files) {
    const relPath = path.relative(skillDir, f).replace(/\\/g, '/');
    const content = fs.readFileSync(f);
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    hashes.push(`${relPath}:${hash}`);
  }

  const combined = hashes.join('\n');
  return 'sha256:' + crypto.createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

/**
 * Scan the Base directory for skills.
 * Each subdirectory containing SKILL.md is a skill.
 */
export function scanBase(basePath) {
  if (!basePath || !fs.existsSync(basePath)) return [];

  const entries = fs.readdirSync(basePath, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(basePath, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { data } = parseFrontmatter(content);
      const hash = computeSkillHash(skillDir);
      const stat = fs.statSync(skillMdPath);

      skills.push({
        id: entry.name,
        name: data.name || entry.name,
        description: data.description || data.summary || '',
        contentHash: hash,
        updatedAt: stat.mtime.toISOString()
      });
    } catch (e) {
      // Skip unreadable skills
      console.error(`Error scanning skill ${entry.name}:`, e.message);
    }
  }

  return skills;
}

/**
 * Get a human-readable relative time string.
 */
export function relativeTime(isoString) {
  if (!isoString) return '未知';
  const date = new Date(isoString);
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return date.toLocaleDateString('zh-CN');
}
