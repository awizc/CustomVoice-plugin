using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using Windows.Graphics;
using static Vortice.Direct3D11.D3D11;

// Exercise the shipped GPU conversion/recovery methods with owned textures.
// Bypass Capture's constructor: no HWND, WGC session, desktop duplication,
// shared process handles, application windows or real screen pixels are used.
var type = typeof(ProcessAudio).Assembly.GetType("Capture", throwOnError: true)!;
var capture = RuntimeHelpers.GetUninitializedObject(type);
const BindingFlags flags = BindingFlags.Instance | BindingFlags.NonPublic;
void Set(string name, object value) => type.GetField(name, flags)!.SetValue(capture, value);
T Get<T>(string name) => (T)type.GetField(name, flags)!.GetValue(capture)!;
void Call(string name) => type.GetMethod(name, flags)!.Invoke(capture, null);
void Check(bool value, string message) { if (!value) throw new Exception(message); }

D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
    new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 }, out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
using (device)
using (context)
using (var videoDevice = device.QueryInterface<ID3D11VideoDevice>())
using (var videoContext = context.QueryInterface<ID3D11VideoContext>())
{
    Set("gate", new object()); Set("device", device); Set("context", context);
    Set("videoDevice", videoDevice); Set("videoContext", videoContext);
    Set("inputSize", new SizeInt32 { Width = 1920, Height = 1080 });
    Set("contentRegion", new RectI(0, 0, 1920, 1080)); Set("fps", 165); Set("quality", "1080p");
    Set("pacingFps", 1d); Set("pacingUpdated", 1d);
    byte Luma()
    {
        var texture = Get<ID3D11Texture2D>("cachedTexture");
        var description = texture.Description;
        description.Usage = ResourceUsage.Staging; description.BindFlags = BindFlags.None;
        description.CPUAccessFlags = CpuAccessFlags.Read; description.MiscFlags = ResourceOptionFlags.None;
        using var readback = device.CreateTexture2D(description);
        context.CopyResource(readback, texture);
        var mapped = context.Map(readback, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try { return Marshal.ReadByte(mapped.DataPointer); } finally { context.Unmap(readback, 0); }
    }
    try
    {
        Call("RebuildProcessor"); Call("EnsurePlaceholder");
        Check(Get<bool>("cachedReady") && Get<bool>("placeholderReady") && !Get<bool>("sourceAvailable"), "A waiting game needs a complete owned output frame.");
        Check(Get<int>("outputWidth") == 1920 && Get<int>("outputHeight") == 1080, "The initial placeholder must have the intended encoder size.");
        var black = Luma(); Check(black >= 15 && black <= 17, "The placeholder must be black in limited-range NV12.");
        long revision = Get<long>("revision");
        Call("EnsurePlaceholder"); Check(Get<long>("revision") == revision, "Waiting must reuse the GPU cache, not regenerate it each tick.");
        using var source = device.CreateTexture2D(new Texture2DDescription {
            Width = 1920, Height = 1080, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget
        });
        using var renderTarget = device.CreateRenderTargetView(source);
        var update = type.GetMethod("UpdateCache", flags, null, new[] { typeof(ID3D11Texture2D), typeof(bool) }, null)!;
        var colors = new[] { new Color4(0, 1, 0, 1), new Color4(1, 0, 0, 1), new Color4(0, 0, 1, 1) };
        byte lastColor = black;
        for (int transition = 0; transition < 3; transition++)
        {
            context.ClearRenderTargetView(renderTarget, colors[transition]);
            Set("pacingFps", 1d); Set("pacingUpdated", 1d);
            update.Invoke(capture, new object[] { source, false });
            Check(Get<bool>("sourceAvailable") && !Get<bool>("placeholderReady"), "The first real frame must leave waiting state.");
            Check(Get<double>("pacingFps") == 165 && Get<double>("pacingUpdated") == 0, "Recovery must discard the stale 1 FPS throttle.");
            lastColor = Luma(); Check(lastColor > black + 2, "The real frame must replace the waiting cache.");
            Call("RememberPresentedFrame");
            // A prepared frame that fails the final focus check must not become
            // the held image, even if it overwrote the conversion cache.
            context.ClearRenderTargetView(renderTarget, new Color4(1, 1, 1, 1));
            update.Invoke(capture, new object[] { source, false });
            Call("EnsurePlaceholder");
            Check(!Get<bool>("sourceAvailable") && Get<bool>("cachedReady"), "Losing the source must keep an owned output frame ready.");
            Check(Get<bool>("holdingFrame") && Luma() == lastColor, "Focus loss must retain only the last validated game frame, never black or an unsubmitted desktop frame.");
        }
        Set("quality", "720p"); Call("RebuildProcessor"); Call("EnsurePlaceholder");
        Check(Get<int>("outputWidth") == 1280 && Get<int>("outputHeight") == 720, "Quality changes while waiting must resize the saved image.");
        Check(Math.Abs(Luma() - lastColor) <= 1, "Resizing a held NV12 frame must preserve its pixel color.");
        using var game = device.CreateTexture2D(new Texture2DDescription { Width = 64, Height = 32, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0), BindFlags = BindFlags.RenderTarget });
        var pixels = new byte[64 * 32 * 4];
        for (int y = 0; y < 32; y++) for (int x = 0; x < 64; x++) { int offset = (y * 64 + x) * 4; pixels[offset + (y < 16 ? 0 : 1)] = 255; pixels[offset + 3] = 255; }
        context.UpdateSubresource(pixels, game, 0, 64 * 4);
        Set("gameMode", true); Set("desktopMode", false); Set("targetWindow", new nint(1234));
        // A fake HWND is intentional: game mode must not query foreground,
        // minimized state or the old window client crop during conversion.
        var updateGame = type.GetMethod("UpdateGameCache", flags)!;
        updateGame.Invoke(capture, new object[] { game, false }); byte blueTop = Luma();
        updateGame.Invoke(capture, new object[] { game, true }); byte greenTop = Luma();
        Check(greenTop > blueTop + 80, "OpenGL vertical flip must be applied to the actual GPU output.");
        updateGame.Invoke(capture, new object[] { game, false });
        Check(Math.Abs(Luma() - blueTop) <= 1, "Mirror state must not leak into subsequent non-flipped frames.");
        Check(Get<int>("outputWidth") == 64 && Get<int>("outputHeight") == 32 && !Get<bool>("holdingFrame"), "Game buffer dimensions and live state must override the old minimized window crop.");
        var meterType = typeof(ProcessAudio).Assembly.GetType("GpuWorkMeter")!;
        using var meter = (IDisposable)Activator.CreateInstance(meterType, flags, null, new object[] { device, context }, null)!;
        for (int i = 0; i < 30; i++) {
            meterType.GetMethod("Begin", flags)!.Invoke(meter, new object[] { (double)i * 100000 });
            updateGame.Invoke(capture, new object[] { game, false });
            meterType.GetMethod("End", flags)!.Invoke(meter, null);
            context.Flush(); Thread.Sleep(2);
        }
        Check((long)meterType.GetProperty("Count", flags)!.GetValue(meter)! > 0, "Nonblocking GPU timestamp queries must collect completed samples");
        Check(double.IsFinite((double)meterType.GetProperty("TotalUs", flags)!.GetValue(meter)!), "GPU work duration must be finite");
        Console.WriteLine("PASS: production GPU recovery, held-frame resize, live game frame conversion without window/focus queries, and OpenGL vertical flip/reset.");
    }
    finally
    {
        foreach (var name in new[] { "cachedView", "cachedTexture", "lastPresentedTexture", "processor", "enumerator" })
            (type.GetField(name, flags)!.GetValue(capture) as IDisposable)?.Dispose();
    }
}
