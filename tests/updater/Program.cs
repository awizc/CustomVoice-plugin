using System.Net;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

internal static class Program
{
    internal static void Send(object value) => throw new InvalidOperationException("Tests must not invoke an installed updater.");
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Reject(Action action) { try { action(); } catch (InvalidDataException) { return; } throw new Exception("Accepted invalid package"); }
    static async Task RejectAsync(Func<Task> action) { try { await action(); } catch (InvalidDataException) { return; } throw new Exception("Accepted invalid download"); }
    static string Plugin(string version) => $"/**\n * @name CustomVoice\n * @version {version}\n */\nmodule.exports = class {{}};";
    static async Task Main(string[] args)
    {
        if (args is ["--wait-fixture"]) { await Task.Delay(TimeSpan.FromMinutes(1)); return; }
        if (args is ["--spawn-fixture"])
        {
            using var child = NativeUpdate.StartDetachedWorker(Environment.ProcessPath!, AppContext.BaseDirectory, "--wait-fixture");
            Console.WriteLine(child.Id); return;
        }
        if (OperatingSystem.IsWindows())
        {
            var start = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            start.ArgumentList.Add("--spawn-fixture");
            using var parent = Process.Start(start)!; parent.StandardInput.Close();
            int childId = int.Parse((await parent.StandardOutput.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(10)))!);
            using var child = Process.GetProcessById(childId);
            try
            {
                await parent.StandardOutput.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5));
                await parent.StandardError.ReadToEndAsync().WaitAsync(TimeSpan.FromSeconds(5));
                await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
                Check(parent.ExitCode == 0 && !child.HasExited, "Detached worker must survive while request pipes close immediately");
                Console.WriteLine("PASS: hidden detached worker does not hold requesting process pipes open");
            }
            finally { if (!child.HasExited) { child.Kill(); await child.WaitForExitAsync(); } }
        }
        var firstMetadata = NativeUpdate.LatestMetadataUrl(); var nextMetadata = NativeUpdate.LatestMetadataUrl();
        Check(firstMetadata != nextMetadata && firstMetadata.Query.Length > 1 && GithubUpdate.TrustedDownload(firstMetadata), "Latest metadata must bypass stale GitHub redirect caches");
        Check(firstMetadata.AbsolutePath == "/awizc/CustomVoice-plugin/releases/latest/download/CustomVoice-native.json", "Metadata cache bypass changed download destination");
        Console.WriteLine("PASS: latest metadata requests bypass stale redirects without changing trusted destination");
        string repo = "https://github.com/awizc/CustomVoice-plugin/releases/";
        var url = new Uri(repo + "latest/download/CustomVoice-native.json");
        foreach (string invalid in new[] { "http://github.com/awizc/CustomVoice-plugin/releases/x", "https://evil.example/file", "https://github.com/other/repo/releases/x", "https://github.com:444/awizc/CustomVoice-plugin/releases/x", "https://user@github.com/awizc/CustomVoice-plugin/releases/x", "https://github.com.evil.example/x", "https://raw.githubusercontent.com/other/repo/main/x" })
            Check(!GithubUpdate.TrustedDownload(new Uri(invalid)), "Untrusted download accepted: " + invalid);
        int requests = 0;
        using (var http = new HttpClient(new FakeHandler(request => {
            Check(request.Headers.Authorization == null, "Unexpected authorization"); requests++;
            if (requests == 1) return Redirect(repo + "download/v1.1.17/CustomVoice-native.json");
            if (requests == 2) return Redirect("https://release-assets.githubusercontent.com/github-production-release-asset/file?signature=example");
            return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("payload") };
        })))
        using (var target = new MemoryStream()) {
            await GithubUpdate.Download(http, url, target, 32, CancellationToken.None);
            Check(requests == 3 && Encoding.UTF8.GetString(target.ToArray()) == "payload", "Public release redirect failed");
        }
        foreach (string redirect in new[] { "https://evil.example/file", "http://release-assets.githubusercontent.com/x", repo + "latest/download/loop" })
        {
            using var http = new HttpClient(new FakeHandler(_ => Redirect(redirect))); using var target = new MemoryStream();
            await RejectAsync(() => GithubUpdate.Download(http, url, target, 32, CancellationToken.None));
        }
        foreach (bool declaredLength in new[] { true, false })
        {
            using var http = new HttpClient(new FakeHandler(_ => {
                HttpContent content = declaredLength ? new ByteArrayContent(new byte[65]) : new StreamContent(new NonSeekStream(new byte[65]));
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            }));
            using var target = new MemoryStream(); await RejectAsync(() => GithubUpdate.Download(http, url, target, 64, CancellationToken.None));
        }
        Console.WriteLine("PASS: anonymous public downloads, redirect bounds, advertised and streamed size bounds");
        byte[] Metadata(string version = "1.1.17", string? file = null, string? sha = null, int schema = 1) => JsonSerializer.SerializeToUtf8Bytes(new { schema, nativeVersion = "1.1.13", packageVersion = version, file = file ?? $"CustomVoice-{version}-windows-x64.zip", sha256 = sha ?? new string('a',64) });
        Check(NativeUpdate.ParseMetadata(Metadata()).nativeVersion == "1.1.13", "Metadata parse failed");
        Reject(() => NativeUpdate.ParseMetadata(Metadata(version: "../x")));
        Reject(() => NativeUpdate.ParseMetadata(Metadata(file: "../file.zip")));
        Reject(() => NativeUpdate.ParseMetadata(Metadata(sha: "broken")));
        Reject(() => NativeUpdate.ParseMetadata(Metadata(schema: 2)));
        string root = Path.Combine(Path.GetTempPath(), "cv-native-updater-" + Guid.NewGuid().ToString("N"));
        string payload = Path.Combine(root, "package", "CustomVoice.native"), plugins = Path.Combine(root, "plugins");
        Directory.CreateDirectory(payload); Directory.CreateDirectory(plugins);
        try
        {
            string source = Path.Combine(root, "package", "CustomVoice.plugin.js"), installed = Path.Combine(plugins, "CustomVoice.plugin.js");
            File.WriteAllText(source, Plugin("1.1.17"));
            Check(NativeUpdate.PackagePluginNewer(payload, plugins, "1.1.17"), "Missing plugin should be installed");
            File.WriteAllText(installed, Plugin("1.1.12"));
            Check(NativeUpdate.PackagePluginNewer(payload, plugins, "1.1.17"), "Old plugin should be upgraded with native");
            foreach (string version in new[] { "1.1.17", "1.1.18" }) {
                File.WriteAllText(installed, Plugin(version));
                Check(!NativeUpdate.PackagePluginNewer(payload, plugins, "1.1.17"), "Same/newer plugin must be preserved");
            }
            Reject(() => NativeUpdate.PackagePluginNewer(payload, plugins, "1.1.18"));
            File.WriteAllText(source, Plugin("1.1.17").Replace("CustomVoice", "Other"));
            Reject(() => NativeUpdate.PackagePluginNewer(payload, plugins, "1.1.17"));
            string native = Path.Combine(plugins, "CustomVoice.native"); Directory.CreateDirectory(native);
            foreach (string name in new[] { "CustomVoice.Capture.exe", "CustomVoice.Publisher.exe", "CustomVoice.Capture.dll", "CustomVoice.Capture.runtimeconfig.json", "coreclr.dll", "hostfxr.dll", "host-main.cjs", "host-preload.cjs", "audio-main.cjs", "github-main.cjs", "window-sources-main.cjs" })
                File.WriteAllText(Path.Combine(native, name), "fixture:" + name);
            Directory.CreateDirectory(Path.Combine(native, "game-hook"));
            foreach (string name in new[] { "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe", "get-graphics-offsets32.exe", "get-graphics-offsets64.exe", "COPYING.txt", "NOTICE.txt", "OBS-Studio-32.0.4-Sources.tar.gz" })
                File.WriteAllText(Path.Combine(native, "game-hook", name), "fixture:" + name);
            string stamp = Path.Combine(native, "native-version.json"), manifest = Path.Combine(native, "manifest.json");
            File.WriteAllText(stamp, JsonSerializer.Serialize(new { version = "1.1.16" }));
            File.WriteAllText(manifest, JsonSerializer.Serialize(Directory.GetFiles(native, "*", SearchOption.AllDirectories).Select(file => new { name = Path.GetRelativePath(native, file).Replace('\\', '/'), sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file))) })));
            var healthy = NativeUpdate.InspectInstallation(plugins);
            Check(healthy.valid && healthy.version == "1.1.16", "Healthy installation rejected");
            Check(!NativeUpdate.UpdateAvailable(healthy, "1.1.16"), "Healthy current install needs no update");
            Check(NativeUpdate.UpdateAvailable(healthy, "1.1.17"), "Newer release must be offered");
            Check(NativeUpdate.ReconcileStatus(new("failed", "1.1.16", message: "old locked file"), healthy).state == "installed", "Stale failure was not cleared after verified installation");
            Check(NativeUpdate.ReconcileStatus(new("failed", "1.1.17"), healthy).state == "failed", "A failed newer version was hidden");
            Check(NativeUpdate.ReconcileStatus(new("waiting", "1.1.16"), healthy).state == "waiting", "Live worker state changed");
            File.WriteAllText(Path.Combine(native, "host-preload.cjs"), "corrupt");
            var corrupt = NativeUpdate.InspectInstallation(plugins);
            Check(!corrupt.valid && corrupt.version == "1.1.16", "Corrupt files were accepted by version stamp alone");
            Check(NativeUpdate.UpdateAvailable(corrupt, "1.1.16"), "Same-version repair was not offered");
            Check(!NativeUpdate.UpdateAvailable(corrupt, "1.1.15"), "Repair must not downgrade");
            Check(NativeUpdate.ReconcileStatus(new("installed", "1.1.16"), corrupt).state == "failed", "Invalid installation showed success");
            Check(NativeUpdate.ReconcileStatus(new("failed", "1.1.16"), corrupt).state == "failed", "Corrupt install cleared failure");
            File.WriteAllText(manifest, "[{\"name\":null,\"sha256\":null}]");
            Check(!NativeUpdate.InspectInstallation(plugins).valid, "Malformed manifest did not require repair");
            File.WriteAllText(stamp, "{\"version\":\"broken\"}");
            Check(NativeUpdate.UpdateAvailable(NativeUpdate.InspectInstallation(plugins), "1.1.16"), "Malformed stamp did not offer repair");
            File.Delete(stamp);
            Check(NativeUpdate.UpdateAvailable(NativeUpdate.InspectInstallation(plugins), "1.1.16"), "Missing stamp did not offer repair");
            Console.WriteLine("PASS: installed file hashes, stale failure reconciliation, same-version repair, no downgrade");
            Console.WriteLine("PASS: release metadata validation and bootstrap upgrades without plugin downgrades");
        }
        finally { Directory.Delete(root, true); }
    }
    static HttpResponseMessage Redirect(string url) { var response = new HttpResponseMessage(HttpStatusCode.Found); response.Headers.Location = new Uri(url); return response; }
    sealed class FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => Task.FromResult(respond(request));
    }
    sealed class NonSeekStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
    }
}
