using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

// Launcher 与真正的应用位于不同目录；启动器退出后窗口才建立，复现桌面应用的启动交接。
class ScreenshotLauncherFixture {
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
    Application.Run(window);
  }
}
