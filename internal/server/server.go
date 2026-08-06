// Package server implements the SkillDock HTTP server: server-side rendered
// HTML (via html/template), a small JSON API, and Server-Sent Events for
// real-time updates. No WebView2 / Wails is involved — the user opens the
// app in any browser.
package server

import (
	"embed"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"skilldock/internal/app"
	"skilldock/internal/models"
)

//go:embed templates static
var content embed.FS

// Server wires the application core to HTTP.
type Server struct {
	app  *app.App
	tmpl *template.Template
	hub  *Hub
}

// New builds a Server, parses the embedded templates, and connects the app's
// event emitter to the SSE hub.
func New(a *app.App) (*Server, error) {
	funcMap := template.FuncMap{
		"relTime":         formatRelative,
		"absTime":         formatAbsolute,
		"sliceHash":       sliceHash,
		"join":            strings.Join,
		"colors":          agentColors,
		"historyLabel":    historyLabel,
		"historyRollback": historyRollback,
	}
	tmpl, err := template.New("sd").Funcs(funcMap).ParseFS(content, "templates/*.html")
	if err != nil {
		return nil, err
	}
	s := &Server{app: a, tmpl: tmpl, hub: NewHub()}
	a.SetEmitter(s.hub.Broadcast)
	return s, nil
}

// formatRelative renders an ISO timestamp as a short Chinese relative string.
func formatRelative(iso string) string {
	if iso == "" {
		return "未知"
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	diff := time.Since(t)
	min := int(diff.Minutes())
	if min < 1 {
		return "刚刚"
	}
	if min < 60 {
		return fmt.Sprintf("%d 分钟前", min)
	}
	hr := min / 60
	if hr < 24 {
		return fmt.Sprintf("%d 小时前", hr)
	}
	day := hr / 24
	if day < 7 {
		return fmt.Sprintf("%d 天前", day)
	}
	return t.Format("2006-01-02")
}

// formatAbsolute renders an ISO timestamp as a fixed "2006-01-02 15:04" string,
// used as the absolute companion to the relative label.
func formatAbsolute(iso string) string {
	if iso == "" {
		return ""
	}
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		return iso
	}
	return t.Format("2006-01-02 15:04")
}

// sliceHash returns the last 6 characters of a content hash for display.
func sliceHash(h string) string {
	if h == "" {
		return "------"
	}
	if len(h) >= 6 {
		return h[len(h)-6:]
	}
	return h
}

// agentColors returns the preset palette used by the agent color picker.
func agentColors() []string {
	return []string{"#D97757", "#3E8EED", "#4E9A51", "#A78BFA", "#F59E0B", "#EC4899", "#14B8A6", "#6366F1"}
}

// historyLabel maps a history action to a Chinese label.
func historyLabel(action string) string {
	switch action {
	case "sync":
		return "同步"
	case "unsync":
		return "移除"
	case "push":
		return "推送变更"
	case "drift_keep":
		return "保留漂移"
	case "drift_save_new":
		return "另存为新 skill"
	case "rollback":
		return "回滚"
	default:
		return action
	}
}

// historyRollback reports whether a history action supports rollback.
func historyRollback(action string) bool {
	return action == "sync" || action == "push" || action == "unsync"
}

// Handler returns the HTTP handler with all routes registered.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	staticFS, err := fs.Sub(content, "static")
	if err == nil {
		mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFS))))
	}

	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/partial/", s.handlePartial)
	mux.HandleFunc("/api/config", s.handleGetConfig)
	mux.HandleFunc("/api/base", s.handleSetBase)
	mux.HandleFunc("/api/scan", s.handleScan)
	mux.HandleFunc("/api/browse", s.handleBrowse)
	mux.HandleFunc("/api/agents", s.handleAgents)
	mux.HandleFunc("/api/sync", s.handleSync)
	mux.HandleFunc("/api/sync-batch", s.handleSyncBatch)
	mux.HandleFunc("/api/unsync", s.handleUnsync)
	mux.HandleFunc("/api/push", s.handlePush)
	mux.HandleFunc("/api/drift", s.handleDrift)
	mux.HandleFunc("/api/history", s.handleHistory)
	mux.HandleFunc("/api/rollback", s.handleRollback)
	mux.HandleFunc("/api/changes", s.handleChanges)
	mux.HandleFunc("/api/open", s.handleOpen)
	mux.HandleFunc("/api/events", s.handleEvents)

	return mux
}

// --- View model ---

// AgentSummary counts skill statuses for one agent.
type AgentSummary struct {
	Synced, Stale, Drifted, NotSynced int
}

// SkillRow pairs a skill with its sync status for a given agent.
type SkillRow struct {
	Skill  models.Skill
	Status string
}

// AgentView is an agent enriched with its status summary and per-skill rows.
type AgentView struct {
	models.Agent
	Summary AgentSummary
	Pending int // number of stale/drifted skills (drives "查看变更" button)
	Rows    []SkillRow
}

// DashboardData is the full view model passed to the dashboard template.
type DashboardData struct {
	Config     models.Config
	Matrix     models.StatusMatrix
	Agents     []AgentView
	StaleCount int
	History    []models.HistoryEntry
}

func (s *Server) buildDashboard() DashboardData {
	resp := s.app.GetConfig()
	cfg := resp.Config
	matrix := resp.StatusMatrix

	var agents []AgentView
	stale := 0
	for _, ag := range cfg.Agents {
		sv := AgentView{Agent: ag}
		rowMap := matrix[ag.ID]
		for _, sk := range cfg.Base.Skills {
			st := rowMap[sk.ID]
			if st == "" {
				st = "not_synced"
			}
			sv.Rows = append(sv.Rows, SkillRow{Skill: sk, Status: st})
			if st == "stale" || st == "drifted" {
				sv.Pending++
			}
			switch st {
			case "synced":
				sv.Summary.Synced++
			case "stale":
				sv.Summary.Stale++
				stale++
			case "drifted":
				sv.Summary.Drifted++
				stale++
			default:
				sv.Summary.NotSynced++
			}
		}
		agents = append(agents, sv)
	}

	hist := cfg.History
	start := 0
	if len(hist) > 100 {
		start = len(hist) - 100
	}
	recent := make([]models.HistoryEntry, 0, len(hist)-start)
	for i := len(hist) - 1; i >= start; i-- {
		recent = append(recent, hist[i])
	}

	return DashboardData{Config: cfg, Matrix: matrix, Agents: agents, StaleCount: stale, History: recent}
}

// --- Page / partial rendering ---

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	data := s.buildDashboard()
	s.render(w, "index", data)
}

func (s *Server) handlePartial(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/partial/")
	name = strings.Trim(name, "/")
	if name == "" {
		http.NotFound(w, r)
		return
	}

	switch name {
	case "browse":
		path := r.URL.Query().Get("path")
		res, err := s.app.Browse(path)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		s.render(w, "browse-entries", res)
		return
	case "edit-agent":
		id := r.URL.Query().Get("agentId")
		data := s.buildDashboard()
		agent := findAgent(data.Config.Agents, id)
		if agent == nil {
			http.Error(w, "Agent 不存在", 404)
			return
		}
		s.render(w, "edit-agent", struct {
			DashboardData
			Agent models.Agent
		}{data, *agent})
		return
	case "diff":
		id := r.URL.Query().Get("agentId")
		s.renderDiff(w, id)
		return
	case "drift":
		skillID := r.URL.Query().Get("skillId")
		agentID := r.URL.Query().Get("agentId")
		s.renderDrift(w, skillID, agentID)
		return
	}

	data := s.buildDashboard()
	s.render(w, name, data)
}

func (s *Server) render(w http.ResponseWriter, name string, data interface{}) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := s.tmpl.ExecuteTemplate(w, name, data); err != nil {
		log.Printf("template %s error: %v", name, err)
		http.Error(w, "模板渲染错误: "+err.Error(), 500)
	}
}

func (s *Server) renderDiff(w http.ResponseWriter, agentID string) {
	data := s.buildDashboard()
	agent := findAgent(data.Config.Agents, agentID)
	if agent == nil {
		http.Error(w, "Agent 不存在", 404)
		return
	}
	rowMap := data.Matrix[agentID]
	var rows []SkillRow
	for _, sk := range data.Config.Base.Skills {
		st := rowMap[sk.ID]
		if st == "stale" || st == "drifted" || st == "not_synced" {
			rows = append(rows, SkillRow{Skill: sk, Status: st})
		}
	}
	s.render(w, "diff", struct {
		Agent models.Agent
		Rows  []SkillRow
	}{*agent, rows})
}

func (s *Server) renderDrift(w http.ResponseWriter, skillID, agentID string) {
	data := s.buildDashboard()
	agent := findAgent(data.Config.Agents, agentID)
	var skillName string
	for _, sk := range data.Config.Base.Skills {
		if sk.ID == skillID {
			skillName = sk.Name
			break
		}
	}
	agentName := ""
	if agent != nil {
		agentName = agent.Name
	}
	s.render(w, "drift", struct {
		SkillID   string
		AgentID   string
		SkillName string
		AgentName string
	}{skillID, agentID, skillName, agentName})
}

// --- API helpers ---

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"error": msg})
}

func readJSON(r *http.Request, v interface{}) error {
	dec := json.NewDecoder(r.Body)
	return dec.Decode(v)
}

// --- API handlers ---

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", 405)
		return
	}
	writeJSON(w, s.app.GetConfig())
}

func (s *Server) handleSetBase(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.SetBase(body.Path)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleScan(w http.ResponseWriter, r *http.Request) {
	resp, err := s.app.ScanBase()
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", 405)
		return
	}
	res, err := s.app.Browse(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, res)
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, s.app.GetAgents())
	case http.MethodPost:
		var body struct {
			Name        string `json:"name"`
			Path        string `json:"path"`
			Color       string `json:"color"`
			DefaultMode string `json:"defaultMode"`
		}
		if err := readJSON(r, &body); err != nil {
			writeError(w, "请求格式错误", 400)
			return
		}
		resp, err := s.app.AddAgent(body.Name, body.Path, body.Color, body.DefaultMode)
		if err != nil {
			writeError(w, err.Error(), 400)
			return
		}
		writeJSON(w, resp)
	case http.MethodPut:
		id := r.URL.Query().Get("id")
		var body struct {
			Name        string `json:"name"`
			Path        string `json:"path"`
			Color       string `json:"color"`
			DefaultMode string `json:"defaultMode"`
		}
		if err := readJSON(r, &body); err != nil {
			writeError(w, "请求格式错误", 400)
			return
		}
		resp, err := s.app.UpdateAgent(id, body.Name, body.Path, body.Color, body.DefaultMode)
		if err != nil {
			writeError(w, err.Error(), 400)
			return
		}
		writeJSON(w, resp)
	case http.MethodDelete:
		id := r.URL.Query().Get("id")
		cleanup := r.URL.Query().Get("cleanup") == "true"
		resp, err := s.app.DeleteAgent(id, cleanup)
		if err != nil {
			writeError(w, err.Error(), 400)
			return
		}
		writeJSON(w, resp)
	default:
		writeError(w, "method not allowed", 405)
	}
}

func (s *Server) handleSync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkillID string `json:"skillId"`
		AgentID string `json:"agentId"`
		Mode    string `json:"mode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.SyncSkill(body.SkillID, body.AgentID, body.Mode)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleSyncBatch(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkillIDs []string `json:"skillIds"`
		AgentIDs []string `json:"agentIds"`
		Mode     string   `json:"mode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	writeJSON(w, s.app.SyncBatch(body.SkillIDs, body.AgentIDs, body.Mode))
}

func (s *Server) handleUnsync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkillID string `json:"skillId"`
		AgentID string `json:"agentId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.UnsyncSkill(body.SkillID, body.AgentID)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkillID string `json:"skillId"`
		AgentID string `json:"agentId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.PushChanges(body.SkillID, body.AgentID)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleDrift(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SkillID      string `json:"skillId"`
		AgentID      string `json:"agentId"`
		Action       string `json:"action"`
		NewSkillName string `json:"newSkillName"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.ResolveDrift(body.SkillID, body.AgentID, body.Action, body.NewSkillName)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", 405)
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	writeJSON(w, s.app.GetHistory(limit))
}

func (s *Server) handleRollback(w http.ResponseWriter, r *http.Request) {
	var body struct {
		HistoryID string `json:"historyId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	resp, err := s.app.Rollback(body.HistoryID)
	if err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, resp)
}

func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, "method not allowed", 405)
		return
	}
	writeJSON(w, s.app.GetChanges())
}

func (s *Server) handleOpen(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, "请求格式错误", 400)
		return
	}
	if err := s.app.OpenPath(body.Path); err != nil {
		writeError(w, err.Error(), 400)
		return
	}
	writeJSON(w, map[string]string{"ok": "1"})
}

// --- SSE ---

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	ch := make(chan string, 32)
	s.hub.Add(ch)
	defer s.hub.Remove(ch)

	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case line := <-ch:
			fmt.Fprint(w, line)
			flusher.Flush()
		}
	}
}

// --- Hub ---

// Hub broadcasts SSE messages to all connected clients.
type Hub struct {
	mu      sync.Mutex
	clients map[chan string]struct{}
}

// NewHub creates an empty hub.
func NewHub() *Hub {
	return &Hub{clients: make(map[chan string]struct{})}
}

// Add registers a client channel.
func (h *Hub) Add(c chan string) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

// Remove unregisters a client channel.
func (h *Hub) Remove(c chan string) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

// Broadcast sends an event to every connected client.
func (h *Hub) Broadcast(eventType string, payload interface{}) {
	msg, err := json.Marshal(struct {
		Type string      `json:"type"`
		Data interface{} `json:"data"`
	}{eventType, payload})
	if err != nil {
		return
	}
	line := "data: " + string(msg) + "\n\n"
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c <- line:
		default:
		}
	}
}

// --- misc ---

func findAgent(agents []models.Agent, id string) *models.Agent {
	for i := range agents {
		if agents[i].ID == id {
			return &agents[i]
		}
	}
	return nil
}
