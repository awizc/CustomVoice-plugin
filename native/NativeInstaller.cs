using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

// Runs inside the distributed capture executable. No Node, PowerShell modules,
// SDK, network download, elevation, or independently installed runtime is needed.
internal static class NativeInstaller
{
    static readonly Regex Hook = new("\\n// <CustomVoiceNativeHost>[\\s\\S]*?// </CustomVoiceNativeHost>\\n?", RegexOptions.CultureInvariant);
    static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal static byte[] PatchArchive(byte[] bytes, string nativeDirectory, bool remove = false)
    {
        if (bytes.Length < 16 || bytes.Length > 256 * 1024 * 1024 || BitConverter.ToUInt32(bytes, 0) != 4)
            throw new InvalidDataException("BetterDiscord archive header is invalid.");
        int length = checked((int)BitConverter.ToUInt32(bytes, 12));
        int bodyOffset = checked(8 + (int)BitConverter.ToUInt32(bytes, 4));
        if (length < 2 || length > bytes.Length - 16 || bodyOffset < 16 + length || bodyOffset > bytes.Length)
            throw new InvalidDataException("BetterDiscord archive bounds are invalid.");
        var header = JsonNode.Parse(Encoding.UTF8.GetString(bytes, 16, length))!.AsObject();
        var files = header["files"]?.AsObject() ?? throw new InvalidDataException("Archive files are missing.");
        foreach (var name in new[] { "main.js", "preload.js" })
            if (files[name]?["size"]?.GetValue<long>() is not > 0 || files[name]?["unpacked"]?.GetValue<bool>() == true || files[name]?["link"] != null)
                throw new InvalidDataException("Unsupported BetterDiscord archive layout.");
        using var body = new MemoryStream();
        void Visit(JsonObject entries, string prefix)
        {
            foreach (var (name, node) in entries)
            {
                var entry = node!.AsObject();
                if (entry["files"] is JsonObject directory) { Visit(directory, prefix + name + "/"); continue; }
                if (entry["unpacked"]?.GetValue<bool>() == true || entry["link"] != null) continue;
                int offset = checked(bodyOffset + int.Parse(entry["offset"]!.GetValue<string>(), System.Globalization.CultureInfo.InvariantCulture));
                int size = checked((int)entry["size"]!.GetValue<long>());
                if (offset < bodyOffset || size < 0 || offset > bytes.Length - size) throw new InvalidDataException("Archive file bounds are invalid.");
                byte[] content = bytes.AsSpan(offset, size).ToArray();
                if (prefix.Length == 0 && name is "main.js" or "preload.js")
                {
                    string code = Hook.Replace(Encoding.UTF8.GetString(content), "");
                    string host = Path.Combine(nativeDirectory, name == "main.js" ? "host-main.cjs" : "host-preload.cjs");
                    content = Encoding.UTF8.GetBytes(code + (remove ? "" : "\n// <CustomVoiceNativeHost>\n;try { require(" + JsonSerializer.Serialize(host) + ").install(); } catch (error) { console.error('[CustomVoice] Native host initialization failed:', error); }\n// </CustomVoiceNativeHost>\n"));
                    if (entry["integrity"] is JsonObject integrity)
                    {
                        int blockSize = integrity["blockSize"]?.GetValue<int>() ?? 4 * 1024 * 1024;
                        if (blockSize < 1 || blockSize > 64 * 1024 * 1024) throw new InvalidDataException("Invalid integrity block size.");
                        var blocks = new JsonArray();
                        for (int index = 0; index < content.Length; index += blockSize)
                            blocks.Add(Hash(content.AsSpan(index, Math.Min(blockSize, content.Length - index)).ToArray()));
                        entry["integrity"] = new JsonObject { ["algorithm"] = "SHA256", ["hash"] = Hash(content), ["blockSize"] = blockSize, ["blocks"] = blocks };
                    }
                }
                entry["offset"] = body.Position.ToString(System.Globalization.CultureInfo.InvariantCulture);
                entry["size"] = content.Length;
                body.Write(content);
            }
        }
        Visit(files, "");
        byte[] json = Encoding.UTF8.GetBytes(header.ToJsonString());
        int padding = (4 - json.Length % 4) % 4, payloadSize = checked(4 + json.Length + padding);
        using var output = new MemoryStream();
        using var writer = new BinaryWriter(output, Encoding.UTF8, true);
        writer.Write(4); writer.Write(payloadSize + 4); writer.Write(payloadSize); writer.Write(json.Length);
        writer.Write(json); writer.Write(new byte[padding]); body.Position = 0; body.CopyTo(output);
        return output.ToArray();
    }

    static string Within(string directory, string relative)
    {
        string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        string result = Path.GetFullPath(Path.Combine(root, relative));
        if (Path.IsPathRooted(relative) || relative.Contains(':') || !result.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Invalid package file path.");
        return result;
    }

    internal static string Install(string payloadDirectory, string pluginsDirectory, bool remove = false, bool nativeOnly = false, bool requireDiscordExit = false)
    {
        payloadDirectory = Path.GetFullPath(payloadDirectory);
        pluginsDirectory = Path.GetFullPath(pluginsDirectory);
        string nativeDirectory = Path.Combine(pluginsDirectory, "CustomVoice.native");
        string dataDirectory = Path.Combine(Path.GetDirectoryName(pluginsDirectory)!, "data");
        string archive = Path.Combine(dataDirectory, "betterdiscord.asar");
        if (!File.Exists(archive)) throw new FileNotFoundException("BetterDiscord가 설치되어 있지 않습니다. BetterDiscord를 먼저 설치해 주세요.");
        byte[] original = File.ReadAllBytes(archive);
        byte[] updated = PatchArchive(original, nativeDirectory, remove);
        var copies = new List<(string Source, string Target)>();
        if (!remove)
        {
            string manifestPath = Path.Combine(payloadDirectory, "manifest.json");
            var manifest = JsonNode.Parse(File.ReadAllText(manifestPath))!.AsArray();
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in manifest)
            {
                string name = item!["name"]!.GetValue<string>();
                if (!names.Add(name)) throw new InvalidDataException("Duplicate package file.");
                string source = Within(payloadDirectory, name), target = Within(nativeDirectory, name);
                if (!Hash(File.ReadAllBytes(source)).Equals(item["sha256"]!.GetValue<string>(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException($"파일이 누락되었거나 손상되었습니다: {name}. 배포 압축 파일을 다시 풀어 주세요.");
                if (!source.Equals(target, StringComparison.OrdinalIgnoreCase)) copies.Add((source, target));
            }
            foreach (string required in new[] { "CustomVoice.Capture.exe", "CustomVoice.Capture.dll", "CustomVoice.Capture.runtimeconfig.json", "host-main.cjs", "host-preload.cjs", "audio-main.cjs", "github-main.cjs", "window-sources-main.cjs", "native-version.json", "coreclr.dll", "hostfxr.dll" })
                if (!names.Contains(required)) throw new InvalidDataException($"배포 폴더에 필요한 파일이 없습니다: {required}");
            foreach (string required in new[] { "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe", "get-graphics-offsets32.exe", "get-graphics-offsets64.exe", "COPYING.txt", "NOTICE.txt", "OBS-Studio-32.0.4-Sources.tar.gz" })
                if (!names.Contains("game-hook/" + required)) throw new InvalidDataException($"게임 캡처 구성요소가 없습니다: {required}");
            string targetManifest = Path.Combine(nativeDirectory, "manifest.json");
            if (!manifestPath.Equals(targetManifest, StringComparison.OrdinalIgnoreCase)) copies.Add((manifestPath, targetManifest));
            string plugin = Path.GetFullPath(Path.Combine(payloadDirectory, "..", "CustomVoice.plugin.js"));
            string targetPlugin = Path.Combine(pluginsDirectory, "CustomVoice.plugin.js");
            if (!nativeOnly && File.Exists(plugin) && !plugin.Equals(targetPlugin, StringComparison.OrdinalIgnoreCase)) copies.Add((plugin, targetPlugin));
        }
        bool archiveChanged = !original.AsSpan().SequenceEqual(updated);
        if (!archiveChanged && copies.Count == 0) return "이미 설치되어 있습니다.";
        // A short-lived status/download helper can outlive Discord. Detect its
        // file locks before creating backups or changing any installed files.
        if (nativeOnly || requireDiscordExit)
            foreach (var (_, target) in copies)
                if (File.Exists(target)) { using var available = new FileStream(target, FileMode.Open, FileAccess.ReadWrite, FileShare.None); }
        string backup = Path.Combine(dataDirectory, "CustomVoice-install-backups", DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(backup);
        File.WriteAllBytes(Path.Combine(backup, "betterdiscord.asar"), original);
        var restored = new List<(string Target, string? Backup)>();
        string temporary = archive + ".customvoice-" + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            if ((nativeOnly || requireDiscordExit) && DiscordRunning()) throw new IOException("Discord가 다시 실행되어 native 설치를 연기합니다.");
            foreach (var (source, target) in copies)
            {
                string? saved = null;
                if (File.Exists(target))
                {
                    saved = Within(backup, Path.GetRelativePath(pluginsDirectory, target));
                    Directory.CreateDirectory(Path.GetDirectoryName(saved)!); File.Copy(target, saved);
                }
                restored.Add((target, saved));
                Directory.CreateDirectory(Path.GetDirectoryName(target)!); File.Copy(source, target, true);
            }
            if (archiveChanged)
            {
                File.WriteAllBytes(temporary, updated);
                if (!File.ReadAllBytes(archive).AsSpan().SequenceEqual(original)) throw new IOException("설치 도중 BetterDiscord 파일이 변경되었습니다. 다시 실행해 주세요.");
                File.Replace(temporary, archive, null);
            }
        }
        catch
        {
            foreach (var (target, saved) in restored.AsEnumerable().Reverse())
                try { if (saved != null) File.Copy(saved, target, true); else File.Delete(target); }
                catch { Console.Error.WriteLine($"복원하지 못한 파일: {target}. 백업 위치: {backup}"); }
            throw;
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return (remove ? "네이티브 연결을 해제했습니다." : nativeOnly ? "native 업데이트를 완료했습니다." : "플러그인과 네이티브 캡처 설치를 완료했습니다.") + "\n백업: " + backup;
    }

    internal static bool DiscordRunning()
    {
        bool running = false;
        foreach (var process in Process.GetProcesses())
            using (process)
                try { if (new[] { "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment" }.Contains(process.ProcessName, StringComparer.OrdinalIgnoreCase)) running = true; }
                catch (InvalidOperationException) { }
        return running;
    }

    internal static int Run(bool remove)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string plugins = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "BetterDiscord", "plugins");
        try
        {
            bool running = false;
            foreach (var process in Process.GetProcesses())
            {
                using (process)
                    try { if (new[] { "Discord", "DiscordPTB", "DiscordCanary", "DiscordDevelopment" }.Contains(process.ProcessName, StringComparer.OrdinalIgnoreCase)) running = true; }
                    catch (InvalidOperationException) { }
            }
            if (running) throw new IOException("Discord를 트레이 아이콘의 Quit Discord까지 눌러 완전히 종료한 후 설치 파일을 다시 실행해 주세요.");
            Console.WriteLine(Install(AppContext.BaseDirectory, plugins, remove));
            Console.WriteLine("Discord를 다시 실행하고 CustomVoice 플러그인을 켜 주세요.");
            return 0;
        }
        catch (Exception error)
        {
            string message = "설치 실패: " + error.Message;
            Console.Error.WriteLine(message);
            try
            {
                string logs = Path.Combine(plugins, "logs", "CustomVoice"); Directory.CreateDirectory(logs);
                File.AppendAllText(Path.Combine(logs, "installer-" + DateTime.Now.ToString("yyyy-MM-dd") + ".log"), $"[{DateTimeOffset.Now:O}] {error}\n");
            }
            catch { }
            return 1;
        }
    }
}
