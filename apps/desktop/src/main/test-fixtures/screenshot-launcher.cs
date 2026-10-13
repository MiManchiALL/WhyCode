using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

// Launcher 与真正的应用位于不同目录；启动器退出后窗口才建立，复现桌面应用的启动交接。
class ScreenshotLauncherFixture {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr window, out uint color, out byte alpha, out uint flags);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  class CaptureWindow : Form {
    public bool ActivateOnShow;
    protected override bool ShowWithoutActivation { get { return !ActivateOnShow; } }
  }
  [STAThread]
  static void Main() {
    string directory = AppDomain.CurrentDomain.BaseDirectory;
    if (Path.GetFileName(Application.ExecutablePath) == "Launcher.exe") {
      Process.Start(new ProcessStartInfo(Path.Combine(directory, "app", "Fixture.exe")) {
        UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Normal
      });
      return;
    }
    File.WriteAllText(Path.Combine(directory, "started"), "started");
    System.Threading.Thread.Sleep(250);
    Application.EnableVisualStyles();
    Form window = new CaptureWindow {
      Width = 640, Height = 480, BackColor = Color.HotPink, Text = "",
      ActivateOnShow = Path.GetFileName(Application.ExecutablePath) == "ActiveFixture.exe"
    };
    window.Controls.Add(new Label { Text = "Launcher child capture", AutoSize = true });
    Timer title = new Timer { Interval = 300 };
    title.Tick += (sender, args) => { window.Text = "WhyCode Launcher Child"; title.Stop(); };
    window.Shown += (sender, args) => title.Start();
    if (Path.GetFileName(Application.ExecutablePath) == "RestoringFixture.exe") {
      int count = 0;
      Timer restore = new Timer { Interval = 850 };
      restore.Tick += (sender, args) => {
        // 可见窗口的非激活还原不会再次发送 SHOW 或 FOREGROUND；模拟异步初始化的还原。
        ShowWindow(window.Handle, 4);
        window.Controls.Add(new Panel { Width = 100, Height = 100 });
        uint color, flags; byte alpha;
        bool transparent = GetLayeredWindowAttributes(window.Handle, out color, out alpha, out flags) && alpha == 0;
        Point center = window.PointToScreen(new Point(window.ClientSize.Width / 2, window.ClientSize.Height / 2));
        bool intercepts = GetAncestor(WindowFromPoint(center), 2) == window.Handle;
        File.AppendAllText(Path.Combine(directory, "restored"), transparent && !intercepts ? "protected\n" : "intercepts\n");
        if (++count == 2) restore.Stop();
      };
      window.Shown += (sender, args) => restore.Start();
    }
    Application.Run(window);
  }
}
