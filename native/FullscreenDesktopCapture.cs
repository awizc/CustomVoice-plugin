using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Windows.Graphics;

// Automatic foreground/fullscreen path. Monitor pixels may include overlays;
// audio remains bound to the HWND selected in the application picker.
internal sealed class FullscreenDesktopCapture : IDisposable
{
    readonly nint window, root;
    readonly uint processId;
    readonly ID3D11Device device;
    IDXGIOutputDuplication? duplication;
    nint monitor;
    long nextAttempt, lastWarning;
    bool firstImage;
    internal long Epoch { get; private set; }

    internal FullscreenDesktopCapture(nint window, ID3D11Device device)
    {
        this.window = window; this.device = device;
        root = GetAncestor(window, 2);
        GetWindowThreadProcessId(window, out processId);
        if (root == 0 || processId == 0) throw new InvalidOperationException("선택한 게임 창을 찾지 못했습니다.");
    }

    internal static nint WindowFromSource(string source) => source.StartsWith("window:", StringComparison.Ordinal) && long.TryParse(source.Split(':')[1], out var value) ? new nint(value) : 0;
    internal static bool IsMinimized(nint window) => window != 0 && IsIconic(GetAncestor(window, 2));
    internal static IDXGIAdapter1? AdapterFor(nint window)
    {
        nint target = MonitorFromWindow(window, 2);
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint index = 0; factory.EnumAdapters1(index, out var adapter).Success; index++)
        {
            bool found = false;
            try
            {
                for (uint outputIndex = 0; adapter.EnumOutputs(outputIndex, out var output).Success; outputIndex++)
                    using (output) if (output.Description.Monitor == target) { found = true; return adapter; }
            }
            finally { if (!found) adapter.Dispose(); }
        }
        throw new InvalidOperationException("게임이 있는 모니터의 GPU를 찾지 못했습니다.");
    }

    internal static SizeInt32 MonitorSize(nint window)
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref info)) throw new InvalidOperationException("게임 모니터를 찾지 못했습니다.");
        return new SizeInt32 { Width = info.Monitor.Right - info.Monitor.Left, Height = info.Monitor.Bottom - info.Monitor.Top };
    }

    internal static RectI? ClientRegion(nint window, SizeInt32 surface)
    {
        if (IsMinimized(window)) return null;
        if (!GetClientRect(window, out var client) || client.Right < 2 || client.Bottom < 2) return null;
        var origin = new Point();
        if (!ClientToScreen(window, ref origin)) return null;
        // WGC normally uses DWM's extended frame bounds, without the invisible
        // resize margin. Only use GetWindowRect when it matches the surface.
        var result = DwmGetWindowAttribute(window, 9, out var bounds, Marshal.SizeOf<Rect>());
        if (result != 0 || Math.Abs(bounds.Right - bounds.Left - surface.Width) > 2 || Math.Abs(bounds.Bottom - bounds.Top - surface.Height) > 2)
        {
            if (!GetWindowRect(window, out var alternate) || Math.Abs(alternate.Right - alternate.Left - surface.Width) > 2 || Math.Abs(alternate.Bottom - alternate.Top - surface.Height) > 2) return null;
            bounds = alternate;
        }
        return CaptureGeometry.ClipClientRegion(surface.Width, surface.Height,
            (long)origin.X - bounds.Left, (long)origin.Y - bounds.Top, client.Right, client.Bottom);
    }

    nint EligibleMonitor()
    {
        GetWindowThreadProcessId(window, out var currentPid);
        if (currentPid != processId || !IsWindow(window)) throw new InvalidOperationException("선택한 게임 창이 종료되거나 다른 창으로 바뀌었습니다.");
        if (!IsWindowVisible(window) || IsIconic(root) || GetAncestor(GetForegroundWindow(), 2) != root) return 0;
        if (!GetClientRect(window, out var client)) return 0;
        var origin = new Point(); if (!ClientToScreen(window, ref origin)) return 0;
        nint target = MonitorFromWindow(window, 2);
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        if (!GetMonitorInfo(target, ref info)) return 0;
        var rect = info.Monitor;
        return Math.Abs(origin.X - rect.Left) <= 2 && Math.Abs(origin.Y - rect.Top) <= 2 &&
            Math.Abs(origin.X + client.Right - rect.Right) <= 2 && Math.Abs(origin.Y + client.Bottom - rect.Bottom) <= 2 ? target : 0;
    }

    internal bool UpdateTarget()
    {
        nint target = EligibleMonitor();
        if (target != monitor)
        {
            Invalidate(); monitor = target;
            nextAttempt = Environment.TickCount64 + 250;
        }
        return monitor != 0;
    }
    internal bool StillEligible() => monitor != 0 && EligibleMonitor() == monitor;
    internal void Invalidate() { duplication?.Dispose(); duplication = null; Epoch++; }

    internal bool TryRead(Action<ID3D11Texture2D> consume)
    {
        if (!StillEligible() || Environment.TickCount64 < nextAttempt) return false;
        try
        {
            if (duplication == null)
            {
                using var dxgiDevice = device.QueryInterface<IDXGIDevice>();
                dxgiDevice.GetAdapter(out var adapter).CheckError();
                using (adapter)
                {
                    for (uint index = 0; adapter.EnumOutputs(index, out var output).Success; index++)
                        using (output)
                        {
                            if (output.Description.Monitor != monitor) continue;
                            if (output.Description.Rotation is not (ModeRotation.Identity or ModeRotation.Unspecified)) throw new NotSupportedException("회전한 모니터에서는 게임 호환 캡처를 지원하지 않습니다.");
                            using var output1 = output.QueryInterface<IDXGIOutput1>();
                            duplication = output1.DuplicateOutput(device); firstImage = true; break;
                        }
                }
                if (duplication == null) throw new InvalidOperationException("게임이 다른 GPU의 모니터로 이동했습니다. 화면 공유를 다시 시작해 주세요.");
            }
            // Never block the pacing thread waiting for a frame.
            var acquired = duplication.AcquireNextFrame(0, out var info, out var resource);
            if (acquired.Code == unchecked((int)0x887A0027)) { resource?.Dispose(); return false; } // WAIT_TIMEOUT
            if (acquired.Failure) { resource?.Dispose(); acquired.CheckError(); }
            try
            {
                using (resource)
                {
                    if (resource == null) throw new InvalidDataException("게임 캡처에서 GPU 프레임을 받지 못했습니다.");
                    // The first snapshot may depict a static fullscreen app.
                    // Accept it after the focus-settle delay; later pointer-only
                    // updates do not count as new application image frames.
                    if (!firstImage && info.LastPresentTime == 0 || !StillEligible()) return false;
                    using var texture = resource.QueryInterface<ID3D11Texture2D>();
                    consume(texture); firstImage = false; return true;
                }
            }
            finally { duplication.ReleaseFrame().CheckError(); }
        }
        catch (Exception error)
        {
            // Exclusive-mode and Alt-Tab transitions invalidate duplication.
            // Recreate it with bounded retries, without retaining its frame.
            Invalidate(); nextAttempt = Environment.TickCount64 + 1000;
            if (lastWarning == 0 || Environment.TickCount64 - lastWarning >= 30000)
            {
                lastWarning = Environment.TickCount64;
                Program.Send(new { type = "capture-warning", message = $"전체 화면 게임 호환 캡처를 재연결합니다. (0x{error.HResult:X8}) {error.Message}" });
            }
            return false;
        }
    }
    public void Dispose() => Invalidate();

    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] static extern nint MonitorFromWindow(nint window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindow(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindowVisible(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsIconic(nint window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetClientRect(nint window, out Rect rect);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetWindowRect(nint window, out Rect rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(nint window, uint attribute, out Rect rect, int size);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool ClientToScreen(nint window, ref Point point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);
}
