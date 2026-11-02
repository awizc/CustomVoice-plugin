using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;
using static Vortice.Direct3D11.D3D11;

static void Check(bool value, string message)
{
    if (!value) throw new Exception(message);
}

static RectI Expect(int sw, int sh, long x, long y, int width, int height, int left, int top, int right, int bottom)
{
    var crop = CaptureGeometry.ClipClientRegion(sw, sh, x, y, width, height);
    Check(crop.HasValue, "A usable client area must be retained.");
    var region = crop!.Value;
    Check(region.Left == left && region.Top == top && region.Right == right && region.Bottom == bottom,
        $"Unexpected crop for {sw}x{sh}, offset {x}/{y}.");
    CaptureGeometry.Validate(sw, sh, region);
    return region;
}

var window = Expect(1296, 759, 8, 31, 1280, 720, 8, 31, 1288, 751);
Check(CaptureGeometry.InitialSurface(160, 28, true, 1920, 1080) == (1920, 1080), "Minimized iconic dimensions must not initialize a tiny encoder.");
Check(CaptureGeometry.InitialSurface(1280, 720, false, 1920, 1080) == (1280, 720), "A normal app must keep its actual size.");
Check(CaptureGeometry.InitialSurface(160, 28, false, 1920, 1080) == (160, 28), "A genuinely small visible window must not be misclassified as minimized.");
Check(CaptureGeometry.InitialSurface(0, 0, false, 1920, 1080) == (1920, 1080), "An unavailable initial size needs a usable placeholder size.");
Check(window.Width == 1280 && window.Height == 720, "Title bar offsets must not enlarge the client area.");
var fullscreen = Expect(1920, 1080, 0, 0, 1920, 1080, 0, 0, 1920, 1080);
var odd = Expect(1297, 760, 8, 31, 1281, 721, 8, 31, 1289, 752);
Expect(1280, 720, -8, -31, 1296, 759, 0, 0, 1280, 720);
Expect(1280, 720, 10, 20, 1280, 720, 10, 20, 1280, 720);
Expect(1280, 720, 8, 31, int.MaxValue, int.MaxValue, 8, 31, 1280, 720);
foreach (var invalid in new[] {
    (1280, 720, 1280L, 0L, 100, 100), (1280, 720, 0L, 720L, 100, 100),
    (1280, 720, -100L, -100L, 100, 100), (1280, 720, 1279L, 0L, 100, 100),
    (1280, 720, 0L, 0L, 0, 100), (1280, 720, 0L, 0L, 100, -1),
    (0, 720, 0L, 0L, 100, 100), (1280, 1, 0L, 0L, 100, 100),
    (1280, 720, (long)int.MaxValue * 2, 0L, int.MaxValue, 100) })
    Check(CaptureGeometry.ClipClientRegion(invalid.Item1, invalid.Item2, invalid.Item3, invalid.Item4, invalid.Item5, invalid.Item6) == null,
        "Empty, off-texture and degenerate client areas must not reach the GPU.");

var broken = new RectI(8, 31, 1288, 751); // The former call interpreted right/bottom as width/height.
bool rejected = false;
try { CaptureGeometry.Validate(1296, 759, broken); } catch (InvalidOperationException) { rejected = true; }
Check(rejected, "The original out-of-bounds crop must be rejected before Direct3D.");
Console.WriteLine("PASS: crop geometry, clipping, invalid sizes, overflow and former regression.");

if (!args.Contains("--gpu")) return;
// Owned synthetic textures only: no capture API, desktop pixels or windows.
D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
    new[] { FeatureLevel.Level_11_1, FeatureLevel.Level_11_0 }, out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
using (device)
using (context)
using (var videoDevice = device.QueryInterface<ID3D11VideoDevice>())
using (var videoContext = context.QueryInterface<ID3D11VideoContext>())
{
    void Convert(int sw, int sh, RectI region)
    {
        int ow = region.Width & ~1, oh = region.Height & ~1;
        using var enumerator = videoDevice.CreateVideoProcessorEnumerator(new VideoProcessorContentDescription {
            InputFrameFormat = VideoFrameFormat.Progressive, InputFrameRate = new Rational(165, 1), OutputFrameRate = new Rational(165, 1),
            InputWidth = (uint)sw, InputHeight = (uint)sh, OutputWidth = (uint)ow, OutputHeight = (uint)oh, Usage = VideoUsage.PlaybackNormal
        });
        using var processor = videoDevice.CreateVideoProcessor(enumerator, 0);
        videoContext.VideoProcessorSetStreamFrameFormat(processor, 0, VideoFrameFormat.Progressive);
        videoContext.VideoProcessorSetStreamAutoProcessingMode(processor, 0, false);
        videoContext.VideoProcessorSetStreamSourceRect(processor, 0, true, region);
        videoContext.VideoProcessorSetStreamDestRect(processor, 0, true, new RectI(0, 0, ow, oh));
        videoContext.VideoProcessorSetOutputTargetRect(processor, true, new RectI(0, 0, ow, oh));
        using var colors = videoContext.QueryInterface<ID3D11VideoContext1>();
        colors.VideoProcessorSetStreamColorSpace1(processor, 0, ColorSpaceType.RgbFullG22NoneP709);
        colors.VideoProcessorSetOutputColorSpace1(processor, ColorSpaceType.YcbcrStudioG22LeftP709);
        using var source = device.CreateTexture2D(new Texture2DDescription {
            Width = (uint)sw, Height = (uint)sh, MipLevels = 1, ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget
        });
        using var renderTarget = device.CreateRenderTargetView(source);
        context.ClearRenderTargetView(renderTarget, new Color4(0, 0, 0, 1));
        using var target = device.CreateTexture2D(new Texture2DDescription {
            Width = (uint)ow, Height = (uint)oh, MipLevels = 1, ArraySize = 1,
            Format = Format.NV12, SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default, BindFlags = BindFlags.RenderTarget | BindFlags.ShaderResource
        });
        using var output = videoDevice.CreateVideoProcessorOutputView(target, enumerator, new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D });
        using var input = videoDevice.CreateVideoProcessorInputView(source, enumerator, new VideoProcessorInputViewDescription { ViewDimension = VideoProcessorInputViewDimension.Texture2D });
        videoContext.VideoProcessorBlt(processor, output, 0, new[] { new VideoProcessorStream { Enable = true, InputSurface = input } }).CheckError();
        context.Flush();
    }

    // Driver behavior for an invalid source rect differs; record, do not depend on it.
    try { Convert(1296, 759, broken); Console.WriteLine("INFO: driver accepted the former invalid crop (geometry remains wrong)."); }
    catch (Exception error) { Console.WriteLine($"INFO: former crop failed: 0x{error.HResult:X8} {error.Message}"); }
    Convert(1296, 759, window);
    Convert(1920, 1080, fullscreen);
    Convert(1297, 760, odd);
    Console.WriteLine("PASS: synthetic BGRA to NV12 GPU conversion for cropped, fullscreen and odd-sized inputs.");
}

Check(WindowCapturePolicy.IsGame("osu!", "WindowsForms10.Window"), "Windowed osu should use game capture");
Check(WindowCapturePolicy.IsGame("game", "UnityWndClass"), "Borderless/windowed Unity should use game capture");
Check(!WindowCapturePolicy.IsGame("Discord", "Chrome_WidgetWin_1"), "Do not inject into generic Chromium windows");
Check(!WindowCapturePolicy.IsGame("explorer", "CabinetWClass"), "Do not inject into ordinary desktop apps");
