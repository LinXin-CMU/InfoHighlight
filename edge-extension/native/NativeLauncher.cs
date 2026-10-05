// Minimal Windows binary-stdio launcher for our Node Native Messaging bridge.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
class NativeLauncher {
  static void Pump(Stream source, Stream destination) {
    byte[] buffer=new byte[8192];int read;
    while((read=source.Read(buffer,0,buffer.Length))>0){destination.Write(buffer,0,read);destination.Flush();}
  }
  static int Main(string[] args) {
    try {
      string root=AppDomain.CurrentDomain.BaseDirectory;
      string[] config=File.ReadAllLines(Path.Combine(root,"native-runtime.txt"));
      if(args.Length<1 || !args[0].StartsWith("chrome-extension://") || args[0].Contains("\""))return 2;
      var info=new ProcessStartInfo(config[0],"\""+config[1]+"\" \""+args[0]+"\"");
      info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardInput=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;info.WorkingDirectory=root;
      var child=Process.Start(info);
      Task input=Task.Factory.StartNew(()=>{try{Pump(Console.OpenStandardInput(),child.StandardInput.BaseStream);}finally{child.StandardInput.Close();}});
      Task output=Task.Factory.StartNew(()=>Pump(child.StandardOutput.BaseStream,Console.OpenStandardOutput()));
      Task error=Task.Factory.StartNew(()=>Pump(child.StandardError.BaseStream,Console.OpenStandardError()));
      child.WaitForExit();Task.WaitAll(output,error);return child.ExitCode;
    } catch(Exception e){Console.Error.WriteLine(e.GetType().Name);return 1;}
  }
}
