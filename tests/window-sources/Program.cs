// Snapshot tests only. Do not enumerate actual desktop windows.
static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}
var game = new WindowSources.Snapshot(123456789, "osu!", true, false, 0x10000000, 0, false, false, 0);
var normal = WindowSources.Select(game);
Check(normal?.id == "window:123456789:0" && normal.name == "osu!" && !normal.minimized, "Preserve the exact HWND for video and process audio.");
var minimized = WindowSources.Select(game with { Minimized = true, Style = 0x30000000 });
Check(minimized?.id == normal?.id && minimized?.minimized == true, "Alt-Tab/minimization must not remove the game from the picker.");
foreach (var excluded in new[] {
    game with { Handle = 0 }, game with { Visible = false }, game with { Cloaked = true },
    game with { DisplayAffinity = 0x11 }, game with { DisplayAffinity = 1 },
    game with { Style = 0x40000000 }, game with { ExtendedStyle = 0x80 },
    game with { ExtendedStyle = 0x08000000 }, game with { Owned = true }, game with { Title = "  " }
}) Check(WindowSources.Select(excluded) == null, "Hidden, protected, child or tool windows must not be offered.");
Check(WindowSources.Select(game with { Owned = true, ExtendedStyle = 0x40000 }) != null, "An explicit application window can have an owner.");
Check(WindowSources.Select(game with { Handle = 4294967297 })?.id == "window:4294967297:0", "Keep the full handle without 32-bit truncation.");
Console.WriteLine("PASS: normal/minimized application selection, exact HWND, and hidden/protected/tool-window filtering.");
