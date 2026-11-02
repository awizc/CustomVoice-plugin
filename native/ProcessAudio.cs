using System.Diagnostics;
using System.Runtime.InteropServices;

// Windows process-loopback capture. The selected HWND determines the target PID;
// only that process tree is included. No endpoint/system-loopback fallback.
// API reference: Microsoft Windows-classic-samples/Samples/ApplicationLoopback.
public static class ProcessAudio
{
    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WaveFormat
    {
        public ushort Tag, Channels;
        public uint Rate, BytesPerSecond;
        public ushort Align, Bits, Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Activation { public int Type; public uint Process; public int Mode; }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct Variant
    {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public uint Size;
        [FieldOffset(16)] public nint Data;
    }
    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int mode, uint flags, long duration, long period, ref WaveFormat format, ref Guid session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long value);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int mode, ref WaveFormat format, out nint closest);
        [PreserveSig] int GetMixFormat(out nint format);
        [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(nint handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }
    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out nint data, out uint frames, out uint flags, out ulong position, out ulong qpc);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IOperation
    {
        [PreserveSig] int GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object client);
    }
    [ComVisible(true), Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ICompletion { [PreserveSig] int ActivateCompleted(IOperation operation); }
    [ComVisible(true), Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject { }
    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class Completion : ICompletion, IAgileObject
    {
        internal readonly ManualResetEvent Done = new(false);
        internal object? Client;
        internal int Result = unchecked((int)0x80004005);
        public int ActivateCompleted(IOperation operation)
        {
            try { var call = operation.GetActivateResult(out var result, out var client); Result = call < 0 ? call : result; Client = client; }
            catch (Exception error) { Result = error.HResult; }
            finally { Done.Set(); }
            return 0;
        }
    }
    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode)]
    static extern int ActivateAudioInterfaceAsync(string path, ref Guid iid, ref Variant parameters, ICompletion completion, out IOperation operation);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] static extern bool IsWindow(nint window);
    [DllImport("avrt.dll", CharSet = CharSet.Unicode)] static extern nint AvSetMmThreadCharacteristics(string task, ref uint index);
    [DllImport("avrt.dll")] static extern bool AvRevertMmThreadCharacteristics(nint task);

    internal static int Run(int parentId, string source)
    {
        var parts = source.Split(':');
        if (parts.Length != 3 || parts[0] != "window" || !long.TryParse(parts[1], out var hwnd) || !IsWindow(new nint(hwnd)))
            throw new ArgumentException("프로세스 오디오는 선택한 애플리케이션 창에서만 사용할 수 있습니다.");
        GetWindowThreadProcessId(new nint(hwnd), out var pid);
        if (pid == 0) throw new InvalidOperationException("선택한 창의 프로세스를 찾지 못했습니다.");
        using var parent = Process.GetProcessById(parentId);
        using var target = Process.GetProcessById(checked((int)pid));
        using var stopped = new ManualResetEvent(false);
        using var samples = new AutoResetEvent(false);
        void Stop() { try { stopped.Set(); } catch (ObjectDisposedException) { } }
        parent.EnableRaisingEvents = target.EnableRaisingEvents = true;
        parent.Exited += (_, _) => Stop(); target.Exited += (_, _) => Stop();
        _ = Task.Run(() => { try { Console.In.ReadLine(); } finally { Stop(); } });
        var completion = new Completion();
        var parameters = Marshal.AllocCoTaskMem(Marshal.SizeOf<Activation>());
        IOperation? operation = null;
        IAudioClient? client = null;
        IAudioCaptureClient? capture = null;
        nint priority = 0;
        try
        {
            Marshal.StructureToPtr(new Activation { Type = 1, Process = pid, Mode = 0 }, parameters, false);
            var variant = new Variant { Type = 65, Size = (uint)Marshal.SizeOf<Activation>(), Data = parameters };
            var iid = typeof(IAudioClient).GUID;
            Marshal.ThrowExceptionForHR(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, ref variant, completion, out operation));
            // The host owns the startup deadline and terminates a stuck helper.
            if (WaitHandle.WaitAny(new WaitHandle[] { stopped, completion.Done }) == 0) return 0;
            Marshal.ThrowExceptionForHR(completion.Result);
            client = (IAudioClient)completion.Client!;
            var format = new WaveFormat { Tag = 1, Channels = 2, Rate = 48000, BytesPerSecond = 192000, Align = 4, Bits = 16 };
            var session = Guid.Empty;
            Marshal.ThrowExceptionForHR(client.Initialize(0, 0x80060000, 0, 0, ref format, ref session));
            iid = typeof(IAudioCaptureClient).GUID;
            Marshal.ThrowExceptionForHR(client.GetService(ref iid, out var service));
            capture = (IAudioCaptureClient)service;
            Marshal.ThrowExceptionForHR(client.SetEventHandle(samples.SafeWaitHandle.DangerousGetHandle()));
            uint index = 0; priority = AvSetMmThreadCharacteristics("Audio", ref index);
            Marshal.ThrowExceptionForHR(client.Start());
            Program.Send(new { type = "audio-ready", sampleRate = 48000, channels = 2, processId = pid });
            var waits = new WaitHandle[] { stopped, samples };
            while (WaitHandle.WaitAny(waits) != 0)
            {
                while (!stopped.WaitOne(0))
                {
                    Marshal.ThrowExceptionForHR(capture.GetNextPacketSize(out var available));
                    if (available == 0) break;
                    Marshal.ThrowExceptionForHR(capture.GetBuffer(out var data, out var frames, out var flags, out _, out var qpc));
                    try
                    {
                        if (frames > 48000) throw new InvalidDataException("Unexpected audio packet length.");
                        // Small packets bound transport latency; silence remains silence.
                        for (uint offset = 0; offset < frames && !stopped.WaitOne(0); offset += 960)
                        {
                            int count = checked((int)Math.Min(960u, frames - offset));
                            byte[] pcm = new byte[count * 4];
                            if ((flags & 2) == 0) Marshal.Copy(data + checked((int)offset * 4), pcm, 0, pcm.Length);
                            Program.Send(new { type = "audio", frames = count, timestamp = qpc / 10 + offset * 1000000UL / 48000, pcm = Convert.ToBase64String(pcm) });
                        }
                    }
                    finally { Marshal.ThrowExceptionForHR(capture.ReleaseBuffer(frames)); }
                }
            }
            return 0;
        }
        finally
        {
            if (client != null) { try { client.Stop(); } catch { } }
            if (priority != 0) AvRevertMmThreadCharacteristics(priority);
            if (capture != null) Marshal.ReleaseComObject(capture);
            if (client != null) Marshal.ReleaseComObject(client);
            if (operation != null) Marshal.ReleaseComObject(operation);
            // An unfinished activation owns its input until this isolated process exits.
            if (completion.Done.WaitOne(0)) { Marshal.FreeCoTaskMem(parameters); completion.Done.Dispose(); }
            GC.KeepAlive(completion);
        }
    }
}
