//go:build linux

// The helper lives only for its SSH channel. It owns no credentials or project data.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
)

const protocol = 1
const maxTasks = 32

type request struct {
	ID      string `json:"id"`
	Method  string `json:"method"`
	Task    string `json:"task"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	Data    []byte `json:"data"`
	PTY     bool   `json:"pty"`
	Cols    uint16 `json:"cols"`
	Rows    uint16 `json:"rows"`
	End     bool   `json:"end"`
}
type response struct {
	ID      string `json:"id,omitempty"`
	Task    string `json:"task,omitempty"`
	Event   string `json:"event,omitempty"`
	Data    []byte `json:"data,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
	Version int    `json:"version,omitempty"`
}
type task struct {
	cmd          *exec.Cmd
	input        io.WriteCloser
	tty          *os.File
	done         chan struct{}
	mu           sync.Mutex
	writing      atomic.Bool
	outputSlots  chan struct{}
	cancelOutput chan struct{}
	outputOnce   sync.Once
}
type server struct {
	mu       sync.Mutex
	tasks    map[string]*task
	output   chan response
	control  chan response
	closing  chan struct{}
	lastPing atomic.Int64
}

func main() {
	s := &server{tasks: make(map[string]*task), output: make(chan response, 64), control: make(chan response, 64), closing: make(chan struct{})}
	s.lastPing.Store(time.Now().Unix())
	go s.write()
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if time.Now().Unix()-s.lastPing.Load() > 75 {
				s.shutdown()
				os.Exit(1)
			}
		}
	}()
	scan := bufio.NewScanner(os.Stdin)
	scan.Buffer(make([]byte, 4096), 1024*1024)
	for scan.Scan() {
		var r request
		if err := json.Unmarshal(scan.Bytes(), &r); err != nil || r.ID == "" {
			break
		}
		if r.Method == "input" {
			// A full stdin pipe must not block stop or heartbeat messages.
			go s.respond(r)
		} else {
			s.respond(r)
		}
	}
	s.shutdown()
}

func (s *server) respond(r request) {
	result := s.handle(r)
	result.ID = r.ID
	select {
	case s.control <- result:
	case <-s.closing:
	case <-time.After(5 * time.Second):
		s.shutdown()
	}
}

func (s *server) write() {
	encoder := json.NewEncoder(os.Stdout)
	for {
		var message response
		select {
		case message = <-s.control:
		default:
			select {
			case message = <-s.control:
			case message = <-s.output:
			case <-s.closing:
				return
			}
		}
		if encoder.Encode(message) != nil {
			s.shutdown()
			os.Exit(1)
		}
	}
}

func (s *server) handle(r request) response {
	if r.Method == "hello" || r.Method == "ping" {
		s.lastPing.Store(time.Now().Unix())
		return response{Version: protocol}
	}
	if r.Method == "start" {
		return s.start(r)
	}
	s.mu.Lock()
	t := s.tasks[r.Task]
	s.mu.Unlock()
	if t == nil {
		return response{Error: "进程不存在或已结束"}
	}
	var err error
	switch r.Method {
	case "input":
		if !t.writing.CompareAndSwap(false, true) {
			return response{Error: "上一条输入尚未完成"}
		}
		defer t.writing.Store(false)
		t.mu.Lock()
		if r.End {
			err = t.input.Close()
		} else {
			_, err = t.input.Write(r.Data)
		}
		t.mu.Unlock()
	case "resize":
		if t.tty == nil || r.Cols < 1 || r.Rows < 1 {
			err = fmt.Errorf("终端尺寸无效")
		} else {
			err = pty.Setsize(t.tty, &pty.Winsize{Cols: r.Cols, Rows: r.Rows})
		}
	case "stop":
		if !stop(t) {
			err = fmt.Errorf("无法确认进程已停止")
		}
	case "ack":
		select {
		case <-t.outputSlots:
		default:
		}
	default:
		err = fmt.Errorf("未知请求")
	}
	if err != nil {
		return response{Error: err.Error()}
	}
	return response{}
}

func (s *server) start(r request) response {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.closing:
		return response{Error: "连接已关闭"}
	default:
	}
	if r.Task == "" || s.tasks[r.Task] != nil || len(s.tasks) >= maxTasks || r.Cwd == "" || r.Cwd[0] != '/' {
		return response{Error: "进程身份、目录无效或任务数已达上限"}
	}
	cmd := exec.Command("/bin/sh", "-c", r.Command)
	cmd.Dir = r.Cwd
	cmd.Env = append(os.Environ(), "PAGER=cat", "GIT_PAGER=cat")
	t := &task{cmd: cmd, done: make(chan struct{}), outputSlots: make(chan struct{}, 8), cancelOutput: make(chan struct{})}
	var readers []io.ReadCloser
	var writers []*os.File
	var err error
	if r.PTY {
		if r.Cols == 0 {
			r.Cols = 80
		}
		if r.Rows == 0 {
			r.Rows = 24
		}
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
		t.tty, err = pty.StartWithSize(cmd, &pty.Winsize{Cols: r.Cols, Rows: r.Rows})
		t.input = t.tty
		readers = []io.ReadCloser{t.tty}
	} else {
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		t.input, err = cmd.StdinPipe()
		if err == nil {
			var out, writer *os.File
			out, writer, err = os.Pipe()
			if err == nil {
				cmd.Stdout = writer
				readers = append(readers, out)
				writers = append(writers, writer)
			}
		}
		if err == nil {
			var out, writer *os.File
			out, writer, err = os.Pipe()
			if err == nil {
				cmd.Stderr = writer
				readers = append(readers, out)
				writers = append(writers, writer)
			}
		}
		if err == nil {
			err = cmd.Start()
		}
		for _, writer := range writers {
			writer.Close()
		}
	}
	if err != nil {
		if t.input != nil {
			t.input.Close()
		}
		for _, reader := range readers {
			if reader != nil {
				reader.Close()
			}
		}
		return response{Error: err.Error()}
	}
	s.tasks[r.Task] = t
	var outputs sync.WaitGroup
	for _, reader := range readers {
		outputs.Add(1)
		go func(reader io.ReadCloser) { defer outputs.Done(); s.read(r.Task, t, reader) }(reader)
	}
	go func() {
		// Wait on the process first; its descendants must not hold the channel open forever.
		err := cmd.Wait()
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		close(t.done)
		outputs.Wait()
		for _, reader := range readers {
			reader.Close()
		}
		code := 0
		if err != nil {
			code = cmd.ProcessState.ExitCode()
		}
		s.mu.Lock()
		delete(s.tasks, r.Task)
		s.mu.Unlock()
		// Exit shares the data queue so consumers observe all accepted output first.
		select {
		case s.output <- response{Task: r.Task, Event: "exit", Code: &code}:
		case <-s.closing:
		}
	}()
	return response{Task: r.Task}
}

func (s *server) read(id string, t *task, reader io.Reader) {
	buffer := make([]byte, 16*1024)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			// Each consumer grants its own output window; a paused terminal cannot block other tasks.
			select {
			case t.outputSlots <- struct{}{}:
			case <-t.cancelOutput:
				return
			case <-s.closing:
				return
			}
			data := append([]byte(nil), buffer[:n]...)
			select {
			case s.output <- response{Task: id, Event: "data", Data: data}:
			case <-s.closing:
				return
			case <-t.cancelOutput:
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func stop(t *task) bool {
	t.outputOnce.Do(func() { close(t.cancelOutput) })
	select {
	case <-t.done:
		return true
	default:
	}
	syscall.Kill(-t.cmd.Process.Pid, syscall.SIGTERM)
	select {
	case <-t.done:
		return true
	case <-time.After(500 * time.Millisecond):
	}
	syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
	select {
	case <-t.done:
		return true
	case <-time.After(time.Second):
		return false
	}
}

func (s *server) shutdown() {
	s.mu.Lock()
	select {
	case <-s.closing:
		s.mu.Unlock()
		return
	default:
		close(s.closing)
	}
	tasks := make([]*task, 0, len(s.tasks))
	for _, t := range s.tasks {
		tasks = append(tasks, t)
	}
	s.mu.Unlock()
	var wait sync.WaitGroup
	for _, t := range tasks {
		wait.Add(1)
		go func(t *task) { defer wait.Done(); stop(t) }(t)
	}
	wait.Wait()
}
