using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

internal static class WindowSources
{
    internal readonly record struct Snapshot(long Handle, string Title, bool Visible, bool Minimized,
        uint Style, uint ExtendedStyle, bool Owned, bool Cloaked, uint DisplayAffinity);
    internal sealed record Source(string id, string name, bool minimized);

    internal static Source? Select(Snapshot window)
    {
        const uint child = 0x40000000, toolWindow = 0x80, noActivate = 0x08000000, appWindow = 0x40000;
        if (window.Handle <= 0 || !window.Visible || window.Cloaked || window.DisplayAffinity != 0 ||
            (window.Style & child) != 0 || (window.ExtendedStyle & (toolWindow | noActivate)) != 0 ||
            window.Owned && (window.ExtendedStyle & appWindow) == 0 || string.IsNullOrWhiteSpace(window.Title)) return null;
        // Do not require a thumbnail, a nonzero client size, or !IsIconic:
        // exclusive fullscreen games can minimize when the picker takes focus.
        return new Source($"window:{window.Handle}:0", window.Title.Trim(), window.Minimized);
    }

    internal static List<Source> List()
    {
        var sources = new List<Source>();
        nint shell = GetShellWindow(), desktop = GetDesktopWindow();
        bool complete = EnumWindows((window, _) =>
        {
            if (window == shell || window == desktop || !IsWindowVisible(window)) return true;
            var title = new StringBuilder(513);
            if (GetWindowText(window, title, title.Capacity) == 0) return true;
            uint cloaked = 0;
            DwmGetWindowAttribute(window, 14 /* DWMWA_CLOAKED */, out cloaked, sizeof(uint));
            GetWindowDisplayAffinity(window, out var affinity);
            var source = Select(new Snapshot(window.ToInt64(), title.ToString(), true, IsIconic(window),
                unchecked((uint)GetWindowLong(window, -16)), unchecked((uint)GetWindowLong(window, -20)),
                GetWindow(window, 4 /* GW_OWNER */) != 0, cloaked != 0, affinity));
            if (source != null) sources.Add(source);
            return sources.Count < 256;
        }, 0);
        if (!complete && sources.Count < 256) throw new Win32Exception(Marshal.GetLastWin32Error(), "공유할 창 목록을 읽지 못했습니다.");
        return sources;
    }

    delegate bool WindowCallback(nint window, nint data);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool EnumWindows(WindowCallback callback, nint data);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsIconic(nint window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(nint window, StringBuilder title, int count);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(nint window, int index);
    [DllImport("user32.dll")] static extern nint GetWindow(nint window, uint command);
    [DllImport("user32.dll")] static extern nint GetShellWindow();
    [DllImport("user32.dll")] static extern nint GetDesktopWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetWindowDisplayAffinity(nint window, out uint affinity);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint window, uint attribute, out uint value, int size);
}
