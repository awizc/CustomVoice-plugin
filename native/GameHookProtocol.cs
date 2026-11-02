using System.Globalization;
using System.Runtime.InteropServices;

// OBS graphics-hook 1.8 shared-memory ABI. See game-hook/NOTICE.txt.
// These offsets are identical in the 32-bit producer and 64-bit consumer.
[StructLayout(LayoutKind.Explicit, Size = 648)]
internal struct GameHookInfo
{
    [FieldOffset(0)] public uint Major;
    [FieldOffset(4)] public uint Minor;
    [FieldOffset(8)] public uint Type;
    [FieldOffset(12)] public uint Window;
    [FieldOffset(16)] public uint Format;
    [FieldOffset(20)] public uint Width;
    [FieldOffset(24)] public uint Height;
    [FieldOffset(36)] public uint Pitch;
    [FieldOffset(40)] public uint MapId;
    [FieldOffset(44)] public uint MapSize;
    [FieldOffset(48)] public byte Flip;
    [FieldOffset(56)] public ulong FrameInterval;
}

internal static class GameHookProtocol
{
    internal static int BytesPerPixel(uint format) => format switch { 28 or 29 or 87 or 88 or 90 or 91 or 93 => 4, _ => 0 };
    internal static bool Valid(GameHookInfo info) => info.Major == 1 && info.Minor <= 8 &&
        info.Type <= 1 && info.Width is >= 2 and <= 16384 && info.Height is >= 2 and <= 16384 &&
        info.Window != 0 && info.MapId != 0 && BytesPerPixel(info.Format) != 0 &&
        (info.Type == 1 ? info.MapSize == 4 : info.Pitch >= info.Width * 4 &&
            info.MapSize is >= 12 and <= 512 * 1024 * 1024 && (ulong)info.Pitch * info.Height <= info.MapSize - 12);

    internal static bool ValidBuffer(GameHookInfo info, uint offset) => info.Type == 0 && offset >= 12 &&
        (ulong)offset + (ulong)info.Pitch * info.Height <= info.MapSize;

    internal static byte[] ParseOffsets(string text)
    {
        if (text.Length > 8192) throw new InvalidDataException("게임 캡처 초기화 응답이 너무 큽니다.");
        var entries = new Dictionary<string, uint>(StringComparer.Ordinal);
        string section = "";
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith('[') && line.EndsWith(']')) { section = line[1..^1]; continue; }
            var parts = line.Split('=', 2);
            if (parts.Length == 2 && parts[1].StartsWith("0x", StringComparison.Ordinal) &&
                uint.TryParse(parts[1].AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var value))
                entries[section + "." + parts[0]] = value;
        }
        // graphics_offsets: d3d8(1), d3d9(5), dxgi(3), ddraw(8), dxgi2(1), d3d12(1).
        string[] keys = ["d3d8.present", "d3d9.present", "d3d9.present_ex", "d3d9.present_swap", "d3d9.d3d9_clsoff", "d3d9.is_d3d9ex_clsoff",
            "dxgi.present", "dxgi.resize", "dxgi.present1", "", "", "", "", "", "", "", "", "dxgi.release", ""];
        var result = new byte[76];
        for (int i = 0; i < keys.Length; i++) BitConverter.TryWriteBytes(result.AsSpan(i * 4, 4), entries.GetValueOrDefault(keys[i]));
        if (!entries.ContainsKey("dxgi.present")) throw new InvalidDataException("게임 캡처 그래픽 주소를 확인하지 못했습니다.");
        return result;
    }
}
