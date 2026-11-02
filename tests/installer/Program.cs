using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
static byte[] Archive()
{
    byte[] main = Encoding.UTF8.GetBytes("console.log('main');"), preload = Encoding.UTF8.GetBytes("console.log('preload');"), binary = new byte[] { 0, 255, 12, 128 };
    JsonObject Entry(byte[] bytes, int offset) => new() { ["offset"] = offset.ToString(), ["size"] = bytes.Length, ["integrity"] = new JsonObject { ["algorithm"] = "SHA256", ["hash"] = Hash(bytes), ["blockSize"] = 16, ["blocks"] = new JsonArray() } };
    var header = new JsonObject { ["files"] = new JsonObject {
        ["main.js"] = Entry(main, 0), ["preload.js"] = Entry(preload, main.Length),
        ["assets"] = new JsonObject { ["files"] = new JsonObject { ["data.bin"] = Entry(binary, main.Length + preload.Length) } },
        ["external.node"] = new JsonObject { ["unpacked"] = true, ["size"] = 12 }
    } };
    byte[] json = Encoding.UTF8.GetBytes(header.ToJsonString()); int pad = (4 - json.Length % 4) % 4;
    using var output = new MemoryStream(); using var writer = new BinaryWriter(output);
    writer.Write(4); writer.Write(8 + json.Length + pad); writer.Write(4 + json.Length + pad); writer.Write(json.Length);
    writer.Write(json); writer.Write(new byte[pad]); writer.Write(main); writer.Write(preload); writer.Write(binary);
    return output.ToArray();
}
static JsonObject Header(byte[] archive) => JsonNode.Parse(Encoding.UTF8.GetString(archive, 16, BitConverter.ToInt32(archive, 12)))!.AsObject();
static byte[] Content(byte[] archive, JsonNode entry) => archive.AsSpan(8 + BitConverter.ToInt32(archive, 4) + int.Parse(entry["offset"]!.GetValue<string>()), entry["size"]!.GetValue<int>()).ToArray();
static void Manifest(string payload)
{
    var items = Directory.GetFiles(payload, "*", SearchOption.AllDirectories).Where(file => Path.GetFileName(file) != "manifest.json").Select(file => new { name = Path.GetRelativePath(payload, file).Replace('\\', '/'), sha256 = Hash(File.ReadAllBytes(file)) }).ToArray();
    File.WriteAllText(Path.Combine(payload, "manifest.json"), JsonSerializer.Serialize(items));
}

byte[] original = Archive();
string native = @"C:\User files\한글 O'Brien\CustomVoice.native";
byte[] patched = NativeInstaller.PatchArchive(original, native);
Check(patched.AsSpan().SequenceEqual(NativeInstaller.PatchArchive(patched, native)), "Repeated install must be idempotent");
var files = Header(patched)["files"]!;
foreach (var name in new[] { "main.js", "preload.js" })
{
    byte[] content = Content(patched, files[name]!);
    string code = Encoding.UTF8.GetString(content);
    string argument = code.Split("require(")[1].Split(").install()")[0];
    Check(JsonSerializer.Deserialize<string>(argument) == Path.Combine(native, name == "main.js" ? "host-main.cjs" : "host-preload.cjs"), "Unicode paths must remain valid JavaScript strings");
    Check(Hash(content) == files[name]!["integrity"]!["hash"]!.GetValue<string>(), "ASAR integrity hash mismatch");
    var blocks = files[name]!["integrity"]!["blocks"]!.AsArray();
    for (int i = 0; i < blocks.Count; i++) Check(blocks[i]!.GetValue<string>() == Hash(content.AsSpan(i * 16, Math.Min(16, content.Length - i * 16)).ToArray()), "ASAR block hash mismatch");
}
Check(Content(patched, files["assets"]!["files"]!["data.bin"]!).SequenceEqual(new byte[] { 0, 255, 12, 128 }), "Unrelated binary content changed");
byte[] removed = NativeInstaller.PatchArchive(patched, native, true);
Check(Encoding.UTF8.GetString(Content(removed, Header(removed)["files"]!["main.js"]!)) == "console.log('main');", "Uninstall must restore original code");
try { NativeInstaller.PatchArchive(new byte[16], native); throw new Exception("Accepted invalid archive"); } catch (InvalidDataException) { }
Console.WriteLine("PASS: archive integrity, Unicode paths, idempotence, removal, invalid input");

string parent = Path.GetFullPath(Path.GetTempPath());
string root = Path.GetFullPath(Path.Combine(parent, "CustomVoice-installer-test-" + Guid.NewGuid().ToString("N")));
Directory.CreateDirectory(root);
try
{
    string payload = Path.Combine(root, "package", "CustomVoice.native"), plugins = Path.Combine(root, "BetterDiscord", "plugins"), data = Path.Combine(root, "BetterDiscord", "data");
    Directory.CreateDirectory(payload); Directory.CreateDirectory(plugins); Directory.CreateDirectory(data);
    string archive = Path.Combine(data, "betterdiscord.asar"); File.WriteAllBytes(archive, original);
    foreach (string name in new[] { "CustomVoice.Capture.exe", "CustomVoice.Publisher.exe", "CustomVoice.Capture.dll", "CustomVoice.Capture.runtimeconfig.json", "host-main.cjs", "host-preload.cjs", "audio-main.cjs", "github-main.cjs", "window-sources-main.cjs", "native-version.json", "coreclr.dll", "hostfxr.dll" }) File.WriteAllText(Path.Combine(payload, name), "fixture:" + name);
    Directory.CreateDirectory(Path.Combine(payload, "game-hook"));
    foreach (string name in new[] { "graphics-hook32.dll", "graphics-hook64.dll", "inject-helper32.exe", "inject-helper64.exe", "get-graphics-offsets32.exe", "get-graphics-offsets64.exe", "COPYING.txt", "NOTICE.txt", "OBS-Studio-32.0.4-Sources.tar.gz" }) File.WriteAllText(Path.Combine(payload, "game-hook", name), "fixture:" + name);
    File.WriteAllText(Path.Combine(root, "package", "CustomVoice.plugin.js"), "new plugin");
    File.WriteAllText(Path.Combine(plugins, "CustomVoice.plugin.js"), "old plugin");
    File.WriteAllText(Path.Combine(plugins, "CustomVoice.config.json"), "keep settings");
    Manifest(payload);
    string manifestPath = Path.Combine(payload, "manifest.json"), fullManifest = File.ReadAllText(manifestPath);
    var incomplete = JsonNode.Parse(fullManifest)!.AsArray();
    incomplete.Remove(incomplete.First(item => item!["name"]!.GetValue<string>() == "window-sources-main.cjs"));
    File.WriteAllText(manifestPath, incomplete.ToJsonString());
    try { NativeInstaller.Install(payload, plugins); throw new Exception("Accepted missing window source module"); } catch (InvalidDataException) { }
    Check(File.ReadAllBytes(archive).SequenceEqual(original), "Incomplete package modified the archive");
    File.WriteAllText(manifestPath, fullManifest);
    incomplete = JsonNode.Parse(fullManifest)!.AsArray();
    incomplete.Remove(incomplete.First(item => item!["name"]!.GetValue<string>() == "game-hook/graphics-hook32.dll"));
    File.WriteAllText(manifestPath, incomplete.ToJsonString());
    try { NativeInstaller.Install(payload, plugins); throw new Exception("Accepted missing 32-bit game hook"); } catch (InvalidDataException) { }
    Check(File.ReadAllBytes(archive).SequenceEqual(original), "Incomplete game capture package modified the archive");
    File.WriteAllText(manifestPath, fullManifest);
    NativeInstaller.Install(payload, plugins);
    Check(File.Exists(Path.Combine(plugins, "CustomVoice.native", "game-hook", "graphics-hook32.dll")), "Nested game capture files were not installed");
    Check(File.ReadAllText(Path.Combine(plugins, "CustomVoice.plugin.js")) == "new plugin", "Plugin was not copied");
    Check(File.ReadAllText(Path.Combine(plugins, "CustomVoice.config.json")) == "keep settings", "Settings were changed");
    Check(File.ReadAllBytes(archive).SequenceEqual(NativeInstaller.PatchArchive(original, Path.Combine(plugins, "CustomVoice.native"))), "Wrong install destination");
    Check(Directory.GetFiles(Path.Combine(data, "CustomVoice-install-backups"), "betterdiscord.asar", SearchOption.AllDirectories).Any(file => File.ReadAllBytes(file).SequenceEqual(original)), "Original archive backup is missing");
    Console.WriteLine("PASS: package install, hook destination, backups, settings preservation");
    string installedNative = Path.Combine(plugins, "CustomVoice.native"), hook = Path.Combine(installedNative, "game-hook", "graphics-hook64.dll");
    string sourceHook = Path.Combine(payload, "game-hook", "graphics-hook64.dll");
    File.SetLastWriteTimeUtc(hook, new DateTime(2020, 1, 1));
    DateTime hookWrite = File.GetLastWriteTimeUtc(hook);
    File.WriteAllText(Path.Combine(payload, "host-main.cjs"), "updated bridge"); Manifest(payload);
    using (var game = new FileStream(hook, FileMode.Open, FileAccess.Read, FileShare.Read))
        NativeInstaller.Install(payload, plugins);
    Check(File.GetLastWriteTimeUtc(hook) == hookWrite, "Unchanged loaded hook was rewritten");
    Check(File.ReadAllText(Path.Combine(installedNative, "host-main.cjs")) == "updated bridge", "Unchanged loaded hook blocked bridge update");
    File.WriteAllText(sourceHook, "changed hook");
    File.WriteAllText(Path.Combine(payload, "host-main.cjs"), "next bridge");
    File.WriteAllText(Path.Combine(payload, "native-version.json"), "next version"); Manifest(payload);
    using (var game = new FileStream(hook, FileMode.Open, FileAccess.Read, FileShare.Read))
    {
        try { NativeInstaller.Install(payload, plugins); throw new Exception("Overwrote a changed loaded hook"); }
        catch (NativeInstaller.FilesBusyException error) { Check(error.Message.Contains("graphics-hook64.dll"), "Waiting reason must identify the locked file"); }
        Check(File.ReadAllText(Path.Combine(installedNative, "host-main.cjs")) == "updated bridge", "Blocked update partially changed bridge");
        Check(File.ReadAllText(Path.Combine(installedNative, "native-version.json")) != "next version", "Blocked update advanced version");
    }
    NativeInstaller.Install(payload, plugins);
    Check(File.ReadAllText(hook) == "changed hook", "Released hook update did not resume");
    Check(File.ReadAllText(Path.Combine(installedNative, "native-version.json")) == "next version", "Completed update did not advance version");
    Console.WriteLine("PASS: unchanged loaded hook skipped; changed locked hook waits without partial writes and resumes");
    byte[] before = File.ReadAllBytes(archive);
    string executable = Path.Combine(plugins, "CustomVoice.native", "CustomVoice.Capture.exe");
    string previousExe = File.ReadAllText(executable);
    File.WriteAllText(Path.Combine(payload, "CustomVoice.Capture.exe"), "replacement"); Manifest(payload);
    using (var locked = new FileStream(Path.Combine(plugins, "CustomVoice.native", "coreclr.dll"), FileMode.Open, FileAccess.Read, FileShare.None))
    {
        try { NativeInstaller.Install(payload, plugins); throw new Exception("Accepted locked payload"); } catch (IOException) { }
    }
    Check(File.ReadAllText(executable) == previousExe, "Failure did not restore copied files");
    Check(File.ReadAllBytes(archive).SequenceEqual(before), "Failure modified the archive");
    File.WriteAllText(Path.Combine(payload, "manifest.json"), "[{\"name\":\"../outside\",\"sha256\":\"invalid\"}]");
    try { NativeInstaller.Install(payload, plugins); throw new Exception("Accepted path traversal"); } catch (InvalidDataException) { }
    Console.WriteLine("PASS: locked-file rollback and package path bounds");
}
finally
{
    // Delete only this test's newly created directory, never a supplied path.
    if (!root.StartsWith(Path.Combine(parent, "CustomVoice-installer-test-"), StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe test cleanup path");
    Directory.Delete(root, true);
}
if (args.Length == 1)
{
    byte[] actual = File.ReadAllBytes(args[0]);
    byte[] preview = NativeInstaller.PatchArchive(actual, native);
    Check(preview.Length > 16, "Actual archive preview is empty");
    Console.WriteLine("PASS: installed BetterDiscord archive read-only compatibility check");
}
