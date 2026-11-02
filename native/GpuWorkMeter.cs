using Vortice.Direct3D11;

// Timestamp a small fraction of submissions. Never flush or wait for telemetry.
internal sealed class GpuWorkMeter : IDisposable
{
    sealed class Sample : IDisposable
    {
        internal readonly ID3D11Query Start, End, Disjoint;
        internal bool Pending;
        internal Sample(ID3D11Device device)
        {
            Start = device.CreateQuery(new QueryDescription(QueryType.Timestamp));
            End = device.CreateQuery(new QueryDescription(QueryType.Timestamp));
            Disjoint = device.CreateQuery(new QueryDescription(QueryType.TimestampDisjoint));
        }
        public void Dispose() { Start.Dispose(); End.Dispose(); Disjoint.Dispose(); }
    }
    readonly Sample[] samples;
    readonly ID3D11DeviceContext context;
    Sample? active;
    double next;
    internal long Count { get; private set; }
    internal double TotalUs { get; private set; }
    internal GpuWorkMeter(ID3D11Device device, ID3D11DeviceContext context)
    { this.context = context; samples = Enumerable.Range(0, 3).Select(_ => new Sample(device)).ToArray(); }
    internal unsafe void Begin(double now)
    {
        foreach (var sample in samples)
        {
            if (!sample.Pending) continue;
            QueryDataTimestampDisjoint disjoint; ulong start, end;
            if (context.GetData(sample.Disjoint, (nint)(&disjoint), (uint)sizeof(QueryDataTimestampDisjoint), AsyncGetDataFlags.DoNotFlush).Code != 0 ||
                context.GetData(sample.Start, (nint)(&start), sizeof(ulong), AsyncGetDataFlags.DoNotFlush).Code != 0 ||
                context.GetData(sample.End, (nint)(&end), sizeof(ulong), AsyncGetDataFlags.DoNotFlush).Code != 0) continue;
            sample.Pending = false;
            if (!disjoint.Disjoint && disjoint.Frequency > 0 && end >= start)
            { Count++; TotalUs += (end - start) * 1e6 / disjoint.Frequency; }
        }
        if (now < next || active != null) return;
        active = samples.FirstOrDefault(sample => !sample.Pending);
        if (active == null) return;
        next = now + 100000;
        context.Begin(active.Disjoint); context.End(active.Start);
    }
    internal void End()
    {
        if (active == null) return;
        context.End(active.End); context.End(active.Disjoint); active.Pending = true; active = null;
    }
    public void Dispose() { foreach (var sample in samples) sample.Dispose(); }
}
