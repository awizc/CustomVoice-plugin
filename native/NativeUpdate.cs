using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

internal static class NativeUpdate
{
    internal const string CurrentVersion = "1.1.14";
    static string Plugins => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BetterDiscord", "plugins");
    static string Root => Path.Combine(Path.GetDirectoryName(Plugins)!, "data", "CustomVoice", "native-updates");
    static string StateFile => Path.Combine(Root, "status.json");
    internal sealed record State(string state, string? version = null, int pid = 0, long startTicks = 0, string? message = null);
    internal sealed record Metadata(int schema, string nativeVersion, string packageVersion, string file, string sha256);
    sealed record Release(Metadata Meta, Uri Url);
    static Version VersionOf(string? value) => value != null && Regex.IsMatch(value, @"^\d+\.\d+\.\d+$") && Version.TryParse(value, out var parsed) ? parsed : throw new InvalidDataException("업데이트 버전 정보가 올바르지 않습니다.");
    static string InstalledVersion()
    {
        string file = Path.Combine(Plugins, "CustomVoice.native", "native-version.json");
        if (!File.Exists(file)) return "0.0.0";
        using var document = JsonDocument.Parse(File.ReadAllText(file));
        string version = document.RootElement.GetProperty("version").GetString()!;
        _ = VersionOf(version); return version;
    }
    static bool Alive(State state)
    {
        try { using var process = Process.GetProcessById(state.pid); return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == state.startTicks; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (System.ComponentModel.Win32Exception) { return false; }
    }
    internal static State Status()
    {
        if (!File.Exists(StateFile)) return new("idle");
        try
        {
            // Readers must allow the writer's atomic replacement on Windows.
            using var input = new FileStream(StateFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            State state = JsonSerializer.Deserialize<State>(input) ?? throw new JsonException("상태 정보가 비어 있습니다.");
            if (state.state is not ("idle" or "downloading" or "waiting" or "applying" or "failed" or "installed" or "current") || state.version != null && (!Regex.IsMatch(state.version, @"^\d+\.\d+\.\d+$") || !Version.TryParse(state.version, out _))) throw new JsonException("알 수 없는 업데이트 상태입니다.");
            if (state.state is "downloading" or "waiting" or "applying" && !Alive(state))
                return state with { state = "failed", message = "이전 업데이트가 중단되었습니다. 새 버전 확인 후 다시 시도해 주세요." };
            return state;
        }
        catch (Exception error) when (error is JsonException or IOException or UnauthorizedAccessException)
        { return new("failed", message: "업데이트 상태 파일을 읽지 못했습니다. 새 버전 확인 후 다시 업데이트하면 상태를 새로 기록합니다."); }
    }
    static void Save(State state)
    {
        Directory.CreateDirectory(Root);
        string temporary = StateFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllText(temporary, JsonSerializer.Serialize(state)); File.Move(temporary, StateFile, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    static State Owned(string state, string? version, string? message = null)
    {
        using var process = Process.GetCurrentProcess();
        return new(state, version, process.Id, process.StartTime.ToUniversalTime().Ticks, message);
    }
    static FileStream Lock()
    {
        Directory.CreateDirectory(Root);
        return new FileStream(Path.Combine(Root, "operation.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    }
    internal static Metadata ParseMetadata(byte[] bytes)
    {
        var meta = JsonSerializer.Deserialize<Metadata>(bytes) ?? throw new InvalidDataException("native 업데이트 정보가 없습니다.");
        _ = VersionOf(meta.nativeVersion); _ = VersionOf(meta.packageVersion);
        if (meta.schema != 1 || meta.file != $"CustomVoice-{meta.packageVersion}-windows-x64.zip" || meta.sha256 == null || !Regex.IsMatch(meta.sha256, "^[a-fA-F0-9]{64}$"))
            throw new InvalidDataException("native 업데이트 정보가 올바르지 않습니다.");
        return meta;
    }
    static async Task<Release> Latest(HttpClient http, CancellationToken cancellation)
    {
        using var memory = new MemoryStream();
        await GithubUpdate.Download(http, new Uri($"https://github.com/{GithubUpdate.Repository}/releases/latest/download/CustomVoice-native.json"), memory, 16384, cancellation);
        var meta = ParseMetadata(memory.ToArray());
        return new(meta, new Uri($"https://github.com/{GithubUpdate.Repository}/releases/download/v{meta.packageVersion}/{meta.file}"));
    }
    internal static async Task Check()
    {
        using var http = GithubUpdate.Client(); using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        var release = await Latest(http, cancellation.Token);
        string installed = InstalledVersion();
        Program.Send(new { installedVersion = installed, latestVersion = release.Meta.nativeVersion,
            available = VersionOf(release.Meta.nativeVersion) > VersionOf(installed), pending = Status(),
            releaseUrl = $"https://github.com/{GithubUpdate.Repository}/releases/tag/v{release.Meta.packageVersion}" });
    }
    static string Within(string directory, string relative)
    {
        string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string file = Path.GetFullPath(Path.Combine(root, relative));
        if (Path.IsPathRooted(relative) || relative.Contains(':') || !file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("배포 ZIP 경로가 올바르지 않습니다.");
        return file;
    }
    static void Extract(string zip, string target)
    {
        using var archive = ZipFile.OpenRead(zip); long total = 0;
        if (archive.Entries.Count > 1024) throw new InvalidDataException("배포 ZIP에 파일이 너무 많습니다.");
        foreach (var entry in archive.Entries)
        {
            total = checked(total + entry.Length);
            if (total > 512L * 1024 * 1024 || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new InvalidDataException("지원하지 않는 배포 ZIP입니다.");
            string file = Within(target, entry.FullName);
            if (entry.FullName.EndsWith('/')) { Directory.CreateDirectory(file); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(file)!); entry.ExtractToFile(file, false);
        }
    }
    static void Validate(string payload, string version)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(payload, "manifest.json")));
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in document.RootElement.EnumerateArray())
        {
            string name = item.GetProperty("name").GetString()!;
            if (!names.Add(name)) throw new InvalidDataException("배포 파일이 중복되었습니다.");
            using var file = File.OpenRead(Within(payload, name));
            if (!Convert.ToHexString(SHA256.HashData(file)).Equals(item.GetProperty("sha256").GetString(), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("native 배포 파일이 손상되었습니다.");
        }
        foreach (string name in new[] { "CustomVoice.Capture.exe", "CustomVoice.Capture.dll", "CustomVoice.Capture.runtimeconfig.json", "coreclr.dll", "hostfxr.dll", "host-main.cjs", "host-preload.cjs", "audio-main.cjs", "github-main.cjs", "window-sources-main.cjs", "native-version.json" })
            if (!names.Contains(name)) throw new InvalidDataException("native 배포 파일이 누락되었습니다.");
        foreach (string name in new[] { "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe", "get-graphics-offsets32.exe", "get-graphics-offsets64.exe", "COPYING.txt", "NOTICE.txt", "OBS-Studio-32.0.4-Sources.tar.gz" })
            if (!names.Contains("game-hook/" + name)) throw new InvalidDataException("게임 캡처 배포 파일이 누락되었습니다.");
        using var stamp = JsonDocument.Parse(File.ReadAllText(Path.Combine(payload, "native-version.json")));
        if (stamp.RootElement.GetProperty("version").GetString() != version) throw new InvalidDataException("native 배포 버전이 일치하지 않습니다.");
    }
    internal static async Task Prepare()
    {
        FileStream operation;
        try { operation = Lock(); }
        catch (IOException) { var state = Status(); if (state.state is "downloading" or "waiting" or "applying") { Program.Send(state); return; } throw new IOException("native 업데이트가 진행 중입니다. 잠시 후 다시 시도해 주세요."); }
        using (operation)
        {
            // The prepared worker may not have taken operation.lock yet. Its
            // live status closes that handoff gap for concurrent Discord apps.
            var existing = Status();
            if (existing.state is "downloading" or "waiting" or "applying") { Program.Send(existing); return; }
            CleanupJobs();
            string? version = null;
            try
            {
                using var http = GithubUpdate.Client(); using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(5));
                Save(Owned("downloading", null));
                var release = await Latest(http, cancellation.Token); version = release.Meta.nativeVersion;
                if (VersionOf(version) <= VersionOf(InstalledVersion())) { var current = new State("current", InstalledVersion()); Save(current); Program.Send(current); return; }
                Save(Owned("downloading", version));
                string job = Path.Combine(Root, Guid.NewGuid().ToString("N")); Directory.CreateDirectory(job);
                string zip = Path.Combine(job, "package.zip"), unpacked = Path.Combine(job, "payload");
                try
                {
                    await using (var file = new FileStream(zip, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        await GithubUpdate.Download(http, release.Url, file, 128L * 1024 * 1024, cancellation.Token);
                    using (var file = File.OpenRead(zip))
                        if (!Convert.ToHexString(SHA256.HashData(file)).Equals(release.Meta.sha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("다운로드한 ZIP이 손상되었습니다.");
                    Extract(zip, unpacked);
                }
                finally { if (File.Exists(zip)) File.Delete(zip); }
                string payload = Path.Combine(unpacked, "CustomVoice.native"); Validate(payload, version);
                _ = PackagePluginNewer(payload, Plugins, release.Meta.packageVersion);
                File.WriteAllText(Path.Combine(job, "request.json"), JsonSerializer.Serialize(release.Meta));
                using var worker = StartDetachedWorker(Path.Combine(payload, "CustomVoice.Capture.exe"), payload, "--apply-native-update");
                var pending = new State("waiting", version, worker.Id, worker.StartTime.ToUniversalTime().Ticks, "Discord를 트레이에서 완전히 종료하면 플러그인과 native를 적용합니다. 종료 후 5초 정도 기다렸다가 다시 실행해 주세요.");
                Save(pending); Program.Send(pending);
            }
            catch (Exception error) { Save(new("failed", version, message: error.Message)); throw; }
        }
    }
    internal static Process StartDetachedWorker(string executable, string directory, string argument)
    {
        // A redirected CreateProcess worker can inherit the requesting helper's
        // pipe handles on Windows, keeping Node's close/read-to-end pending for
        // the entire Discord session. The installer communicates via status.json
        // only; launch it hidden with no inherited request pipes.
        var start = new ProcessStartInfo(executable) { WorkingDirectory = directory, UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden, ErrorDialog = false };
        start.ArgumentList.Add(argument);
        return Process.Start(start) ?? throw new IOException("native 업데이트 설치를 예약하지 못했습니다.");
    }
    static void CleanupJobs()
    {
        // Only our GUID-named staging folders, never installation backups or
        // an active operation. Keep the two newest and at least seven days.
        try
        {
            string root = Path.GetFullPath(Root).TrimEnd(Path.DirectorySeparatorChar);
            var jobs = new DirectoryInfo(root).GetDirectories().Where(d => Regex.IsMatch(d.Name, "^[a-f0-9]{32}$"))
                .OrderByDescending(d => d.LastWriteTimeUtc).Skip(2);
            foreach (var job in jobs)
            {
                if (job.LastWriteTimeUtc > DateTime.UtcNow.AddDays(-7) || !string.Equals(job.Parent?.FullName, root, StringComparison.OrdinalIgnoreCase)) continue;
                try
                {
                    bool links = false; var directories = new Stack<DirectoryInfo>(); directories.Push(job);
                    while (directories.Count != 0 && !links)
                    {
                        var directory = directories.Pop();
                        if ((directory.Attributes & FileAttributes.ReparsePoint) != 0) { links = true; break; }
                        foreach (var entry in directory.EnumerateFileSystemInfos())
                        {
                            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0) { links = true; break; }
                            if (entry is DirectoryInfo child) directories.Push(child);
                        }
                    }
                    if (!links) Directory.Delete(job.FullName, true);
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
    internal static bool PackagePluginNewer(string payload, string plugins, string packageVersion)
    {
        static Version ReadVersion(string file)
        {
            if (new FileInfo(file).Length > 8 * 1024 * 1024) throw new InvalidDataException("플러그인 파일이 너무 큽니다.");
            string source = File.ReadAllText(file);
            string header = Regex.Match(source, @"^\uFEFF?\s*/\*\*[\s\S]*?\*/").Value;
            if (!Regex.IsMatch(header, @"^\s*\*\s*@name\s+CustomVoice\s*$", RegexOptions.Multiline) || !source.Contains("module.exports")) throw new InvalidDataException("CustomVoice 플러그인 형식이 아닙니다.");
            return VersionOf(Regex.Match(header, @"^\s*\*\s*@version\s+(\d+\.\d+\.\d+)\s*$", RegexOptions.Multiline).Groups[1].Value);
        }
        string package = Path.GetFullPath(Path.Combine(payload, "..", "CustomVoice.plugin.js"));
        Version remote = ReadVersion(package);
        if (remote != VersionOf(packageVersion)) throw new InvalidDataException("플러그인 배포 버전이 일치하지 않습니다.");
        string installed = Path.Combine(plugins, "CustomVoice.plugin.js");
        return !File.Exists(installed) || remote > ReadVersion(installed);
    }
    internal static async Task<int> ApplyAfterExit()
    {
        string? version = null;
        bool ownsState = false;
        try
        {
            string payload = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
            string job = Directory.GetParent(Directory.GetParent(payload)!.FullName)!.FullName;
            if (!string.Equals(Directory.GetParent(job)!.FullName, Path.GetFullPath(Root), StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(Path.GetFileName(job), "^[a-f0-9]{32}$") || !string.Equals(payload, Path.Combine(job, "payload", "CustomVoice.native"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("native 업데이트 대기 경로가 올바르지 않습니다.");
            var meta = JsonSerializer.Deserialize<Metadata>(File.ReadAllText(Path.Combine(job, "request.json"))) ?? throw new InvalidDataException("업데이트 요청 정보가 없습니다.");
            version = meta.nativeVersion; _ = VersionOf(version);
            FileStream? operation = null;
            for (int attempt = 0; attempt < 30 && operation == null; attempt++)
            { try { operation = Lock(); } catch (IOException) { await Task.Delay(500); } }
            if (operation == null) throw new IOException("다른 native 업데이트가 진행 중입니다.");
            using (operation)
            {
                var existing = Status();
                if (existing.state is "downloading" or "waiting" or "applying" && existing.pid != Environment.ProcessId) return 0;
                ownsState = true;
                Save(Owned("waiting", version, "Discord 완전 종료 후 플러그인과 native를 자동으로 적용합니다."));
                var deadline = DateTime.UtcNow.AddHours(24);
                int retries = 0;
                while (true)
                {
                    if (DateTime.UtcNow > deadline) throw new IOException("24시간 내에 Discord가 종료되지 않아 업데이트 예약을 취소했습니다. 다시 업데이트해 주세요.");
                    if (NativeInstaller.DiscordRunning()) { retries = 0; await Task.Delay(1500); continue; }
                    await Task.Delay(1500);
                    if (NativeInstaller.DiscordRunning()) continue;
                    if (VersionOf(InstalledVersion()) >= VersionOf(version)) { Save(new("installed", InstalledVersion(), message: "native가 최신 버전입니다.")); return 0; }
                    Validate(payload, version); Save(Owned("applying", version));
                    try
                    {
                        bool includePlugin = PackagePluginNewer(payload, Plugins, meta.packageVersion);
                        string result = NativeInstaller.Install(payload, Plugins, nativeOnly: !includePlugin, requireDiscordExit: true);
                        Save(new("installed", version, message: result)); return 0;
                    }
                    catch (IOException) when (NativeInstaller.DiscordRunning() || ++retries < 20) { Save(Owned("waiting", version)); }
                }
            }
        }
        catch (Exception error)
        {
            // A second or incorrectly launched worker must not replace another
            // live operation's status with its own failure.
            try { if (ownsState || Status().pid == Environment.ProcessId) Save(new("failed", version, message: error.Message)); } catch { }
            return 1;
        }
    }
}
