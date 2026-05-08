using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32;
using QRCoder;

namespace OnlineCLI.Companion;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var companion = new CompanionApplication();
        Application.Run(companion);
    }
}

internal sealed class CompanionApplication : ApplicationContext
{
    private readonly CompanionConfigStore configStore = new();
    private readonly ServerController controller;
    private readonly CompanionHttpServer httpServer;
    private readonly NotifyIcon trayIcon;
    private CompanionForm? form;

    public CompanionApplication()
    {
        var config = configStore.Load();
        controller = new ServerController(configStore, config);
        httpServer = new CompanionHttpServer(controller, configStore);
        httpServer.Start();

        trayIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Online CLI Companion",
            Visible = true,
            ContextMenuStrip = BuildMenu()
        };
        trayIcon.DoubleClick += (_, _) => ShowPanel();

        if (config.AutoStartServer)
        {
            _ = Task.Run(() => controller.StartServerAsync());
        }
    }

    private ContextMenuStrip BuildMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open Panel", null, (_, _) => ShowPanel());
        menu.Items.Add("Start Server", null, async (_, _) => await controller.StartServerAsync());
        menu.Items.Add("Stop Server", null, async (_, _) => await controller.StopServerAsync());
        menu.Items.Add("Restart Server", null, async (_, _) => await controller.RestartServerAsync());
        menu.Items.Add("Configure Tailscale Serve", null, async (_, _) => await controller.ConfigureTailscaleServeAsync());
        menu.Items.Add(new ToolStripSeparator());

        var startup = new ToolStripMenuItem("Run on Startup")
        {
            Checked = controller.GetRunOnStartup()
        };
        startup.Click += async (_, _) =>
        {
            var enabled = !startup.Checked;
            await controller.SetRunOnStartupAsync(enabled);
            startup.Checked = enabled;
        };
        menu.Items.Add(startup);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitThread());
        return menu;
    }

    private void ShowPanel()
    {
        form ??= new CompanionForm(controller, configStore);
        if (form.IsDisposed)
        {
            form = new CompanionForm(controller, configStore);
        }

        form.Show();
        form.WindowState = FormWindowState.Normal;
        form.Activate();
    }

    protected override void ExitThreadCore()
    {
        httpServer.Dispose();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        form?.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class CompanionForm : Form
{
    private readonly ServerController controller;
    private readonly CompanionConfigStore configStore;
    private readonly Label statusLabel = new() { AutoSize = true };
    private readonly Label urlLabel = new() { AutoSize = true };
    private readonly Label tokenLabel = new() { AutoSize = true };
    private readonly PictureBox qrBox = new() { Width = 220, Height = 220, SizeMode = PictureBoxSizeMode.Zoom };
    private readonly CheckBox runOnStartup = new() { Text = "Run on startup", AutoSize = true };
    private readonly CheckBox autoStartServer = new() { Text = "Auto-start server with companion", AutoSize = true };
    private readonly TextBox repoRoot = new() { Width = 460 };
    private readonly TextBox logs = new() { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Width = 600, Height = 160 };

    public CompanionForm(ServerController controller, CompanionConfigStore configStore)
    {
        this.controller = controller;
        this.configStore = configStore;
        Text = "Online CLI Companion";
        Width = 680;
        Height = 700;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(18),
            RowCount = 10,
            ColumnCount = 2,
            AutoSize = true
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 45));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 55));
        Controls.Add(layout);

        layout.Controls.Add(HeaderLabel("Online CLI Companion"), 0, 0);
        layout.SetColumnSpan(layout.GetControlFromPosition(0, 0), 2);

        layout.Controls.Add(statusLabel, 0, 1);
        layout.SetColumnSpan(statusLabel, 2);
        layout.Controls.Add(qrBox, 0, 2);

        var details = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, Dock = DockStyle.Fill, AutoSize = true };
        details.Controls.Add(urlLabel);
        details.Controls.Add(tokenLabel);
        details.Controls.Add(Button("Copy Pairing", (_, _) => Clipboard.SetText(controller.GetPairingPayload())));
        details.Controls.Add(Button("Configure Tailscale Serve", async (_, _) => await controller.ConfigureTailscaleServeAsync()));
        layout.Controls.Add(details, 1, 2);

        layout.Controls.Add(new Label { Text = "Repository root", AutoSize = true }, 0, 3);
        layout.Controls.Add(repoRoot, 1, 3);
        layout.Controls.Add(Button("Save Root", (_, _) =>
        {
            var config = configStore.Load();
            config.RepoRoot = repoRoot.Text.Trim();
            configStore.Save(config);
            controller.ReloadConfig();
            RefreshStatus();
        }), 1, 4);

        var buttons = new FlowLayoutPanel { AutoSize = true };
        buttons.Controls.Add(Button("Start", async (_, _) => await RunAndRefresh(controller.StartServerAsync)));
        buttons.Controls.Add(Button("Stop", async (_, _) => await RunAndRefresh(controller.StopServerAsync)));
        buttons.Controls.Add(Button("Restart", async (_, _) => await RunAndRefresh(controller.RestartServerAsync)));
        buttons.Controls.Add(Button("Refresh", (_, _) => RefreshStatus()));
        layout.Controls.Add(buttons, 0, 5);
        layout.SetColumnSpan(buttons, 2);

        runOnStartup.CheckedChanged += async (_, _) => await controller.SetRunOnStartupAsync(runOnStartup.Checked);
        autoStartServer.CheckedChanged += (_, _) =>
        {
            var config = configStore.Load();
            config.AutoStartServer = autoStartServer.Checked;
            configStore.Save(config);
            controller.ReloadConfig();
        };
        layout.Controls.Add(runOnStartup, 0, 6);
        layout.Controls.Add(autoStartServer, 1, 6);

        layout.Controls.Add(new Label { Text = "Logs", AutoSize = true }, 0, 7);
        layout.SetColumnSpan(layout.GetControlFromPosition(0, 7), 2);
        layout.Controls.Add(logs, 0, 8);
        layout.SetColumnSpan(logs, 2);

        Shown += (_, _) => RefreshStatus();
    }

    private static Label HeaderLabel(string text) => new()
    {
        Text = text,
        Font = new Font(SystemFonts.CaptionFont.FontFamily, 18, FontStyle.Bold),
        AutoSize = true,
        Padding = new Padding(0, 0, 0, 12)
    };

    private static Button Button(string text, EventHandler handler)
    {
        var button = new Button { Text = text, AutoSize = true, Padding = new Padding(10, 5, 10, 5) };
        button.Click += handler;
        return button;
    }

    private async Task RunAndRefresh(Func<Task<CompanionActionResponse>> action)
    {
        statusLabel.Text = "Working...";
        await action();
        RefreshStatus();
    }

    private void RefreshStatus()
    {
        var status = controller.GetStatus("panel-refresh");
        var config = configStore.Load();
        repoRoot.Text = config.RepoRoot;
        runOnStartup.Checked = status.RunOnStartup;
        autoStartServer.Checked = status.AutoStartServer;
        statusLabel.Text = $"Server: {(status.ServerRunning ? "Running" : "Stopped")}    Remote: {(status.RemoteAgentRunning ? "Ready" : "Stopped")}";
        urlLabel.Text = $"URL: {status.AppUrl ?? "unknown"}";
        tokenLabel.Text = $"Token: {config.Token}";
        qrBox.Image?.Dispose();
        qrBox.Image = GenerateQr(controller.GetPairingPayload());
        logs.Text = controller.ReadLogs(80);
    }

    private static Bitmap GenerateQr(string value)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(value, QRCodeGenerator.ECCLevel.Q);
        using var qr = new QRCode(data);
        return qr.GetGraphic(8, Color.Black, Color.White, true);
    }
}

internal sealed class CompanionHttpServer : IDisposable
{
    private readonly HttpListener listener = new();
    private readonly ServerController controller;
    private readonly CompanionConfigStore configStore;
    private readonly CancellationTokenSource cts = new();

    public CompanionHttpServer(ServerController controller, CompanionConfigStore configStore)
    {
        this.controller = controller;
        this.configStore = configStore;
        listener.Prefixes.Add($"http://127.0.0.1:{configStore.Load().LauncherPort}/");
    }

    public void Start()
    {
        listener.Start();
        _ = Task.Run(ListenAsync);
    }

    private async Task ListenAsync()
    {
        while (!cts.IsCancellationRequested)
        {
            try
            {
                var context = await listener.GetContextAsync();
                _ = Task.Run(() => HandleAsync(context));
            }
            catch when (cts.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                await Task.Delay(250);
            }
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        try
        {
            var path = NormalizePath(context.Request.Url?.AbsolutePath ?? "/");
            if (context.Request.HttpMethod == "OPTIONS")
            {
                WriteCors(context.Response);
                context.Response.StatusCode = 204;
                context.Response.Close();
                return;
            }

            object payload = path switch
            {
                "/api/health" => new { ok = true, service = "online-cli-companion", time = DateTimeOffset.UtcNow },
                "/api/status" => controller.GetStatus("api-status"),
                "/api/server/start" => await RequirePost(context, controller.StartServerAsync),
                "/api/server/stop" => await RequirePost(context, controller.StopServerAsync),
                "/api/server/restart" => await RequirePost(context, controller.RestartServerAsync),
                "/api/startup" => await SetStartupAsync(context),
                "/api/tailscale/serve" => await RequirePost(context, controller.ConfigureTailscaleServeAsync),
                "/api/logs" => new { ok = true, text = controller.ReadLogs(160) },
                "/api/pairing" => new { ok = true, payload = controller.GetPairingPayload() },
                _ => throw new HttpException(404, "Not found")
            };

            await WriteJsonAsync(context.Response, payload);
        }
        catch (HttpException error)
        {
            context.Response.StatusCode = error.StatusCode;
            await WriteJsonAsync(context.Response, new { ok = false, error = error.Message });
        }
        catch (Exception error)
        {
            context.Response.StatusCode = 500;
            await WriteJsonAsync(context.Response, new { ok = false, error = error.Message });
        }
    }

    private async Task<object> RequirePost(HttpListenerContext context, Func<Task<CompanionActionResponse>> action)
    {
        if (context.Request.HttpMethod != "POST")
        {
            throw new HttpException(405, "Method not allowed");
        }
        RequireAuth(context);
        return await action();
    }

    private async Task<object> SetStartupAsync(HttpListenerContext context)
    {
        if (context.Request.HttpMethod != "POST")
        {
            throw new HttpException(405, "Method not allowed");
        }
        RequireAuth(context);

        using var reader = new StreamReader(context.Request.InputStream, context.Request.ContentEncoding);
        var body = await reader.ReadToEndAsync();
        var request = JsonSerializer.Deserialize<StartupRequest>(body, JsonOptions.Default) ?? new StartupRequest(false);
        return await controller.SetRunOnStartupAsync(request.Enabled);
    }

    private void RequireAuth(HttpListenerContext context)
    {
        var token = configStore.Load().Token;
        var supplied = context.Request.Headers["Authorization"] ?? "";
        if (supplied.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            supplied = supplied["Bearer ".Length..].Trim();
        }

        if (!string.IsNullOrWhiteSpace(token) && SecureEquals(supplied, token))
        {
            return;
        }

        throw new HttpException(401, "Unauthorized");
    }

    private static bool SecureEquals(string left, string right)
    {
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static string NormalizePath(string path)
    {
        if (path.StartsWith("/companion", StringComparison.OrdinalIgnoreCase))
        {
            path = path["/companion".Length..];
        }
        return string.IsNullOrWhiteSpace(path) ? "/" : path;
    }

    private static async Task WriteJsonAsync(HttpListenerResponse response, object payload)
    {
        WriteCors(response);
        response.ContentType = "application/json; charset=utf-8";
        var data = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions.Default);
        response.ContentLength64 = data.Length;
        await response.OutputStream.WriteAsync(data);
        response.Close();
    }

    private static void WriteCors(HttpListenerResponse response)
    {
        response.Headers["Access-Control-Allow-Origin"] = "*";
        response.Headers["Access-Control-Allow-Headers"] = "authorization, content-type";
        response.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    }

    public void Dispose()
    {
        cts.Cancel();
        if (listener.IsListening)
        {
            listener.Stop();
        }
        listener.Close();
        cts.Dispose();
    }
}

internal sealed class ServerController
{
    private readonly CompanionConfigStore configStore;
    private CompanionConfig config;

    public ServerController(CompanionConfigStore configStore, CompanionConfig config)
    {
        this.configStore = configStore;
        this.config = config;
    }

    public void ReloadConfig()
    {
        config = configStore.Load();
    }

    public CompanionStatus GetStatus(string? message = null)
    {
        RefreshTailscaleInfo();
        return new CompanionStatus(
            true,
            "0.1.0",
            IsPortOpen(config.ServerPort),
            IsPortOpen(config.RemotePort),
            GetRunOnStartup(),
            config.AutoStartServer,
            CurrentAppUrl(),
            config.TailnetUrl,
            config.RepoRoot,
            config.ServerPort,
            config.RemotePort,
            config.LauncherPort,
            message
        );
    }

    public async Task<CompanionActionResponse> StartServerAsync()
    {
        ReloadConfig();
        if (IsPortOpen(config.ServerPort))
        {
            return Response("Server already running");
        }

        Directory.CreateDirectory(config.LogDirectory);
        var stdout = Path.Combine(config.LogDirectory, "server.out");
        var stderr = Path.Combine(config.LogDirectory, "server.err");
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/d /s /c npm start >> \"{stdout}\" 2>> \"{stderr}\"",
            WorkingDirectory = config.RepoRoot,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        Process.Start(startInfo);
        await Task.Delay(1_200);
        return Response("Server start requested");
    }

    public async Task<CompanionActionResponse> StopServerAsync()
    {
        ReloadConfig();
        await StopPortsAsync(config.ServerPort, config.RemotePort);
        await Task.Delay(600);
        return Response("Server stopped");
    }

    public async Task<CompanionActionResponse> RestartServerAsync()
    {
        await StopServerAsync();
        await Task.Delay(600);
        return await StartServerAsync();
    }

    public async Task<CompanionActionResponse> ConfigureTailscaleServeAsync()
    {
        RefreshTailscaleInfo();
        await RunProcessAsync("tailscale", ["serve", "--yes", "--bg", config.ServerPort.ToString()], config.RepoRoot, 15_000);
        await RunProcessAsync(
            "tailscale",
            ["serve", "--yes", "--bg", "--set-path=/companion", $"http://127.0.0.1:{config.LauncherPort}"],
            config.RepoRoot,
            15_000
        );
        return Response("Tailscale Serve configured");
    }

    public async Task<CompanionActionResponse> SetRunOnStartupAsync(bool enabled)
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: true);
        if (enabled)
        {
            var path = Environment.ProcessPath ?? Application.ExecutablePath;
            key?.SetValue("OnlineCLI Companion", $"\"{path}\"");
        }
        else
        {
            key?.DeleteValue("OnlineCLI Companion", throwOnMissingValue: false);
        }

        await Task.CompletedTask;
        return Response(enabled ? "Run on startup enabled" : "Run on startup disabled");
    }

    public bool GetRunOnStartup()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", writable: false);
        return key?.GetValue("OnlineCLI Companion") is string value && value.Length > 0;
    }

    public string GetPairingPayload()
    {
        RefreshTailscaleInfo();
        var url = Uri.EscapeDataString(CurrentAppUrl() ?? "");
        var token = Uri.EscapeDataString(config.Token);
        return $"onlinecli://pair?url={url}&token={token}";
    }

    public string ReadLogs(int lines)
    {
        var stdout = Tail(Path.Combine(config.LogDirectory, "server.out"), lines);
        var stderr = Tail(Path.Combine(config.LogDirectory, "server.err"), Math.Max(20, lines / 2));
        return string.Join(Environment.NewLine, new[] { stdout, stderr }.Where(value => !string.IsNullOrWhiteSpace(value)));
    }

    private CompanionActionResponse Response(string message)
    {
        return new CompanionActionResponse(true, message, GetStatus(message));
    }

    private string? CurrentAppUrl()
    {
        if (!string.IsNullOrWhiteSpace(config.TailnetUrl))
        {
            return config.TailnetUrl.TrimEnd('/');
        }
        return null;
    }

    private void RefreshTailscaleInfo()
    {
        var result = RunProcess("tailscale", ["status", "--json"], config.RepoRoot, 8_000);
        if (result.ExitCode != 0 || string.IsNullOrWhiteSpace(result.Stdout))
        {
            return;
        }

        try
        {
            using var doc = JsonDocument.Parse(result.Stdout);
            if (!doc.RootElement.TryGetProperty("Self", out var self))
            {
                return;
            }

            if (self.TryGetProperty("DNSName", out var dnsNameElement))
            {
                var dnsName = dnsNameElement.GetString()?.Trim().TrimEnd('.');
                if (!string.IsNullOrWhiteSpace(dnsName))
                {
                    config.TailnetUrl = $"https://{dnsName}";
                    configStore.Save(config);
                }
            }
        }
        catch
        {
            // Tailscale status shape changed or is temporarily unavailable.
        }
    }

    private static async Task StopPortsAsync(params int[] ports)
    {
        var portList = string.Join(",", ports);
        var command = "$ports = @(" + portList + "); "
            + "$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | "
            + "Where-Object { $ports -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique; "
            + "foreach ($processId in $pids) { if ($processId -and $processId -ne $PID) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } }";
        await RunProcessAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], null, 20_000);
    }

    private static bool IsPortOpen(int port)
    {
        try
        {
            using var client = new TcpClient();
            var task = client.ConnectAsync(IPAddress.Loopback, port);
            return task.Wait(250) && client.Connected;
        }
        catch
        {
            return false;
        }
    }

    private static string Tail(string path, int lines)
    {
        if (!File.Exists(path))
        {
            return "";
        }
        return string.Join(Environment.NewLine, File.ReadLines(path).TakeLast(lines));
    }

    private static async Task<ProcessResult> RunProcessAsync(string fileName, IReadOnlyList<string> args, string? cwd, int timeoutMs)
    {
        return await Task.Run(() => RunProcess(fileName, args, cwd, timeoutMs));
    }

    private static ProcessResult RunProcess(string fileName, IReadOnlyList<string> args, string? cwd, int timeoutMs)
    {
        using var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = fileName,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = string.IsNullOrWhiteSpace(cwd) ? Environment.CurrentDirectory : cwd
        };
        foreach (var arg in args)
        {
            process.StartInfo.ArgumentList.Add(arg);
        }

        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        var exited = process.WaitForExit(timeoutMs);
        if (!exited)
        {
            try { process.Kill(entireProcessTree: true); } catch { }
            try { process.WaitForExit(2_000); } catch { }
        }

        var exitCode = exited
            ? process.ExitCode
            : -1;
        return new ProcessResult(exitCode, stdoutTask.Result, stderrTask.Result);
    }
}

internal sealed class CompanionConfigStore
{
    private readonly string configDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "OnlineCLICompanion"
    );

    private string ConfigPath => Path.Combine(configDirectory, "config.json");

    public CompanionConfig Load()
    {
        Directory.CreateDirectory(configDirectory);
        if (File.Exists(ConfigPath))
        {
            try
            {
                var loaded = JsonSerializer.Deserialize<CompanionConfig>(File.ReadAllText(ConfigPath), JsonOptions.Default);
                if (loaded is not null)
                {
                    loaded.EnsureDefaults(configDirectory);
                    Save(loaded);
                    return loaded;
                }
            }
            catch
            {
                // Fall through to a fresh config.
            }
        }

        var config = new CompanionConfig();
        config.EnsureDefaults(configDirectory);
        Save(config);
        return config;
    }

    public void Save(CompanionConfig config)
    {
        Directory.CreateDirectory(configDirectory);
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(config, JsonOptions.Default));
    }
}

internal sealed class CompanionConfig
{
    public string RepoRoot { get; set; } = "";
    public string Token { get; set; } = "";
    public string TailnetUrl { get; set; } = "";
    public int ServerPort { get; set; } = 3000;
    public int RemotePort { get; set; } = 3390;
    public int LauncherPort { get; set; } = 3778;
    public bool AutoStartServer { get; set; } = true;
    public string LogDirectory { get; set; } = "";

    public void EnsureDefaults(string configDirectory)
    {
        if (string.IsNullOrWhiteSpace(RepoRoot) || !File.Exists(Path.Combine(RepoRoot, "package.json")))
        {
            RepoRoot = FindRepoRoot() ?? Environment.CurrentDirectory;
        }
        if (string.IsNullOrWhiteSpace(Token))
        {
            Token = GenerateToken();
        }
        if (string.IsNullOrWhiteSpace(LogDirectory))
        {
            LogDirectory = Path.Combine(configDirectory, "logs");
        }
    }

    private static string? FindRepoRoot()
    {
        var current = new DirectoryInfo(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "package.json")) && File.Exists(Path.Combine(current.FullName, "server.js")))
            {
                return current.FullName;
            }
            current = current.Parent;
        }
        return null;
    }

    private static string GenerateToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }
}

internal sealed record CompanionStatus(
    bool Ok,
    string CompanionVersion,
    bool ServerRunning,
    bool RemoteAgentRunning,
    bool RunOnStartup,
    bool AutoStartServer,
    string? AppUrl,
    string? TailnetUrl,
    string RepoRoot,
    int ServerPort,
    int RemotePort,
    int LauncherPort,
    string? Message
);

internal sealed record CompanionActionResponse(bool Ok, string Message, CompanionStatus Status);
internal sealed record StartupRequest(bool Enabled);
internal sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);

internal sealed class HttpException(int statusCode, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

internal static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}
