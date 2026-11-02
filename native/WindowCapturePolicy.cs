using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowCapturePolicy
{
    // Recognize game windows, not generic Chromium/D3D windows. Existing
    // full-screen detection remains available for other render engines.
    internal static bool IsGame(string process, string windowClass) =>
        process.Equals("osu!", StringComparison.OrdinalIgnoreCase) ||
        process.Equals("osu", StringComparison.OrdinalIgnoreCase) ||
        windowClass is "SDL_app" or "UnityWndClass" or "UnrealWindow" ||
        windowClass.StartsWith("GLFW", StringComparison.Ordinal) ||
        windowClass.StartsWith("LWJGL", StringComparison.Ordinal);
    internal static bool PreferGameHook(nint window)
    {
        if (window == 0) return false;
        try
        {
            var name = new StringBuilder(256); GetClassNameW(window, name, name.Capacity);
            GetWindowThreadProcessId(window, out uint pid);
            using var process = Process.GetProcessById(checked((int)pid));
            return IsGame(process.ProcessName, name.ToString());
        }
        catch { return false; }
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(nint window, StringBuilder name, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window, out uint pid);
}
