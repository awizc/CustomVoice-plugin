using Vortice.Mathematics;

internal static class CaptureGeometry
{
    internal static (int Width, int Height) InitialSurface(int width, int height, bool minimized, int monitorWidth, int monitorHeight)
    {
        // A minimized WGC item may report its 160x28 iconic rectangle. Never
        // negotiate an encoder against that temporary size.
        if (!minimized && width >= 2 && height >= 2) return (width, height);
        if (monitorWidth < 2 || monitorHeight < 2) throw new InvalidOperationException("공유할 창의 초기 크기를 확인하지 못했습니다.");
        return (monitorWidth, monitorHeight);
    }

    // Coordinates are relative to the WGC texture, not the desktop. Intersect
    // the client rectangle with that texture before giving it to Direct3D.
    internal static RectI? ClipClientRegion(int surfaceWidth, int surfaceHeight, long x, long y, int width, int height)
    {
        if (surfaceWidth < 2 || surfaceHeight < 2 || width < 2 || height < 2) return null;
        int left = (int)Math.Clamp(x, 0L, surfaceWidth), top = (int)Math.Clamp(y, 0L, surfaceHeight);
        int right = (int)Math.Clamp(x + width, 0L, surfaceWidth), bottom = (int)Math.Clamp(y + height, 0L, surfaceHeight);
        // RectI's constructor takes x/y/width/height; these values are edges.
        return right - left >= 2 && bottom - top >= 2 ? RectI.FromLTRB(left, top, right, bottom) : null;
    }

    internal static void Validate(int surfaceWidth, int surfaceHeight, RectI region)
    {
        if (surfaceWidth < 2 || surfaceHeight < 2 || region.Left < 0 || region.Top < 0 ||
            region.Right > surfaceWidth || region.Bottom > surfaceHeight || region.Width < 2 || region.Height < 2)
            throw new InvalidOperationException($"캡처 영역이 원본 프레임을 벗어났습니다. 원본 {surfaceWidth}×{surfaceHeight}, 영역 [{region.Left}, {region.Top}, {region.Right}, {region.Bottom}]");
    }
}
