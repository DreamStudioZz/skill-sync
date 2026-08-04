// Three themes matching the PRD design spec

export const THEMES = {
  mint: {
    label: "薄荷极客",
    bg: "#F3FBF7",
    surface: "#FFFFFF",
    surfaceAlt: "#EAF7F0",
    border: "#CDEBDD",
    text: "#16241F",
    textMuted: "#5B7A6E",
    primary: "#0FA37F",
    primarySoft: "#DCF4EA",
    accent: "#FF6B5E",
    accentSoft: "#FFE3DF",
    warn: "#E3A008",
    warnSoft: "#FBEBC8",
    danger: "#E14B4B",
    dangerSoft: "#FBDCDC",
  },
  neon: {
    label: "深空霓虹",
    bg: "#12101C",
    surface: "#1B1830",
    surfaceAlt: "#221E3B",
    border: "#332C55",
    text: "#EDEAFB",
    textMuted: "#9B93C4",
    primary: "#8B5CF6",
    primarySoft: "#2C2450",
    accent: "#C6FF3D",
    accentSoft: "#2A3512",
    warn: "#FFD166",
    warnSoft: "#3A2E10",
    danger: "#FF6B8B",
    dangerSoft: "#3A1A2A",
  },
  cargo: {
    label: "复古货运",
    bg: "#FBF3E4",
    surface: "#FFFDF8",
    surfaceAlt: "#F3E6CC",
    border: "#E6D2A8",
    text: "#2B2118",
    textMuted: "#8A7554",
    primary: "#D9622B",
    primarySoft: "#F6DBC7",
    accent: "#274472",
    accentSoft: "#DEE6EF",
    warn: "#B9862B",
    warnSoft: "#F1E1B8",
    danger: "#B3392C",
    dangerSoft: "#F2D8D2",
  },
};

export const AGENT_PRESETS = [
  { name: "Claude Code", path: "~/.claude/skills", color: "#D97757", defaultMode: "link" },
  { name: "Codex CLI", path: "~/.agents/skills", color: "#3E8EED", defaultMode: "copy" },
  { name: "Gemini CLI", path: "~/.gemini/skills", color: "#4E9A51", defaultMode: "link" },
  { name: "Cursor", path: "~/.cursor/skills", color: "#A78BFA", defaultMode: "link" },
];

export const STATUS_META = {
  synced: { label: "已同步", icon: "CheckCircle2" },
  stale: { label: "待更新", icon: "Bell" },
  drifted: { label: "漂移", icon: "AlertTriangle" },
  not_synced: { label: "未同步", icon: "XCircle" },
};
