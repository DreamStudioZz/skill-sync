package models

// Skill represents a skill directory in the Base warehouse.
type Skill struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	ContentHash string `json:"contentHash"`
	UpdatedAt   string `json:"updatedAt"`
}

// Link records the sync state of a skill in an agent directory.
type Link struct {
	SkillID        string `json:"skillId"`
	Mode           string `json:"mode"`
	LastSyncedHash string `json:"lastSyncedHash"`
	LastSyncedAt   string `json:"lastSyncedAt"`
}

// Agent is an AI agent whose skills directory we manage.
type Agent struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Path        string `json:"path"`
	Color       string `json:"color"`
	DefaultMode string `json:"defaultMode"`
	Links       []Link `json:"links"`
}

// HistoryEntry records one sync-related operation for audit/rollback.
type HistoryEntry struct {
	ID         string  `json:"id"`
	Timestamp  string  `json:"timestamp"`
	Action     string  `json:"action"`
	SkillID    string  `json:"skillId"`
	SkillName  string  `json:"skillName"`
	AgentID    string  `json:"agentId"`
	AgentName  string  `json:"agentName"`
	Mode       string  `json:"mode"`
	BeforeHash *string `json:"beforeHash"`
	AfterHash  *string `json:"afterHash"`
	BackupPath *string `json:"backupPath"`
	Note       *string `json:"note"`
}

// Base is the central skill warehouse.
type Base struct {
	Path   string  `json:"path"`
	Skills []Skill `json:"skills"`
}

// Config is the persisted application state.
type Config struct {
	Base    Base           `json:"base"`
	Agents  []Agent        `json:"agents"`
	History []HistoryEntry `json:"history"`
}

// StatusMatrix maps agentID → skillID → status string.
type StatusMatrix map[string]map[string]string

// ConfigResponse is returned to the frontend for most operations.
type ConfigResponse struct {
	Config       Config       `json:"config"`
	StatusMatrix StatusMatrix `json:"statusMatrix"`
}

// SyncResult extends ConfigResponse with the history entry created by the operation.
type SyncResult struct {
	Config       Config        `json:"config"`
	StatusMatrix StatusMatrix  `json:"statusMatrix"`
	HistoryEntry *HistoryEntry `json:"historyEntry"`
}

// DriftResult extends ConfigResponse with optional new skill ID.
type DriftResult struct {
	Config       Config       `json:"config"`
	StatusMatrix StatusMatrix `json:"statusMatrix"`
	NewSkillID   string       `json:"newSkillId"`
}

// BrowseEntry is a directory entry for the path browser.
type BrowseEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
}

// BrowseResult is the response for browsing directories.
type BrowseResult struct {
	Path    string        `json:"path"`
	Parent  string        `json:"parent"`
	Entries []BrowseEntry `json:"entries"`
}

// ChangeItem represents a stale/drifted skill and its affected agents.
type ChangeItem struct {
	Skill  Skill                 `json:"skill"`
	Agents []ChangeAffectedAgent `json:"agents"`
}

// ChangeAffectedAgent records which agent is affected and its status.
type ChangeAffectedAgent struct {
	AgentID   string `json:"agentId"`
	AgentName string `json:"agentName"`
	Status    string `json:"status"`
}

// BatchSyncResult records errors from batch sync.
type BatchSyncResult struct {
	Config       Config           `json:"config"`
	StatusMatrix StatusMatrix     `json:"statusMatrix"`
	Errors       []BatchSyncError `json:"errors"`
}

// BatchSyncError records a failed sync in a batch operation.
type BatchSyncError struct {
	SkillID string `json:"skillId"`
	AgentID string `json:"agentId"`
	Error   string `json:"error"`
}
