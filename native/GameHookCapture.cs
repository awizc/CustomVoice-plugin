using System.Diagnostics;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using Vortice.Direct3D11;
using Vortice.DXGI;

// Consumes OBS's published graphics-hook ABI in our own capture process.
// Only the selected game's render surface is read. Foreground/minimized state
// is deliberately irrelevant once attached; there is no desktop substitution.
internal sealed class GameHookCapture : IDisposable
{
    readonly nint window;
    readonly ID3D11Device device;
    readonly ID3D11DeviceContext context;
    readonly CancellationTokenSource stopped = new();
    Task<Session>? starting;
    Session? session;
    bool failed, disposed;
    long firstSurfaceDeadline;
    internal bool Active { get; private set; }
    internal string Backend => session?.Info.Type == 0 ? "GAME-HOOK-MEMORY" : "GAME-HOOK-D3D11";

    internal GameHookCapture(nint window, ID3D11Device device, ID3D11DeviceContext context)
    { this.window = window; this.device = device; this.context = context; }

    internal void StartOnce()
    {
        if (disposed || starting != null || failed) return;
        starting = Session.Start(window, stopped.Token);
        Program.Send(new { type = "game-hook", state = "starting", message = "게임 캡처 연결 중" });
    }

    internal bool TryRead(int fps, Action<ID3D11Texture2D, bool> consume)
    {
        if (disposed || failed || starting == null || !starting.IsCompleted) return false;
        try
        {
            if (session == null) { session = starting.GetAwaiter().GetResult(); firstSurfaceDeadline = Environment.TickCount64 + 15000; }
            bool read = session.TryRead(device, context, fps, consume);
            if (read) firstSurfaceDeadline = 0;
            else if (firstSurfaceDeadline != 0 && Environment.TickCount64 >= firstSurfaceDeadline)
                throw new TimeoutException("게임에서 캡처 프레임을 받지 못했습니다.");
            Active = session.HasSurface;
            return read;
        }
        catch (Exception error)
        {
            failed = true; Active = false; session?.Dispose(); session = null;
            Program.Send(new { type = "capture-warning", message = $"게임 캡처를 사용할 수 없어 창 캡처를 사용합니다. 알탭 중 영상은 중단될 수 있습니다. {error.Message}" });
            return false;
        }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true; stopped.Cancel();
        if (session != null) session.Dispose();
        else if (starting != null) _ = starting.ContinueWith(task => { if (task.IsCompletedSuccessfully) task.Result.Dispose(); else _ = task.Exception; }, TaskScheduler.Default);
        stopped.Dispose(); Active = false;
    }

    sealed class Session : IDisposable
    {
        readonly nint window, root;
        readonly uint pid;
        readonly Action checkTarget;
        readonly Func<uint, bool> acceptsWindow;
        SafeWaitHandle? keepAlive, process;
        EventWaitHandle? initialize, restart, ready, exit, stop;
        MemoryMappedFile? infoMap, dataMap;
        MemoryMappedViewAccessor? infoView, dataView;
        Mutex? mutex0, mutex1;
        ID3D11Texture2D? shared, copy;
        uint mapId;
        uint rejectedGpuMap;
        bool memoryFallback;
        bool ownsHook, disposed;
        internal GameHookInfo Info { get; private set; }
        internal bool HasSurface => copy != null;

        Session(nint window)
        {
            this.window = window; root = GetAncestor(window, 2);
            GetWindowThreadProcessId(window, out pid);
            if (root == 0 || pid == 0 || pid == Environment.ProcessId) throw new InvalidOperationException("선택한 게임 창이 유효하지 않습니다.");
            checkTarget = ValidateTarget;
            acceptsWindow = value => {
                nint handle = new((long)value);
                GetWindowThreadProcessId(handle, out uint owner);
                return owner == pid && GetAncestor(handle, 2) == root;
            };
        }

        internal static async Task<Session> Start(nint window, CancellationToken cancelled)
        {
            var result = new Session(window);
            try { await result.Initialize(cancelled); return result; }
            catch { result.Dispose(); throw; }
        }

        async Task Initialize(CancellationToken cancelled)
        {
            process = new SafeWaitHandle(OpenProcess(0x00101000, false, pid), true); // query limited + synchronize
            if (process.IsInvalid) throw new System.ComponentModel.Win32Exception();
            if (!IsWow64Process2(process, out ushort machine, out ushort nativeMachine) || nativeMachine != 0x8664 || machine is not (0 or 0x14c))
                throw new NotSupportedException("이 게임의 프로세스 형식을 지원하지 않습니다.");
            string arch = machine == 0x14c ? "32" : "64";
            string directory = Path.Combine(AppContext.BaseDirectory, "game-hook");
            var dll = Path.Combine(directory, $"graphics-hook{arch}.dll");
            if (!File.Exists(dll)) throw new FileNotFoundException("게임 캡처 구성요소를 포함한 전체 ZIP을 설치해 주세요.");
            byte[] offsets = GameHookProtocol.ParseOffsets(await Run(Path.Combine(directory, $"get-graphics-offsets{arch}.exe"), [], cancelled));
            cancelled.ThrowIfCancellationRequested(); ValidateTarget();

            // Never reconfigure or stop another OBS-compatible capture owner.
            keepAlive = new SafeWaitHandle(CreateMutexW(0, false, $"CaptureHook_KeepAlive{pid}"), true);
            int lastError = Marshal.GetLastWin32Error();
            if (keepAlive.IsInvalid || lastError == 183) throw new InvalidOperationException("다른 프로그램에서 이 게임을 캡처 중입니다.");
            ownsHook = true;
            if (!EventWaitHandle.TryOpenExisting($"CaptureHook_Restart{pid}", out restart))
                await Run(Path.Combine(directory, $"inject-helper{arch}.exe"), [dll, "0", pid.ToString(System.Globalization.CultureInfo.InvariantCulture)], cancelled);

            for (int attempt = 0; attempt < 80; attempt++)
            {
                cancelled.ThrowIfCancellationRequested(); ValidateTarget();
                try { infoMap = MemoryMappedFile.OpenExisting($"CaptureHook_HookInfo{pid}", MemoryMappedFileRights.ReadWrite); break; }
                catch (FileNotFoundException) { await Task.Delay(100, cancelled); }
            }
            if (infoMap == null) throw new TimeoutException("게임 캡처 후크가 응답하지 않습니다.");
            infoView = infoMap.CreateViewAccessor(0, 648, MemoryMappedFileAccess.ReadWrite);
            initialize = EventWaitHandle.OpenExisting($"CaptureHook_Initialize{pid}");
            restart ??= EventWaitHandle.OpenExisting($"CaptureHook_Restart{pid}");
            ready = EventWaitHandle.OpenExisting($"CaptureHook_HookReady{pid}");
            exit = EventWaitHandle.OpenExisting($"CaptureHook_Exit{pid}");
            stop = EventWaitHandle.OpenExisting($"CaptureHook_Stop{pid}");
            mutex0 = Mutex.OpenExisting($"CaptureHook_TextureMutex1{pid}");
            mutex1 = Mutex.OpenExisting($"CaptureHook_TextureMutex2{pid}");
            infoView.WriteArray(68, offsets, 0, offsets.Length);
            infoView.Write(56, 1_000_000_000UL / 165);
            infoView.Write(64, (byte)0); infoView.Write(65, (byte)0); // no scaling, prefer shared GPU texture
            infoView.Write(66, (byte)0); infoView.Write(67, (byte)1); // no third-party overlays; permit sRGB alias
            cancelled.ThrowIfCancellationRequested(); ValidateTarget();
            stop.Reset(); restart.Set(); initialize.Set();
        }

        static async Task<string> Run(string path, string[] arguments, CancellationToken cancelled)
        {
            var start = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(path)! };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var child = Process.Start(start) ?? throw new InvalidOperationException("게임 캡처 도우미 실행에 실패했습니다.");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancelled);
            timeout.CancelAfter(TimeSpan.FromSeconds(10));
            var output = child.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = child.StandardError.ReadToEndAsync(timeout.Token);
            try
            {
                await child.WaitForExitAsync(timeout.Token);
                if (child.ExitCode != 0) throw new InvalidOperationException($"게임 캡처 도우미 오류: {child.ExitCode}");
                await errors; return await output;
            }
            finally { if (!child.HasExited) child.Kill(); }
        }

        void ValidateTarget()
        {
            GetWindowThreadProcessId(window, out uint current);
            if (current != pid || GetAncestor(window, 2) != root || process is { IsInvalid: false } && WaitForSingleObject(process, 0) == 0)
                throw new InvalidOperationException("공유하던 게임이 종료되었습니다.");
        }

        internal unsafe bool TryRead(ID3D11Device device, ID3D11DeviceContext context, int fps, Action<ID3D11Texture2D, bool> consume)
        {
            checkTarget();
            if (exit!.WaitOne(0)) { ClearSurface(); restart!.Set(); return false; }
            infoView!.Write(56, 1_000_000_000UL / (ulong)Math.Clamp(fps, 1, 165));
            bool changed = ready!.WaitOne(0);
            infoView.Read(0, out GameHookInfo current);
            if (changed || current.MapId != mapId) ClearSurface();
            if (!GameHookProtocol.Valid(current)) { ClearSurface(); return false; }
            if (current.MapId == rejectedGpuMap) return false;
            // A process may own multiple windows; never accept another window's surface.
            if (!acceptsWindow(current.Window)) { ClearSurface(); return false; }
            if (dataView == null)
            {
                try { dataMap = MemoryMappedFile.OpenExisting($"CaptureHook_Texture_{(ulong)root.ToInt64()}_{current.MapId}", MemoryMappedFileRights.Read); }
                catch (FileNotFoundException) { return false; }
                try
                {
                    dataView = dataMap.CreateViewAccessor(0, current.MapSize, MemoryMappedFileAccess.Read);
                    Info = current; mapId = current.MapId;
                    var format = current.Format switch { 29u => Format.R8G8B8A8_UNorm, 90u or 91u => Format.B8G8R8A8_UNorm, 93u => Format.B8G8R8X8_UNorm, _ => (Format)current.Format };
                    copy = device.CreateTexture2D(new Texture2DDescription { Width = current.Width, Height = current.Height, MipLevels = 1, ArraySize = 1, Format = format,
                        SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget });
                    if (current.Type == 1)
                    {
                        uint handle = dataView.ReadUInt32(0);
                        if (handle == 0) throw new InvalidDataException("게임 GPU 버퍼가 비어 있습니다.");
                        try { shared = device.OpenSharedResource<ID3D11Texture2D>(new nint((long)handle)); }
                        catch when (!memoryFallback)
                        {
                            // Hybrid-GPU/OpenGL interoperability may not share
                            // this surface with our adapter. Ask the same hook
                            // for its synchronized CPU buffers, once.
                            memoryFallback = true; rejectedGpuMap = current.MapId;
                            infoView.Write(65, (byte)1); stop!.Set(); restart!.Set();
                            ClearSurface(); return false;
                        }
                        var desc = shared.Description;
                        if (desc.Width != current.Width || desc.Height != current.Height || desc.SampleDescription.Count != 1 ||
                            !CompatibleFormat(desc.Format, format)) throw new InvalidDataException("게임 GPU 버퍼 정보가 일치하지 않습니다.");
                    }
                }
                catch { ClearSurface(); throw; }
            }
            if (current.Width != Info.Width || current.Height != Info.Height || current.Format != Info.Format || current.Type != Info.Type) { ClearSurface(); return false; }
            if (shared != null) context.CopyResource(copy!, shared);
            else
            {
                int index = dataView.ReadInt32(0);
                if (index is not (0 or 1)) return false;
                var mutex = index == 0 ? mutex0! : mutex1!;
                bool acquired;
                try { acquired = mutex.WaitOne(0); } catch (AbandonedMutexException) { mutex.ReleaseMutex(); return false; }
                if (!acquired) return false;
                try
                {
                    uint offset = dataView.ReadUInt32(index == 0 ? 4 : 8);
                    if (!GameHookProtocol.ValidBuffer(Info, offset)) throw new InvalidDataException("게임 메모리 버퍼 영역이 유효하지 않습니다.");
                    byte* pointer = null;
                    dataView.SafeMemoryMappedViewHandle.AcquirePointer(ref pointer);
                    try { context.UpdateSubresource(copy!, 0, null, (nint)(pointer + dataView.PointerOffset + offset), Info.Pitch, 0); }
                    finally { dataView.SafeMemoryMappedViewHandle.ReleasePointer(); }
                }
                finally { mutex.ReleaseMutex(); }
            }
            consume(copy!, Info.Flip != 0); context.Flush(); return true;
        }

        static bool CompatibleFormat(Format actual, Format expected) => actual == expected || expected switch {
            Format.R8G8B8A8_UNorm => actual is Format.R8G8B8A8_UNorm_SRgb or Format.R8G8B8A8_Typeless,
            Format.B8G8R8A8_UNorm => actual is Format.B8G8R8A8_UNorm_SRgb or Format.B8G8R8A8_Typeless,
            Format.B8G8R8X8_UNorm => actual is Format.B8G8R8X8_UNorm_SRgb or Format.B8G8R8X8_Typeless, _ => false };

        void ClearSurface()
        {
            copy?.Dispose(); copy = null; shared?.Dispose(); shared = null;
            dataView?.Dispose(); dataView = null; dataMap?.Dispose(); dataMap = null; mapId = 0;
        }
        public void Dispose()
        {
            if (disposed) return; disposed = true;
            if (ownsHook)
            {
                // Initialization may have been cancelled before opening stop.
                if (stop == null) EventWaitHandle.TryOpenExisting($"CaptureHook_Stop{pid}", out stop);
                stop?.Set();
            }
            ClearSurface(); infoView?.Dispose(); infoMap?.Dispose();
            initialize?.Dispose(); restart?.Dispose(); ready?.Dispose(); exit?.Dispose(); stop?.Dispose();
            mutex0?.Dispose(); mutex1?.Dispose(); keepAlive?.Dispose(); process?.Dispose();
        }
    }

    [DllImport("user32.dll")] static extern nint GetAncestor(nint window, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern nint OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process2(SafeWaitHandle process, out ushort processMachine, out ushort nativeMachine);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern nint CreateMutexW(nint attributes, bool owner, string name);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeWaitHandle handle, uint timeout);
}
