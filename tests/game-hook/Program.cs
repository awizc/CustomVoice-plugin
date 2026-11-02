using System.IO.MemoryMappedFiles;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using static Vortice.Direct3D11.D3D11;

// No window enumeration, game, injector, offset helper, Electron or capture API
// runs here. An in-process fake producer supplies only synthetic RGB surfaces.
void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
Check(Marshal.SizeOf<GameHookInfo>() == 648, "Hook ABI size");
Check(Marshal.OffsetOf<GameHookInfo>(nameof(GameHookInfo.FrameInterval)).ToInt32() == 56, "32/64-bit interval alignment");
var offsets = GameHookProtocol.ParseOffsets("[d3d8]\npresent=0x11\n[d3d9]\npresent=0x22\nis_d3d9ex_clsoff=0x33\n[dxgi]\npresent=0x44\nresize=0x55\npresent1=0x66\nrelease=0x77\n");
Check(offsets.Length == 76 && BitConverter.ToUInt32(offsets, 0) == 0x11 && BitConverter.ToUInt32(offsets, 20) == 0x33 &&
    BitConverter.ToUInt32(offsets, 24) == 0x44 && BitConverter.ToUInt32(offsets, 28) == 0x55 && BitConverter.ToUInt32(offsets, 68) == 0x77, "Graphics address layout");
var valid = new GameHookInfo { Major = 1, Minor = 8, Type = 1, Window = 1234, Width = 64, Height = 32, Format = 87, MapId = 1, MapSize = 4 };
Check(GameHookProtocol.Valid(valid), "Valid shared GPU surface");
foreach (var field in new[] { nameof(GameHookInfo.Major), nameof(GameHookInfo.Type), nameof(GameHookInfo.Width), nameof(GameHookInfo.Format), nameof(GameHookInfo.MapSize) })
{
    object invalid = valid; typeof(GameHookInfo).GetField(field)!.SetValue(invalid, uint.MaxValue);
    Check(!GameHookProtocol.Valid((GameHookInfo)invalid), "Reject invalid " + field);
}
var memoryInfo = valid; memoryInfo.Type = 0; memoryInfo.Pitch = 256; memoryInfo.MapSize = 12 + 2 * 256 * 32;
Check(GameHookProtocol.ValidBuffer(memoryInfo, 12) && GameHookProtocol.ValidBuffer(memoryInfo, 12 + 256 * 32) &&
    !GameHookProtocol.ValidBuffer(memoryInfo, uint.MaxValue) && !GameHookProtocol.ValidBuffer(memoryInfo, memoryInfo.MapSize - 1), "Bounded CPU texture ranges");

D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
    new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 }, out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
using (device)
using (context)
{
    var type = Type.GetType("GameHookCapture+Session, CustomVoice.Capture", true)!;
    var consumer = RuntimeHelpers.GetUninitializedObject(type);
    const BindingFlags flags = BindingFlags.NonPublic | BindingFlags.Instance;
    void Set(string name, object value) => type.GetField(name, flags)!.SetValue(consumer, value);
    long fakeRoot = Random.Shared.NextInt64(0x10000000, 0x70000000);
    Set("root", new nint(fakeRoot)); Set("checkTarget", (Action)(() => { }));
    Set("acceptsWindow", (Func<uint, bool>)(window => window == 1234));
    using var infoMap = MemoryMappedFile.CreateNew(null, 648);
    using var infoView = infoMap.CreateViewAccessor();
    using var ready = new EventWaitHandle(false, EventResetMode.AutoReset);
    using var exit = new EventWaitHandle(false, EventResetMode.AutoReset);
    using var restart = new EventWaitHandle(false, EventResetMode.AutoReset);
    using var stop = new EventWaitHandle(false, EventResetMode.AutoReset);
    Set("infoView", infoView); Set("ready", ready); Set("exit", exit); Set("restart", restart); Set("stop", stop);
    Set("mutex0", new Mutex()); Set("mutex1", new Mutex());
    var read = type.GetMethod("TryRead", flags)!;
    byte Sample(ID3D11Texture2D texture)
    {
        var desc = texture.Description; desc.Usage = ResourceUsage.Staging; desc.BindFlags = BindFlags.None;
        desc.CPUAccessFlags = CpuAccessFlags.Read; desc.MiscFlags = ResourceOptionFlags.None;
        using var staging = device.CreateTexture2D(desc);
        context.CopyResource(staging, texture);
        var mapped = context.Map(staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try { return Marshal.ReadByte(mapped.DataPointer); } finally { context.Unmap(staging, 0); }
    }
    byte sample = 0; bool flipped = false; uint width = 0;
    Action<ID3D11Texture2D, bool> consume = (texture, flip) => { sample = Sample(texture); flipped = flip; width = texture.Description.Width; };
    bool Read() => (bool)read.Invoke(consumer, new object[] { device, context, 165, consume })!;
    try
    {
        using var data = MemoryMappedFile.CreateNew($"CaptureHook_Texture_{fakeRoot}_1", 4);
        using var dataView = data.CreateViewAccessor();
        using var texture = device.CreateTexture2D(new Texture2DDescription { Width = 64, Height = 32, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0), BindFlags = BindFlags.RenderTarget,
            MiscFlags = ResourceOptionFlags.Shared });
        using var dxgi = texture.QueryInterface<IDXGIResource>();
        dataView.Write(0, checked((uint)dxgi.SharedHandle.ToInt64())); infoView.Write(0, ref valid); ready.Set();
        using var renderTarget = device.CreateRenderTargetView(texture);
        foreach (float blue in new[] { .1f, .4f, .8f, .2f })
        {
            // Same shared handle keeps updating while the host is unfocused.
            context.ClearRenderTargetView(renderTarget, new Color4(0, 0, blue, 1)); context.Flush();
            Check(Read() && Math.Abs(sample - blue * 255) <= 1, "New game frames must replace the previous image without any focus dependency");
        }
        Check(infoView.ReadUInt64(56) == 1_000_000_000UL / 165, "Requested hook cadence");
        valid.Window = 9876; infoView.Write(0, ref valid);
        Check(!Read(), "Reject another window in the same process");
        valid.Window = 1234; infoView.Write(0, ref valid); Check(Read(), "Recover after invalid surface");

        using var invalidGpu = MemoryMappedFile.CreateNew($"CaptureHook_Texture_{fakeRoot}_3", 4);
        using var invalidGpuView = invalidGpu.CreateViewAccessor(); invalidGpuView.Write(0, uint.MaxValue);
        valid.MapId = 3; infoView.Write(0, ref valid); ready.Set();
        Check(!Read() && stop.WaitOne(0) && restart.WaitOne(0) && infoView.ReadByte(65) == 1,
            "Unshareable GPU buffer must request synchronized memory fallback once");
        Check(!Read() && !stop.WaitOne(0), "Do not loop on the rejected GPU buffer while waiting for its replacement");

        // Simulate a fullscreen swapchain reset to shared CPU memory at a new size.
        memoryInfo.Width = 32; memoryInfo.Pitch = 128; memoryInfo.MapSize = 12 + 2 * 128 * 32; memoryInfo.MapId = 2; memoryInfo.Flip = 1;
        using var cpuData = MemoryMappedFile.CreateNew($"CaptureHook_Texture_{fakeRoot}_2", memoryInfo.MapSize);
        using var cpuView = cpuData.CreateViewAccessor();
        cpuView.Write(0, 0); cpuView.Write(4, 12u); cpuView.Write(8, 12u + 128 * 32);
        cpuView.WriteArray(12, Enumerable.Repeat((byte)117, 128 * 32).ToArray(), 0, 128 * 32);
        infoView.Write(0, ref memoryInfo); ready.Set();
        Check(Read() && width == 32 && flipped && sample == 117, "Reopen replacement buffer and preserve OpenGL flip metadata");
        cpuView.WriteArray(12, Enumerable.Repeat((byte)219, 128 * 32).ToArray(), 0, 128 * 32);
        Check(Read() && sample == 219, "CPU fallback must also keep receiving moving frames");
        exit.Set(); Check(!Read() && restart.WaitOne(0), "Hook exit clears stale surfaces and requests recovery");
    }
    finally { ((IDisposable)consumer).Dispose(); }

    // Cancelling a broadcast while setup is pending owns no session yet. Its
    // late completion must still release all resources, without starting work.
    var outerType = type.DeclaringType!;
    var outer = Activator.CreateInstance(outerType, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { new nint(1234), device, context }, null)!;
    var completionType = typeof(TaskCompletionSource<>).MakeGenericType(type);
    var completion = Activator.CreateInstance(completionType)!;
    var task = (Task)completionType.GetProperty("Task")!.GetValue(completion)!;
    outerType.GetField("starting", flags)!.SetValue(outer, task);
    ((IDisposable)outer).Dispose();
    var lateSession = RuntimeHelpers.GetUninitializedObject(type);
    completionType.GetMethod("SetResult")!.Invoke(completion, new[] { lateSession });
    for (int i = 0; i < 100 && !(bool)type.GetField("disposed", flags)!.GetValue(lateSession)!; i++) await Task.Delay(10);
    Check((bool)type.GetField("disposed", flags)!.GetValue(lateSession)!, "Late setup completion after cancellation must be disposed");
}
Console.WriteLine("PASS: hook ABI/bounds, live shared GPU frames, selected-window isolation, swapchain replacement, automatic CPU fallback, flip metadata, exit recovery and late-start cancellation (no game/desktop access).");
