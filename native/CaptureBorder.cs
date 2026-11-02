internal sealed class CaptureBorder(Func<Task<bool>> requestAccess, Action<bool> apply) : IDisposable
{
    readonly object gate = new();
    Task<bool>? permission;
    long revision;
    bool disposed, visible = true;
    internal sealed record Result(string borderStatus, bool borderVisible, string? message = null);

    internal async Task<Result> SetAsync(bool show, CancellationToken cancellation)
    {
        long operation;
        lock (gate) { if (disposed) return new("cancelled", visible); operation = ++revision; }
        try
        {
            if (!show)
            {
                Task<bool> access;
                lock (gate) access = permission is { IsCompleted: false } ? permission : permission = requestAccess();
                var allowed = await access.WaitAsync(cancellation);
                lock (gate)
                {
                    if (disposed || operation != revision || cancellation.IsCancellationRequested) return new("cancelled", visible);
                    if (!allowed) return new("denied", visible, "Windows가 테두리 숨김을 허용하지 않았습니다.");
                }
            }
            lock (gate)
            {
                if (disposed || operation != revision || cancellation.IsCancellationRequested) return new("cancelled", visible);
                apply(show); visible = show;
                return new("applied", visible);
            }
        }
        catch (OperationCanceledException) { lock (gate) return new("cancelled", visible, "테두리 변경 대기 시간이 끝났습니다. 다시 시도해 주세요."); }
        catch (Exception error) { lock (gate) return new("failed", visible, error.Message); }
    }

    public void Dispose() { lock (gate) { disposed = true; revision++; } }
}
