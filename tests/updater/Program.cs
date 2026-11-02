using System.Net;
using System.Text;
using System.Text.Json;

internal static class Program
{
    internal static void Send(object value) => throw new InvalidOperationException("Tests must not invoke an installed updater.");
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Reject(Action action) { try { action(); } catch (InvalidDataException) { return; } throw new Exception("Accepted invalid package"); }
    static async Task RejectAsync(Func<Task> action) { try { await action(); } catch (InvalidDataException) { return; } throw new Exception("Accepted invalid download"); }
    static string Plugin(string version) => $"/**\n * @name CustomVoice\n * @version {version}\n */\nmodule.exports = class {{}};";
    static async Task Main()
    {
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
