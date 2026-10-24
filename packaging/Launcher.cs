using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Reflection;

[assembly: AssemblyTitle("映替视频工作台")]
[assembly: AssemblyDescription("映替本地视频工作台启动器")]
[assembly: AssemblyVersion("2.2.9.0")]
[assembly: AssemblyFileVersion("2.2.9.0")]

internal static class Launcher {
    [STAThread]
    private static int Main(string[] args) {
        bool headless = Array.IndexOf(args, "--no-browser") >= 0;
        bool check = Array.IndexOf(args, "--check-running") >= 0;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try {
            if (!headless && !check) {
                string desktop = Path.Combine(root, "desktop", "YingTiDesktop.exe");
                if (!File.Exists(desktop)) throw new FileNotFoundException("应用界面组件缺失，请重新运行安装包。", desktop);
                var desktopStart = new ProcessStartInfo(desktop, Array.IndexOf(args, "--start-minimized") >= 0 ? "--start-minimized" : "");
                desktopStart.WorkingDirectory = root;
                desktopStart.UseShellExecute = false;
                desktopStart.CreateNoWindow = true;
                desktopStart.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(desktopStart);
                return 0;
            }
            string script = Path.Combine(root, "scripts", "start.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("启动文件缺失，请重新安装映替。", script);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(powershell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"" + (headless ? " -NoBrowser" : "") + (check ? " -CheckRunning" : ""));
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            // Background children may inherit pipe handles. The PowerShell launcher
            // writes diagnostics to disk; do not wait for redirected pipes to close.
            start.RedirectStandardOutput = false;
            start.RedirectStandardError = false;
            using (var process = Process.Start(start)) {
                process.WaitForExit();
                if (process.ExitCode != 0 && !(check && process.ExitCode == 10)) {
                    string logRoot = Environment.GetEnvironmentVariable("WAN_EDITOR_DATA_DIR");
                    if (String.IsNullOrWhiteSpace(logRoot)) logRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YingTiStudio", "data");
                    Directory.CreateDirectory(logRoot);
                    string log = Path.Combine(logRoot, "launcher-error.log");
                    if (!File.Exists(log)) File.WriteAllText(log, "Startup failed with exit code " + process.ExitCode, new UTF8Encoding(false));
                    if (!headless && !check) MessageBox.Show("工作台启动失败。\n请先退出仍在运行的旧工作台后再试。\n\n详细日志：" + log, "映替", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return process.ExitCode;
            }
        } catch (Exception error) {
            if (!headless && !check) MessageBox.Show(error.Message, "映替启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
