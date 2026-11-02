using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Threading.Channels;
using Vortice.Direct3D11;

internal sealed class NativePublisher : IDisposable
{
    internal sealed record Credentials(string Url, string Token, string Identity, string Owner, int Bitrate);
    sealed record Frame(ID3D11Texture2D Texture, long Timestamp, int Fps);
    readonly Channel<Frame> queue = Channel.CreateBounded<Frame>(new BoundedChannelOptions(1) { SingleReader = true, SingleWriter = true });
    readonly ConcurrentQueue<ID3D11Texture2D> available = new();
    readonly ID3D11Device device;
    readonly Credentials credentials;
    readonly Action<object> status;
    readonly CancellationTokenSource stopped = new();
    readonly Task worker;
    readonly TaskCompletionSource<string> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    Process? process;
    int pending, keyframe = 1, bitrate;
    long frames, drops, bytes, sentFrames, sentBytes, statsTimestamp;
    double encodeUs;
    internal Task<string> Ready => ready.Task;
    internal object Stats => new { frames = Interlocked.Read(ref frames), drops = Interlocked.Read(ref drops), bytes = Interlocked.Read(ref bytes), sentFrames = Interlocked.Read(ref sentFrames), sentBytes = Interlocked.Read(ref sentBytes), timestamp = Interlocked.Read(ref statsTimestamp), encodeUs = Volatile.Read(ref encodeUs), bitrate = Volatile.Read(ref bitrate) };
    internal NativePublisher(ID3D11Device device, Credentials credentials, Action<object> status)
    {
        if (!Uri.TryCreate(credentials.Url, UriKind.Absolute, out var url) || url.Scheme != "wss" || url.UserInfo.Length != 0 || credentials.Token.Length is < 10 or > 12000 || string.IsNullOrWhiteSpace(credentials.Owner) || credentials.Identity == credentials.Owner || !credentials.Identity.StartsWith("cv-screen:", StringComparison.Ordinal) || credentials.Bitrate is < 250000 or > 100000000)
            throw new ArgumentException("Invalid native publisher credentials");
        this.device = device; this.credentials = credentials; this.status = status;
        bitrate = Math.Min(credentials.Bitrate, 4000000);
        worker = Task.Run(Run);
    }
    // Copy into at most two owned surfaces: one encoding, one waiting. A slow
    // encoder/network never blocks the capture lock or accumulates raw frames.
    internal void Offer(ID3D11DeviceContext context, ID3D11Texture2D source, long timestamp, int fps)
    {
        if (stopped.IsCancellationRequested) return;
        if (Interlocked.Increment(ref pending) > 2)
        { Interlocked.Decrement(ref pending); Interlocked.Increment(ref drops); return; }
        ID3D11Texture2D? texture = null; bool accepted = false;
        try
        {
            if (available.TryDequeue(out texture) && (texture.Description.Width != source.Description.Width || texture.Description.Height != source.Description.Height)) { texture.Dispose(); texture = null; }
            texture ??= device.CreateTexture2D(source.Description);
            context.CopyResource(texture, source); context.Flush();
            if (queue.Writer.TryWrite(new Frame(texture, timestamp, fps))) { texture = null; accepted = true; return; }
        }
        finally { texture?.Dispose(); if (!accepted) { Interlocked.Decrement(ref pending); Interlocked.Increment(ref drops); } }
    }
    async Task Run()
    {
        NvencEncoder? encoder = null; uint width = 0, height = 0, rate = 0; int appliedBitrate = 0;
        try
        {
            await foreach (var frame in queue.Reader.ReadAllAsync(stopped.Token))
            {
                try
                {
                    var size = frame.Texture.Description;
                    if (size.Width != width || size.Height != height || rate != frame.Fps)
                    {
                        encoder?.Dispose(); encoder = null;
                        width = size.Width; height = size.Height; rate = (uint)frame.Fps;
                        encoder = new NvencEncoder(device, width, height, rate, (uint)Volatile.Read(ref bitrate));
                        appliedBitrate = Volatile.Read(ref bitrate); Interlocked.Exchange(ref keyframe, 1);
                    }
                    int target = Volatile.Read(ref bitrate);
                    if (target != appliedBitrate) { encoder!.SetBitrate((uint)target); appliedBitrate = target; }
                    var start = Stopwatch.GetTimestamp();
                    var encoded = encoder!.Encode(frame.Texture, (ulong)frame.Timestamp, Interlocked.Exchange(ref keyframe, 0) != 0);
                    Volatile.Write(ref encodeUs, Volatile.Read(ref encodeUs) + Stopwatch.GetElapsedTime(start).TotalMicroseconds);
                    if (process == null) await StartProcess(encoded, width, height, rate);
                    var header = new byte[12];
                    BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)encoded.Length);
                    BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(4), (ulong)frame.Timestamp);
                    await process!.StandardInput.BaseStream.WriteAsync(header, stopped.Token);
                    await process.StandardInput.BaseStream.WriteAsync(encoded, stopped.Token);
                    await process.StandardInput.BaseStream.FlushAsync(stopped.Token);
                    Interlocked.Increment(ref frames); Interlocked.Add(ref bytes, encoded.Length);
                }
                finally { available.Enqueue(frame.Texture); Interlocked.Decrement(ref pending); }
            }
        }
        catch (OperationCanceledException) { ready.TrySetCanceled(); }
        catch (Exception error) { ready.TrySetException(new InvalidOperationException("Native publisher failed", error)); status(new { type = "publisher-error", message = "NVENC 방송 연결이 중단되었습니다. 일반 송출로 다시 시작해 주세요." }); stopped.Cancel(); }
        finally
        {
            encoder?.Dispose();
            while (queue.Reader.TryRead(out var frame)) frame.Texture.Dispose();
            while (available.TryDequeue(out var texture)) texture.Dispose();
            try { process?.StandardInput.Close(); if (process is { HasExited: false }) process.Kill(); } catch { }
            process?.Dispose();
        }
    }
    async Task StartProcess(byte[] firstFrame, uint width, uint height, uint fps)
    {
        string? profile = null;
        for (int i = 0; i + 7 < firstFrame.Length; i++)
            if (firstFrame[i] == 0 && firstFrame[i+1] == 0 && firstFrame[i+2] == 1 && (firstFrame[i+3] & 31) == 7)
            { profile = Convert.ToHexString(firstFrame.AsSpan(i+4, 3)).ToLowerInvariant(); break; }
        if (profile == null) throw new InvalidDataException("Encoder did not emit H264 SPS");
        process = new Process { StartInfo = new ProcessStartInfo(Path.Combine(AppContext.BaseDirectory, "CustomVoice.Publisher.exe")) {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        } };
        process.Start();
        _ = process.StandardError.BaseStream.CopyToAsync(Stream.Null, stopped.Token);
        await process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new { url = credentials.Url, token = credentials.Token, identity = credentials.Identity, owner = credentials.Owner, width, height, fps, bitrate = credentials.Bitrate, profile }));
        _ = ReadFeedback(process);
    }
    async Task ReadFeedback(Process child)
    {
        try
        {
            while (!stopped.IsCancellationRequested)
            {
                var line = await child.StandardOutput.ReadLineAsync(stopped.Token);
                if (line == null || line.Length > 16384) throw new IOException("Publisher ended");
                using var json = JsonDocument.Parse(line); var message = json.RootElement;
                switch (message.GetProperty("type").GetString())
                {
                    case "ready": ready.TrySetResult(message.GetProperty("sid").GetString()!); break;
                    case "feedback":
                        Interlocked.Exchange(ref sentFrames, message.GetProperty("sentFrames").GetInt64());
                        Interlocked.Exchange(ref sentBytes, message.GetProperty("sentBytes").GetInt64());
                        Interlocked.Exchange(ref statsTimestamp, message.GetProperty("timestamp").GetInt64());
                        Volatile.Write(ref bitrate, Math.Clamp(message.GetProperty("bitrate").GetInt32(), 250000, credentials.Bitrate));
                        if (message.GetProperty("keyframe").GetBoolean()) Interlocked.Exchange(ref keyframe, 1);
                        break;
                    case "error": case "disconnected": throw new IOException("Publisher disconnected");
                }
            }
        }
        catch (OperationCanceledException) { }
        catch { ready.TrySetException(new IOException("Native publisher connection failed")); status(new { type = "publisher-error", message = "NVENC 방송 연결이 끊겼습니다." }); stopped.Cancel(); }
    }
    public void Dispose()
    {
        stopped.Cancel(); queue.Writer.TryComplete();
        try { if (process is { HasExited: false }) process.Kill(); } catch { }
        // GPU/device lifetime outlives this worker, including an in-flight encode.
        worker.GetAwaiter().GetResult();
    }
}
