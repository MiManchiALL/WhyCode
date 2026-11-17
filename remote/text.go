//go:build linux

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"syscall"
	"unicode/utf8"
)

// UTF-8 decoders in Node consume the valid prefix of an incomplete scalar as one replacement.
func utf8Unit(p []byte) int {
	r, size := utf8.DecodeRune(p)
	if r != utf8.RuneError || size != 1 || p[0] < 0xc2 || p[0] > 0xf4 {
		return size
	}
	width := 2
	if p[0] >= 0xf0 {
		width = 4
	} else if p[0] >= 0xe0 {
		width = 3
	}
	for size < width && size < len(p) && p[size]&0xc0 == 0x80 {
		if size == 1 && ((p[0] == 0xe0 && p[1] < 0xa0) || (p[0] == 0xed && p[1] > 0x9f) ||
			(p[0] == 0xf0 && p[1] < 0x90) || (p[0] == 0xf4 && p[1] > 0x8f)) {
			break
		}
		size++
	}
	return size
}

func readTextWindow(args []string, out io.Writer) error {
	if len(args) != 5 {
		return errors.New("invalid text range")
	}
	values := make([]int, 4)
	for i, arg := range args[1:] {
		n, err := strconv.Atoi(arg)
		if err != nil || n < 0 {
			return errors.New("invalid text range")
		}
		values[i] = n
	}
	line, column, limit, budget := values[0], values[1], values[2], values[3]
	if line < 1 || column < 1 || budget < 1 || budget > 1024*1024 {
		return errors.New("invalid text range")
	}
	encode := json.NewEncoder(out)
	info, err := os.Stat(args[0])
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return encode.Encode(map[string]string{"unreadable": "not-file"})
	}
	file, err := os.OpenFile(args[0], os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	r := bufio.NewReaderSize(file, 64*1024)
	sample, err := r.Peek(512)
	if err != nil && err != io.EOF {
		return err
	}
	if bytes.IndexByte(sample, 0) >= 0 {
		return encode.Encode(map[string]string{"unreadable": "binary"})
	}
	// Consume CRLF together, including at a reader-buffer boundary.
	consumeLF := func() bool {
		next, _ := r.Peek(1)
		if len(next) == 0 || next[0] != '\n' {
			return false
		}
		r.Discard(1)
		return true
	}
	for current := 1; current <= line; current++ {
		if _, err = r.Peek(1); err != nil {
			if errors.Is(err, io.EOF) {
				return encode.Encode(map[string]int{"lines": current - 1})
			}
			return err
		}
		if current == line {
			break
		}
		for {
			b, err := r.ReadByte()
			if err == io.EOF {
				return encode.Encode(map[string]int{"lines": current})
			}
			if err != nil {
				return err
			}
			if b == '\r' {
				consumeLF()
				break
			}
			if b == '\n' {
				break
			}
		}
	}
	if column > 1 {
		for current := 1; current <= column; current++ {
			p, err := r.Peek(utf8.UTFMax)
			if err != nil && err != io.EOF {
				return err
			}
			if len(p) == 0 || p[0] == '\n' || p[0] == '\r' {
				return encode.Encode(map[string]int{"columns": current - 1})
			}
			if current == column {
				break
			}
			r.Discard(utf8Unit(p))
		}
	}
	var data []byte
	lines := 0
	for len(data) < budget {
		b, err := r.ReadByte()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		data = append(data, b)
		if b != '\n' && b != '\r' {
			continue
		}
		if b == '\r' && consumeLF() {
			data = append(data, '\n')
		}
		lines++
		if lines == limit {
			// One lookahead byte lets the common formatter distinguish EOF from another line.
			next, err := r.Peek(1)
			if err != nil && err != io.EOF {
				return err
			}
			data = append(data, next...)
			break
		}
	}
	if _, err := io.WriteString(out, "text\n"); err != nil {
		return err
	}
	_, err = out.Write(data)
	return err
}
