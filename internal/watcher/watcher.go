package watcher

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"skilldock/internal/models"
	"skilldock/internal/scanner"
)

// Watcher wraps an fsnotify watcher with debounce logic.
type Watcher struct {
	fw       *fsnotify.Watcher
	done     chan struct{}
	basePath string
	onChange func([]models.Skill)
	mu       sync.Mutex
	timer    *time.Timer
}

// Start creates a watcher for the given base path.
// onChange is called (after debounce) with the fresh scan results whenever files change.
func Start(basePath string, onChange func([]models.Skill)) (*Watcher, error) {
	if basePath == "" {
		return nil, nil
	}
	if info, err := os.Stat(basePath); err != nil || !info.IsDir() {
		return nil, nil
	}

	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &Watcher{
		fw:       fw,
		done:     make(chan struct{}),
		basePath: basePath,
		onChange: onChange,
	}

	// Recursively add watch paths
	w.addWatchRecursive(basePath)

	// Start the event loop
	go w.loop()

	return w, nil
}

func (w *Watcher) addWatchRecursive(root string) {
	filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		// Skip dotfiles/dotdirs
		base := filepath.Base(p)
		if strings.HasPrefix(base, ".") && p != root {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			w.fw.Add(p)
		}
		return nil
	})
}

func (w *Watcher) loop() {
	for {
		select {
		case <-w.done:
			return
		case event, ok := <-w.fw.Events:
			if !ok {
				return
			}
			// Skip dotfiles
			if strings.HasPrefix(filepath.Base(event.Name), ".") {
				// But if a directory was created, add it to the watch
				if event.Op&fsnotify.Create != 0 {
					if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
						w.fw.Add(event.Name)
					}
				}
				continue
			}
			w.debounce()
		case err, ok := <-w.fw.Errors:
			if !ok {
				return
			}
			_ = err
		}
	}
}

func (w *Watcher) debounce() {
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.timer != nil {
		w.timer.Stop()
	}
	w.timer = time.AfterFunc(800*time.Millisecond, func() {
		skills := scanner.ScanBase(w.basePath)
		if w.onChange != nil {
			w.onChange(skills)
		}
	})
}

// Stop closes the watcher and stops listening.
func (w *Watcher) Stop() {
	close(w.done)
	if w.fw != nil {
		w.fw.Close()
	}
}
