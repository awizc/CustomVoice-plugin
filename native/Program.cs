using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Windows.Foundation.Metadata;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;
using Windows.Security.Authorization.AppCapabilityAccess;
using static Vortice.Direct3D11.D3D11;

// Private stdin/stdout protocol. Only texture handles and timestamps cross the
// pipe; captured pixels stay on the GPU. No listener, recording, or network IO.
internal static class Program
{
    static readonly object OutputLock = new();
    internal static void Send(object value)
    {
        lock (OutputLock) { Console.WriteLine(JsonSerializer.Serialize(value)); Console.Out.Flush(); }
    }

    [MTAThread]
    static async Task<int> Main(string[] args)
    {
        Capture? capture = null;
        try
        {
            if (args.Length == 1 && args[0] == "--store-update-token") { GithubUpdate.Save(); return 0; }
            if (args.Length == 1 && args[0] == "--update-source") { await GithubUpdate.Fetch(); return 0; }
            if (args.Length == 1 && args[0] == "--native-update-check") { await NativeUpdate.Check(); return 0; }
            if (args.Length == 1 && args[0] == "--native-update-prepare") { await NativeUpdate.Prepare(); return 0; }
            if (args.Length == 1 && args[0] == "--native-update-status") { Program.Send(NativeUpdate.Status()); return 0; }
            if (args.Length == 1 && args[0] == "--apply-native-update") return await NativeUpdate.ApplyAfterExit();
            if (args.Length == 3 && args[0] == "--process-audio") return ProcessAudio.Run(int.Parse(args[1]), args[2]);
            if (args.Length == 1 && args[0] is "--install" or "--remove")
                return NativeInstaller.Run(args[0] == "--remove");
            Native.SetProcessDpiAwarenessContext(new nint(-4));
            if (args.Length == 1 && args[0] == "--check")
            {
                Send(new { type = "capabilities", supported = GraphicsCaptureSession.IsSupported(), minUpdateInterval = ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "MinUpdateInterval"), runtimePath = typeof(object).Assembly.Location });
                return 0;
            }
            if (args.Length != 4) throw new ArgumentException("Expected: parentPid sourceId fps quality");
            using var parent = Process.GetProcessById(int.Parse(args[0]));
            using var ended = new CancellationTokenSource();
            parent.EnableRaisingEvents = true;
            parent.Exited += (_, _) => ended.Cancel();
            capture = new Capture(parent.Id, args[1], int.Parse(args[2]), args[3], () => ended.Cancel());
            capture.Start();
            while (!ended.IsCancellationRequested)
            {
                var line = await Console.In.ReadLineAsync(ended.Token);
                if (line == null) break;
                if (line.Length > 4096) throw new InvalidDataException("Control message too large");
                using var doc = JsonDocument.Parse(line);
                var message = doc.RootElement;
                switch (message.GetProperty("type").GetString())
                {
                    case "release": capture.Release(message.GetProperty("slot").GetInt32(), message.GetProperty("sequence").GetInt64()); break;
                    case "configure": capture.Configure(message.GetProperty("fps").GetInt32(), message.GetProperty("quality").GetString()!, message.GetProperty("request").GetInt32()); break;
                    case "pace": capture.SetPacing(message.GetProperty("fps").GetDouble()); break;
                    case "border": _ = capture.SetBorderAsync(message.GetProperty("visible").GetBoolean(), message.GetProperty("request").GetInt32(), ended.Token); break;
                    case "stop": ended.Cancel(); break;
                    default: throw new InvalidDataException("Unknown control message");
                }
            }
            return 0;
        }
        catch (OperationCanceledException) { return 0; }
        catch (Exception error) { Send(new { type = "error", message = error.Message }); return 1; }
        finally { capture?.Dispose(); }
    }
}

internal sealed class Capture : IDisposable
{
    readonly object gate = new();
    readonly Action stop;
    readonly nint parentHandle;
    readonly GraphicsCaptureItem item;
    readonly ID3D11Device device;
    readonly ID3D11DeviceContext context;
    readonly ID3D11VideoDevice videoDevice;
    readonly ID3D11VideoContext videoContext;
    readonly IDirect3DDevice winrtDevice;
    readonly Direct3D11CaptureFramePool pool;
    readonly GraphicsCaptureSession session;
    readonly CaptureBorder border;
    // Bounded GPU pool: hardware encoders may retain several frames. Eight NV12
    // 1080p surfaces use about 24 MiB of GPU memory, without a CPU frame queue.
    readonly Slot[] slots = Enumerable.Range(0, 8).Select(i => new Slot(i)).ToArray();
    ID3D11VideoProcessorEnumerator? enumerator;
    ID3D11VideoProcessor? processor;
    SizeInt32 inputSize;
    int outputWidth, outputHeight, fps;
    string quality;
    double pacingFps, pacingUpdated;
    readonly ManualResetEvent outputStopped = new(false);
    Thread? outputThread;
    Direct3D11CaptureFrame? retainedFrame;
    ID3D11Texture2D? cachedTexture;
    ID3D11VideoProcessorOutputView? cachedView;
    bool cachedReady;
    long revision, lastOutputRevision = -1, repeated;
    long sourceRevision, cachedSourceRevision = -1, conversions, gpuContentions;
    long sequence;
    bool disposed;
    long frames, dropped, captured;
    long outputAttempts, outputOverruns;
    double outputWorkUs;
    readonly Stopwatch statsClock = Stopwatch.StartNew();
    long statsTime;

    public Capture(int parentPid, string source, int frameRate, string resolution, Action onStop)
    {
        Validate(frameRate, resolution);
        fps = frameRate; pacingFps = frameRate; quality = resolution; stop = onStop;
        parentHandle = Native.OpenProcess(0x0040, false, parentPid);
        if (parentHandle == 0) throw new System.ComponentModel.Win32Exception();
        // Select the same HWND/device index selected in Discord's source picker.
        item = Native.CreateItem(source);
        inputSize = item.Size;
        D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
            new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 }, out device, out context).CheckError();
        using (var threaded = context.QueryInterface<ID3D11Multithread>()) threaded.SetMultithreadProtected(true);
        videoDevice = device.QueryInterface<ID3D11VideoDevice>();
        videoContext = context.QueryInterface<ID3D11VideoContext>();
        using (var dxgiDevice = device.QueryInterface<IDXGIDevice>())
        {
            Marshal.ThrowExceptionForHR(Native.CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out var ptr));
            try { winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(ptr); }
            finally { Marshal.Release(ptr); }
        }
        // Retain one source frame for quality changes; two buffers remain free
        // for WGC. Repeated output reuses a separate NV12 GPU texture.
        pool = Direct3D11CaptureFramePool.CreateFreeThreaded(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, inputSize);
        session = pool.CreateCaptureSession(item);
        if (!ApiInformation.IsPropertyPresent("Windows.Graphics.Capture.GraphicsCaptureSession", "MinUpdateInterval"))
            throw new PlatformNotSupportedException("High-FPS capture requires Windows 11 24H2 or later.");
        session.MinUpdateInterval = TimeSpan.FromMilliseconds(1);
        if (session.MinUpdateInterval.TotalMilliseconds > 1.1) throw new InvalidOperationException("Windows did not accept the 1 ms capture interval.");
        // Border hiding uses Windows' consent API; cursor capture is unchanged.
        border = new CaptureBorder(async () =>
            await GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless) == AppCapabilityAccessStatus.Allowed,
            visible => { lock (gate) { if (disposed) throw new ObjectDisposedException(nameof(Capture)); session.IsBorderRequired = visible; } });
        RebuildProcessor();
        item.Closed += OnClosed;
        pool.FrameArrived += OnFrame;
    }

    public void Start()
    {
        Program.Send(new { type = "ready", protocol = 1, width = outputWidth, height = outputHeight, sourceWidth = inputSize.Width, sourceHeight = inputSize.Height, fps, intervalMs = session.MinUpdateInterval.TotalMilliseconds, backend = "WGC-D3D11", cadence = "paced", adaptivePacing = true, borderControl = true, borderVisible = true });
        session.StartCapture();
        outputThread = new Thread(OutputLoop) { IsBackground = true, Name = "CustomVoice GPU frame pacing" };
        outputThread.Start();
    }

    static void Validate(int rate, string resolution)
    {
        if (rate is not (15 or 30 or 60 or 90 or 120 or 144 or 165)) throw new ArgumentOutOfRangeException(nameof(rate));
        if (resolution is not ("720p" or "1080p" or "1440p" or "source")) throw new ArgumentOutOfRangeException(nameof(resolution));
    }

    public void Configure(int rate, string resolution, int request)
    {
        Validate(rate, resolution);
        lock (gate)
        {
            if (disposed) return;
            fps = rate; pacingFps = rate; pacingUpdated = 0; quality = resolution;
            RebuildProcessor();
            if (retainedFrame != null) UpdateCache(retainedFrame);
            Program.Send(new { type = "configured", request, width = outputWidth, height = outputHeight, sourceWidth = inputSize.Width, sourceHeight = inputSize.Height, fps });
        }
    }

    public void SetPacing(double rate)
    {
        if (!double.IsFinite(rate) || rate < 1 || rate > 165) return;
        lock (gate)
        {
            pacingFps = Math.Min(rate, fps);
            pacingUpdated = Microseconds();
        }
    }

    public async Task SetBorderAsync(bool visible, int request, CancellationToken stopped)
    {
        // Do not await this from the stdin loop: frame release and stop messages
        // must keep flowing while Windows is displaying a permission prompt.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(stopped);
        timeout.CancelAfter(TimeSpan.FromSeconds(25));
        var result = await border.SetAsync(visible, timeout.Token);
        try { Program.Send(new { type = "border", request, result.borderStatus, result.borderVisible, result.message }); }
        catch { /* The owner may already have closed its pipe. */ }
    }

    double EffectiveFps(double now) => pacingUpdated != 0 && now - pacingUpdated < 10e6 ? pacingFps : fps;

    void RebuildProcessor()
    {
        var targetWidth = quality == "1440p" ? 2560 : quality == "1080p" ? 1920 : 1280;
        var targetHeight = quality == "1440p" ? 1440 : quality == "1080p" ? 1080 : 720;
        var scale = quality == "source" ? 1 : Math.Min(1, Math.Min((double)targetWidth / inputSize.Width, (double)targetHeight / inputSize.Height));
        // NV12 uses 2x2 chroma blocks. Only remove an odd edge pixel, never lower
        // the requested preset or upscale a smaller source.
        outputWidth = Math.Max(2, (int)(inputSize.Width * scale) & ~1);
        outputHeight = Math.Max(2, (int)(inputSize.Height * scale) & ~1);
        cachedReady = false;
        cachedSourceRevision = -1;
        cachedView?.Dispose(); cachedTexture?.Dispose();
        cachedView = null; cachedTexture = null;
        processor?.Dispose(); enumerator?.Dispose();
        enumerator = videoDevice.CreateVideoProcessorEnumerator(new VideoProcessorContentDescription
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputFrameRate = new Rational((uint)fps, 1), OutputFrameRate = new Rational((uint)fps, 1),
            InputWidth = (uint)inputSize.Width, InputHeight = (uint)inputSize.Height,
            OutputWidth = (uint)outputWidth, OutputHeight = (uint)outputHeight,
            Usage = VideoUsage.PlaybackNormal
        });
        processor = videoDevice.CreateVideoProcessor(enumerator, 0);
        videoContext.VideoProcessorSetStreamFrameFormat(processor, 0, VideoFrameFormat.Progressive);
        videoContext.VideoProcessorSetStreamAutoProcessingMode(processor, 0, false);
        videoContext.VideoProcessorSetStreamSourceRect(processor, 0, true, new RectI(0, 0, inputSize.Width, inputSize.Height));
        videoContext.VideoProcessorSetStreamDestRect(processor, 0, true, new RectI(0, 0, outputWidth, outputHeight));
        videoContext.VideoProcessorSetOutputTargetRect(processor, true, new RectI(0, 0, outputWidth, outputHeight));
        using var colors = videoContext.QueryInterface<ID3D11VideoContext1>();
        colors.VideoProcessorSetStreamColorSpace1(processor, 0, ColorSpaceType.RgbFullG22NoneP709);
        colors.VideoProcessorSetOutputColorSpace1(processor, ColorSpaceType.YcbcrStudioG22LeftP709);
        cachedTexture = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)outputWidth, Height = (uint)outputHeight, MipLevels = 1, ArraySize = 1,
            Format = Format.NV12, SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource
        });
        cachedView = videoDevice.CreateVideoProcessorOutputView(cachedTexture, enumerator, new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D });
    }

    void UpdateCache(Direct3D11CaptureFrame frame)
    {
        using var source = Native.GetTexture(frame.Surface);
        using var inputView = videoDevice.CreateVideoProcessorInputView(source, enumerator!, new VideoProcessorInputViewDescription { ViewDimension = VideoProcessorInputViewDimension.Texture2D });
        videoContext.VideoProcessorBlt(processor!, cachedView!, 0, new[] { new VideoProcessorStream { Enable = true, InputSurface = inputView } }).CheckError();
        cachedReady = true; cachedSourceRevision = sourceRevision; revision++; conversions++;
    }

    static double Microseconds() => Stopwatch.GetTimestamp() * 1e6 / Stopwatch.Frequency;

    void Fail(Exception error)
    {
        try { Program.Send(new { type = "error", message = error.Message }); } catch { }
        stop();
    }

    void OutputLoop()
    {
        try
        {
            // A high-resolution waitable timer sleeps between output deadlines;
            // no busy-spin or system-wide timer-resolution override is needed.
            using var timer = new PacingTimer();
            var waits = new WaitHandle[] { outputStopped, timer };
            double deadline = Microseconds();
            while (!outputStopped.WaitOne(0))
            {
                var now = Microseconds();
                if (now < deadline)
                {
                    timer.Arm(deadline - now);
                    if (WaitHandle.WaitAny(waits) == 0) break;
                    continue;
                }
                double step;
                lock (gate)
                {
                    if (disposed) return;
                    step = 1e6 / EffectiveFps(now);
                    if ((cachedReady || retainedFrame != null) && !TryOutputFrame(now)) dropped++;
                    if (statsClock.ElapsedMilliseconds - statsTime >= 2000)
                    {
                        Program.Send(new { type = "stats", captured, frames, dropped, repeated, conversions, gpuContentions, outputAttempts, outputOverruns, outputWorkUs, pacingFps = EffectiveFps(now), elapsedMs = statsClock.ElapsedMilliseconds });
                        statsTime = statsClock.ElapsedMilliseconds;
                    }
                }
                var completed = Microseconds();
                outputAttempts++; outputWorkUs += completed - now;
                if (completed - now >= step) outputOverruns++;
                deadline = FramePacer.NextDeadline(deadline, now, completed, step);
            }
        }
        catch (Exception error) { Fail(error); }
    }

    bool TryOutputFrame(double now)
    {
        foreach (var slot in slots)
        {
            if (slot.Busy) continue;
            EnsureSlot(slot);
            var acquired = Native.AcquireKeyedMutex(slot.Mutex!.NativePointer);
            if (acquired != 0)
            {
                // WAIT_TIMEOUT/WAIT_ABANDONED are non-negative HRESULTs.
                // Never overwrite or release a surface we did not acquire.
                Marshal.ThrowExceptionForHR(acquired); gpuContentions++;
                if (acquired == 0x80) slot.Clear(parentHandle);
                continue;
            }
            try
            {
                // WGC callbacks only retain the newest source. Perform one GPU
                // conversion when output has a free surface, not for every
                // captured frame that an overloaded encoder will later discard.
                if (retainedFrame != null && (!cachedReady || cachedSourceRevision != sourceRevision)) UpdateCache(retainedFrame);
                context.CopyResource(slot.Texture!, cachedTexture!);
                context.Flush();
            }
            finally { slot.Mutex.ReleaseSync(0); }
            slot.Busy = true; slot.Sequence = ++sequence;
            if (lastOutputRevision == revision) repeated++;
            lastOutputRevision = revision;
            Program.Send(new { type = "frame", slot = slot.Index, sequence, revision, handle = slot.RemoteHandle.ToInt64().ToString(), width = outputWidth, height = outputHeight, timestamp = (long)now, format = "nv12" });
            frames++; return true;
        }
        return false;
    }

    sealed class PacingTimer : WaitHandle
    {
        public PacingTimer()
        {
            var handle = Native.CreateWaitableTimerExW(0, null, 2, 0x1F0003);
            if (handle == 0) throw new System.ComponentModel.Win32Exception();
            SafeWaitHandle = new SafeWaitHandle(handle, true);
        }
        public void Arm(double microseconds)
        {
            long due = -(long)Math.Max(1, microseconds * 10);
            if (!Native.SetWaitableTimer(SafeWaitHandle.DangerousGetHandle(), ref due, 0, 0, 0, false)) throw new System.ComponentModel.Win32Exception();
        }
    }

    void OnClosed(GraphicsCaptureItem _, object args) => stop();

    void OnFrame(Direct3D11CaptureFramePool sender, object args)
    {
        lock (gate)
        {
            if (disposed) return;
            Direct3D11CaptureFrame? frame = null;
            try
            {
                frame = sender.TryGetNextFrame();
                if (frame == null) return;
                captured++;
                // Consume the newest available source after a scheduling delay.
                // Do not let old capture frames queue behind the output cadence.
                for (var i = 0; i < 2; i++)
                {
                    var newer = sender.TryGetNextFrame();
                    if (newer == null) break;
                    frame.Dispose(); frame = newer; captured++;
                }
                var size = frame.ContentSize;
                if (size.Width < 2 || size.Height < 2) return;
                if (size.Width != inputSize.Width || size.Height != inputSize.Height)
                {
                    inputSize = size;
                    retainedFrame?.Dispose(); retainedFrame = null;
                    RebuildProcessor();
                    // Recreate after disposing the old frame; this frame may still
                    // have the previous texture dimensions, so do not publish it.
                    frame.Dispose(); frame = null;
                    sender.Recreate(winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 3, size);
                    Program.Send(new { type = "resized", width = outputWidth, height = outputHeight, sourceWidth = size.Width, sourceHeight = size.Height, fps });
                    return;
                }
                // Keep only the latest source. Conversion belongs to the paced
                // output worker so input callbacks cannot flood the GPU queue.
                sourceRevision++;
                retainedFrame?.Dispose(); retainedFrame = frame; frame = null;
            }
            catch (Exception error) { Fail(error); }
            finally { frame?.Dispose(); }
        }
    }

    void EnsureSlot(Slot slot)
    {
        if (slot.Texture != null && slot.Width == outputWidth && slot.Height == outputHeight) return;
        slot.Clear(parentHandle);
        slot.Width = outputWidth; slot.Height = outputHeight;
        slot.Texture = device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)outputWidth, Height = (uint)outputHeight, MipLevels = 1, ArraySize = 1,
            Format = Format.NV12, SampleDescription = new SampleDescription(1, 0), Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource,
            MiscFlags = ResourceOptionFlags.SharedNTHandle | ResourceOptionFlags.SharedKeyedMutex
        });
        slot.Mutex = slot.Texture.QueryInterface<IDXGIKeyedMutex>();
        using var resource = slot.Texture.QueryInterface<IDXGIResource1>();
        slot.Handle = resource.CreateSharedHandle(null, Vortice.DXGI.SharedResourceFlags.Read | Vortice.DXGI.SharedResourceFlags.Write, null);
        if (!Native.DuplicateHandle(Native.GetCurrentProcess(), slot.Handle, parentHandle, out slot.RemoteHandle, 0, false, 2))
            throw new System.ComponentModel.Win32Exception();
    }

    public void Release(int index, long id)
    {
        lock (gate) if (index >= 0 && index < slots.Length && slots[index].Sequence == id) slots[index].Busy = false;
    }

    public void Dispose()
    {
        border.Dispose();
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            pool.FrameArrived -= OnFrame; item.Closed -= OnClosed;
        }
        outputStopped.Set();
        if (outputThread != Thread.CurrentThread) outputThread?.Join();
        retainedFrame?.Dispose(); retainedFrame = null;
        session.Dispose(); pool.Dispose();
        lock (gate)
        {
            foreach (var slot in slots) slot.Clear(parentHandle);
            cachedView?.Dispose(); cachedTexture?.Dispose();
            processor?.Dispose(); enumerator?.Dispose();
            videoContext.Dispose(); videoDevice.Dispose(); context.Dispose(); device.Dispose(); winrtDevice.Dispose();
            Native.CloseHandle(parentHandle);
        }
        outputStopped.Dispose();
    }

    sealed class Slot(int index)
    {
        public readonly int Index = index;
        public int Width, Height;
        public long Sequence;
        public bool Busy;
        public ID3D11Texture2D? Texture;
        public IDXGIKeyedMutex? Mutex;
        public nint Handle, RemoteHandle;
        public void Clear(nint parent)
        {
            if (RemoteHandle != 0 && Native.DuplicateHandle(parent, RemoteHandle, Native.GetCurrentProcess(), out var local, 0, false, 3)) Native.CloseHandle(local);
            RemoteHandle = 0;
            if (Handle != 0) Native.CloseHandle(Handle);
            Handle = 0; Mutex?.Dispose(); Texture?.Dispose(); Mutex = null; Texture = null;
        }
    }
}

internal static unsafe class Native
{
    // Vortice 3.8's void wrapper loses non-negative WAIT_* results. Preserve
    // the HRESULT from IDXGIKeyedMutex::AcquireSync (IUnknown 3 + DXGIObject 4
    // + DeviceSubObject 1 = slot 8) so a nonblocking timeout is never success.
    internal static int AcquireKeyedMutex(nint mutex) =>
        ((delegate* unmanaged[Stdcall]<nint, ulong, uint, int>)(*(nint**)mutex)[8])(mutex, 0, 0);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern nint CreateWaitableTimerExW(nint attributes, string? name, uint flags, uint access);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool SetWaitableTimer(nint timer, ref long due, int period, nint callback, nint argument, bool resume);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(nint value);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern nint OpenProcess(uint access, bool inherit, int id);
    [DllImport("kernel32.dll")] internal static extern nint GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool DuplicateHandle(nint sourceProcess, nint source, nint targetProcess, out nint target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(nint handle);
    [DllImport("d3d11.dll")] internal static extern int CreateDirect3D11DeviceFromDXGIDevice(nint device, out nint result);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string text, int length, out nint str);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(nint str);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(nint name, ref Guid iid, out nint factory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string? device, uint index, ref DisplayDevice output, uint flags);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(nint hdc, nint clip, MonitorCallback callback, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);
    delegate bool MonitorCallback(nint monitor, nint hdc, nint rect, nint data);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct DisplayDevice
    {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MonitorInfo
    {
        public int Size;
        public RectI Monitor, Work;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    public static GraphicsCaptureItem CreateItem(string source)
    {
        var parts = source.Split(':');
        if (parts.Length != 3 || !long.TryParse(parts[1], out var id)) throw new ArgumentException("Invalid desktop source ID");
        nint target;
        int method;
        if (parts[0] == "window") { target = new nint(id); method = 3; }
        else if (parts[0] == "screen" && id >= 0)
        {
            // Match Chromium/WebRTC: screen ID is EnumDisplayDevices' index,
            // not an assumed primary-monitor index or a different monitor list.
            var display = new DisplayDevice { Size = Marshal.SizeOf<DisplayDevice>() };
            if (!EnumDisplayDevices(null, (uint)id, ref display, 0) || (display.Flags & 1) == 0) throw new ArgumentException("Selected monitor is unavailable");
            nint found = 0;
            EnumDisplayMonitors(0, 0, (monitor, _, _, _) =>
            {
                var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
                if (GetMonitorInfo(monitor, ref info) && info.Device == display.Name) found = monitor;
                return true;
            }, 0);
            if (found == 0) throw new ArgumentException("Selected monitor could not be resolved");
            target = found; method = 4;
        }
        else throw new ArgumentException("Unsupported desktop source type");
        var className = "Windows.Graphics.Capture.GraphicsCaptureItem";
        Marshal.ThrowExceptionForHR(WindowsCreateString(className, className.Length, out var name));
        nint factory = 0, item = 0;
        try
        {
            var factoryIid = new Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(name, ref factoryIid, out factory));
            var itemIid = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");
            var create = (delegate* unmanaged[Stdcall]<nint, nint, Guid*, nint*, int>)(*(nint**)factory)[method];
            Marshal.ThrowExceptionForHR(create(factory, target, &itemIid, &item));
            return GraphicsCaptureItem.FromAbi(item);
        }
        finally { if (item != 0) Marshal.Release(item); if (factory != 0) Marshal.Release(factory); WindowsDeleteString(name); }
    }

    public static ID3D11Texture2D GetTexture(IDirect3DSurface surface)
    {
        var ptr = MarshalInterface<IDirect3DSurface>.FromManaged(surface);
        nint access = 0;
        try
        {
            var accessIid = new Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(ptr, in accessIid, out access));
            var iid = typeof(ID3D11Texture2D).GUID;
            nint texture = 0;
            var get = (delegate* unmanaged[Stdcall]<nint, Guid*, nint*, int>)(*(nint**)access)[3];
            Marshal.ThrowExceptionForHR(get(access, &iid, &texture));
            return new ID3D11Texture2D(texture);
        }
        finally { if (access != 0) Marshal.Release(access); Marshal.Release(ptr); }
    }
}
