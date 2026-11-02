using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

internal static class GithubUpdate
{
    internal const string Repository = "awizc/CustomVoice-plugin";
    static string TokenFile => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BetterDiscord", "data", "CustomVoice", "github-token.bin");
    [StructLayout(LayoutKind.Sequential)] struct Blob { public int Length; public nint Data; }
    [DllImport("crypt32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CryptProtectData(ref Blob data, string description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("crypt32.dll", SetLastError = true)] static extern bool CryptUnprotectData(ref Blob data, nint description, nint entropy, nint reserved, nint prompt, uint flags, out Blob output);
    [DllImport("kernel32.dll")] static extern nint LocalFree(nint memory);
    static byte[] Protect(byte[] bytes, bool decrypt)
    {
        var input = new Blob { Length = bytes.Length, Data = Marshal.AllocHGlobal(bytes.Length) };
        Blob output = default;
        try
        {
            Marshal.Copy(bytes, 0, input.Data, bytes.Length);
            bool success = decrypt ? CryptUnprotectData(ref input, 0, 0, 0, 0, 1, out output) : CryptProtectData(ref input, "CustomVoice GitHub", 0, 0, 0, 1, out output);
            if (!success) throw new System.ComponentModel.Win32Exception();
            byte[] result = new byte[output.Length]; Marshal.Copy(output.Data, result, 0, result.Length); return result;
        }
        finally { Marshal.FreeHGlobal(input.Data); if (output.Data != 0) LocalFree(output.Data); }
    }
    internal static void Save()
    {
        string token = Console.In.ReadToEnd().Trim();
        if (token.Length == 0) { if (File.Exists(TokenFile)) File.Delete(TokenFile); Program.Send(new { configured = false }); return; }
        if (token.Length > 512 || token.Any(c => !char.IsAsciiLetterOrDigit(c) && c != '_')) throw new ArgumentException("GitHub 토큰 형식이 올바르지 않습니다.");
        Directory.CreateDirectory(Path.GetDirectoryName(TokenFile)!);
        string temporary = TokenFile + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try { File.WriteAllBytes(temporary, Protect(Encoding.UTF8.GetBytes(token), false)); File.Move(temporary, TokenFile, true); }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        Program.Send(new { configured = true });
    }
    internal static HttpClient Client()
    {
        if (!File.Exists(TokenFile)) throw new InvalidOperationException("업데이트 설정에서 private 저장소 읽기 권한이 있는 GitHub 토큰을 등록해 주세요.");
        string token = Encoding.UTF8.GetString(Protect(File.ReadAllBytes(TokenFile), true));
        var http = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(20), MaxResponseContentBufferSize = 8 * 1024 * 1024 };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        http.DefaultRequestHeaders.UserAgent.ParseAdd("CustomVoice-Updater/" + NativeUpdate.CurrentVersion);
        http.DefaultRequestHeaders.Add("X-GitHub-Api-Version", "2022-11-28");
        http.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true };
        return http;
    }
    internal static async Task Fetch()
    {
        string knownCommit = Console.In.ReadToEnd().Trim();
        if (knownCommit.Length != 0 && ((knownCommit.Length != 40 && knownCommit.Length != 64) || !knownCommit.All(Uri.IsHexDigit))) throw new InvalidDataException("저장된 업데이트 커밋이 올바르지 않습니다.");
        using var http = Client();
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(40));
        using var reference = await http.GetAsync($"https://api.github.com/repos/{Repository}/git/ref/heads/main", cancellation.Token);
        RequireSuccess(reference, "업데이트 조회");
        using var document = JsonDocument.Parse(await reference.Content.ReadAsStringAsync(cancellation.Token));
        string commit = document.RootElement.GetProperty("object").GetProperty("sha").GetString()!;
        if ((commit.Length != 40 && commit.Length != 64) || !commit.All(Uri.IsHexDigit)) throw new InvalidDataException("GitHub commit response is invalid.");
        if (commit == knownCommit) { Program.Send(new { commit, repository = Repository, unchanged = true }); return; }
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{Repository}/contents/CustomVoice.plugin.js?ref={commit}");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github.raw+json"));
        using var response = await http.SendAsync(request, cancellation.Token);
        RequireSuccess(response, "플러그인 다운로드");
        Program.Send(new { commit, repository = Repository, source = await response.Content.ReadAsStringAsync(cancellation.Token) });
    }
    internal static void RequireSuccess(HttpResponseMessage response, string action)
    {
        if (response.IsSuccessStatusCode) return;
        string reason = (int)response.StatusCode switch {
            401 => "GitHub 토큰이 만료되었거나 유효하지 않습니다. 토큰을 다시 등록해 주세요.",
            403 when response.Headers.Contains("Retry-After") || response.Headers.TryGetValues("X-RateLimit-Remaining", out var remaining) && remaining.Contains("0") => "GitHub 요청 한도에 도달했습니다. 잠시 후 다시 시도합니다.",
            403 => "저장소 읽기 권한 또는 조직의 토큰 승인을 확인해 주세요.",
            404 => "저장소·배포 파일이 없거나 private 저장소 읽기 권한이 없습니다.",
            429 => "GitHub 요청 한도에 도달했습니다. 잠시 후 다시 시도합니다.",
            >= 500 => "GitHub 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도합니다.",
            _ => "잠시 후 다시 시도해 주세요."
        };
        throw new IOException($"GitHub {action} 실패 (HTTP {(int)response.StatusCode}). {reason}");
    }
}
