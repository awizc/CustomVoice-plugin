using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

internal static class GithubUpdate
{
    internal const string Repository = "awizc/CustomVoice-plugin";
    internal static void CleanupLegacyCredential()
    {
        // Only CustomVoice's retired updater credential, never Git credentials.
        string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BetterDiscord", "data", "CustomVoice", "github-token.bin");
        try { File.Delete(file); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
    internal static HttpClient Client()
    {
        CleanupLegacyCredential();
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromMinutes(5) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CustomVoice-Updater/" + NativeUpdate.CurrentVersion);
        http.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true };
        return http;
    }
    internal static bool TrustedDownload(Uri url) => url.IsAbsoluteUri && url.Scheme == "https" && url.IsDefaultPort && url.UserInfo.Length == 0 &&
        (url.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase) && url.AbsolutePath.StartsWith("/" + Repository + "/releases/", StringComparison.Ordinal) ||
         url.Host.Equals("release-assets.githubusercontent.com", StringComparison.OrdinalIgnoreCase) ||
         url.Host.Equals("raw.githubusercontent.com", StringComparison.OrdinalIgnoreCase) && url.AbsolutePath.StartsWith("/" + Repository + "/", StringComparison.Ordinal));

    internal static async Task Download(HttpClient http, Uri url, Stream destination, long maximum, CancellationToken cancellation)
    {
        for (int hop = 0; ; hop++)
        {
            if (!TrustedDownload(url)) throw new InvalidDataException("GitHub 다운로드 주소가 올바르지 않습니다.");
            using var response = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                if (hop >= 4 || response.Headers.Location == null) throw new InvalidDataException("GitHub 다운로드 리디렉션이 올바르지 않습니다.");
                url = new Uri(url, response.Headers.Location); continue;
            }
            RequireSuccess(response, "공개 파일 다운로드");
            if (response.Content.Headers.ContentLength > maximum) throw new InvalidDataException("배포 파일이 허용 크기를 초과합니다.");
            await using var input = await response.Content.ReadAsStreamAsync(cancellation);
            byte[] buffer = new byte[65536]; long total = 0; int count;
            while ((count = await input.ReadAsync(buffer, cancellation)) != 0)
            {
                total += count; if (total > maximum) throw new InvalidDataException("배포 파일이 허용 크기를 초과합니다.");
                await destination.WriteAsync(buffer.AsMemory(0, count), cancellation);
            }
            return;
        }
    }
    internal static async Task Fetch()
    {
        // Compatibility for older plugins that still call the native bridge.
        string knownCommit = Console.In.ReadToEnd().Trim();
        if (knownCommit.Length != 0 && ((knownCommit.Length != 40 && knownCommit.Length != 64) || !knownCommit.All(Uri.IsHexDigit))) throw new InvalidDataException("저장된 업데이트 식별자가 올바르지 않습니다.");
        using var http = Client(); using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        using var memory = new MemoryStream();
        await Download(http, new Uri($"https://raw.githubusercontent.com/{Repository}/main/CustomVoice.plugin.js"), memory, 8 * 1024 * 1024, cancellation.Token);
        byte[] bytes = memory.ToArray(); string commit = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (commit == knownCommit) { Program.Send(new { commit, repository = Repository, unchanged = true }); return; }
        Program.Send(new { commit, repository = Repository, source = Encoding.UTF8.GetString(bytes) });
    }
    internal static void RequireSuccess(HttpResponseMessage response, string action)
    {
        if (response.IsSuccessStatusCode) return;
        string reason = (int)response.StatusCode switch {
            404 => "공개 배포 파일을 찾을 수 없습니다.",
            403 or 429 => "GitHub 다운로드가 일시적으로 제한되었습니다. 잠시 후 다시 시도합니다.",
            >= 500 => "GitHub 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도합니다.",
            _ => "잠시 후 다시 시도해 주세요."
        };
        throw new IOException($"GitHub {action} 실패 (HTTP {(int)response.StatusCode}). {reason}");
    }
}
