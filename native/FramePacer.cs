// Pure monotonic-clock arithmetic; all units are microseconds.
internal static class FramePacer
{
    internal static double NextDeadline(double previous, double started, double completed, double interval)
    {
        var next = previous + interval;
        // Preserve phase for ordinary timer jitter, allowing at most 10% timing
        // correction. Never replay a run of expired deadlines after a stall.
        if (completed < next) return Math.Max(next, started + interval * 0.9);
        // Work has consumed the deadline. A short wait still yields the thread,
        // without adding another whole frame interval to the processing cost.
        return Math.Max(started + interval, completed + 500);
    }
}
