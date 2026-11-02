using System.Reflection;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using static Vortice.Direct3D11.D3D11;
// Owned synthetic NV12 textures only. No screen capture or network connection.
D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.VideoSupport | DeviceCreationFlags.BgraSupport, new[]{FeatureLevel.Level_11_0}, out ID3D11Device device, out ID3D11DeviceContext context).CheckError();
using(device) using(context) {
 var type=typeof(ProcessAudio).Assembly.GetType("NvencEncoder")!;
 const BindingFlags flags=BindingFlags.Instance|BindingFlags.NonPublic;
 foreach(var (width,height,fps) in new[]{(640u,360u,30u),(1920u,1080u,60u),(2560u,1440u,165u)}) {
  using var texture=device.CreateTexture2D(new Texture2DDescription{Width=width,Height=height,MipLevels=1,ArraySize=1,Format=Format.NV12,SampleDescription=new(1,0),Usage=ResourceUsage.Default,BindFlags=BindFlags.RenderTarget|BindFlags.ShaderResource});
  // NV12 clear via video processor tested in capture-recovery; initialize here
  // with UpdateSubresource using a synthetic gray planar byte array.
  var pixels=Enumerable.Repeat((byte)128,checked((int)(width*height*3/2))).ToArray();
  context.UpdateSubresource(pixels,texture,0,width); context.Flush();
  using var encoder=(IDisposable)Activator.CreateInstance(type,flags,null,new object[]{device,width,height,fps,4_000_000u},null)!;
  using var file=File.Create(Path.Combine(Path.GetTempPath(),$"customvoice-nvenc-{width}.h264"));
  var watch=System.Diagnostics.Stopwatch.StartNew();
  for(int i=0;i<60;i++) {
   if(i==30)type.GetMethod("SetBitrate",flags)!.Invoke(encoder,new object[]{2_000_000u});
   var bytes=(byte[])type.GetMethod("Encode",flags)!.Invoke(encoder,new object[]{texture,(ulong)(i*1000000/fps),i==0||i==40})!;
   if(bytes.Length<5)throw new Exception("Empty access unit");
   file.Write(bytes);
  }
  Console.WriteLine($"NVENC {width}x{height}@{fps}: 60 frames, IDR + live bitrate update, {watch.ElapsedMilliseconds}ms");
 }
}
