// 小胡笔记 · Windows 客户端启动器
// 用系统自带的 Edge / Chrome 打开「应用窗口」模式：没有地址栏和标签页，
// 独立用户目录，数据与平时上网的浏览器互不干扰。
// 编译：GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-H=windowsgui -s -w"
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

const homeURL = "https://n.139t.cn/"

func exists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// 依次找 Edge、Chrome 的安装位置（64 位与 32 位目录都看）
func findBrowser() string {
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	la := os.Getenv("LOCALAPPDATA")
	candidates := []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(la, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(la, `Google\Chrome\Application\chrome.exe`),
	}
	for _, c := range candidates {
		if exists(c) {
			return c
		}
	}
	return ""
}

func main() {
	// 独立数据目录，笔记存在这里，不污染日常浏览器
	dataDir := filepath.Join(os.Getenv("LOCALAPPDATA"), "IvyNoteApp")

	args := []string{
		"--app=" + homeURL,
		"--user-data-dir=" + dataDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--window-size=1240,840",
	}

	if browser := findBrowser(); browser != "" {
		cmd := exec.Command(browser, args...)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := cmd.Start(); err == nil {
			return // 启动器自己退出，窗口留下
		}
	}

	// 兜底：没有任何 Chromium 浏览器时，用默认浏览器打开网页版
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", homeURL).Start()
}
