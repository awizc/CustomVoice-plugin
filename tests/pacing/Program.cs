static void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}
static bool Near(double a, double b) => Math.Abs(a - b) < 0.001;

var period = 1e6 / 144;
Check(Near(FramePacer.NextDeadline(0, 0, 1000, period), period), "Normal work must retain the target cadence.");
Check(Near(FramePacer.NextDeadline(0, 200, 1200, period), period), "Small timer jitter must not accumulate phase drift.");
Check(Near(FramePacer.NextDeadline(0, 0, 10000, period), 10500), "10ms work must not incur another 6.94ms wait.");
Check(Near(FramePacer.NextDeadline(0, 100000, 101000, period), 100000 + period), "A long scheduler stall must not produce a catch-up burst.");
Check(FramePacer.NextDeadline(0, 5000, 6000, period) >= 5000 + period * 0.9, "Phase correction must have bounded spacing.");

double deadline = 0, last = -1e9;
for (var frame = 0; frame < 100; frame++)
{
    var started = deadline + (frame % 4) * 100;
    Check(started - last >= period * 0.9 - 0.001, "Ordinary jitter must not create a burst.");
    deadline = FramePacer.NextDeadline(deadline, started, started + 1000, period);
    last = started;
}
Check(Near(deadline, period * 100), "Ordinary jitter must preserve average target FPS.");

foreach (var fps in new[] { 1, 15, 30, 60, 90, 120, 144, 165 })
{
    var interval = 1e6 / fps;
    var completed = interval * 1.5;
    var next = FramePacer.NextDeadline(0, 0, completed, interval);
    Check(next >= completed + 500 && next < completed + interval, "Overload must yield without a whole extra interval.");
}
Check(Near(FramePacer.NextDeadline(0, 0, 1000, 1e6 / 30), 1e6 / 30), "A changed pace must use its new interval.");
Console.WriteLine("Pacing checks passed: normal/jitter/overrun/stall/spacing/profile changes.");

var applied = new List<bool>();
using (var allowed = new CaptureBorder(() => Task.FromResult(true), applied.Add))
{
    Check((await allowed.SetAsync(false, default)).borderStatus == "applied" && applied[^1] == false, "Allowed OFF must hide the border.");
    Check((await allowed.SetAsync(true, default)).borderVisible && applied[^1], "ON must restore the border.");
}
using (var denied = new CaptureBorder(() => Task.FromResult(false), _ => throw new Exception("Denied access must not call the setter")))
    Check((await denied.SetAsync(false, default)).borderStatus == "denied", "Denied consent must remain a nonfatal setting result.");

applied.Clear();
var permission = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
using (var race = new CaptureBorder(() => permission.Task, applied.Add))
{
    var old = race.SetAsync(false, default);
    Check((await race.SetAsync(true, default)).borderVisible, "ON must not wait for an earlier consent prompt.");
    permission.SetResult(true);
    Check((await old).borderStatus == "cancelled" && applied.SequenceEqual(new[] { true }), "Late permission must not undo a newer ON.");
}
applied.Clear();
permission = new(TaskCreationOptions.RunContinuationsAsynchronously);
using (var cancelled = new CaptureBorder(() => permission.Task, applied.Add))
using (var stop = new CancellationTokenSource())
{
    var work = cancelled.SetAsync(false, stop.Token); stop.Cancel();
    Check((await work).borderStatus == "cancelled", "Cancellation must finish without waiting for permission.");
    permission.SetResult(true); await Task.Yield();
    Check(applied.Count == 0, "Timed-out permission must not apply later.");
}
permission = new(TaskCreationOptions.RunContinuationsAsynchronously);
var ended = new CaptureBorder(() => permission.Task, applied.Add);
var late = ended.SetAsync(false, default); ended.Dispose(); permission.SetResult(true);
Check((await late).borderStatus == "cancelled" && applied.Count == 0, "Ended capture must ignore late consent.");
using (var failure = new CaptureBorder(() => Task.FromResult(true), _ => throw new InvalidOperationException("Setter unavailable")))
    Check((await failure.SetAsync(false, default)).borderStatus == "failed", "Setter failure must not stop the broadcast.");
Console.WriteLine("Border checks passed: allowed/denied/ON precedence/timeout/ended capture/setter failure.");
