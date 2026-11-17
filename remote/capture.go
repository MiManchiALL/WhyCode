//go:build linux

package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unicode/utf8"
)

type captureOptions struct {
	Directory string `json:"directory"`
	MaxBytes  int    `json:"maxBytes"`
	MaxLines  int    `json:"maxLines"`
	Progress  bool   `json:"progress"`
}

type captureResult struct {
	Tail     []byte `json:"tail"`
	Boundary bool   `json:"boundary"`
	Bytes    int64  `json:"bytes"`
	Lines    int64  `json:"lines"`
	Saved    bool   `json:"saved,omitempty"`
	Error    string `json:"error,omitempty"`
}

type commandCapture struct {
	captureOptions
	mu sync.Mutex
	captureResult
	openLine bool
	dir      *os.File
	file     *os.File
	name     string
	err      error
}

func newCapture(opts captureOptions, taskID string) (*commandCapture, error) {
	if opts.MaxBytes <= 0 || opts.MaxBytes > 1024*1024 || opts.MaxLines <= 0 ||
		(opts.Directory != "" && !filepath.IsAbs(opts.Directory)) || !filepath.IsLocal(taskID) || filepath.Base(taskID) != taskID {
		return nil, errors.New("命令日志参数无效")
	}
	return &commandCapture{captureOptions: opts, name: taskID + ".log", captureResult: captureResult{Boundary: true, Tail: []byte{}}}, nil
}

// Retain the directory descriptor until close, so exclusive creation and partial-file cleanup share the same owner.
func (c *commandCapture) openLog() error {
	if c.Directory == "" {
		return errors.New("当前会话没有临时工作目录，无法保存完整命令输出")
	}
	root, err := syscall.Open(c.Directory, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(root)
	if err := syscall.Mkdirat(root, "command-output", 0700); err != nil && err != syscall.EEXIST {
		return err
	}
	dir, err := syscall.Openat(root, "command-output", syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	c.dir = os.NewFile(uintptr(dir), "command-output")
	fd, err := syscall.Openat(dir, c.name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return err
	}
	c.file = os.NewFile(uintptr(fd), c.name)
	_, err = c.file.Write(c.Tail)
	return err
}

func (c *commandCapture) append(data []byte) error {
	c.Bytes += int64(len(data))
	c.Lines += int64(bytes.Count(data, []byte{'\n'}))
	c.openLine = data[len(data)-1] != '\n'
	if c.file == nil && (c.Bytes > int64(c.MaxBytes) || c.Lines > int64(c.MaxLines) || (c.Lines == int64(c.MaxLines) && c.openLine)) {
		c.err = c.openLog()
	}
	if c.err == nil && c.file != nil {
		_, c.err = c.file.Write(data)
	}
	c.Tail = append(c.Tail, data...)
	if start := len(c.Tail) - c.MaxBytes; start > 0 {
		for start < len(c.Tail) && !utf8.RuneStart(c.Tail[start]) {
			start++
		}
		c.Boundary = c.Tail[start-1] == '\n'
		c.Tail = c.Tail[start:]
	}
	return c.err
}

func (c *commandCapture) finish() *captureResult {
	if c.openLine {
		c.Lines++
	}
	if c.file != nil {
		c.err = errors.Join(c.err, c.file.Close())
		if c.err == nil {
			c.Saved = true
		} else {
			c.err = errors.Join(c.err, syscall.Unlinkat(int(c.dir.Fd()), c.name))
		}
	}
	if c.dir != nil {
		c.dir.Close()
	}
	if c.err != nil {
		c.Error = c.err.Error()
	}
	return &c.captureResult
}

// Decode each pipe independently, before merging stdout and stderr. Keep only an incomplete UTF-8 scalar between reads.
func decodeOutput(p []byte, eof bool) (decoded, remaining []byte) {
	if utf8.Valid(p) {
		return p, nil
	}
	for i := 0; i < len(p); {
		if !eof && !utf8.FullRune(p[i:]) {
			return decoded, append([]byte(nil), p[i:]...)
		}
		r, size := utf8.DecodeRune(p[i:])
		if r == utf8.RuneError && size == 1 {
			size = utf8Unit(p[i:])
		}
		decoded = utf8.AppendRune(decoded, r)
		i += size
	}
	return decoded, nil
}

func (s *server) readCaptured(id string, t *task, reader io.Reader) {
	c := t.capture
	buffer := make([]byte, 16*1024)
	var pending []byte
	for {
		n, readErr := reader.Read(buffer)
		data := buffer[:n]
		if len(pending) > 0 {
			data = append(pending, data...)
		}
		data, pending = decodeOutput(data, readErr != nil)
		c.mu.Lock()
		if c.err == nil && len(data) > 0 {
			if c.append(data) == nil && c.Progress {
				for len(data) > 0 {
					count := min(len(data), 16*1024)
					if !s.sendData(id, t, data[:count], "stdout") {
						break
					}
					data = data[count:]
				}
			}
		}
		if readErr != nil && readErr != io.EOF && c.err == nil {
			c.err = readErr
		}
		failed := c.err != nil
		c.mu.Unlock()
		if failed {
			syscall.Kill(-t.cmd.Process.Pid, syscall.SIGKILL)
			return
		}
		if readErr != nil {
			return
		}
	}
}
