using Lennox.NvEncSharp;
using Vortice.Direct3D11;
using static Lennox.NvEncSharp.LibNvEnc;

// Only encoded access units leave GPU capture. No CPU readback of raw pixels.
internal sealed class NvencEncoder : IDisposable
{
    NvEncoder encoder;
    NvEncCreateBitstreamBuffer bitstream;
    NvEncConfig config;
    NvEncInitializeParams init;
    readonly uint width, height, fps;
    bool disposed;
    internal unsafe NvencEncoder(ID3D11Device device, uint width, uint height, uint fps, uint bitrate)
    {
        this.width = width; this.height = height; this.fps = fps;
        try
        {
            encoder = OpenEncoderForDirectX(device.NativePointer);
            config = encoder.GetEncodePresetConfigEx(NvEncCodecGuids.H264, NvEncPresetGuids.P1, NvEncTuningInfo.UltraLowLatency).PresetCfg;
            config.ProfileGuid = NvEncProfileGuids.H264Baseline;
            config.FrameIntervalP = 1; config.GopLength = fps * 2;
            config.RcParams.EnableLookahead = false;
            config.RcParams.EnableAQ = false;
            config.RcParams.RateControlMode = NvEncParamsRcMode.Cbr;
            config.RcParams.AverageBitRate = config.RcParams.MaxBitRate = bitrate;
            config.RcParams.VbvBufferSize = bitrate / fps * 2;
            config.RcParams.VbvInitialDelay = config.RcParams.VbvBufferSize;
            config.EncodeCodecConfig.H264Config.RepeatSPSPPS = true;
            config.EncodeCodecConfig.H264Config.IdrPeriod = fps * 2;
            init = new NvEncInitializeParams {
                Version = NV_ENC_INITIALIZE_PARAMS_VER, EncodeGuid = NvEncCodecGuids.H264, PresetGuid = NvEncPresetGuids.P1,
                EncodeWidth = width, EncodeHeight = height, MaxEncodeWidth = width, MaxEncodeHeight = height,
                DarWidth = width, DarHeight = height, FrameRateNum = fps, FrameRateDen = 1,
                EnablePTD = 1, EnableEncodeAsync = 0, TuningInfo = NvEncTuningInfo.UltraLowLatency
            };
            fixed (NvEncConfig* p = &config) { init.EncodeConfig = p; encoder.InitializeEncoder(ref init); }
            init.EncodeConfig = null;
            bitstream = encoder.CreateBitstreamBuffer();
        }
        catch { Dispose(); throw; }
    }
    internal unsafe void SetBitrate(uint bitrate)
    {
        config.RcParams.AverageBitRate = config.RcParams.MaxBitRate = bitrate;
        config.RcParams.VbvBufferSize = bitrate / fps * 2;
        config.RcParams.VbvInitialDelay = config.RcParams.VbvBufferSize;
        fixed (NvEncConfig* p = &config)
        {
            var parameters = new NvEncReconfigureParams { Version = NV_ENC_RECONFIGURE_PARAMS_VER, ReInitEncodeParams = init };
            parameters.ReInitEncodeParams.EncodeConfig = p;
            encoder.ReconfigureEncoder(ref parameters);
        }
    }
    internal byte[] Encode(ID3D11Texture2D texture, ulong timestamp, bool keyframe)
    {
        var resource = new NvEncRegisterResource {
            Version = NV_ENC_REGISTER_RESOURCE_VER, ResourceType = NvEncInputResourceType.Directx,
            ResourceToRegister = texture.NativePointer, Width = width, Height = height,
            BufferFormat = NvEncBufferFormat.Nv12, BufferUsage = NvEncBufferUsage.NvEncInputImage
        };
        using var registration = encoder.RegisterResource(ref resource);
        var mapped = new NvEncMapInputResource { Version = NV_ENC_MAP_INPUT_RESOURCE_VER, RegisteredResource = resource.RegisteredResource };
        encoder.MapInputResource(ref mapped);
        try
        {
            var picture = new NvEncPicParams {
                Version = NV_ENC_PIC_PARAMS_VER, PictureStruct = NvEncPicStruct.Frame,
                InputBuffer = mapped.MappedResource, BufferFmt = mapped.MappedBufferFmt,
                InputWidth = width, InputHeight = height, OutputBitstream = bitstream.BitstreamBuffer,
                InputTimeStamp = timestamp, InputDuration = 1000000 / fps,
                EncodePicFlags = keyframe ? (uint)(NvEncPicFlags.FlagForceidr | NvEncPicFlags.FlagOutputSpspps) : 0
            };
            encoder.EncodePicture(ref picture);
            using var locked = encoder.LockBitstreamAndCreateStream(ref bitstream);
            using var bytes = new MemoryStream(); locked.CopyTo(bytes);
            if (bytes.Length is <= 0 or > 8388608) throw new InvalidDataException("Invalid encoded frame size");
            return bytes.ToArray();
        }
        finally { encoder.UnmapInputResource(mapped.MappedResource); }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        if (encoder.Handle == 0) return;
        try { if (bitstream.BitstreamBuffer.Handle != 0) encoder.DestroyBitstreamBuffer(bitstream.BitstreamBuffer); }
        finally { encoder.DestroyEncoder(); }
    }
}
