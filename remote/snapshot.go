//go:build linux

package main

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"syscall"
)

// The host creates and owns the empty destination and rolls it back on failure.
func copyScratch(source, destination string) error {
	src, err := os.OpenRoot(source)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenRoot(destination)
	if err != nil {
		return err
	}
	defer dst.Close()
	return fs.WalkDir(src.FS(), ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == "." {
			return err
		}
		if entry.IsDir() {
			return dst.Mkdir(path, 0700)
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("目录快照只支持普通文件和目录：%s", path)
		}
		return copyScratchFile(src, dst, path)
	})
}

func copyScratchFile(src, dst *os.Root, path string) error {
	in, err := src.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("目录快照只支持普通文件：%s", path)
	}
	out, err := dst.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err == nil {
		err = out.Chmod(info.Mode().Perm())
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}
